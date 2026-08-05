import assert from "node:assert/strict"
import test from "node:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdirSync } from "node:fs"
import { createCompressRangeTool } from "../lib/compress/range"
import { createCompressMessageTool } from "../lib/compress/message"
import { createSessionState, type SessionState, type WithParts } from "../lib/state"
import type { PluginConfig } from "../lib/config"
import { Logger } from "../lib/logger"

// Per-test isolation: redirect XDG_DATA_HOME / XDG_CONFIG_HOME so the
// persistence layer and the logger never touch the host filesystem.
const testDataHome = join(tmpdir(), `opencode-dcp-validator-tests-${process.pid}`)
const testConfigHome = join(tmpdir(), `opencode-dcp-validator-config-${process.pid}`)

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

/** Build a conversation of N back-and-forth user/assistant messages. Together
 *  with `assignMessageRefs` (called inside prepareSession), this populates
 *  `state.messageIds.byRef` with m0001..mNNNN against the canonical raw IDs.
 *  Tests must align N with the startId/endId range they pass to the tool. */
function buildMessages(sessionID: string, count: number): WithParts[] {
    const out: WithParts[] = []
    for (let i = 1; i <= count; i++) {
        const role = i % 2 === 1 ? "user" : "assistant"
        out.push({
            info: {
                id: `msg-r${i}`,
                role,
                sessionID,
                agent: "assistant",
                ...(role === "user"
                    ? {
                          model: { providerID: "anthropic", modelID: "claude-test" },
                      }
                    : {}),
                time: { created: i },
            } as WithParts["info"],
            parts: [textPart(`msg-r${i}`, sessionID, `part-r${i}`, `message body ${i}`)],
        })
    }
    return out
}

/** Seed state with a prior active block whose endId is the given string.
 *  The validator block in both range.ts and message.ts derives prevAnchorEnd
 *  from this block (most-recent-active blockId), so the seed endId is what
 *  triggers the ≥ / ≤ comparison.
 *
 *  The seeded block is fully populated so tests where validation passes and
 *  the body runs (e.g. "accepts when endId > previous block's endId") don't
 *  hit `undefined.effectiveToolIds is not iterable` in applyCompressionState.
 *  The validator-only path (rejection tests) only needs `endId`. */
function seedPriorBlock(state: SessionState, blockId: number, endId: string) {
    state.prune.messages.activeBlockIds = new Set([blockId])
    state.prune.messages.blocksById.set(blockId, {
        blockId,
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 0,
        summaryTokens: 0,
        durationMs: 0,
        topic: "prior compress",
        batchTopic: "prior compress",
        startId: "m0001",
        endId,
        anchorMessageId: "m0001",
        compressMessageId: "msg-prior",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: [],
        directToolIds: [],
        effectiveMessageIds: [],
        effectiveToolIds: [],
        createdAt: 1,
        summary: "[prior summary]",
    } as any)
    state.prune.messages.nextBlockId = Math.max(2, blockId + 1)
}

function makeRangeTool(state: SessionState, sessionID: string, rawMessages: WithParts[]) {
    return createCompressRangeTool({
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
            getRuntimePrompts() {
                return { compressRange: "", compressMessage: "" }
            },
        },
    } as any)
}

function makeMessageTool(state: SessionState, sessionID: string, rawMessages: WithParts[]) {
    return createCompressMessageTool({
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
            getRuntimePrompts() {
                return { compressRange: "", compressMessage: "" }
            },
        },
    } as any)
}

/** Pre-set state.sessionId to match the tool-context sessionID so
 *  ensureSessionInitialized hits its early-return path and does NOT call
 *  resetSessionState. That preserves our pre-seeded activeBlockIds and
 *  blocksById, which the validator block reads on the very next tick. */
function primeSession(state: SessionState, sessionID: string) {
    state.sessionId = sessionID
    state.isSubAgent = false
}

// ────────────────────────────────────────────────────────────────────────────
// Range-mode validator wiring
// ────────────────────────────────────────────────────────────────────────────

