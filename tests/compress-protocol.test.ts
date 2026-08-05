import assert from "node:assert/strict"
import test from "node:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdirSync } from "node:fs"
import {
    effectiveManualMode,
    finalizeSession,
    type NotificationEntry,
    type WithParts,
} from "../lib/compress/pipeline"
import {
    isBoundaryIdValid,
    listValidBoundaryIds,
    validateBoundaryIds,
    validateMonotonicEnd,
    validateRangeSanity,
} from "../lib/compress/range-utils"
import { Logger } from "../lib/logger"
import { assignMessageRefs } from "../lib/message-ids"
import type { PluginConfig } from "../lib/config"
import type { ToolContext } from "../lib/compress/types"
import { createSessionState, type SessionState } from "../lib/state"

const testDataHome = join(tmpdir(), `opencode-dcp-protocol-tests-${process.pid}`)
const testConfigHome = join(tmpdir(), `opencode-dcp-protocol-config-${process.pid}`)

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

function buildToolContext(
    state: SessionState,
    config: PluginConfig = buildConfig(),
): ToolContext {
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
                id: "msg-u1",
                role: "user",
                sessionID,
                agent: "assistant",
                model: { providerID: "anthropic", modelID: "claude-test" },
                time: { created: 1 },
            } as WithParts["info"],
            parts: [textPart("msg-u1", sessionID, "p-1", "Investigate auth")],
        },
        {
            info: {
                id: "msg-a1",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 2 },
            } as WithParts["info"],
            parts: [textPart("msg-a1", sessionID, "p-2", "Found the auth path")],
        },
        {
            info: {
                id: "msg-u2",
                role: "user",
                sessionID,
                agent: "assistant",
                model: { providerID: "anthropic", modelID: "claude-test" },
                time: { created: 3 },
            } as WithParts["info"],
            parts: [textPart("msg-u2", sessionID, "p-3", "Compress findings")],
        },
        {
            info: {
                id: "msg-a2",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 4 },
            } as WithParts["info"],
            parts: [textPart("msg-a2", sessionID, "p-4", "Compressing")],
        },
    ]
}

function indexRefMessages(state: SessionState): void {
    assignMessageRefs(state, [])
}

// #590: finalizeSession no longer collapses "compress-pending" -> "active".
test("finalizeSession #590: compress-pending round-trips to false (not active)", async () => {
    const sessionID = `ses_590_roundtrip_${Date.now()}`
    const state = createSessionState()
    state.sessionId = sessionID
    state.manualMode = "compress-pending"

    const config = buildConfig()
    const ctx = buildToolContext(state, config)

    // The pipeline's existing finalizeSession path uses sessionMessages to
    // build params; mock the client so it can run end-to-end.
    let toastCalls = 0
    ctx.client.tui = {
        showToast: async () => {
            toastCalls++
        },
    }

    const rawMessages = buildMessages(sessionID)
    const entries: NotificationEntry[] = [
        {
            blockId: 1,
            runId: 1,
            summary: "compressed summary",
            summaryTokens: 100,
            compressedTokens: 1000,
        },
    ]

    await finalizeSession(
        ctx,
        {
            ask: async () => {},
            metadata: () => {},
            sessionID,
        },
        rawMessages,
        entries,
        "test topic",
    )

    assert.equal(state.manualMode, false)
    assert.equal(state.userForced, false)
    assert.equal(state.recoveryForced, false)
    assert.equal(state.nonCompactingRunCount, 0)
    assert.equal(toastCalls, 0)
})

test("finalizeSession #590: active round-trips to active (preserved) when not via /dcp-compress", async () => {
    const sessionID = `ses_590_active_${Date.now()}`
    const state = createSessionState()
    state.sessionId = sessionID
    state.userForced = true
    state.recoveryForced = false
    state.manualMode = "active"

    const ctx = buildToolContext(state)

    const rawMessages = buildMessages(sessionID)
    const entries: NotificationEntry[] = [
        {
            blockId: 1,
            runId: 1,
            summary: "compressed summary",
            summaryTokens: 100,
            compressedTokens: 1000,
        },
    ]

    await finalizeSession(
        ctx,
        {
            ask: async () => {},
            metadata: () => {},
            sessionID,
        },
        rawMessages,
        entries,
        "test topic",
    )

    // A compress that runs without going through `/dcp-compress` is not
    // classified as a "manual compress" — `wasManualCompress` requires
    // manualMode === "compress-pending" at entry. userForced is preserved.
    assert.equal(state.userForced, true)
    assert.equal(state.manualMode, "active")
})

