import assert from "node:assert/strict"
import test, { afterEach } from "node:test"
import { mkdirSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Logger } from "../lib/logger"

// BUG-044 — saveContext still writes per-fire when debug enabled.
//
// Contract: even when the minimized payload mutates every fire (synthetic
// timestamps, nudges, message-ids), the disk write rate for a single session
// must be bounded. The fix gates per-fire writes behind either a change-
// detection hash (already in place, but bypassed by churn) OR a real rate-
// limit. The test below exercises the churn case — every payload is distinct
// so the change-detection hash never matches — and asserts that the write
// count is NOT one-per-fire.
//
// In current code, N distinct fires produce N context-dump files (one per
// fire). After the fix, the write count must be bounded (the test asserts
// `<= 2` so it accepts either an exact-single-fire fix or a real rate-limit
// gate; per-fire writes continue to be documented by tests/savecontext-rate-
// limit-bug002.test.ts, which targets a separate filename-collision bug).
//
// Per-test isolation: redirect XDG_DATA_HOME / XDG_CONFIG_HOME so context
// dumps land in a per-pid temp dir and never touch the host filesystem.
const testDataHome = join(tmpdir(), `opencode-dcp-fire-rate-data-${process.pid}`)
const testConfigHome = join(tmpdir(), `opencode-dcp-fire-rate-config-${process.pid}`)
process.env.XDG_DATA_HOME = testDataHome
process.env.XDG_CONFIG_HOME = testConfigHome
mkdirSync(testDataHome, { recursive: true })
mkdirSync(testConfigHome, { recursive: true })

// Module-level Logger cache must be cleared between tests so a previous case's
// sessionId doesn't pre-seed the hash map for the next case's sessionId.
// Mirrors the afterEach in tests/savecontext-rate-limit.test.ts.
afterEach(() => {
    Logger.clearSaveContextCache()
})

function messages(text: string) {
    return [{ info: { id: "msg-1", role: "user" }, parts: [{ type: "text", text }] }]
}

function files(sessionId: string): string[] {
    try {
        return readdirSync(join(testConfigHome, "opencode", "logs", "dcp", "context", sessionId))
    } catch {
        return []
    }
}

async function nextTick() {
    await new Promise<void>((resolve) => setImmediate(resolve))
}

test("BUG-044 #distinct-payloads-per-fire produce bounded write count, not N", async () => {
    // Each call uses a distinct payload so the change-detection hash check
    // never short-circuits (the only existing gate today). After the fix, the
    // disk write rate must be bounded — either single-fire or rate-limited.
    // The assertion is "<= 2" so it tolerates either:
    //   (a) an exact single-fire gate (one canonical dump per session), or
    //   (b) a real per-minute/per-N rate-limit that keeps the count small.
    // The current per-fire write path produces N=8 files and fails this test.
    const sessionId = `ses_bug044_bounded_${Date.now()}`
    const logger = new Logger(true)
    const N = 8

    for (let i = 0; i < N; i++) {
        await logger.saveContext(sessionId, messages(`distinct-churn-${i}`))
        await nextTick()
    }

    const written = files(sessionId)
    assert.ok(
        written.length <= 2,
        `expected bounded writes for ${N} distinct-payload fires in one session; got ${written.length} files. ` +
            `Current behaviour writes per-fire; the fix must gate the per-fire write.`,
    )
})

test("BUG-044 #churning-nudges-and-ids do not produce per-fire writes", async () => {
    // Stronger form: drive saveContext with payloads that mutate every fire in
    // the way the chat-transform hook actually mutates — different messageId
    // + different timestamp + different nudge fragment per fire. The bug is
    // that the change-detection hash check fires "different hash → write" for
    // every one of these, and over a long debug session the context dump dir
    // fills with redundant files. The fix must bound the rate; this test
    // asserts the rate is bounded under realistic per-fire churn.
    const sessionId = `ses_bug044_churn_${Date.now()}`
    const logger = new Logger(true)
    const N = 12

    for (let i = 0; i < N; i++) {
        const payload = [
            {
                info: { id: `msg-${i}`, role: "user", time: { created: i + 1 } },
                parts: [
                    { type: "text", text: `turn-${i}-${Math.random().toString(36).slice(2, 8)}` },
                ],
            },
        ]
        await logger.saveContext(sessionId, payload)
        await nextTick()
    }

    const written = files(sessionId)
    assert.ok(
        written.length <= 2,
        `expected bounded writes under churning payloads; got ${written.length} for ${N} fires. ` +
            `Per-fire writes defeat the point of debug logging — the fix must dedupe or rate-limit.`,
    )
})

// Logic Verified: rapid and churning saveContext fires for a single session
//                  do not produce one disk write per fire; the write count is
//                  bounded by the fix's gate (single-fire or rate-limit).
// Bugs Documented: BUG-044-perf-fire-write.md (per-fire disk write when
//                  payload churns every fire).
// Fakes Updated:  none (uses production Logger directly; XDG redirected into
//                  a per-pid temp dir per PAT-011).
// Review Status:  pending independent review.
// Logic Verified: saveContext respects a fire-rate bound so distinct payloads do not produce N writes and churning nudges/ids do not produce per-fire writes.
// Bugs Documented: BUG-044.
// Fakes Updated: none (uses production Logger directly; XDG redirected into a per-pid temp dir per PAT-011).
// Review Status: pending independent review.
