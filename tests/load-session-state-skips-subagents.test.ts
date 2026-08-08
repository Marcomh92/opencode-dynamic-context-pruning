import assert from "node:assert/strict"
import test from "node:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs"
import { Logger } from "../lib/logger"
import { createSessionState, ensureSessionInitialized, type WithParts } from "../lib/state"
import { FORK_SCHEMA_VERSION } from "../lib/state/types"

// ────────────────────────────────────────────────────────────────────────────
// BUG-054 — loadSessionState runs even for skipped subagent sessions
//
// `ensureSessionInitialized` calls `await isSubAgentSession(client, id)`,
// then unconditionally calls `await loadSessionState(...)`. When the
// session IS a subagent and `allowSubAgents = false`, the downstream
// hook handlers early-return — but the disk read has already happened,
// wasting I/O on the skipped path.
//
// The fix gates `loadSessionState` on `!isSubAgent` (when `allowSubAgents`
// is false). These tests assert the contract via observable side-effects:
// write a sentinel state file on disk, run `ensureSessionInitialized` with
// a subagent-returning SDK stub, assert the sentinel values were NOT
// loaded into `state`. The inverse case (primary session) is a regression
// test confirming the disk IS read normally.
// ────────────────────────────────────────────────────────────────────────────

// Per-test isolation: redirect XDG_DATA_HOME / XDG_CONFIG_HOME so the
// persistence layer never touches the host filesystem.
const testDataHome = join(tmpdir(), `opencode-dcp-bug054-data-${process.pid}`)
const testConfigHome = join(tmpdir(), `opencode-dcp-bug054-config-${process.pid}`)

process.env.XDG_DATA_HOME = testDataHome
process.env.XDG_CONFIG_HOME = testConfigHome

mkdirSync(testDataHome, { recursive: true })
mkdirSync(testConfigHome, { recursive: true })

const logger = new Logger(false)

const STORAGE_DIR = join(testDataHome, "opencode", "storage", "plugin", "dcp")

/** Write a sentinel persisted-state file to the DCP storage directory.
 *  The values are deliberately distinguishable from defaults — any of
 *  them landing in `state` after the call proves the disk read happened. */
function writeSentinelState(sessionID: string): string {
    mkdirSync(STORAGE_DIR, { recursive: true })
    const filePath = join(STORAGE_DIR, `${sessionID}.json`)
    const sentinel = {
        manualMode: true,
        userForced: true,
        // BUG-031: recoveryForced / nonCompactingRunCount / recoveryFadeCounter
        // are intentionally NOT persisted (session-local recovery state, see
        // lib/state/persistence.ts). Excluding them here keeps the test
        // focused on fields that actually round-trip through loadSessionState.
        forkSchemaVersion: FORK_SCHEMA_VERSION,
        prune: {
            tools: { "sentinel-call-id": 9999, "another-call": 1234 },
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
            contextLimitAnchors: ["sentinel-context-anchor"],
            turnNudgeAnchors: ["sentinel-turn-anchor"],
            iterationNudgeAnchors: ["sentinel-iteration-anchor"],
        },
        stats: {
            pruneTokenCounter: 0,
            totalPruneTokens: 8888,
        },
        lastUpdated: new Date().toISOString(),
    }
    writeFileSync(filePath, JSON.stringify(sentinel, null, 2), "utf-8")
    return filePath
}

/** SDK stub whose `session.get` reports the session as a subagent. The
 *  fixed `isSubAgentSession` would resolve to `true` for this stub. */
function makeSubAgentClient(): any {
    return {
        session: {
            get: async () => ({ data: { parentID: "parent-1" } }),
        },
    }
}

/** SDK stub whose `session.get` reports the session as a primary session
 *  (no parentID). The fixed `isSubAgentSession` would resolve to `false`. */
function makePrimaryClient(): any {
    return {
        session: {
            get: async () => ({ data: {} }),
        },
    }
}

function buildMessages(sessionID: string): WithParts[] {
    return [
        {
            info: {
                id: "msg-user-1",
                role: "user",
                sessionID,
                agent: "assistant",
                time: { created: 1 },
            } as WithParts["info"],
            parts: [],
        },
    ]
}

function removeSentinel(filePath: string): void {
    rmSync(filePath, { force: true })
}

// ────────────────────────────────────────────────────────────────────────────
// Scenario 1 — subagent session must NOT trigger a disk load.
//
// Pre-seed a sentinel state file. Stub the SDK to report parentID
// (isSubAgent = true). Call ensureSessionInitialized. Assert none of the
// sentinel values reached state — proving the disk read was skipped.
//
// In the CURRENT (buggy) code, the disk IS read; sentinel values ARE
// loaded; assertions fail. After the fix, the disk load is skipped for
// subagent sessions; assertions pass.
// ────────────────────────────────────────────────────────────────────────────

