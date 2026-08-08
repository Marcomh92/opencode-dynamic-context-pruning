// Regression tests for BUG-009 — strategy helpers (deduplicate, purgeErrors)
// can throw, and in `lib/compress/pipeline.ts` they are called back-to-back
// without any error isolation. A throw in either strategy bubbles out of
// `prepareSession`, aborting the whole compress pipeline before validation /
// refetch completes.
//
// The expected fix is per-strategy try/catch in `prepareSession` that logs
// and continues, so a single buggy strategy does not kill the compress.

import assert from "node:assert/strict"
import test from "node:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdirSync } from "node:fs"
import { prepareSession, type PreparedSession } from "../lib/compress/pipeline"
import { createSessionState, type SessionState } from "../lib/state"
import { Logger } from "../lib/logger"
import type { PluginConfig } from "../lib/config"
import type { ToolContext } from "../lib/compress/types"

// XDG sandbox so the persistence layer + logger never touch the host fs.
const testDataHome = join(tmpdir(), `opencode-dcp-robustness-tests-${process.pid}`)
const testConfigHome = join(tmpdir(), `opencode-dcp-robustness-config-${process.pid}`)

process.env.XDG_DATA_HOME = testDataHome
process.env.XDG_CONFIG_HOME = testConfigHome

mkdirSync(testDataHome, { recursive: true })
mkdirSync(testConfigHome, { recursive: true })

function buildConfig(): PluginConfig {
    return {
        enabled: true,
        debug: false,
        pruneNotification: "off",
        pruneNotificationType: "chat",
        commands: { enabled: true, protectedTools: [] },
        manualMode: { enabled: false, automaticStrategies: true },
        turnProtection: { enabled: false, turns: 4 },
        experimental: { allowSubAgents: true, customPrompts: false },
        protectedFilePatterns: [],
        compress: {
            mode: "range",
            permission: "allow",
            showCompression: false,
            summaryBuffer: true,
            maxContextLimit: 150000,
            minContextLimit: 50000,
            nudgeFrequency: 5,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            protectedTools: [],
            protectTags: false,
            protectUserMessages: false,
            maxCompactionRatio: 0.7,
            maxContextLimitRecovery: 3,
            recoveryFadeWindow: 5,
            forkSchemaVersion: 3,
            stateMaxAgeDays: null,
        },
        strategies: {
            deduplication: { enabled: true, protectedTools: [] },
            purgeErrors: { enabled: true, turns: 4, protectedTools: [] },
        },
    }
}

function buildToolContext(state: SessionState, config: PluginConfig = buildConfig()): ToolContext {
    return {
        client: {
            session: {
                messages: async () => ({ data: [] }),
                get: async () => ({ data: { parentID: null } }),
            },
        },
        state,
        logger: new Logger(false),
        config,
        prompts: {
            reload() {},
            getRuntimePrompts() {
                return { compressRange: "", compressMessage: "" }
            },
        },
    }
}

/**
 * Force `state.toolParameters.get(id)` to throw on EVERY call. The strategies
 * iterate `state.toolIdList` and call `toolParameters.get(id)` for each id;
 * this hook makes both deduplicate AND purgeErrors throw on their first
 * internal call.
 *
 * The override is installed on the Map instance (not the prototype) so the
 * other Map methods (`.set`, `.has`, etc.) continue to work for our test
 * setup.
 */
function forceToolParametersGetThrow(state: SessionState): void {
    const realMap = state.toolParameters
    ;(realMap as any).get = () => {
        throw new Error("forced strategy throw")
    }
}

/**
 * Force `state.toolParameters.get(id)` to throw starting at the Nth+1 call
 * (calls 1..N return metadata, calls N+1+ throw).
 *
 * Trace with one id in `state.toolIdList`:
 *   - deduplicate runs first; with 1 id and no duplicate signature, it
 *     calls `.get` once. No second-loop calls because no duplicates found.
 *   - purgeErrors runs second and calls `.get` once.
 *   - call 1 → deduplicate
 *   - call 2 → purgeErrors
 *
 * So `throwAfterCall(1)` makes purgeErrors the throwing strategy while
 * leaving deduplicate intact. This proves the per-strategy wrap is
 * independent (one throwing does not skip the other).
 */
function throwAfterCall(state: SessionState, n: number): void {
    const realMap = state.toolParameters
    let callCount = 0
    ;(realMap as any).get = (id: string) => {
        callCount++
        if (callCount > n) {
            throw new Error(`forced strategy throw on call ${callCount}`)
        }
        return {
            tool: "test-tool",
            parameters: { x: 1 },
            turn: 1,
            tokenCount: 10,
        }
    }
}

/**
 * Force `state.toolParameters.get(id)` to throw ONLY on the Nth call. All
 * other calls return metadata. Use this to make deduplicate (which runs
 * first and reads metadata once per id) throw on its very first call,
 * while purgeErrors (which runs second) still gets metadata and can run
 * its body to a verifiable side effect.
 */
