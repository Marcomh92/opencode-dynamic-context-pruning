import assert from "node:assert/strict"
import test from "node:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdirSync } from "node:fs"
import { createCompressRangeTool } from "../lib/compress/range"
import { createSessionState, type WithParts } from "../lib/state"
import type { PluginConfig } from "../lib/config"
import { Logger } from "../lib/logger"

const testDataHome = join(tmpdir(), `opencode-dcp-tests-${process.pid}`)
const testConfigHome = join(tmpdir(), `opencode-dcp-config-tests-${process.pid}`)

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
        commands: {
            enabled: true,
            protectedTools: [],
        },
        manualMode: {
            enabled: false,
            automaticStrategies: true,
        },
        turnProtection: {
            enabled: false,
            turns: 4,
        },
        experimental: {
            allowSubAgents: true,
            customPrompts: false,
        },
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
            deduplication: {
                enabled: true,
                protectedTools: [],
            },
            purgeErrors: {
                enabled: true,
                turns: 4,
                protectedTools: [],
            },
        },
    }
}

function textPart(messageID: string, sessionID: string, id: string, text: string) {
    return {
        id,
        messageID,
        sessionID,
        type: "text" as const,
        text,
    }
}

function buildMessages(sessionID: string): WithParts[] {
    return [
        {
            info: {
                id: "msg-subagent-prompt",
                role: "user",
                sessionID,
                agent: "codebase-analyzer",
                model: {
                    providerID: "anthropic",
                    modelID: "claude-test",
                },
                time: { created: 1 },
            } as WithParts["info"],
            parts: [textPart("msg-subagent-prompt", sessionID, "part-1", "Investigate the issue")],
        },
        {
            info: {
                id: "msg-assistant-1",
                role: "assistant",
                sessionID,
                agent: "codebase-analyzer",
                time: { created: 2 },
            } as WithParts["info"],
            parts: [
                textPart("msg-assistant-1", sessionID, "part-2", "I found the relevant code path"),
            ],
        },
        {
            info: {
                id: "msg-user-2",
                role: "user",
                sessionID,
                agent: "codebase-analyzer",
                model: {
                    providerID: "anthropic",
                    modelID: "claude-test",
                },
                time: { created: 3 },
            } as WithParts["info"],
            parts: [
                textPart("msg-user-2", sessionID, "part-3", "Please compress the initial findings"),
            ],
        },
    ]
}

function mkUser(sessionID: string, id: string, text: string, created: number): WithParts {
    return {
        info: {
            id,
            role: "user",
            sessionID,
            agent: "assistant",
            model: { providerID: "anthropic", modelID: "claude-test" },
            time: { created },
        } as WithParts["info"],
        parts: [textPart(id, sessionID, `${id}-p`, text)],
    }
}

function mkAssistant(sessionID: string, id: string, text: string, created: number): WithParts {
    return {
        info: {
            id,
            role: "assistant",
            sessionID,
            agent: "assistant",
            time: { created },
        } as WithParts["info"],
        parts: [textPart(id, sessionID, `${id}-p`, text)],
    }
}

