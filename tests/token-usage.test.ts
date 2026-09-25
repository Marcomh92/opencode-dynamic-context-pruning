import assert from "node:assert/strict"
import test from "node:test"
import { type PluginConfig, clampUnit } from "../lib/config"
import { isContextOverLimits } from "../lib/messages/inject/utils"
import { wrapCompressedSummary } from "../lib/compress/state"
import { createSessionState, type WithParts } from "../lib/state"
import type { CompressionBlock } from "../lib/state"
import { getCurrentTokenUsage } from "../lib/token-utils"

function buildConfig(maxContextLimit: number, minContextLimit = 1): PluginConfig {
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
            allowSubAgents: false,
            customPrompts: false,
        },
        protectedFilePatterns: [],
        compress: {
            mode: "message",
            permission: "allow",
            showCompression: false,
            summaryBuffer: true,
            // Default 0.2 mirrors the production default in lib/config.ts. The
            // existing tests above only assert overMaxLimit and ignore the min
            // path, so this field is inert for them; the new min-threshold tests
            // below rely on it being present (a missing field would NaN the min
            // extension and silently flip overMinLimit false everywhere).
            summaryBufferMinRatio: 0.2,
            maxContextLimit,
            minContextLimit,
            nudgeFrequency: 5,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            protectedTools: ["task"],
            protectTags: false,
            protectUserMessages: false,
            // BUG-096: default 1 (protect only the most recent real user
            // message). Not exercised in this file (protectUserMessages is
            // always false), so the default is fine.
            protectUserMessagesCount: 1,
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

function repeatedWord(word: string, count: number): string {
    return Array.from({ length: count }, () => word).join(" ")
}

function buildCompactedMessages(): WithParts[] {
    const sessionID = "ses_compaction_token_usage"

    return [
        {
            info: {
                id: "msg-user-summary",
                role: "user",
                sessionID,
                agent: "assistant",
                time: { created: 1 },
            } as WithParts["info"],
            parts: [
                textPart(
                    "msg-user-summary",
                    sessionID,
                    "msg-user-summary-part",
                    `[Compressed conversation section]\n${repeatedWord("summary", 120)}`,
                ),
            ],
        },
        {
            info: {
                id: "msg-assistant-summary",
                role: "assistant",
                sessionID,
                agent: "assistant",
                summary: true,
                time: { created: 2 },
                tokens: {
                    input: 86000,
                    output: 1200,
                    reasoning: 300,
                    cache: {
                        read: 5000,
                        write: 0,
                    },
                },
            } as WithParts["info"],
            parts: [
                textPart(
                    "msg-assistant-summary",
                    sessionID,
                    "msg-assistant-summary-part",
                    `Compaction summary. ${repeatedWord("carry", 180)}`,
                ),
            ],
        },
        {
            info: {
                id: "msg-user-follow-up",
                role: "user",
                sessionID,
                agent: "assistant",
                time: { created: 3 },
            } as WithParts["info"],
            parts: [
                textPart(
                    "msg-user-follow-up",
                    sessionID,
                    "msg-user-follow-up-part",
                    `Continue from here. ${repeatedWord("next", 40)}`,
                ),
            ],
        },
    ]
}

function buildPostCompactionAssistantMessage(): WithParts {
    const sessionID = "ses_compaction_token_usage"

    return {
        info: {
            id: "msg-assistant-post-compaction",
            role: "assistant",
            sessionID,
            agent: "assistant",
            time: { created: 4 },
            tokens: {
                input: 2400,
                output: 600,
                reasoning: 150,
                cache: {
                    read: 300,
                    write: 0,
                },
            },
        } as WithParts["info"],
        parts: [
            textPart(
                "msg-assistant-post-compaction",
                sessionID,
                "msg-assistant-post-compaction-part",
                `Fresh post-compaction reply. ${repeatedWord("done", 60)}`,
            ),
        ],
    }
}

function createActiveBlock(
    blockId: number,
    summary: string,
    summaryTokens: number,
): CompressionBlock {
    return {
        blockId,
        runId: blockId,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 0,
        summaryTokens,
        mode: "message",
        topic: `Summary ${blockId}`,
        batchTopic: `Summary ${blockId}`,
        startId: "m0001",
        endId: "m0001",
        anchorMessageId: `msg-${blockId}`,
        compressMessageId: `compress-${blockId}`,
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: [],
        directToolIds: [],
        effectiveMessageIds: [],
        effectiveToolIds: [],
        createdAt: blockId,
        summary,
    }
}

test("getCurrentTokenUsage returns 0 until a fresh assistant follows compaction", () => {
    const messages = buildCompactedMessages()
    const state = createSessionState()
    state.lastCompaction = 2

    assert.equal(getCurrentTokenUsage(state, messages), 0)
})

test("isContextOverLimits ignores stale summary totals and resumes with fresh reported totals", () => {
    const messages = buildCompactedMessages()
    const state = createSessionState()
    state.lastCompaction = 2

    const staleAssistantTotal = 86000 + 1200 + 300 + 5000
    assert.equal(getCurrentTokenUsage(state, messages), 0)

    const underLimit = isContextOverLimits(
        buildConfig(staleAssistantTotal - 1, 1),
        state,
        undefined,
        undefined,
        messages,
    )

    assert.equal(underLimit.overMaxLimit, false)
    assert.equal(underLimit.overMinLimit, false)

    messages.push(buildPostCompactionAssistantMessage())
    const freshReportedTotal = 2400 + 600 + 150 + 300

    assert.equal(getCurrentTokenUsage(state, messages), freshReportedTotal)

    const overLimit = isContextOverLimits(
        buildConfig(freshReportedTotal - 1, 1),
        state,
        undefined,
        undefined,
        messages,
    )

    assert.equal(overLimit.overMaxLimit, true)
})

test("isContextOverLimits extends the max threshold by active summary tokens", () => {
    const messages = buildCompactedMessages()
    messages.push(buildPostCompactionAssistantMessage())

    const state = createSessionState()
    state.lastCompaction = 2

    const storedSummary = wrapCompressedSummary(7, repeatedWord("summary", 120))
    state.prune.messages.blocksById.set(7, createActiveBlock(7, storedSummary, 1000))
    state.prune.messages.activeBlockIds.add(7)

    const freshReportedTotal = 2400 + 600 + 150 + 300

    const underExtendedLimit = isContextOverLimits(
        buildConfig(freshReportedTotal - 1, 1),
        state,
        undefined,
        undefined,
        messages,
    )

    assert.equal(underExtendedLimit.overMaxLimit, false)

    const overExtendedLimit = isContextOverLimits(
        buildConfig(freshReportedTotal - 1001, 1),
        state,
        undefined,
        undefined,
        messages,
    )

    assert.equal(overExtendedLimit.overMaxLimit, true)
})

test("isContextOverLimits does not extend the max threshold when summaryBuffer is disabled", () => {
    const messages = buildCompactedMessages()
    messages.push(buildPostCompactionAssistantMessage())

    const state = createSessionState()
    state.lastCompaction = 2

    const storedSummary = wrapCompressedSummary(7, repeatedWord("summary", 120))
    state.prune.messages.blocksById.set(7, createActiveBlock(7, storedSummary, 1000))
    state.prune.messages.activeBlockIds.add(7)

    const freshReportedTotal = 2400 + 600 + 150 + 300
    const config = buildConfig(freshReportedTotal - 1, 1)
    config.compress.summaryBuffer = false

    const overLimit = isContextOverLimits(config, state, undefined, undefined, messages)

    assert.equal(overLimit.overMaxLimit, true)
})

// Shared setup used by the summaryBufferMinRatio tests below: one active block
// with 1000 summary tokens, a fresh post-compaction assistant (so
// getCurrentTokenUsage returns a known 3450), and a lastCompaction cursor that
// lets the fresh assistant be picked up.
function setupActiveBlockState() {
    const messages = buildCompactedMessages()
    messages.push(buildPostCompactionAssistantMessage())

    const state = createSessionState()
    state.lastCompaction = 2

    const storedSummary = wrapCompressedSummary(7, repeatedWord("summary", 120))
    state.prune.messages.blocksById.set(7, createActiveBlock(7, storedSummary, 1000))
    state.prune.messages.activeBlockIds.add(7)

    return { messages, state }
}

test("isContextOverLimits extends the min threshold by summaryBufferMinRatio * active summary tokens (default 0.2)", () => {
    // summaryTokens = 1000, default ratio = 0.2 → minExtension = 200.
    // freshReportedTotal (3450) is held constant via buildPostCompactionAssistantMessage();
    // we vary minContextLimit so the relative position crosses the boundary.
    const { messages, state } = setupActiveBlockState()

    const freshReportedTotal = 2400 + 600 + 150 + 300 // 3450

    // minContextLimit = 3260 → effective min = 3260 + 200 = 3460.
    // currentTokens (3450) < 3460 → overMinLimit = false.
    const underExtendedMin = isContextOverLimits(
        buildConfig(freshReportedTotal + 1000, 3260),
        state,
        undefined,
        undefined,
        messages,
    )
    assert.equal(underExtendedMin.overMinLimit, false)

    // minContextLimit = 3249 → effective min = 3249 + 200 = 3449.
    // currentTokens (3450) >= 3449 → overMinLimit = true.
    const overExtendedMin = isContextOverLimits(
        buildConfig(freshReportedTotal + 1000, 3249),
        state,
        undefined,
        undefined,
        messages,
    )
    assert.equal(overExtendedMin.overMinLimit, true)
})

test("isContextOverLimits honours an explicit summaryBufferMinRatio override (0.1)", () => {
    // summaryTokens = 1000, ratio = 0.1 → minExtension = 100.
    const { messages, state } = setupActiveBlockState()

    const freshReportedTotal = 2400 + 600 + 150 + 300 // 3450

    // minContextLimit = 3360 → effective min = 3360 + 100 = 3460.
    // currentTokens (3450) < 3460 → overMinLimit = false.
    const configUnder = buildConfig(freshReportedTotal + 1000, 3360)
    configUnder.compress.summaryBufferMinRatio = 0.1
    const underExtendedMin = isContextOverLimits(configUnder, state, undefined, undefined, messages)
    assert.equal(underExtendedMin.overMinLimit, false)

    // minContextLimit = 3349 → effective min = 3349 + 100 = 3449.
    // currentTokens (3450) >= 3449 → overMinLimit = true.
    const configOver = buildConfig(freshReportedTotal + 1000, 3349)
    configOver.compress.summaryBufferMinRatio = 0.1
    const overExtendedMin = isContextOverLimits(configOver, state, undefined, undefined, messages)
    assert.equal(overExtendedMin.overMinLimit, true)
})

test("isContextOverLimits does not extend the min threshold when summaryBuffer is disabled", () => {
    // summaryBuffer = false zeroes summaryTokenExtension entirely, so the min
    // extension collapses to 0 even when activeBlockIds has a 1000-token block.
    // This pins the "existing behaviour preserved" path of the feature flag.
    const { messages, state } = setupActiveBlockState()

    const freshReportedTotal = 2400 + 600 + 150 + 300 // 3450

    // minContextLimit = 3451 → effective min = 3451 + 0 = 3451.
    // currentTokens (3450) < 3451 → overMinLimit = false.
    const configUnder = buildConfig(freshReportedTotal + 1000, 3451)
    configUnder.compress.summaryBuffer = false
    const under = isContextOverLimits(configUnder, state, undefined, undefined, messages)
    assert.equal(under.overMinLimit, false)

    // minContextLimit = 3450 → effective min = 3450 + 0 = 3450.
    // currentTokens (3450) >= 3450 → overMinLimit = true (boundary).
    const configOver = buildConfig(freshReportedTotal + 1000, 3450)
    configOver.compress.summaryBuffer = false
    const over = isContextOverLimits(configOver, state, undefined, undefined, messages)
    assert.equal(over.overMinLimit, true)
})

test("isContextOverLimits does not extend the min threshold when summaryBufferMinRatio is 0", () => {
    // summaryBuffer = true but ratio = 0 must cleanly disable the min extension
    // without requiring summaryBuffer to be flipped off. Same effective contract
    // as the summaryBuffer:false case, different code path (the ratio itself is
    // the multiplier, not the summaryTokenExtension gate).
    const { messages, state } = setupActiveBlockState()

    const freshReportedTotal = 2400 + 600 + 150 + 300 // 3450

    const configUnder = buildConfig(freshReportedTotal + 1000, 3451)
    configUnder.compress.summaryBufferMinRatio = 0
    const under = isContextOverLimits(configUnder, state, undefined, undefined, messages)
    assert.equal(under.overMinLimit, false)

    const configOver = buildConfig(freshReportedTotal + 1000, 3450)
    configOver.compress.summaryBufferMinRatio = 0
    const over = isContextOverLimits(configOver, state, undefined, undefined, messages)
    assert.equal(over.overMinLimit, true)
})

test("isContextOverLimits does not extend the min threshold when activeBlockIds is empty", () => {
    // No active blocks → getActiveSummaryTokenUsage returns 0 → minExtension = 0
    // regardless of ratio. Locks the zero-summary case (e.g. a fresh session
    // before any compaction). Ratio set to 0.5 to prove it's the zero-summary
    // path, not a coincidentally-zero ratio, that produces the no-extension.
    const messages = buildCompactedMessages()
    messages.push(buildPostCompactionAssistantMessage())

    const state = createSessionState()
    state.lastCompaction = 2
    // Intentionally do NOT add to activeBlockIds.

    const freshReportedTotal = 2400 + 600 + 150 + 300 // 3450

    const configUnder = buildConfig(freshReportedTotal + 1000, 3451)
    configUnder.compress.summaryBufferMinRatio = 0.5
    const under = isContextOverLimits(configUnder, state, undefined, undefined, messages)
    assert.equal(under.overMinLimit, false)

    const configOver = buildConfig(freshReportedTotal + 1000, 3450)
    configOver.compress.summaryBufferMinRatio = 0.5
    const over = isContextOverLimits(configOver, state, undefined, undefined, messages)
    assert.equal(over.overMinLimit, true)
})

test("isContextOverLimits does not let summaryBufferMinRatio affect the max threshold", () => {
    // The new flag must NOT bleed into the max path. With summaryBuffer: true
    // and ratio: 0, the min extension is 0 but the max extension stays at the
    // full active summaryTokens (1000). We assert the max boundary holds at
    // both sides: one token under the extended max is "under", one token over
    // is "over". If summaryBufferMinRatio ever leaks into the max math, this
    // boundary will flip.
    const { messages, state } = setupActiveBlockState()

    const freshReportedTotal = 2400 + 600 + 150 + 300 // 3450

    // maxContextLimit = 2449 → effective max = 2449 + 1000 = 3449.
    // currentTokens (3450) > 3449 → overMaxLimit = true.
    const configOver = buildConfig(2449, 1)
    configOver.compress.summaryBufferMinRatio = 0
    const over = isContextOverLimits(configOver, state, undefined, undefined, messages)
    assert.equal(over.overMaxLimit, true)

    // maxContextLimit = 2450 → effective max = 2450 + 1000 = 3450.
    // currentTokens (3450) > 3450 → overMaxLimit = false (boundary, equality
    // does not count as "over" per the > comparison in utils.ts:171).
    const configUnder = buildConfig(2450, 1)
    configUnder.compress.summaryBufferMinRatio = 0
    const under = isContextOverLimits(configUnder, state, undefined, undefined, messages)
    assert.equal(under.overMaxLimit, false)
})

test("clampUnit preserves in-range values", () => {
    assert.equal(clampUnit(0.5), 0.5)
    assert.equal(clampUnit(0), 0)
    assert.equal(clampUnit(1), 1)
})

test("clampUnit clamps below-zero to 0", () => {
    assert.equal(clampUnit(-0.1), 0)
    assert.equal(clampUnit(-100), 0)
})

test("clampUnit clamps above-1 to 1", () => {
    assert.equal(clampUnit(1.5), 1)
    assert.equal(clampUnit(100), 1)
})

test("clampUnit returns 0 for NaN (non-finite → floor, safe-failure contract)", () => {
    // NaN fails Number.isFinite → floor branch (0). Matches clampRatio's
    // safe-failure contract for its non-finite inputs.
    assert.equal(clampUnit(NaN), 0)
})

test("clampUnit returns 0 for Infinity (non-finite → floor, same path as NaN)", () => {
    // Infinity also fails Number.isFinite → floor branch (0), NOT ceiling (1).
    // Mirrors clampRatio which routes both NaN and Infinity to the same
    // safe-failure floor (0.7). Pin this so a "fix" to clamp Infinity to 1
    // would surface here as a regression instead of a silent behaviour change.
    assert.equal(clampUnit(Infinity), 0)
    assert.equal(clampUnit(-Infinity), 0)
})
// Logic Verified: getCurrentTokenUsage returns 0 until a fresh assistant follows compaction; isContextOverLimits honours summaryBuffer and ignores stale summary totals; summaryBufferMinRatio scales the same summary-token extension onto minContextLimit (default 0.2, explicit override, summaryBuffer=false bypass, ratio=0 knob-off, zero-summary edge case, and no bleed onto the max threshold); clampUnit clamps to [0,1] with a safe-failure floor for non-finite inputs.
// Bugs Documented: none.
// Fakes Updated: none
// Review Status: pending independent review.