test("BUG-054: ensureSessionInitialized skips disk load when the session is a subagent", async () => {
    const sessionID = `ses_bug054_subagent_${Date.now()}_${process.pid}`
    const filePath = writeSentinelState(sessionID)

    // Sanity: the sentinel file must exist for this test to be meaningful.
    assert.ok(existsSync(filePath), "sentinel state file must exist before the call")

    const state = createSessionState()
    const client = makeSubAgentClient()

    await ensureSessionInitialized(
        client,
        state,
        sessionID,
        logger,
        buildMessages(sessionID),
        false, // manualModeEnabled
        null, // stateMaxAgeDays
    )

    // The subagent detection itself must still work — the disk-skip is
    // only about the persistence layer.
    assert.equal(state.isSubAgent, true, "subagent detection must still set state.isSubAgent")

    // The bug: sentinel values would be loaded onto state. After the fix,
    // they must NOT be present.
    assert.equal(
        state.userForced,
        false,
        "sentinel userForced=true must NOT be loaded for subagent session",
    )

    assert.equal(
        state.prune.tools.has("sentinel-call-id"),
        false,
        "sentinel prune.tools['sentinel-call-id'] must NOT be loaded for subagent session",
    )
    assert.equal(
        state.prune.tools.has("another-call"),
        false,
        "sentinel prune.tools['another-call'] must NOT be loaded for subagent session",
    )

    assert.equal(
        state.nudges.contextLimitAnchors.has("sentinel-context-anchor"),
        false,
        "sentinel nudges.contextLimitAnchors must NOT be loaded for subagent session",
    )
    assert.equal(
        state.nudges.turnNudgeAnchors.has("sentinel-turn-anchor"),
        false,
        "sentinel nudges.turnNudgeAnchors must NOT be loaded for subagent session",
    )
    assert.equal(
        state.nudges.iterationNudgeAnchors.has("sentinel-iteration-anchor"),
        false,
        "sentinel nudges.iterationNudgeAnchors must NOT be loaded for subagent session",
    )

    removeSentinel(filePath)
})

// ────────────────────────────────────────────────────────────────────────────
// Scenario 2 — primary session IS read normally. Regression for the inverse
// case: when the SDK reports no parentID (the common path), the disk read
// must still happen. The fix must not accidentally skip the load for
// primary sessions.
// ────────────────────────────────────────────────────────────────────────────

test("BUG-054: ensureSessionInitialized still loads state from disk for primary sessions", async () => {
    const sessionID = `ses_bug054_primary_${Date.now()}_${process.pid}`
    const filePath = writeSentinelState(sessionID)

    assert.ok(existsSync(filePath), "sentinel state file must exist before the call")

    const state = createSessionState()
    const client = makePrimaryClient()

    await ensureSessionInitialized(
        client,
        state,
        sessionID,
        logger,
        buildMessages(sessionID),
        false, // manualModeEnabled
        null, // stateMaxAgeDays
    )

    // Primary session: disk MUST be loaded.
    assert.equal(state.isSubAgent, false, "primary-session detection must still work")

    assert.equal(
        state.userForced,
        true,
        "sentinel userForced=true MUST be loaded for primary session (regression)",
    )
    assert.equal(
        state.manualMode,
        "active",
        "sentinel manualMode=true MUST round-trip to state.manualMode='active' for primary session (regression)",
    )
    assert.equal(
        state.prune.tools.get("another-call"),
        1234,
        "sentinel prune.tools['another-call']=1234 MUST be loaded for primary session (regression)",
    )
    assert.ok(
        state.nudges.iterationNudgeAnchors.has("sentinel-iteration-anchor"),
        "sentinel nudges.iterationNudgeAnchors MUST be loaded for primary session (regression)",
    )

    assert.equal(
        state.prune.tools.get("sentinel-call-id"),
        9999,
        "sentinel prune.tools MUST be loaded for primary session (regression)",
    )

    assert.ok(
        state.nudges.contextLimitAnchors.has("sentinel-context-anchor"),
        "sentinel nudges.contextLimitAnchors MUST be loaded for primary session (regression)",
    )

    removeSentinel(filePath)
})

// ────────────────────────────────────────────────────────────────────────────
// Scenario 3 — no sentinel file on disk, subagent session. Verifies the
// happy-path absence: with no file present, the subagent-skip path is a
// no-op (state stays default) and nothing crashes. This is the production
// state for any newly-spawned subagent — they have no persisted state yet.
// ────────────────────────────────────────────────────────────────────────────

test("BUG-054: subagent session with no disk state is a clean no-op", async () => {
    const sessionID = `ses_bug054_subagent_nofile_${Date.now()}_${process.pid}`

    const state = createSessionState()
    const client = makeSubAgentClient()

    await ensureSessionInitialized(
        client,
        state,
        sessionID,
        logger,
        buildMessages(sessionID),
        false, // manualModeEnabled
        null, // stateMaxAgeDays
    )

    assert.equal(state.isSubAgent, true)
    assert.equal(state.userForced, false)
    assert.equal(state.prune.tools.size, 0)
    assert.equal(state.nudges.contextLimitAnchors.size, 0)
})

// Logic Verified: subagent sessions skip loadSessionState; primary sessions still load.
// Bugs Documented: BUG-054 (wasted disk read on the skipped subagent path).
// Fakes Updated: writeSentinelState seeds a current-schema file with distinguishable values.
// Review Status: pending implementer round.
