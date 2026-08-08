// BUG-011 — `state.prune.tools` blockmark asymmetry for question/edit/write tools.
//
// The bug:
//   * Compress blocks add every effectiveToolId into `state.prune.tools`
//     (lib/compress/state.ts:267-273 and lib/commands/sweep.ts:226-228).
//   * `pruneToolOutputs` (lib/messages/prune.ts:90-92) explicitly `continue`s
//     on `question` / `edit` / `write`, so those tool outputs are never
//     replaced. Token-count is added to `stats.totalPruneTokens`, but no
//     actual replacement happens. State is therefore inconsistent with
//     runtime behaviour.
//
// The FIX (one of two acceptable resolutions — see bug report):
//   Option A: prune() actually replaces question/edit/write outputs.
//   Option B: the writer filters `question` / `edit` / `write` IDs out of
//             `state.prune.tools` so `.has(callID)` returns false.
//
// This test exercises BOTH outcomes with an OR-style assertion. It passes
// when either fix is in place; it fails in the current code where neither
// is true.
//
// Reference: known_issues/BUG-011-prune-blockmark-asymmetry.md
// Docs:       docs/features/PRUNING.md (Prune behavior table)

import assert from "node:assert/strict"
import test from "node:test"
import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createCompressRangeTool } from "../lib/compress/range"
import { prune } from "../lib/messages/prune"
import { Logger } from "../lib/logger"
import { createSessionState, type SessionState, type WithParts } from "../lib/state"

// Per-test isolation: redirect XDG_DATA_HOME / XDG_CONFIG_HOME so the
// persistence layer never touches the host filesystem.
const testDataHome = join(tmpdir(), `opencode-dcp-prune-bug011-data-${process.pid}`)
const testConfigHome = join(tmpdir(), `opencode-dcp-prune-bug011-config-${process.pid}`)
process.env.XDG_DATA_HOME = testDataHome
process.env.XDG_CONFIG_HOME = testConfigHome
mkdirSync(testDataHome, { recursive: true })
mkdirSync(testConfigHome, { recursive: true })

function buildConfig() {
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
            protectedTools: [],
            protectTags: false,
            protectUserMessages: false,
        },
        strategies: {
            deduplication: { enabled: true, protectedTools: [] },
            purgeErrors: { enabled: true, turns: 4, protectedTools: [] },
        },
    } as any
}

const PRUNED_PLACEHOLDER =
    "[Output removed to save context - information superseded or no longer needed]"

function toolPartOutput(messagesArr: WithParts[], callID: string): string {
    for (const m of messagesArr) {
        for (const p of m.parts) {
            if ((p as any).callID === callID) {
                return (p as any).state?.output ?? ""
            }
        }
    }
    return ""
}

/**
 * Build a non-compacted live message that carries a tool part of the given
 * name. The message is NOT inside any compressed range, so its output is
 * eligible to be replaced by `prune()`.
 */
function liveToolMessage(
    sessionID: string,
    toolName: string,
    callID: string,
    output: string,
): WithParts[] {
    return [
        {
            info: {
                id: `msg-live-${toolName}`,
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 5 },
            } as any,
            parts: [
                {
                    id: `${callID}-part`,
                    messageID: `msg-live-${toolName}`,
                    sessionID,
                    type: "tool",
                    tool: toolName,
                    callID,
                    state: { status: "completed", input: {}, output },
                } as any,
            ],
        },
    ]
}

/**
 * End-to-end fixture: simulate the post-compress state for a `question`
 * tool call. The compress pipeline places the callID into
 * `state.prune.tools` (current behaviour), then a non-compacted live
 * message carrying the same callID remains visible to the next transform.
 *
 * BUG-011 counter-factual (current behaviour):
 *   * state.prune.tools has `call-question` → true
 *   * prune()'s `pruneToolOutputs` skips `question` (line 90-92)
 *   * Output is NOT replaced → bug
 *
 * BUG-011 fix verification (one of two acceptable outcomes):
 *   * Either prune() now replaces the output (Option A), OR
 *   * the writer drops question/edit/write IDs before they reach
 *     state.prune.tools, so `.has(callID)` is false (Option B).
 */
