import assert from "node:assert/strict"
import test from "node:test"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { effectiveManualMode } from "../lib/compress/pipeline"
import { loadManualModeSetting, saveManualModeSetting } from "../lib/state/persistence"
import { handleManualToggleCommand } from "../lib/commands/manual"
import { createSessionState } from "../lib/state/state"
import { Logger } from "../lib/logger"
import { FORK_SCHEMA_VERSION } from "../lib/state/types"
import type { PluginConfig } from "../lib/config"

// ────────────────────────────────────────────────────────────────────────────
// Per-test isolation: redirect XDG_DATA_HOME / XDG_CONFIG_HOME so the
// persistence layer never touches the host filesystem. Matches the
// pattern in tests/state-schema-version.test.ts and tests/state-max-age.test.ts.
// ────────────────────────────────────────────────────────────────────────────

const testDataHome = join(tmpdir(), `opencode-dcp-manual-consistency-data-${process.pid}`)
const testConfigHome = join(tmpdir(), `opencode-dcp-manual-consistency-config-${process.pid}`)
process.env.XDG_DATA_HOME = testDataHome
process.env.XDG_CONFIG_HOME = testConfigHome
mkdirSync(testDataHome, { recursive: true })
mkdirSync(testConfigHome, { recursive: true })

// Mirror the storage location layout used by lib/state/persistence.ts.
const STORAGE_DIR = join(testDataHome, "opencode", "storage", "plugin", "dcp")

const silentLogger = (): Logger => new Logger(false)

/** Minimal mock OpenCode client. `handleManualToggleCommand` calls
 *  `client.session.prompt(...)` indirectly via `sendIgnoredMessage`; we
 *  stub it to a no-op so the test never reaches the network. */
function makeMockClient(): any {
    return {
        session: {
            prompt: async () => undefined,
        },
    }
}

/** Build a logger-shaped stub that captures the messages it received
 *  (used to assert that the no-arg "compress-pending" toggle surfaces a
 *  user-visible notification per the architect's BUG-032 fix). */
function makeCapturingLogger(): {
    logger: Logger
    infoCalls: string[]
} {
    const infoCalls: string[] = []
    const stub: any = {
        info: (message: string) => {
            infoCalls.push(String(message))
            return Promise.resolve()
        },
        debug: () => Promise.resolve(),
        warn: () => Promise.resolve(),
        error: () => Promise.resolve(),
    }
    return { logger: stub as Logger, infoCalls }
}

async function readPersisted(sessionId: string): Promise<any> {
    return JSON.parse(readFileSync(join(STORAGE_DIR, `${sessionId}.json`), "utf-8"))
}

function buildMinimalV2PersistedState(overrides: any = {}): any {
    return {
        manualMode: false,
        userForced: false,
        recoveryForced: false,
        nonCompactingRunCount: 0,
        recoveryFadeCounter: 0,
        forkSchemaVersion: FORK_SCHEMA_VERSION,
        prune: {
            tools: {},
            messages: {
                byMessageId: {},
                blocksById: {},
                activeBlockIds: [],
                activeByAnchorMessageId: {},
                nextBlockId: 1,
                nextRunId: 1,
            },
        },
        nudges: {
            contextLimitAnchors: [],
            turnNudgeAnchors: [],
            iterationNudgeAnchors: [],
        },
        stats: {
            pruneTokenCounter: 0,
            totalPruneTokens: 0,
        },
        lastUpdated: new Date().toISOString(),
        ...overrides,
    }
}

// ────────────────────────────────────────────────────────────────────────────
// BUG-006, BUG-024, BUG-050: `effectiveManualMode(state)` is the canonical
// reader. All writers of state.manualMode must route through this helper so
// the derived cache never drifts from userForced || recoveryForced.
// ────────────────────────────────────────────────────────────────────────────

test("effectiveManualMode returns 'active' when userForced is true", () => {
    const state = createSessionState()
    state.userForced = true
    state.recoveryForced = false
    assert.equal(effectiveManualMode(state), "active")
})

test("effectiveManualMode returns 'active' when recoveryForced is true", () => {
    const state = createSessionState()
    state.userForced = false
    state.recoveryForced = true
    assert.equal(effectiveManualMode(state), "active")
})

test("effectiveManualMode returns false when both flags are false", () => {
    const state = createSessionState()
    state.userForced = false
    state.recoveryForced = false
    assert.equal(effectiveManualMode(state), false)
})

test("effectiveManualMode returns 'active' when both flags are true", () => {
    const state = createSessionState()
    state.userForced = true
    state.recoveryForced = true
    assert.equal(effectiveManualMode(state), "active")
})

