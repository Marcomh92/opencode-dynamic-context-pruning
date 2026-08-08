import assert from "node:assert/strict"
import test from "node:test"
import { createSessionState, type WithParts } from "../lib/state"
import { buildToolIdList } from "../lib/messages/utils"
import { deduplicate } from "../lib/strategies/deduplication"
import { purgeErrors } from "../lib/strategies/purge-errors"
import { Logger } from "../lib/logger"
import { isToolNameProtected } from "../lib/protected-patterns"

// BUG-045 — strategies in the compress pipeline use possibly stale
//           state.toolIdList. Both deduplicate and purgeErrors early-return
//           when state.toolIdList.length === 0 (lib/strategies/dedup:30-33,
//           lib/strategies/purge-errors:33-36). In the chat-transform hook
//           buildToolIdList is called immediately before prune, so the list
//           is fresh. In the compress pipeline it is NOT, so the strategies
//           may operate on a list that's minutes stale.
//
// BUG-048 — buildToolIdList returns raw IDs without honoring protected
//           tools. Consumers re-filter, so end behaviour is correct, but
//           state.toolIdList does not represent "prunable tool IDs". The fix
//           is to filter at the source.
//
// Both bugs converge on the same code path: the strategy's view of "what
// tools are eligible" must reflect the freshly fetched rawMessages AND
// respect protectedTools, regardless of when buildToolIdList was last
// called. The fix path is one of:
//   (a) strategies rebuild their view from rawMessages (refresh on read), or
//   (b) the caller (pipeline / hooks) refreshes before invoking them.
// Either path satisfies the assertions below.

const SESSION = "ses_tool_id_list_protected"

function userMsg(id: string, created: number): WithParts {
    return {
        info: {
            id,
            role: "user",
            sessionID: SESSION,
            agent: "assistant",
            model: { providerID: "anthropic", modelID: "test" },
            time: { created },
        } as any,
        parts: [{ type: "text", text: "u" } as any],
    }
}

function assistantToolMsg(
    id: string,
    callID: string,
    tool: string,
    parameters: Record<string, unknown>,
    created: number,
): WithParts {
    return {
        info: {
            id,
            role: "assistant",
            sessionID: SESSION,
            agent: "assistant",
            time: { created },
        } as any,
        parts: [
            {
                id: `prt-${id}`,
                messageID: id,
                sessionID: SESSION,
                type: "tool",
                tool,
                callID,
                state: { status: "completed", input: parameters, output: "ok" },
            } as any,
        ],
    }
}

function buildConfig(protectedTools: string[] = []) {
    return {
        enabled: true,
        debug: false,
        pruneNotification: "off",
        pruneNotificationType: "chat",
        commands: { enabled: true, protectedTools: [] },
        manualMode: { enabled: false, automaticStrategies: true },
        turnProtection: { enabled: false, turns: 4 },
        experimental: { allowSubAgents: false, customPrompts: false },
        protectedFilePatterns: [],
        compress: {
            mode: "range",
            permission: "allow",
            showCompression: false,
            maxContextLimit: 150000,
            minContextLimit: 50000,
            nudgeFrequency: 5,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            protectedTools,
            protectTags: false,
            protectUserMessages: false,
        },
        strategies: {
            deduplication: { enabled: true, protectedTools },
            purgeErrors: { enabled: true, turns: 1, protectedTools },
        },
    } as any
}

const logger = new Logger(false)

// ---- BUG-045: stale state.toolIdList must not silence strategies ----

test("BUG-045 #stale-empty-toolIdList does not silence deduplicate when fresh messages carry duplicates", () => {
    const state = createSessionState()
    state.toolIdList = [] // STALE: empty (current code early-returns)

    const rawMessages: WithParts[] = [
        userMsg("u1", 1),
        assistantToolMsg("a1", "call-dup-1", "bash", { cmd: "ls" }, 2),
        userMsg("u2", 3),
        assistantToolMsg("a2", "call-dup-2", "bash", { cmd: "ls" }, 4),
    ]

    // Both duplicates registered in toolParameters with identical signatures.
    state.toolParameters.set("call-dup-1", { tool: "bash", parameters: { cmd: "ls" }, turn: 1 })
    state.toolParameters.set("call-dup-2", { tool: "bash", parameters: { cmd: "ls" }, turn: 2 })

    deduplicate(state, logger, buildConfig(), rawMessages)

    // In current code: toolIdList is empty, early-return at line 31 — nothing
    // is marked. After fix: the strategy's view comes from rawMessages and
    // the older duplicate (call-dup-1) is marked for pruning.
    assert.ok(
        state.prune.tools.has("call-dup-1"),
        "duplicate call-dup-1 must be marked for pruning even when state.toolIdList is stale/empty",
    )
})

test("BUG-045 #stale-empty-toolIdList does not silence purgeErrors when fresh messages carry errored tools", () => {
    const state = createSessionState()
    state.toolIdList = [] // STALE: empty
    state.currentTurn = 5

    const rawMessages: WithParts[] = [
        userMsg("u1", 1),
        assistantToolMsg("a1", "call-err-1", "bash", { cmd: "false" }, 2),
    ]
    // Mark this tool as errored and old enough to be eligible for purging.
    state.toolParameters.set("call-err-1", {
        tool: "bash",
        parameters: { cmd: "false" },
        turn: 1,
        status: "error",
    })

    purgeErrors(state, logger, buildConfig(), rawMessages)

    assert.ok(
        state.prune.tools.has("call-err-1"),
        "errored tool must be marked for pruning even when state.toolIdList is stale/empty",
    )
})