test("validator-wiring: range tool rejects when startId > endId", async () => {
    const sessionID = `ses_wire_range_inverted_${Date.now()}`
    const rawMessages = buildMessages(sessionID, 10)
    const state = createSessionState()
    primeSession(state, sessionID)

    const tool = makeRangeTool(state, sessionID, rawMessages)
    const priorSize = state.prune.messages.blocksById.size

    // Spec deviation note: the inverted-range rejection actually fires
    // upstream — `resolveBoundaryIds` (lib/compress/search.ts:101) checks
    // `rawIndex` ordering and throws before the tool's validator block ever
    // sees the entry. The validator block's own `validateRangeSanity` is a
    // belt-and-braces backstop that can't be reached through the tool when
    // both IDs resolve. The tool still rejects, just with the upstream
    // message instead of the `__DCP_RANGE_SANITY__` prefix.
    await assert.rejects(
        tool.execute(
            {
                topic: "Inverted range",
                content: [
                    {
                        startId: "m0005",
                        endId: "m0003",
                        summary: "Should be rejected before anything is written.",
                    },
                ],
            },
            {
                ask: async () => {},
                metadata: () => {},
                sessionID,
                messageID: "msg-wiring-range-inverted",
            },
        ),
        /startId m0005 appears after endId m0003 in the conversation/,
    )

    // Tool rejected — nothing should have been written to state.
    assert.equal(state.prune.messages.blocksById.size, priorSize)
})

test("validator-wiring: range tool rejects when endId is not in context", async () => {
    const sessionID = `ses_wire_range_missing_${Date.now()}`
    const rawMessages = buildMessages(sessionID, 10)
    const state = createSessionState()
    primeSession(state, sessionID)

    const tool = makeRangeTool(state, sessionID, rawMessages)
    const priorSize = state.prune.messages.blocksById.size

    await assert.rejects(
        tool.execute(
            {
                topic: "Missing endId",
                content: [
                    {
                        startId: "m0001",
                        endId: "m9999",
                        summary: "End id is not part of the conversation.",
                    },
                ],
            },
            {
                ask: async () => {},
                metadata: () => {},
                sessionID,
                messageID: "msg-wiring-range-missing",
            },
        ),
        /endId m9999 is not available in the current conversation context/,
    )

    assert.equal(state.prune.messages.blocksById.size, priorSize)
})

test("validator-wiring: range tool rejects when endId ≤ previous block's endId", async () => {
    const sessionID = `ses_wire_range_monotonic_${Date.now()}`
    const rawMessages = buildMessages(sessionID, 10)
    const state = createSessionState()
    primeSession(state, sessionID)
    seedPriorBlock(state, 1, "m0005")

    const tool = makeRangeTool(state, sessionID, rawMessages)
    const priorSize = state.prune.messages.blocksById.size

    await assert.rejects(
        tool.execute(
            {
                topic: "Regressing range",
                content: [
                    {
                        startId: "m0001",
                        endId: "m0005",
                        summary: "End id equals the prior anchor.",
                    },
                ],
            },
            {
                ask: async () => {},
                metadata: () => {},
                sessionID,
                messageID: "msg-wiring-range-monotonic",
            },
        ),
        /__DCP_MONOTONIC_VIOLATION__/,
    )

    assert.equal(state.prune.messages.blocksById.size, priorSize)
})

test("validator-wiring: range tool accepts when endId > previous block's endId", async () => {
    const sessionID = `ses_wire_range_strict_forward_${Date.now()}`
    const rawMessages = buildMessages(sessionID, 10)
    const state = createSessionState()
    primeSession(state, sessionID)
    seedPriorBlock(state, 1, "m0005")

    const tool = makeRangeTool(state, sessionID, rawMessages)

    const result = await tool.execute(
        {
            topic: "Strictly forward range",
            content: [
                {
                    startId: "m0006",
                    endId: "m0010",
                    summary: "Captured the later conversation segment.",
                },
            ],
        },
        {
            ask: async () => {},
            metadata: () => {},
            sessionID,
            messageID: "msg-wiring-range-strict-forward",
        },
    )

    assert.equal(typeof result, "string")
    assert.match(result, /Compressed \d+ messages? into \[Compressed conversation section\]\./)
    // Validator passed and the body ran — exactly one new block on top of the seeded one.
    assert.equal(state.prune.messages.blocksById.size, 2)
})