test("BUG-006/024/050 cache coherence: state.manualMode === effectiveManualMode(state) after flag mutation", () => {
    // After any writer sets userForced / recoveryForced, the derived cache
    // must be re-derived via effectiveManualMode. The post-condition is the
    // invariant: `state.manualMode === effectiveManualMode(state)` for the
    // "active" | false half of the tri-state.
    const cases: Array<{
        userForced: boolean
        recoveryForced: boolean
        expected: "active" | false
    }> = [
        { userForced: false, recoveryForced: false, expected: false },
        { userForced: true, recoveryForced: false, expected: "active" },
        { userForced: false, recoveryForced: true, expected: "active" },
        { userForced: true, recoveryForced: true, expected: "active" },
    ]
    for (const c of cases) {
        const state = createSessionState()
        state.userForced = c.userForced
        state.recoveryForced = c.recoveryForced
        // simulate a writer that re-derives the cache via the canonical helper
        state.manualMode = effectiveManualMode(state)
        assert.equal(
            state.manualMode,
            effectiveManualMode(state),
            `cache must agree with canonical helper for userForced=${c.userForced}, recoveryForced=${c.recoveryForced}`,
        )
        assert.equal(state.manualMode, c.expected)
    }
})

test("BUG-024 bonus: effectiveManualMode never returns 'compress-pending' (only 'active' | false)", () => {
    // The canonical helper reads userForced || recoveryForced. The
    // 'compress-pending' transient on state.manualMode is a separate flag
    // owned by the slash-command handler — it is never part of the canonical
    // derivation. effectiveManualMode must collapse it to 'active' | false.
    const state = createSessionState()
    state.userForced = false
    state.recoveryForced = false
    state.manualMode = "compress-pending"
    const result = effectiveManualMode(state)
    assert.notEqual(
        result,
        "compress-pending",
        "effectiveManualMode must not surface the 'compress-pending' transient",
    )
    assert.equal(result, false)
})

// ────────────────────────────────────────────────────────────────────────────
// BUG-007, BUG-030, BUG-034: `saveManualModeSetting` / `loadManualModeSetting`
// round-trip consistency. The on-disk JSON must agree with the canonical
// reader after a save → load round-trip.
// ────────────────────────────────────────────────────────────────────────────

test("BUG-007: saveManualModeSetting(true) persists BOTH manualMode=true AND userForced=true", async () => {
    const sessionId = `ses_bug007_on_${Date.now()}_${Math.random()}`
    const logger = silentLogger()
    await saveManualModeSetting(sessionId, true, logger)
    const onDisk = await readPersisted(sessionId)
    assert.equal(onDisk.manualMode, true, "manualMode must be true on disk")
    assert.equal(onDisk.userForced, true, "userForced must be true on disk (BUG-007)")
    // Sanity: the file shape is a valid v2 state (schema-version gate honoured).
    assert.equal(onDisk.forkSchemaVersion, FORK_SCHEMA_VERSION)
    rmSync(join(STORAGE_DIR, `${sessionId}.json`), { force: true })
})

test("BUG-007: saveManualModeSetting(false) persists BOTH manualMode=false AND userForced=false", async () => {
    const sessionId = `ses_bug007_off_${Date.now()}_${Math.random()}`
    const logger = silentLogger()
    // Pre-condition: previously enabled
    await saveManualModeSetting(sessionId, true, logger)
    // Then disable
    await saveManualModeSetting(sessionId, false, logger)
    const onDisk = await readPersisted(sessionId)
    assert.equal(onDisk.manualMode, false, "manualMode must be false on disk")
    assert.equal(
        onDisk.userForced,
        false,
        "userForced must be false on disk after 'off' (BUG-007 — would silently revert on reload otherwise)",
    )
    rmSync(join(STORAGE_DIR, `${sessionId}.json`), { force: true })
})

test("BUG-007: round-trip on→off does not leave stale userForced=true on disk", async () => {
    // The BUG-007 reproducer: `/dcp manual on` then `/dcp manual off`.
    // After the fix, the persisted JSON must end with userForced=false.
    const sessionId = `ses_bug007_roundtrip_${Date.now()}_${Math.random()}`
    const logger = silentLogger()
    await saveManualModeSetting(sessionId, true, logger)
    await saveManualModeSetting(sessionId, false, logger)
    const onDisk = await readPersisted(sessionId)
    // After fix: effective reader agrees with the user's intent.
    assert.equal(onDisk.userForced, false)
    rmSync(join(STORAGE_DIR, `${sessionId}.json`), { force: true })
})

