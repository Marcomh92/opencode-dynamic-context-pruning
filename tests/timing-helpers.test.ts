// Regression tests for BUG-022, BUG-010, BUG-060 — the four timing helpers
// in `lib/compress/timing.ts` plus the sibling `attachCompressionDuration` in
// `lib/compress/state.ts`. Per the project audit the helpers were exported
// but no test exercised their contracts; a regression in monotonic-duration
// attribution would silently corrupt `/dcp stats` output.
//
// BUG-010: pendingByCallId leaks entries when the matching block is gone
// (deactivated before the completion event). `applyPendingCompressionDurations`
// only deletes on `applied > 0` — fix is unconditional delete.
//
// BUG-060: startsByCallId leaks entries when the tool call never completes
// (crash, kill, missing event). ResetSessionState currently does NOT clear
// `compressionTiming` — fix is to clear both maps on session reset.

import assert from "node:assert/strict"
import test from "node:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdirSync } from "node:fs"
import {
    applyPendingCompressionDurations,
    buildCompressionTimingKey,
    consumeCompressionStart,
    resolveCompressionDuration,
} from "../lib/compress/timing"
import { attachCompressionDuration } from "../lib/compress/state"
import { createSessionState, resetSessionState, type SessionState } from "../lib/state"

// XDG sandbox so the persistence layer and the logger never touch the host
// filesystem. `createSessionState` itself does not read the filesystem, but
// downstream callers do and we keep the same convention as the rest of the
// suite.
const testDataHome = join(tmpdir(), `opencode-dcp-timing-tests-${process.pid}`)
const testConfigHome = join(tmpdir(), `opencode-dcp-timing-config-${process.pid}`)

process.env.XDG_DATA_HOME = testDataHome
process.env.XDG_CONFIG_HOME = testConfigHome

mkdirSync(testDataHome, { recursive: true })
mkdirSync(testConfigHome, { recursive: true })

// Helper: seed a `CompressionBlock` into a session state's prune.messages
// blocksById with the given compressMessageId / compressCallId tuple. The
// block is filled in with the minimum fields `attachCompressionDuration`
// reads (`compressMessageId`, `compressCallId`) and `applyPendingCompressionDurations`
// writes (`durationMs`).
function seedBlock(
    state: SessionState,
    blockId: number,
    compressMessageId: string,
    compressCallId: string,
): void {
    state.prune.messages.blocksById.set(blockId, {
        blockId,
        runId: blockId,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 0,
        summaryTokens: 0,
        durationMs: 0,
        topic: "t",
        batchTopic: "t",
        startId: "m0001",
        endId: "m0001",
        anchorMessageId: "m0001",
        compressMessageId,
        compressCallId,
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: [],
        directToolIds: [],
        effectiveMessageIds: [],
        effectiveToolIds: [],
        createdAt: 0,
        summary: "s",
    } as any)
    state.prune.messages.nextBlockId = Math.max(2, blockId + 1)
}

// ────────────────────────────────────────────────────────────────────────────
// BUG-022 — buildCompressionTimingKey
// ────────────────────────────────────────────────────────────────────────────

test("BUG-022: buildCompressionTimingKey is collision-free across messageId", () => {
    assert.notEqual(buildCompressionTimingKey("m1", "c1"), buildCompressionTimingKey("m2", "c1"))
})

test("BUG-022: buildCompressionTimingKey is collision-free across callId", () => {
    assert.notEqual(buildCompressionTimingKey("m1", "c1"), buildCompressionTimingKey("m1", "c2"))
})

test("BUG-022: buildCompressionTimingKey is deterministic for same inputs", () => {
    assert.equal(buildCompressionTimingKey("m1", "c1"), buildCompressionTimingKey("m1", "c1"))
})

// ────────────────────────────────────────────────────────────────────────────
// BUG-022 — consumeCompressionStart
// ────────────────────────────────────────────────────────────────────────────

test("BUG-022: consumeCompressionStart returns undefined for missing key", () => {
    const state = createSessionState()
    // No entry inserted — read must not throw and must not pollute the map.
    assert.equal(consumeCompressionStart(state, "m1", "c1"), undefined)
    assert.equal(state.compressionTiming.startsByCallId.size, 0)
})

test("BUG-022: consumeCompressionStart returns the recorded start timestamp", () => {
    const state = createSessionState()
    state.compressionTiming.startsByCallId.set(buildCompressionTimingKey("m1", "c1"), 12345)

    assert.equal(consumeCompressionStart(state, "m1", "c1"), 12345)
})

test("BUG-022: consumeCompressionStart deletes on read (delete-on-consume semantic)", () => {
    const state = createSessionState()
    state.compressionTiming.startsByCallId.set(buildCompressionTimingKey("m1", "c1"), 12345)

    consumeCompressionStart(state, "m1", "c1")
    // Second read returns undefined — entry must be gone.
    assert.equal(consumeCompressionStart(state, "m1", "c1"), undefined)
    assert.equal(state.compressionTiming.startsByCallId.size, 0)
})