test("validator-wiring: range tool accepts first compress (no prior anchor)", async () => {
    const sessionID = `ses_wire_range_first_${Date.now()}`
    const rawMessages = buildMessages(sessionID, 10)
    const state = createSessionState()
    primeSession(state, sessionID)

    const tool = makeRangeTool(state, sessionID, rawMessages)

    const result = await tool.execute(
        {
            topic: "First compress",
            content: [
                {
                    startId: "m0001",
                    endId: "m0005",
                    summary: "Captured the initial segment with no prior anchor.",
                },
            ],
        },
        {
            ask: async () => {},
            metadata: () => {},
            sessionID,
            messageID: "msg-wiring-range-first",
        },
    )

    assert.equal(typeof result, "string")
    assert.match(result, /Compressed \d+ messages? into \[Compressed conversation section\]\./)
    assert.equal(state.prune.messages.blocksById.size, 1)
})

// ────────────────────────────────────────────────────────────────────────────
// Message-mode validator wiring
// ────────────────────────────────────────────────────────────────────────────

test("validator-wiring: message tool rejects when messageId ≤ previous block's endId", async () => {
    const sessionID = `ses_wire_message_monotonic_${Date.now()}`
    const rawMessages = buildMessages(sessionID, 10)
    const state = createSessionState()
    primeSession(state, sessionID)
    seedPriorBlock(state, 1, "m0005")

    const tool = makeMessageTool(state, sessionID, rawMessages)
    const priorSize = state.prune.messages.blocksById.size

    await assert.rejects(
        tool.execute(
            {
                topic: "Regressing message",
                content: [
                    {
                        messageId: "m0003",
                        topic: "Already covered",
                        summary: "Should be rejected by the monotonic guard.",
                    },
                ],
            },
            {
                ask: async () => {},
                metadata: () => {},
                sessionID,
                messageID: "msg-wiring-message-monotonic",
            },
        ),
        /__DCP_MONOTONIC_VIOLATION__/,
    )

    assert.equal(state.prune.messages.blocksById.size, priorSize)
})

test("validator-wiring: message tool accepts first compress (no prior anchor)", async () => {
    const sessionID = `ses_wire_message_first_${Date.now()}`
    const rawMessages = buildMessages(sessionID, 10)
    const state = createSessionState()
    primeSession(state, sessionID)

    const tool = makeMessageTool(state, sessionID, rawMessages)

    const result = await tool.execute(
        {
            topic: "First message compress",
            content: [
                {
                    messageId: "m0001",
                    topic: "Initial message",
                    summary: "Captured the first message with no prior anchor.",
                },
            ],
        },
        {
            ask: async () => {},
            metadata: () => {},
            sessionID,
            messageID: "msg-wiring-message-first",
        },
    )

    assert.equal(typeof result, "string")
    assert.match(result, /Compressed 1 message into \[Compressed conversation section\]\./)
    assert.equal(state.prune.messages.blocksById.size, 1)
})

test("validator-wiring: message tool accepts when messageId > previous block's endId", async () => {
    const sessionID = `ses_wire_message_strict_forward_${Date.now()}`
    const rawMessages = buildMessages(sessionID, 10)
    const state = createSessionState()
    primeSession(state, sessionID)
    seedPriorBlock(state, 1, "m0003")

    const tool = makeMessageTool(state, sessionID, rawMessages)

    const result = await tool.execute(
        {
            topic: "Forward message",
            content: [
                {
                    messageId: "m0005",
                    topic: "Forward message",
                    summary: "Captured a strictly-forward message.",
                },
            ],
        },
        {
            ask: async () => {},
            metadata: () => {},
            sessionID,
            messageID: "msg-wiring-message-strict-forward",
        },
    )

    assert.equal(typeof result, "string")
    assert.match(result, /Compressed 1 message into \[Compressed conversation section\]\./)
    // Exactly one new block on top of the seeded one.
    assert.equal(state.prune.messages.blocksById.size, 2)
})