function throwOnCallOnly(state: SessionState, n: number): void {
    const realMap = state.toolParameters
    let callCount = 0
    ;(realMap as any).get = (id: string) => {
        callCount++
        if (callCount === n) {
            throw new Error(`forced strategy throw on call ${callCount}`)
        }
        return {
            tool: "err-tool",
            parameters: { x: 1 },
            turn: 0,
            status: "error",
            tokenCount: 10,
        }
    }
}

// Silence unused-import warnings on PreparedSession used only as a type.
void ({} as PreparedSession)

// ────────────────────────────────────────────────────────────────────────────
// BUG-009 — strategy throw isolation in prepareSession
// ────────────────────────────────────────────────────────────────────────────

test("BUG-009: prepareSession does not throw when deduplicate throws internally", async () => {
    const sessionID = `ses_robustness_dedupe_${Date.now()}`
    const state = createSessionState()
    // Pre-set sessionId so ensureSessionInitialized early-returns without
    // touching disk or resetting toolParameters.
    state.sessionId = sessionID
    state.isSubAgent = false
    // Skip the manualMode block in prepareSession.
    state.manualMode = "compress-pending"

    // Seed a tool id so deduplicate actually enters its loop instead of
    // early-returning on the empty toolIdList guard.
    state.toolIdList = ["id1"]
    state.toolParameters.set("id1", {
        tool: "test-tool",
        parameters: { x: 1 },
        turn: 1,
        tokenCount: 10,
    })
    forceToolParametersGetThrow(state)

    const ctx = buildToolContext(state)
    const toolCtx = {
        ask: async () => {},
        metadata: () => {},
        sessionID,
    }

    // After fix: prepareSession catches the throw inside deduplicate and
    // returns successfully.
    // Current: the throw propagates out of prepareSession → assert.doesNotReject
    // fails. This is exactly the bug BUG-009 names.
    await assert.doesNotReject(prepareSession(ctx, toolCtx, "robustness test"))
})

test("BUG-009: prepareSession does not throw when purgeErrors throws internally", async () => {
    const sessionID = `ses_robustness_purge_${Date.now()}`
    const state = createSessionState()
    state.sessionId = sessionID
    state.isSubAgent = false
    state.manualMode = "compress-pending"

    state.toolIdList = ["id1"]
    state.toolParameters.set("id1", {
        tool: "test-tool",
        parameters: { x: 1 },
        turn: 1,
        tokenCount: 10,
    })
    // Throw on the SECOND call: deduplicate runs first and reads metadata
    // successfully, then purgeErrors reads and throws.
    throwAfterCall(state, 1)

    const ctx = buildToolContext(state)
    const toolCtx = {
        ask: async () => {},
        metadata: () => {},
        sessionID,
    }

    await assert.doesNotReject(prepareSession(ctx, toolCtx, "robustness test"))
})

test("BUG-009: prepareSession continues running purgeErrors after deduplicate throws", async () => {
    // Per-strategy wrap means deduplicate's throw is caught and purgeErrors
    // still runs. We verify purgeErrors ran by seeding a tool with error
    // status and an old turn so its threshold check passes — purgeErrors
    // marks it for pruning in `state.prune.tools`.
    //
    // throwOnCallOnly(state, 1) throws on the very first .get call only.
    // deduplicate (running first, processing the only id) calls .get once
    // → throws. purgeErrors (running second) calls .get once → returns
    // metadata with status="error", turn=0; combined with currentTurn=10
    // this passes the turnAge >= turnThreshold gate and marks id1.
    const sessionID = `ses_robustness_continues_${Date.now()}`
    const state = createSessionState()
    state.sessionId = sessionID
    state.isSubAgent = false
    state.manualMode = "compress-pending"
    // currentTurn > 0 so turnAge = currentTurn - metadata.turn is positive
    // and exceeds the purgeErrors turnThreshold (Math.max(1, 4) = 4).
    state.currentTurn = 10

    state.toolIdList = ["id1"]
    // The seeded entry is overridden by the throwOnCallOnly hook, but we
    // still set it so state is internally consistent before the override
    // is installed.
    state.toolParameters.set("id1", {
        tool: "err-tool",
        parameters: { x: 1 },
        turn: 0,
        status: "error",
        tokenCount: 10,
    })
    throwOnCallOnly(state, 1)

    const ctx = buildToolContext(state)
    const toolCtx = {
        ask: async () => {},
        metadata: () => {},
        sessionID,
    }

    await prepareSession(ctx, toolCtx, "robustness test")

    // After fix: dedupe threw → caught → purgeErrors ran → marked id1.
    // Current: prepareSession threw at dedupe's call 1 → never reached
    // this assertion line.
    assert.ok(
        state.prune.tools.has("id1"),
        "purgeErrors must still mark its tools after deduplicate throws",
    )
})