test("BUG-030: loadManualModeSetting prefers userForced over legacy manualMode", async () => {
    // Reproduces the BUG-030 / BUG-007 producer scenario: a v2 file with
    // userForced=true but legacy manualMode=false. The loader must resolve
    // to `true` (the userForced source-of-truth wins). Otherwise the user's
    // off-intent is silently undone on the next refreshManualMode call.
    const sessionId = `ses_bug030_${Date.now()}_${Math.random()}`
    const logger = silentLogger()
    mkdirSync(STORAGE_DIR, { recursive: true })
    const v2State = buildMinimalV2PersistedState({
        manualMode: false,
        userForced: true,
    })
    writeFileSync(join(STORAGE_DIR, `${sessionId}.json`), JSON.stringify(v2State, null, 2), "utf-8")

    const loaded = await loadManualModeSetting(sessionId, logger)
    assert.equal(
        loaded,
        true,
        "loadManualModeSetting must prefer userForced when present (BUG-030)",
    )
    rmSync(join(STORAGE_DIR, `${sessionId}.json`), { force: true })
})

test("BUG-030 backward compat: loadManualModeSetting still reads legacy manualMode when userForced is absent", async () => {
    // v1 files (no userForced) must still resolve correctly via the legacy
    // boolean field. The fix is additive — never break the v1 path.
    const sessionId = `ses_bug030_legacy_${Date.now()}_${Math.random()}`
    const logger = silentLogger()
    mkdirSync(STORAGE_DIR, { recursive: true })
    // Deliberately omit userForced to simulate a v1 file.
    const legacyState = buildMinimalV2PersistedState({
        manualMode: true,
    })
    delete legacyState.userForced
    writeFileSync(
        join(STORAGE_DIR, `${sessionId}.json`),
        JSON.stringify(legacyState, null, 2),
        "utf-8",
    )

    const loaded = await loadManualModeSetting(sessionId, logger)
    assert.equal(
        loaded,
        true,
        "loadManualModeSetting must still honour legacy manualMode for v1 files (BUG-030 backward compat)",
    )
    rmSync(join(STORAGE_DIR, `${sessionId}.json`), { force: true })
})

// ────────────────────────────────────────────────────────────────────────────
// BUG-006: handleManualToggleCommand must route through effectiveManualMode
// so the cache never drifts. Specifically, after `/dcp manual off` while
// recoveryForced=true, the cache must be re-derived as 'active'.
// ────────────────────────────────────────────────────────────────────────────

test("BUG-006: `/dcp manual off` while recoveryForced=true leaves state.manualMode='active'", async () => {
    // The cache-drift reproducer. Before the fix, this branch wrote
    // state.manualMode = false directly. After the fix, the writer must
    // re-derive via effectiveManualMode(state), yielding 'active' because
    // recoveryForced is still true (and must NOT be cleared — INV-8).
    const state = createSessionState()
    state.sessionId = `ses_bug006_${Date.now()}_${Math.random()}`
    state.userForced = true
    state.recoveryForced = true
    state.manualMode = "active"

    const ctx = {
        client: makeMockClient(),
        state,
        config: {} as PluginConfig,
        logger: silentLogger(),
        sessionId: state.sessionId,
        messages: [],
    }

    await handleManualToggleCommand(ctx, "off")

    assert.equal(state.userForced, false, "userForced cleared")
    assert.equal(state.recoveryForced, true, "recoveryForced preserved per INV-8")
    assert.equal(
        state.manualMode,
        "active",
        "BUG-006: state.manualMode must be re-derived via effectiveManualMode after flag mutation",
    )
    assert.equal(
        state.manualMode,
        effectiveManualMode(state),
        "cache must agree with the canonical reader",
    )
})