test("compress range rebuilds subagent message refs after session state was reset", async () => {
    const sessionID = `ses_subagent_compress_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const state = createSessionState()
    state.sessionId = "ses_other"
    state.messageIds.byRawId.set("other-message", "m0001")
    state.messageIds.byRef.set("m0001", "other-message")
    state.messageIds.nextRef = 2

    const logger = new Logger(false)
    const tool = createCompressRangeTool({
        client: {
            session: {
                messages: async () => ({ data: rawMessages }),
                get: async () => ({ data: { parentID: "ses_parent" } }),
            },
        },
        state,
        logger,
        config: buildConfig(),
        prompts: {
            reload() {},
            getRuntimePrompts() {
                return { compressRange: "", compressMessage: "" }
            },
        },
    } as any)

    const result = await tool.execute(
        {
            topic: "Subagent race fix",
            content: [
                {
                    startId: "m0001",
                    endId: "m0002",
                    summary: "Captured the initial investigation and follow-up request.",
                },
            ],
        },
        {
            ask: async () => {},
            metadata: () => {},
            sessionID,
            messageID: "msg-compress",
        },
    )

    assert.equal(result, "Compressed 2 messages into [Compressed conversation section].")
    assert.equal(state.sessionId, sessionID)
    assert.equal(state.isSubAgent, true)
    assert.equal(state.messageIds.byRef.get("m0001"), "msg-assistant-1")
    assert.equal(state.messageIds.byRef.get("m0002"), "msg-user-2")
    assert.equal(state.prune.messages.blocksById.size, 1)
})

test("compress range mode appends protected prompt info", async () => {
    const sessionID = `ses_range_protect_tag_${Date.now()}`
    const rawMessages: WithParts[] = [
        {
            info: {
                id: "msg-user-1",
                role: "user",
                sessionID,
                agent: "assistant",
                model: {
                    providerID: "anthropic",
                    modelID: "claude-test",
                },
                time: { created: 1 },
            } as WithParts["info"],
            parts: [
                textPart(
                    "msg-user-1",
                    sessionID,
                    "part-user-1",
                    "Investigate the release. <protect>Keep the npm publish token note.</protect>",
                ),
            ],
        },
        {
            info: {
                id: "msg-assistant-1",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 2 },
            } as WithParts["info"],
            parts: [textPart("msg-assistant-1", sessionID, "part-assistant-1", "I checked it")],
        },
    ]

    const state = createSessionState()
    const logger = new Logger(false)
    const config = buildConfig()
    config.compress.protectTags = true
    const tool = createCompressRangeTool({
        client: {
            session: {
                messages: async () => ({ data: rawMessages }),
                get: async () => ({ data: { parentID: null } }),
            },
        },
        state,
        logger,
        config,
        prompts: {
            reload() {},
            getRuntimePrompts() {
                return { compressRange: "", compressMessage: "" }
            },
        },
    } as any)

    await tool.execute(
        {
            topic: "Protected range",
            content: [
                {
                    startId: "m0001",
                    endId: "m0002",
                    summary: "Captured release investigation.",
                },
            ],
        },
        {
            ask: async () => {},
            metadata: () => {},
            sessionID,
            messageID: "msg-compress-range-protect-tag",
        },
    )

    const block = Array.from(state.prune.messages.blocksById.values())[0]
    assert.match(
        block?.summary || "",
        /The following protected prompt information was included in this conversation verbatim:/,
    )
    assert.match(block?.summary || "", /Keep the npm publish token note\./)
})

test("compress range mode batches multiple ranges into one notification", async () => {
    const sessionID = `ses_range_compress_batch_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const state = createSessionState()
    const logger = new Logger(false)
    const config = buildConfig()
    config.pruneNotification = "detailed"
    config.pruneNotificationType = "toast"

    const toastCalls: string[] = []
    const tool = createCompressRangeTool({
        client: {
            session: {
                messages: async () => ({ data: rawMessages }),
                get: async () => ({ data: { parentID: "ses_parent" } }),
            },
            tui: {
                showToast: async ({ body }: { body: { message: string } }) => {
                    toastCalls.push(body.message)
                },
            },
        },
        state,
        logger,
        config,
        prompts: {
            reload() {},
            getRuntimePrompts() {
                return { compressRange: "", compressMessage: "" }
            },
        },
    } as any)

    const result = await tool.execute(
        {
            topic: "Batch stale notes",
            content: [
                {
                    startId: "m0001",
                    endId: "m0001",
                    summary: "Captured the initial assistant investigation.",
                },
                {
                    startId: "m0002",
                    endId: "m0002",
                    summary: "Captured the follow-up user request.",
                },
            ],
        },
        {
            ask: async () => {},
            metadata: () => {},
            sessionID,
            messageID: "msg-compress-range-batch",
        },
    )

    assert.equal(result, "Compressed 2 messages into [Compressed conversation section].")
    assert.equal(state.prune.messages.blocksById.size, 2)
    assert.equal(toastCalls.length, 1)
    assert.match(toastCalls[0] || "", /▣ DCP \| -[^,\n]+ removed, \+[^\s\n]+ summary/)
    assert.match(toastCalls[0] || "", /Compression #1/)
    assert.match(toastCalls[0] || "", /▣ Compression #1 -[^,\n]+ removed, \+[^\s\n]+ summary/)
    assert.match(toastCalls[0] || "", /Topic: Batch stale notes/)
    assert.match(toastCalls[0] || "", /Items: 2 messages/)
})

test("compress range mode rejects overlapping batched ranges", async () => {
    const sessionID = `ses_range_compress_overlap_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const state = createSessionState()
    const logger = new Logger(false)
    const tool = createCompressRangeTool({
        client: {
            session: {
                messages: async () => ({ data: rawMessages }),
                get: async () => ({ data: { parentID: "ses_parent" } }),
            },
        },
        state,
        logger,
        config: buildConfig(),
        prompts: {
            reload() {},
            getRuntimePrompts() {
                return { compressRange: "", compressMessage: "" }
            },
        },
    } as any)

    await assert.rejects(
        tool.execute(
            {
                topic: "Overlapping ranges",
                content: [
                    {
                        startId: "m0001",
                        endId: "m0002",
                        summary: "Captured the initial investigation and follow-up request.",
                    },
                    {
                        startId: "m0002",
                        endId: "m0002",
                        summary: "Captured the follow-up request again.",
                    },
                ],
            },
            {
                ask: async () => {},
                metadata: () => {},
                sessionID,
                messageID: "msg-compress-range-overlap",
            },
        ),
        /Overlapping ranges cannot be compressed in the same batch/,
    )

    assert.equal(state.prune.messages.blocksById.size, 0)
})
// End-to-end coverage of compress.protectUserMessagesCount through
// createCompressRangeTool. The unit-level count behavior is pinned in
// tests/protected-user-messages-count.test.ts; this test covers the
// wiring from compress.protectUserMessagesCount through to
// appendProtectedUserMessages (range.ts:134-146), the gap flagged by
// the BUG-096 second reviewer.
test("compress range mode respects protectUserMessagesCount", async () => {
    // 5 user + 3 assistant messages interleaved so the selection-order
    // walk in appendProtectedUserMessages has to skip non-user roles.
    // With agent="assistant" on every message, injectMessageIds assigns
    // sequential m0001..m0008 in array order.
    const sessionID = `ses_range_protect_user_count_${Date.now()}`
    const rawMessages: WithParts[] = [
        mkUser(sessionID, "msg-user-1", "U1: first real user message", 1),
        mkAssistant(sessionID, "msg-assistant-1", "A1: first assistant reply", 2),
        mkUser(sessionID, "msg-user-2", "U2: second real user message", 3),
        mkAssistant(sessionID, "msg-assistant-2", "A2: second assistant reply", 4),
        mkUser(sessionID, "msg-user-3", "U3: third real user message", 5),
        mkAssistant(sessionID, "msg-assistant-3", "A3: third assistant reply", 6),
        mkUser(sessionID, "msg-user-4", "U4: fourth real user message", 7),
        mkUser(sessionID, "msg-user-5", "U5: fifth real user message", 8),
    ]

    // ── protectUserMessagesCount = 2 ──────────────────────────────────
    // Selection covers all 8 messages; expected to keep ONLY u-4 and u-5.
    const state2 = createSessionState()
    const config2 = buildConfig()
    config2.compress.protectUserMessages = true
    config2.compress.protectUserMessagesCount = 2

    const tool2 = createCompressRangeTool({
        client: {
            session: {
                messages: async () => ({ data: rawMessages }),
                get: async () => ({ data: { parentID: null } }),
            },
        },
        state: state2,
        logger: new Logger(false),
        config: config2,
        prompts: {
            reload() {},
            getRuntimePrompts() {
                return { compressRange: "", compressMessage: "" }
            },
        },
    } as any)

    await tool2.execute(
        {
            topic: "Last-N protected user messages (count=2)",
            content: [
                {
                    startId: "m0001",
                    endId: "m0008",
                    summary: "Captured interleaved user and assistant messages.",
                },
            ],
        },
        {
            ask: async () => {},
            metadata: () => {},
            sessionID,
            messageID: "msg-compress-range-protect-user-count-2",
        },
    )

    const block2 = Array.from(state2.prune.messages.blocksById.values())[0] as any
    const summary2: string = block2?.summary || ""

    assert.match(
        summary2,
        /The following user messages were sent in this conversation verbatim:/,
        "the protected-section heading is present under protectUserMessagesCount=2",
    )
    assert.ok(
        summary2.includes("U4: fourth real user message"),
        "the 4th user message is included under protectUserMessagesCount=2 (last 2 = u-4, u-5)",
    )
    assert.ok(
        summary2.includes("U5: fifth real user message"),
        "the 5th (last) user message is included under protectUserMessagesCount=2",
    )
    assert.doesNotMatch(
        summary2,
        /\nU1: first real user message\n/,
        "the 1st user message is excluded under protectUserMessagesCount=2",
    )
    assert.doesNotMatch(
        summary2,
        /\nU2: second real user message\n/,
        "the 2nd user message is excluded under protectUserMessagesCount=2",
    )
    assert.doesNotMatch(
        summary2,
        /\nU3: third real user message\n/,
        "the 3rd user message is excluded under protectUserMessagesCount=2",
    )
    for (const aText of [
        "A1: first assistant reply",
        "A2: second assistant reply",
        "A3: third assistant reply",
    ]) {
        assert.doesNotMatch(
            summary2,
            new RegExp(`\\n${aText}\\n`),
            `assistant message text "${aText}" must not appear in the protected section`,
        )
    }

    // ── protectUserMessagesCount = 1 ──────────────────────────────────
    // Most common case: only the most recent user message is appended.
    const state1 = createSessionState()
    const config1 = buildConfig()
    config1.compress.protectUserMessages = true
    config1.compress.protectUserMessagesCount = 1

    const tool1 = createCompressRangeTool({
        client: {
            session: {
                messages: async () => ({ data: rawMessages }),
                get: async () => ({ data: { parentID: null } }),
            },
        },
        state: state1,
        logger: new Logger(false),
        config: config1,
        prompts: {
            reload() {},
            getRuntimePrompts() {
                return { compressRange: "", compressMessage: "" }
            },
        },
    } as any)

    await tool1.execute(
        {
            topic: "Last-N protected user messages (count=1)",
            content: [
                {
                    startId: "m0001",
                    endId: "m0008",
                    summary: "Captured interleaved user and assistant messages.",
                },
            ],
        },
        {
            ask: async () => {},
            metadata: () => {},
            sessionID: `${sessionID}_count1`,
            messageID: "msg-compress-range-protect-user-count-1",
        },
    )

    const block1 = Array.from(state1.prune.messages.blocksById.values())[0] as any
    const summary1: string = block1?.summary || ""

    assert.ok(
        summary1.includes("U5: fifth real user message"),
        "only the last user message is included under protectUserMessagesCount=1",
    )
    for (const text of [
        "U1: first real user message",
        "U2: second real user message",
        "U3: third real user message",
        "U4: fourth real user message",
    ]) {
        assert.doesNotMatch(
            summary1,
            new RegExp(`\\n${text}\\n`),
            `"${text}" is excluded under protectUserMessagesCount=1`,
        )
    }
})
// Logic Verified: range mode rebuilds subagent message refs after session reset, appends protected prompt info, batches multiple ranges, rejects overlapping ranges, and respects protectUserMessagesCount end-to-end through createCompressRangeTool.
// Bugs Documented: none.
// Fakes Updated: none
// Review Status: pending independent review.