test("BUG-045 #stale-stale-toolIdList is replaced with the fresh tool view", () => {
    // Stronger form: state.toolIdList contains OLD tool IDs from a previous
    // chat-transform fire. The current messages carry NEW tool IDs that do
    // NOT overlap. In the current code the strategies operate on the OLD
    // list and ignore the new messages entirely.
    const state = createSessionState()
    state.toolIdList = ["call-stale-A", "call-stale-B", "call-stale-C"]

    const rawMessages: WithParts[] = [
        userMsg("u1", 1),
        assistantToolMsg("a1", "call-dup-1", "bash", { cmd: "ls" }, 2),
        userMsg("u2", 3),
        assistantToolMsg("a2", "call-dup-2", "bash", { cmd: "ls" }, 4),
    ]
    state.toolParameters.set("call-dup-1", { tool: "bash", parameters: { cmd: "ls" }, turn: 1 })
    state.toolParameters.set("call-dup-2", { tool: "bash", parameters: { cmd: "ls" }, turn: 2 })

    deduplicate(state, logger, buildConfig(), rawMessages)

    // The fresh duplicates must be marked. State.toolIdList still has the
    // stale entries — that's fine; what matters is the strategy observed the
    // fresh tools in rawMessages.
    assert.ok(
        state.prune.tools.has("call-dup-1"),
        "stale state.toolIdList must not block marking the fresh duplicate",
    )
})

// ---- BUG-048: buildToolIdList must filter protected tools at the source ----

test("BUG-048 #protected-tools are excluded from buildToolIdList returned list", () => {
    // Contract: when a tool name is listed in config.compress.protectedTools,
    // its callIDs must NOT appear in the array returned by buildToolIdList.
    // Current code returns the raw list; the fix filters at the source so
    // downstream consumers (and any reader of state.toolIdList) see only
    // prunable IDs.
    const state = createSessionState()
    const config = buildConfig(["bash"])

    const rawMessages: WithParts[] = [
        assistantToolMsg("a1", "call-bash-1", "bash", { cmd: "ls" }, 1),
        assistantToolMsg("a2", "call-read-1", "read", { filePath: "/etc/hosts" }, 2),
        assistantToolMsg("a3", "call-bash-2", "bash", { cmd: "cat" }, 3),
    ]

    // The fix extends the signature to accept config (or an equivalent
    // protected-tool list). Cast to `any` so this test compiles against the
    // current 2-arg signature; the implementer will widen it.
    const toolIds = (buildToolIdList as any)(state, rawMessages, config) as string[]

    assert.ok(
        !toolIds.includes("call-bash-1"),
        "protected 'bash' tool must be excluded from buildToolIdList output",
    )
    assert.ok(
        !toolIds.includes("call-bash-2"),
        "protected 'bash' tool must be excluded from buildToolIdList output",
    )
    assert.ok(
        toolIds.includes("call-read-1"),
        "non-protected 'read' tool must remain in buildToolIdList output",
    )
    // state.toolIdList must reflect the filtered view, not the raw view.
    assert.ok(
        !state.toolIdList.includes("call-bash-1"),
        "state.toolIdList must not include protected tools",
    )
    assert.ok(
        state.toolIdList.includes("call-read-1"),
        "state.toolIdList must include non-protected tools",
    )
})

test("BUG-048 #glob-protectedTools filter tool names matching the pattern", () => {
    // Glob patterns are honored by isToolNameProtected (lib/protected-patterns:110).
    // The fix's filter at the source must consult the same helper so callers
    // can protect families of tools with a single pattern.
    const state = createSessionState()
    const config = buildConfig(["bash-*"]) // would match hypothetical `bash-run`, `bash-edit` family

    const rawMessages: WithParts[] = [
        assistantToolMsg("a1", "call-bash-run-1", "bash-run", { cmd: "ls" }, 1),
        assistantToolMsg("a2", "call-read-1", "read", { filePath: "/x" }, 2),
    ]

    // Sanity: the helper does match the family.
    assert.ok(isToolNameProtected("bash-run", ["bash-*"]))

    const toolIds = (buildToolIdList as any)(state, rawMessages, config) as string[]

    assert.ok(!toolIds.includes("call-bash-run-1"), "glob-protected family must be filtered")
    assert.ok(toolIds.includes("call-read-1"), "non-matching tool remains")
})

// Logic Verified: strategies process fresh rawMessages regardless of how
//                  stale state.toolIdList is, and buildToolIdList returns a
//                  list that already excludes protected tools.
// Bugs Documented: BUG-045-strategy-stale-toolidlist.md
//                  BUG-048-tool-idlist-no-protection.md
// Fakes Updated:  none (uses production buildToolIdList / deduplicate /
//                  purgeErrors directly with hand-built state and config).
// Review Status:  pending independent review.
// Logic Verified: stale empty/stale toolIdList does not silence deduplicate or purgeErrors on fresh messages, and protectedTools (literal and glob) are excluded from buildToolIdList.
// Bugs Documented: BUG-045, BUG-048.
// Fakes Updated: none (uses production buildToolIdList / deduplicate / purgeErrors directly with hand-built state and config).
// Review Status: pending independent review.