test("finalizeSession clears userForced after a successful manual compress", async () => {
    const sessionID = `ses_590_user_clear_${Date.now()}`
    const state = createSessionState()
    state.sessionId = sessionID
    state.userForced = true
    state.recoveryForced = false
    state.manualMode = "compress-pending"

    const ctx = buildToolContext(state)
    const rawMessages = buildMessages(sessionID)
    const entries: NotificationEntry[] = [
        {
            blockId: 1,
            runId: 1,
            summary: "compressed summary",
            summaryTokens: 100,
            compressedTokens: 1000,
        },
    ]

    await finalizeSession(
        ctx,
        { ask: async () => {}, metadata: () => {}, sessionID },
        rawMessages,
        entries,
        "test topic",
    )

    assert.equal(state.userForced, false)
    assert.equal(state.manualMode, false)
})

test("finalizeSession preserves recoveryForced when userForced clears", async () => {
    const sessionID = `ses_590_recovery_preserve_${Date.now()}`
    const state = createSessionState()
    state.sessionId = sessionID
    state.userForced = true
    state.recoveryForced = true
    state.manualMode = "compress-pending"

    const ctx = buildToolContext(state)
    const rawMessages = buildMessages(sessionID)
    const entries: NotificationEntry[] = [
        {
            blockId: 1,
            runId: 1,
            summary: "compressed summary",
            summaryTokens: 100,
            compressedTokens: 1000,
        },
    ]

    await finalizeSession(
        ctx,
        { ask: async () => {}, metadata: () => {}, sessionID },
        rawMessages,
        entries,
        "test topic",
    )

    assert.equal(state.userForced, false)
    assert.equal(state.recoveryForced, true)
    assert.equal(state.manualMode, "active")
})

test("effectiveManualMode reflects userForced || recoveryForced", () => {
    const state = createSessionState()

    state.userForced = false
    state.recoveryForced = false
    assert.equal(effectiveManualMode(state), false)

    state.userForced = true
    state.recoveryForced = false
    assert.equal(effectiveManualMode(state), "active")

    state.userForced = false
    state.recoveryForced = true
    assert.equal(effectiveManualMode(state), "active")

    state.userForced = true
    state.recoveryForced = true
    assert.equal(effectiveManualMode(state), "active")
})

// #573 monotonicity: strictly-greater on both anchors (and equality throws).
test("validateMonotonicEnd accepts strictly greater newStart and newEnd", () => {
    const state = createSessionState()
    state.messageIds.byRef.set("m0500", "raw-id-500")
    state.messageIds.byRef.set("m0501", "raw-id-501")
    state.messageIds.byRef.set("m0510", "raw-id-510")

    assert.doesNotThrow(() =>
        validateMonotonicEnd("m0500", "m0501", "m0510", state),
    )
})

test("validateMonotonicEnd rejects equal newStart", () => {
    const state = createSessionState()
    state.messageIds.byRef.set("m0500", "raw-id-500")
    state.messageIds.byRef.set("m0510", "raw-id-510")

    assert.throws(
        () => validateMonotonicEnd("m0500", "m0500", "m0510", state),
        /__DCP_MONOTONIC_VIOLATION__/,
    )
})

test("validateMonotonicEnd rejects newStart less than prevAnchorEnd", () => {
    const state = createSessionState()
    state.messageIds.byRef.set("m0500", "raw-id-500")
    state.messageIds.byRef.set("m0510", "raw-id-510")

    assert.throws(
        () => validateMonotonicEnd("m0500", "m0499", "m0510", state),
        /__DCP_MONOTONIC_VIOLATION__/,
    )
})

test("validateMonotonicEnd rejects newEnd less than prevAnchorEnd", () => {
    const state = createSessionState()
    state.messageIds.byRef.set("m0500", "raw-id-500")
    state.messageIds.byRef.set("m0510", "raw-id-510")

    assert.throws(
        () => validateMonotonicEnd("m0500", "m0501", "m0499", state),
        /__DCP_MONOTONIC_VIOLATION__/,
    )
})