// ────────────────────────────────────────────────────────────────────────────
// BUG-022 — resolveCompressionDuration
// ────────────────────────────────────────────────────────────────────────────

test("BUG-022: resolveCompressionDuration returns undefined when all inputs undefined", () => {
    assert.equal(resolveCompressionDuration(undefined, undefined, undefined), undefined)
})

test("BUG-022: resolveCompressionDuration computes pendingToRunningMs from startedAt + eventTime", () => {
    // pendingToRunningMs = max(0, runningAt - startedAt)
    assert.equal(resolveCompressionDuration(100, 250, undefined), 150)
})

test("BUG-022: resolveCompressionDuration prefers partTime.start over eventTime for the running anchor", () => {
    // partTime.start = 250 → runningAt = 250 (not the eventTime 999).
    assert.equal(resolveCompressionDuration(100, 999, { start: 250 }), 150)
})

test("BUG-022: resolveCompressionDuration falls back to runtimeMs when startedAt is missing", () => {
    // startedAt undefined → no pendingToRunningMs → use runtimeMs.
    assert.equal(resolveCompressionDuration(undefined, undefined, { start: 100, end: 250 }), 150)
})

test("BUG-022: resolveCompressionDuration prefers pendingToRunningMs over runtimeMs when both exist", () => {
    // startedAt=100, runningAt=200 (from partTime.start) → pendingToRunningMs=100.
    // runtimeMs=999 (tool duration) → would be 999 if pendingToRunningMs were missing.
    // Function must prefer pendingToRunningMs.
    assert.equal(resolveCompressionDuration(100, undefined, { start: 200, end: 999 }), 100)
})

test("BUG-022: resolveCompressionDuration clamps negative deltas to 0", () => {
    // runningAt < startedAt would be negative — function clamps to 0.
    assert.equal(resolveCompressionDuration(500, 100, undefined), 0)
    assert.equal(resolveCompressionDuration(undefined, undefined, { start: 500, end: 100 }), 0)
})

test("BUG-022: resolveCompressionDuration rejects non-finite partTime fields", () => {
    // NaN / Infinity in partTime must be ignored; falls through to pendingToRunningMs.
    assert.equal(resolveCompressionDuration(100, 250, { start: NaN, end: 999 }), 150)
    assert.equal(resolveCompressionDuration(100, 250, { start: Infinity, end: 999 }), 150)
})

// ────────────────────────────────────────────────────────────────────────────
// BUG-022 — attachCompressionDuration (sibling in lib/compress/state.ts)
// ────────────────────────────────────────────────────────────────────────────

test("BUG-022: attachCompressionDuration returns 0 for non-finite durationMs", () => {
    const state = createSessionState()
    seedBlock(state, 1, "m1", "c1")

    assert.equal(attachCompressionDuration(state.prune.messages, "m1", "c1", NaN), 0)
    assert.equal(attachCompressionDuration(state.prune.messages, "m1", "c1", Infinity), 0)
})

test("BUG-022: attachCompressionDuration updates matching blocks and counts them", () => {
    const state = createSessionState()
    seedBlock(state, 1, "m1", "c1")
    seedBlock(state, 2, "m1", "c2")

    const updates = attachCompressionDuration(state.prune.messages, "m1", "c1", 500)

    assert.equal(updates, 1)
    assert.equal(state.prune.messages.blocksById.get(1)?.durationMs, 500)
    assert.equal(state.prune.messages.blocksById.get(2)?.durationMs, 0)
})

test("BUG-022: attachCompressionDuration matches on compressMessageId AND compressCallId tuple", () => {
    const state = createSessionState()
    seedBlock(state, 1, "m1", "c1")
    seedBlock(state, 2, "m2", "c1") // same callId, different messageId

    const updates = attachCompressionDuration(state.prune.messages, "m1", "c1", 500)

    assert.equal(updates, 1)
    assert.equal(state.prune.messages.blocksById.get(1)?.durationMs, 500)
    assert.equal(state.prune.messages.blocksById.get(2)?.durationMs, 0)
})

// ────────────────────────────────────────────────────────────────────────────
// BUG-010 — pendingByCallId leak when matching block is gone
//
// The current implementation in lib/compress/timing.ts:57-76 only deletes
// entries from `pendingByCallId` when `attachCompressionDuration` returns > 0.
// A compress block that was deactivated (via /dcp decompress) before the
// completion event arrives has no matching block — `attached === 0` — and
// the entry stays in the map for the lifetime of the session state.
//
// After fix: entry is deleted regardless of attach outcome. One tick of
// durationMs writes is harmless; the map must stay bounded.
// ────────────────────────────────────────────────────────────────────────────