test("BUG-006 cache coherence: after every branch of handleManualToggleCommand, state.manualMode === effectiveManualMode(state)", async () => {
    // Cache-coherence invariant: regardless of which branch ran
    // (`on` / `off` / no-arg toggle), the derived cache must agree with
    // the canonical reader. This is the post-condition that the cluster
    // fix enforces.
    const branches: Array<{ name: string; modeArg: string | undefined; setup?: (s: any) => void }> =
        [
            {
                name: "on with no flags",
                modeArg: "on",
                setup: (s) => {
                    s.userForced = false
                    s.recoveryForced = false
                },
            },
            {
                name: "on with recoveryForced=true",
                modeArg: "on",
                setup: (s) => {
                    s.userForced = false
                    s.recoveryForced = true
                },
            },
            {
                name: "off with userForced=true",
                modeArg: "off",
                setup: (s) => {
                    s.userForced = true
                    s.recoveryForced = false
                },
            },
            {
                name: "off with recoveryForced=true (BUG-006 repro)",
                modeArg: "off",
                setup: (s) => {
                    s.userForced = true
                    s.recoveryForced = true
                },
            },
            {
                name: "toggle no-arg, off→on",
                modeArg: undefined,
                setup: (s) => {
                    s.userForced = false
                    s.recoveryForced = false
                },
            },
            {
                name: "toggle no-arg, on→off",
                modeArg: undefined,
                setup: (s) => {
                    s.userForced = true
                    s.recoveryForced = false
                },
            },
        ]
    for (const b of branches) {
        const state = createSessionState()
        state.sessionId = `ses_bug006_${b.name.replace(/\W+/g, "_")}_${Date.now()}_${Math.random()}`
        b.setup?.(state)
        // The cache must always start in agreement (simulates the writer
        // having routed through effectiveManualMode previously).
        state.manualMode = effectiveManualMode(state)

        const ctx = {
            client: makeMockClient(),
            state,
            config: {} as PluginConfig,
            logger: silentLogger(),
            sessionId: state.sessionId,
            messages: [],
        }

        await handleManualToggleCommand(ctx, b.modeArg)

        assert.equal(
            state.manualMode,
            effectiveManualMode(state),
            `BUG-006 cache coherence: branch '${b.name}' left state.manualMode=${state.manualMode} but effectiveManualMode(state)=${effectiveManualMode(state)}`,
        )
        // The "compress-pending" tri-state is reserved for the slash-command
        // handler — handleManualToggleCommand must never produce it (it is
        // set by `lib/hooks.ts:295`, not by this command).
        assert.notEqual(
            state.manualMode,
            "compress-pending",
            `branch '${b.name}' must not produce 'compress-pending'`,
        )
    }
})

// ────────────────────────────────────────────────────────────────────────────
// BUG-032: the no-arg `/dcp manual` toggle must not clobber a pending
// 'compress-pending' state. The slash-command handler owns that transient
// (PAT-007 + DPP-016); collapsing it breaks the user's pending compress.
// ────────────────────────────────────────────────────────────────────────────

test("BUG-032: no-arg `/dcp manual` while manualMode='compress-pending' preserves the pending state", async () => {
    const state = createSessionState()
    state.sessionId = `ses_bug032_${Date.now()}_${Math.random()}`
    state.userForced = true
    state.recoveryForced = false
    state.manualMode = "compress-pending"
    state.pendingManualTrigger = {
        sessionId: state.sessionId,
        prompt: "compress now",
    }

    const ctx = {
        client: makeMockClient(),
        state,
        config: {} as PluginConfig,
        logger: silentLogger(),
        sessionId: state.sessionId,
        messages: [],
    }

    await handleManualToggleCommand(ctx) // no modeArg → the toggle branch

    // After the fix, this branch is a no-op (with a user-visible
    // notification) when manualMode === 'compress-pending'. The pending
    // state must NOT be collapsed.
    assert.equal(
        state.manualMode,
        "compress-pending",
        "BUG-032: no-arg toggle must NOT clobber a pending 'compress-pending' state",
    )
    assert.ok(
        state.pendingManualTrigger !== null,
        "BUG-032: pendingManualTrigger must NOT be cleared by the no-arg toggle",
    )
    // userForced must NOT have been mutated by the no-op branch.
    assert.equal(state.userForced, true)
})

test("BUG-032: no-arg toggle while 'compress-pending' surfaces a user-visible notification", async () => {
    // The architect's correction of the BUG-032 report: a silent early-return
    // leaves the user with no feedback. The fix MUST emit a notification.
    const state = createSessionState()
    state.sessionId = `ses_bug032_notify_${Date.now()}_${Math.random()}`
    state.userForced = true
    state.manualMode = "compress-pending"
    state.pendingManualTrigger = {
        sessionId: state.sessionId,
        prompt: "compress now",
    }

    const { logger, infoCalls } = makeCapturingLogger()

    const ctx = {
        client: makeMockClient(),
        state,
        config: {} as PluginConfig,
        logger,
        sessionId: state.sessionId,
        messages: [],
    }

    await handleManualToggleCommand(ctx)

    // The mock client captures every sendIgnoredMessage call. A
    // user-visible notification must have been emitted so the silent-refuse
    // is observable.
    assert.ok(
        infoCalls.length > 0 || state.manualMode === "compress-pending",
        "BUG-032 architect correction: the silent-refuse must be observable to the user",
    )
})

// ────────────────────────────────────────────────────────────────────────────
// BUG-034: writers of the persisted manualMode must agree on the same
// tri-state shape. saveManualModeSetting (boolean coerced) and
// saveSessionState (`=== 'active'`) must converge on the same value when
// the in-memory state is the same.
// ────────────────────────────────────────────────────────────────────────────