test("validateMonotonicEnd error message carries valid-ID list", () => {
    const state = createSessionState()
    state.messageIds.byRef.set("m0500", "raw-id-500")
    state.messageIds.byRef.set("m0501", "raw-id-501")
    state.messageIds.byRef.set("m0510", "raw-id-510")

    try {
        validateMonotonicEnd("m0500", "m0500", "m0510", state)
        assert.fail("expected validateMonotonicEnd to throw")
    } catch (err) {
        const message = (err as Error).message
        assert.match(message, /__DCP_MONOTONIC_VIOLATION__/)
        assert.match(message, /Valid next anchors:/)
        assert.match(message, /m0501/)
        assert.match(message, /m0510/)
    }
})

// #573 range sanity: startId must come before endId.
test("validateRangeSanity throws when startId > endId", () => {
    assert.throws(() => validateRangeSanity("m0510", "m0501"), /__DCP_RANGE_SANITY__/)
})

test("validateRangeSanity accepts startId <= endId", () => {
    assert.doesNotThrow(() => validateRangeSanity("m0501", "m0510"))
    assert.doesNotThrow(() => validateRangeSanity("m0501", "m0501"))
})

// #573 ID existence.
test("validateBoundaryIds throws when startId does not exist", () => {
    const state = createSessionState()
    state.messageIds.byRef.set("m0510", "raw-id-510")

    assert.throws(
        () => validateBoundaryIds("m9999", "m0510", state),
        /not available in the current conversation context/,
    )
})

test("validateBoundaryIds throws when endId does not exist", () => {
    const state = createSessionState()
    state.messageIds.byRef.set("m0501", "raw-id-501")

    assert.throws(
        () => validateBoundaryIds("m0501", "m9999", state),
        /not available in the current conversation context/,
    )
})

test("validateBoundaryIds accepts known IDs", () => {
    const state = createSessionState()
    state.messageIds.byRef.set("m0501", "raw-id-501")
    state.messageIds.byRef.set("m0510", "raw-id-510")

    assert.doesNotThrow(() => validateBoundaryIds("m0501", "m0510", state))
})

test("listValidBoundaryIds enumerates message refs and active block refs", () => {
    const state = createSessionState()
    state.messageIds.byRef.set("m0001", "raw-id-1")
    state.messageIds.byRef.set("m0002", "raw-id-2")
    state.prune.messages.blocksById.set(1, {
        blockId: 1,
        active: true,
    } as any)
    state.prune.messages.blocksById.set(2, {
        blockId: 2,
        active: false,
    } as any)

    const ids = listValidBoundaryIds(state)
    assert.ok(ids.includes("m0001"))
    assert.ok(ids.includes("m0002"))
    assert.ok(ids.includes("b1"))
    assert.ok(!ids.includes("b2"))
})

test("isBoundaryIdValid accepts known refs and rejects unknown", () => {
    const state = createSessionState()
    state.messageIds.byRef.set("m0001", "raw-id-1")
    state.prune.messages.blocksById.set(1, {
        blockId: 1,
        active: true,
    } as any)

    assert.equal(isBoundaryIdValid("m0001", state), true)
    assert.equal(isBoundaryIdValid("b1", state), true)
    assert.equal(isBoundaryIdValid("m9999", state), false)
    assert.equal(isBoundaryIdValid("invalid", state), false)
})

// #573 net-compaction: after a non-compacting run, nonCompactingRunCount
// increments. After maxContextLimitRecovery consecutive runs, recoveryForced
// is set.
test("net-compaction: non-compacting run increments counter", async () => {
    const sessionID = `ses_netcompact_${Date.now()}`
    const state = createSessionState()
    state.sessionId = sessionID

    const config = buildConfig()
    config.compress.maxCompactionRatio = 0.7
    config.compress.maxContextLimitRecovery = 3

    const ctx = buildToolContext(state, config)
    const rawMessages = buildMessages(sessionID)
    const entries: NotificationEntry[] = [
        {
            blockId: 1,
            runId: 1,
            summary: "x".repeat(1000),
            summaryTokens: 1000,
            compressedTokens: 100,
        },
    ]

    await finalizeSession(
        ctx,
        { ask: async () => {}, metadata: () => {}, sessionID },
        rawMessages,
        entries,
        "topic",
    )

    assert.equal(state.nonCompactingRunCount, 1)
    assert.equal(state.recoveryForced, false)
})