test("BUG-010: pendingByCallId entry is deleted even when no matching block exists", () => {
    const state = createSessionState()
    state.compressionTiming.pendingByCallId.set("m1:c1", {
        messageId: "m1",
        callId: "c1",
        durationMs: 500,
    })

    const updates = applyPendingCompressionDurations(state)

    // No block exists for (m1, c1) → attach returns 0.
    assert.equal(updates, 0)
    // After fix: the entry is gone regardless.
    // Current: entry is leaked (size === 1).
    assert.equal(
        state.compressionTiming.pendingByCallId.size,
        0,
        "orphaned pending entries must be evicted even when no block matches",
    )
})

test("BUG-010: pendingByCallId entry is deleted when the matching block has a different callId", () => {
    const state = createSessionState()
    seedBlock(state, 1, "m1", "c2") // different callId than the pending entry

    state.compressionTiming.pendingByCallId.set("m1:c1", {
        messageId: "m1",
        callId: "c1",
        durationMs: 500,
    })

    applyPendingCompressionDurations(state)

    // attach returns 0 (no match) — entry must still be evicted.
    assert.equal(state.compressionTiming.pendingByCallId.size, 0)
})

test("BUG-010: applyPendingCompressionDurations still applies duration to a matching block", () => {
    const state = createSessionState()
    seedBlock(state, 1, "m1", "c1")

    state.compressionTiming.pendingByCallId.set("m1:c1", {
        messageId: "m1",
        callId: "c1",
        durationMs: 500,
    })

    const updates = applyPendingCompressionDurations(state)

    assert.equal(updates, 1)
    assert.equal(state.prune.messages.blocksById.get(1)?.durationMs, 500)
    assert.equal(state.compressionTiming.pendingByCallId.size, 0)
})

test("BUG-010: applyPendingCompressionDurations returns 0 on an empty map (no-op)", () => {
    const state = createSessionState()
    assert.equal(applyPendingCompressionDurations(state), 0)
})

// ────────────────────────────────────────────────────────────────────────────
// BUG-060 — startsByCallId orphan growth + resetSessionState clearing
//
// The current `resetSessionState` (lib/state/state.ts:118-159) clears prune
// tools, subagent cache, messageIds, etc. but never touches
// `compressionTiming`. Cross-session orphans persist within the same
// `state` object until the process exits.
//
// After fix: session reset clears both `startsByCallId` and
// `pendingByCallId` so orphaned pending compresses do not leak across
// session boundaries inside a long-lived TUI / desktop sidecar process.
// ────────────────────────────────────────────────────────────────────────────

test("BUG-060: resetSessionState clears compressionTiming.startsByCallId", () => {
    const state = createSessionState()
    state.compressionTiming.startsByCallId.set("m1:c1", 12345)
    state.compressionTiming.startsByCallId.set("m1:c2", 67890)

    resetSessionState(state)

    assert.equal(state.compressionTiming.startsByCallId.size, 0)
})

test("BUG-060: resetSessionState clears compressionTiming.pendingByCallId", () => {
    const state = createSessionState()
    state.compressionTiming.pendingByCallId.set("m1:c1", {
        messageId: "m1",
        callId: "c1",
        durationMs: 500,
    })
    state.compressionTiming.pendingByCallId.set("m2:c2", {
        messageId: "m2",
        callId: "c2",
        durationMs: 700,
    })

    resetSessionState(state)

    assert.equal(state.compressionTiming.pendingByCallId.size, 0)
})

test("BUG-060: startsByCallId with a pending-but-never-completed call is cleared on reset", () => {
    // Simulate the orphan scenario from BUG-060: a compress call was
    // recorded as pending (startedAt set on the pending event) but the
    // completion event never arrived (crash mid-call). The entry sits in
    // startsByCallId; after resetSessionState it must be gone so the next
    // session starts clean.
    const state = createSessionState()
    const key = buildCompressionTimingKey("msg-compress-orphan", "call-orphan")
    state.compressionTiming.startsByCallId.set(key, Date.now() - 60 * 60 * 1000) // 1h old

    resetSessionState(state)

    assert.equal(state.compressionTiming.startsByCallId.has(key), false)
})

// Logic Verified: timing helper contracts (key composition, delete-on-consume,
// monotonic deltas, clamping) + pendingByCallId eviction regardless of attach
// outcome + resetSessionState clearing of compressionTiming maps.
// Bugs Documented: BUG-022 (untested surface), BUG-010 (pending leak),
//                  BUG-060 (orphan in startsByCallId + reset misses cleanup).
// Fakes Updated: none.
// Review Status: pending implementer round.
// Logic Verified: buildCompressionTimingKey is collision-free and deterministic, consumeCompressionStart deletes on read, and resetTiming clears startsByCallId (no orphans).
// Bugs Documented: BUG-010, BUG-022, BUG-060.
// Fakes Updated: none
// Review Status: pending independent review.