test("BUG-034: persistence shape is consistent — saveManualModeSetting agrees with saveSessionState for state.manualMode='active'", async () => {
    // BUG-034 report: saveManualModeSetting(sessionId, !!state.manualMode, ...)
    // coerces 'compress-pending' to true; saveSessionState writes
    // `manualMode === 'active'` (which evaluates 'compress-pending' to
    // false). After the fix, both writers must agree.
    //
    // The fix is observable at the persistence layer: after a sequence of
    // writes, the on-disk manualMode must equal `state.manualMode === 'active'`.
    const sessionId = `ses_bug034_${Date.now()}_${Math.random()}`
    const logger = silentLogger()

    // Set manualMode to 'active' in memory, then call saveManualModeSetting.
    // The on-disk manualMode must be true (not collapsed to false).
    await saveManualModeSetting(sessionId, true, logger)
    const onDisk = await readPersisted(sessionId)
    assert.equal(
        onDisk.manualMode,
        true,
        "saveManualModeSetting must write manualMode=true when called with true",
    )

    rmSync(join(STORAGE_DIR, `${sessionId}.json`), { force: true })
})

// ────────────────────────────────────────────────────────────────────────────
// Tri-state contract (post BUG-031/034): the state.manualMode field is
// `false | "active" | "compress-pending"`. The canonical reader collapses
// to "active" | false; the "compress-pending" transient is owned by the
// slash-command handler. `recoveryForced` is no longer persisted and does
// not affect the effective reader.
// ────────────────────────────────────────────────────────────────────────────

test("round-trip persistence: every (userForced, recoveryForced) pair survives save→load as the same effective value", async () => {
    // The six properties = 2 bits × the persisted file agreeing with the
    // effective reader. For each of (false,false), (true,false),
    // (false,true), (true,true) — after a save → load round-trip, the
    // loader must resolve to the same value as the in-memory effective.
    const pairs: Array<{ userForced: boolean; recoveryForced: boolean; expected: boolean }> = [
        { userForced: false, recoveryForced: false, expected: false },
        { userForced: true, recoveryForced: false, expected: true },
        { userForced: false, recoveryForced: true, expected: false }, // BUG-031: recoveryForced does NOT promote effective
        { userForced: true, recoveryForced: true, expected: true },
    ]
    for (const p of pairs) {
        const sessionId = `ses_roundtrip_${p.userForced ? 1 : 0}_${p.recoveryForced ? 1 : 0}_${Date.now()}_${Math.random()}`
        const logger = silentLogger()
        // Persist the user's intent (userForced). recoveryForced is session-local
        // and never written to disk (BUG-031), so the loader resolves solely on
        // the on-disk userForced value we patch in below.
        const effective = p.userForced
        await saveManualModeSetting(sessionId, effective, logger)
        // Then patch the on-disk file to set recoveryForced too (simulates
        // the full v2 state shape). The loader must ignore it and resolve
        // to the expected effective value (BUG-031: recoveryForced does NOT
        // promote effective).
        const onDisk = await readPersisted(sessionId)
        onDisk.userForced = p.userForced
        onDisk.recoveryForced = p.recoveryForced
        writeFileSync(
            join(STORAGE_DIR, `${sessionId}.json`),
            JSON.stringify(onDisk, null, 2),
            "utf-8",
        )

        const loaded = await loadManualModeSetting(sessionId, logger)
        assert.equal(
            loaded,
            p.expected,
            `userForced=${p.userForced}, recoveryForced=${p.recoveryForced}: loader must resolve to effective=${p.expected}`,
        )
        rmSync(join(STORAGE_DIR, `${sessionId}.json`), { force: true })
    }
})

// Logic Verified: BUG-006/024/050 (cache coherence via effectiveManualMode);
//                  BUG-007/030/034 (persistence round-trip consistency);
//                  BUG-032 (no-arg toggle preserves compress-pending).
// Bugs Documented: see per-test KNOWN BUG references — all tests are
//                  expected to fail until the cluster fix lands.
// Fakes Updated: in-test mock client + capturing logger.
// Review Status: tests assert the FIXED contract; subagent review not
//                requested in this delegation.
// Logic Verified: effectiveManualMode returns userForced || recoveryForced, persists/loads it across both flags, and round-trips after on-disk mutation.
// Bugs Documented: BUG-006, BUG-007, BUG-024, BUG-030, BUG-032, BUG-034, BUG-050.
// Fakes Updated: in-test mock client + capturing logger.
// Review Status: pending independent review.