test("net-compaction: recoveryForced triggers after maxContextLimitRecovery runs", async () => {
    const sessionID = `ses_recovery_${Date.now()}`
    const state = createSessionState()
    state.sessionId = sessionID

    const config = buildConfig()
    config.compress.maxCompactionRatio = 0.7
    config.compress.maxContextLimitRecovery = 3

    const ctx = buildToolContext(state, config)
    const rawMessages = buildMessages(sessionID)
    const entries: NotificationEntry[] = [
        {
            blockId: 1,
            runId: 1,
            summary: "x".repeat(1000),
            summaryTokens: 1000,
            compressedTokens: 100,
        },
    ]

    let toastCalls = 0
    let toastVariant: string | undefined
    ctx.client.tui = {
        showToast: async ({ body }: { body: { variant?: string } }) => {
            toastCalls++
            toastVariant = body.variant
        },
    }

    // Three non-compacting runs should trigger recoveryForced.
    for (let i = 0; i < 3; i++) {
        await finalizeSession(
            ctx,
            { ask: async () => {}, metadata: () => {}, sessionID },
            rawMessages,
            entries,
            "topic",
        )
    }

    assert.equal(state.nonCompactingRunCount, 3)
    assert.equal(state.recoveryForced, true)
    assert.equal(toastCalls, 1)
    assert.equal(toastVariant, "warning")
})

test("net-compaction: compacting run resets counter and does not trigger recovery", async () => {
    const sessionID = `ses_compacting_${Date.now()}`
    const state = createSessionState()
    state.sessionId = sessionID

    const config = buildConfig()
    config.compress.maxCompactionRatio = 0.7
    config.compress.maxContextLimitRecovery = 3

    const ctx = buildToolContext(state, config)
    const rawMessages = buildMessages(sessionID)

    // First a non-compacting run, then a compacting run.
    const nonCompacting: NotificationEntry[] = [
        { blockId: 1, runId: 1, summary: "x", summaryTokens: 1000, compressedTokens: 100 },
    ]
    const compacting: NotificationEntry[] = [
        { blockId: 2, runId: 2, summary: "x", summaryTokens: 100, compressedTokens: 1000 },
    ]

    await finalizeSession(
        ctx,
        { ask: async () => {}, metadata: () => {}, sessionID },
        rawMessages,
        nonCompacting,
        "topic",
    )
    assert.equal(state.nonCompactingRunCount, 1)

    await finalizeSession(
        ctx,
        { ask: async () => {}, metadata: () => {}, sessionID },
        rawMessages,
        compacting,
        "topic",
    )
    assert.equal(state.nonCompactingRunCount, 0)
    assert.equal(state.recoveryForced, false)
})

test("recovery: clear after recoveryFadeWindow good manual compresses", async () => {
    const sessionID = `ses_fade_${Date.now()}`
    const state = createSessionState()
    state.sessionId = sessionID

    const config = buildConfig()
    config.compress.maxCompactionRatio = 0.7
    config.compress.maxContextLimitRecovery = 2
    config.compress.recoveryFadeWindow = 3

    const ctx = buildToolContext(state, config)
    const rawMessages = buildMessages(sessionID)
    const nonCompacting: NotificationEntry[] = [
        { blockId: 1, runId: 1, summary: "x", summaryTokens: 1000, compressedTokens: 100 },
    ]
    const compacting: NotificationEntry[] = [
        { blockId: 2, runId: 2, summary: "x", summaryTokens: 100, compressedTokens: 1000 },
    ]

    // Two non-compacting runs set recoveryForced.
    await finalizeSession(
        ctx,
        { ask: async () => {}, metadata: () => {}, sessionID },
        rawMessages,
        nonCompacting,
        "topic",
    )
    await finalizeSession(
        ctx,
        { ask: async () => {}, metadata: () => {}, sessionID },
        rawMessages,
        nonCompacting,
        "topic",
    )
    assert.equal(state.recoveryForced, true)

    // Three good manual compresses (manualMode === "compress-pending" at entry)
    // should clear recoveryForced after the recoveryFadeWindow.
    for (let i = 0; i < 3; i++) {
        state.manualMode = "compress-pending"
        await finalizeSession(
            ctx,
            { ask: async () => {}, metadata: () => {}, sessionID },
            rawMessages,
            compacting,
            "topic",
        )
    }
    assert.equal(state.recoveryForced, false)
    assert.equal(state.recoveryFadeCounter, 0)
})

// Silence unused-import warnings on PreparedSession/indexRefMessages used
// only as type/utility helpers in the harness bootstrap.
void indexRefMessages
void ({} as PreparedSession)