test("BUG-009: prepareSession continues running deduplicate after purgeErrors throws", async () => {
    // Inverse of the previous test: purgeErrors throws, deduplicate ran
    // earlier and is unaffected. We seed two duplicate ids so deduplicate
    // marks id1 for pruning; then we throw starting at call 4 (after
    // deduplicate's three internal `.get` calls — main loop twice, marking
    // loop once) so deduplicate's marking completes before the throw.
    // purgeErrors' first call is call 4 and throws, caught by the wrap.
    const sessionID = `ses_robustness_dedupe_first_${Date.now()}`
    const state = createSessionState()
    state.sessionId = sessionID
    state.isSubAgent = false
    state.manualMode = "compress-pending"

    // Two ids with the same tool + parameters → duplicate signature.
    // deduplicate will mark the older (id1) for pruning.
    state.toolIdList = ["id1", "id2"]
    state.toolParameters.set("id1", {
        tool: "dup-tool",
        parameters: { x: 1 },
        turn: 1,
        tokenCount: 10,
    })
    state.toolParameters.set("id2", {
        tool: "dup-tool",
        parameters: { x: 1 },
        turn: 2,
        tokenCount: 10,
    })
    // Calls 1..3 return metadata (drain dedupe's three .get calls);
    // calls 4+ throw (the first .get inside purgeErrors).
    const realMap = state.toolParameters
    let callCount = 0
    ;(realMap as any).get = (id: string) => {
        callCount++
        if (callCount >= 4) {
            throw new Error(`forced strategy throw on call ${callCount}`)
        }
        return {
            tool: "dup-tool",
            parameters: { x: 1 },
            turn: 1,
            tokenCount: 10,
        }
    }

    const ctx = buildToolContext(state)
    const toolCtx = {
        ask: async () => {},
        metadata: () => {},
        sessionID,
    }

    await prepareSession(ctx, toolCtx, "robustness test")

    // After fix: deduplicate ran fully → id1 marked. purgeErrors then
    // threw on its first call → caught by wrap → prepareSession returns.
    // Current: prepareSession threw on purgeErrors' call → never reached
    // this assertion.
    assert.ok(
        state.prune.tools.has("id1"),
        "deduplicate's prune marks must persist when purgeErrors throws afterwards",
    )
})

test("BUG-009: prepareSession returns the prepared session object after a strategy throw", async () => {
    // Contract: prepareSession's return value is the input to the compress
    // tool body. If a strategy throws and is caught, the body must still
    // receive a valid PreparedSession — not undefined, not a half-built
    // object.
    const sessionID = `ses_robustness_returns_${Date.now()}`
    const state = createSessionState()
    state.sessionId = sessionID
    state.isSubAgent = false
    state.manualMode = "compress-pending"

    state.toolIdList = ["id1"]
    state.toolParameters.set("id1", {
        tool: "test-tool",
        parameters: { x: 1 },
        turn: 1,
        tokenCount: 10,
    })
    forceToolParametersGetThrow(state)

    const ctx = buildToolContext(state)
    const toolCtx = {
        ask: async () => {},
        metadata: () => {},
        sessionID,
    }

    const result = await prepareSession(ctx, toolCtx, "robustness test")

    assert.ok(result, "prepareSession must return a truthy result after a strategy throw")
    assert.ok(Array.isArray(result.rawMessages), "rawMessages must be an array")
    assert.ok(result.searchContext, "searchContext must be present")
})

test("BUG-009: prepareSession does not throw when every strategy call throws", async () => {
    // Defensive contract: the wrap is robust to a strategy that throws on
    // every call. We throw on ALL calls — both deduplicate AND purgeErrors
    // will throw, exercising both arms of the wrap.
    const sessionID = `ses_robustness_all_${Date.now()}`
    const state = createSessionState()
    state.sessionId = sessionID
    state.isSubAgent = false
    state.manualMode = "compress-pending"

    state.toolIdList = ["id1"]
    state.toolParameters.set("id1", {
        tool: "test-tool",
        parameters: { x: 1 },
        turn: 1,
        tokenCount: 10,
    })
    forceToolParametersGetThrow(state)

    const ctx = buildToolContext(state)
    const toolCtx = {
        ask: async () => {},
        metadata: () => {},
        sessionID,
    }

    await assert.doesNotReject(prepareSession(ctx, toolCtx, "robustness test"))
})

// Logic Verified: prepareSession is robust to throws from deduplicate and
// purgeErrors; both strategies are independently wrapped so one throwing
// does not skip the other; the PreparedSession contract is preserved.
// Bugs Documented: BUG-009 (no try/catch around strategy calls in pipeline.ts).
// Fakes Updated: none.
// Review Status: pending implementer round.
// Logic Verified: prepareSession continues running every strategy even when an earlier strategy throws, and returns the PreparedSession object.
// Bugs Documented: BUG-009.
// Fakes Updated: none
// Review Status: pending independent review.