async function runQuestionFixture(): Promise<{
    state: SessionState
    messages: WithParts[]
}> {
    const sessionID = `ses_bug011_${Date.now()}`
    const callID = "call-question"

    // Seed toolParameters so the compress pipeline can pick up a token count
    // for the sweep-marked tool (matches the existing prune-tools-propagation
    // fixture pattern).
    const state = createSessionState()
    state.sessionId = sessionID
    state.isSubAgent = false
    state.toolParameters.set(callID, {
        tool: "question",
        parameters: {},
        turn: 1,
        tokenCount: 250,
    })

    // Run compress on a session that contains a `question` tool part. This
    // is the natural way the buggy state arises in production: compress
    // sees the tool's callID in the range, adds it to `state.prune.tools`,
    // then later transforms skip the replacement because of the silent
    // early-return at lib/messages/prune.ts:90-92.
    const output = "completed tool output ".repeat(120)
    const rawMessages: WithParts[] = [
        {
            info: {
                id: "msg-user",
                role: "user",
                sessionID,
                agent: "assistant",
                model: { providerID: "anthropic", modelID: "test" },
                time: { created: 1 },
            } as any,
            parts: [
                {
                    id: "user-part",
                    messageID: "msg-user",
                    sessionID,
                    type: "text",
                    text: "ask question",
                } as any,
            ],
        },
        {
            info: {
                id: "msg-q",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 2 },
            } as any,
            parts: [
                {
                    id: "q-part",
                    messageID: "msg-q",
                    sessionID,
                    type: "tool",
                    tool: "question",
                    callID,
                    state: { status: "completed", input: { questions: [] }, output },
                } as any,
            ],
        },
        {
            info: {
                id: "msg-u2",
                role: "user",
                sessionID,
                agent: "assistant",
                model: { providerID: "anthropic", modelID: "test" },
                time: { created: 3 },
            } as any,
            parts: [
                {
                    id: "u2-part",
                    messageID: "msg-u2",
                    sessionID,
                    type: "text",
                    text: "thanks",
                } as any,
            ],
        },
        {
            info: {
                id: "msg-a2",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 4 },
            } as any,
            parts: [
                { id: "a2-part", messageID: "msg-a2", sessionID, type: "text", text: "ok" } as any,
            ],
        },
    ]

    const tool = createCompressRangeTool({
        client: {
            session: {
                messages: async () => ({ data: rawMessages }),
                get: async () => ({ data: { parentID: null } }),
            },
        },
        state,
        logger: new Logger(false),
        config: buildConfig(),
        prompts: {
            reload() {},
            getRuntimePrompts: () => ({ compressRange: "", compressMessage: "" }),
        },
    } as any)

    await tool.execute(
        {
            topic: "BUG-011 fixture",
            content: [
                {
                    startId: "m0001",
                    endId: "m0004",
                    summary: "Compressed range with a question tool call.",
                },
            ],
        },
        {
            ask: async () => {},
            metadata: () => {},
            sessionID,
            messageID: `compress-msg-${Date.now()}`,
        } as any,
    )

    // Now the live, non-compacted message that re-uses the same callID.
    // This is the realistic scenario: the question callID is in prune.tools
    // (because compress block added it), and the live message's tool part is
    // eligible for replacement on the next transform.
    const liveMessages = liveToolMessage(sessionID, "question", callID, output)

    prune(state, new Logger(false), buildConfig(), liveMessages)

    return { state, messages: liveMessages }
}

test("BUG-011: `question` tool output is pruned OR the ID is dropped from state.prune.tools", async () => {
    // KNOWN BUG (BUG-011): state.prune.tools.has(callID) is true for the
    // question tool but prune() never replaces its output. This OR-style
    // assertion passes when either fix is implemented:
    //   * Option A: prune() now replaces question/edit/write outputs.
    //   * Option B: the writer filters those tool names out of state.prune.tools.
    // See: known_issues/BUG-011-prune-blockmark-asymmetry.md
    const { state, messages } = await runQuestionFixture()
    const outputAfter = toolPartOutput(messages, "call-question")

    const outputPruned = outputAfter === PRUNED_PLACEHOLDER
    const idDroppedFromPruneTools = !state.prune.tools.has("call-question")

    assert.ok(
        outputPruned || idDroppedFromPruneTools,
        "BUG-011 fix: either the question tool output is replaced by prune() " +
            "(Option A), or state.prune.tools no longer contains call-question " +
            "(Option B). Current: outputPruned=" +
            outputPruned +
            ", idDropped=" +
            idDroppedFromPruneTools,
    )
})

// Logic Verified: either `question` tool output is pruned OR its ID is dropped from state.prune.tools (no zombie state where both are out of sync).
// Bugs Documented: BUG-011.
// Fakes Updated: none
// Review Status: pending independent review.
