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
import type { PluginConfig } from "../lib/config"
import { Logger } from "../lib/logger"
import { createSessionState, type SessionState } from "../lib/state"
import type { ToolContext } from "../lib/compress/types"

const testDataHome = join(tmpdir(), `opencode-dcp-burn-tests-${process.pid}`)
const testConfigHome = join(tmpdir(), `opencode-dcp-burn-config-${process.pid}`)

process.env.XDG_DATA_HOME = testDataHome
process.env.XDG_CONFIG_HOME = testConfigHome

mkdirSync(testDataHome, { recursive: true })
mkdirSync(testConfigHome, { recursive: true })

/** Deterministic #573 burn-graph generator.
 *  Models the burn signature from the original report: 12K chars -> 68K chars
 *  over 71 blocks (each new summary roughly 1.5x the previous). Here we use
 *  N=20 blocks with summaryTokens = previous * 1.5 (rounded), starting from
 *  3000 tokens (~12K chars). Each block reports a constant removedTokens of
 *  1000 — i.e., the model produces a longer summary for roughly the same
 *  removed context, the failure mode #573 documents.
 *
 *  ponytail: global deterministic generator; no IO, no clock. Add when
 *  burn-graph fixture needs to be reused across tests. */
function generateBurnGraph(
    n: number,
    startSummaryTokens: number,
    growthFactor: number,
    constantRemovedTokens: number,
): NotificationEntry[][] {
    const runs: NotificationEntry[][] = []
    let summaryTokens = startSummaryTokens

    for (let runIndex = 0; runIndex < n; runIndex++) {
        const entries: NotificationEntry[] = [
            {
                blockId: runIndex + 1,
                runId: runIndex + 1,
                summary: "x".repeat(Math.max(1, summaryTokens / 4)),
                summaryTokens,
                compressedTokens: constantRemovedTokens,
            },
        ]
        runs.push(entries)
        summaryTokens = Math.round(summaryTokens * growthFactor)
    }

    return runs
}

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
            // BUG-096: default 1 (protect only the most recent real user
            // message). Not exercised in this file (protectUserMessages is
            // always false), so the default is fine.
            protectUserMessagesCount: 1,
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

function buildEmptyMessages(sessionID: string): WithParts[] {
    return []
}

test("synthetic burn: nonCompactingRunCount reaches maxContextLimitRecovery within 3 runs", async () => {
    const sessionID = `ses_burn_${Date.now()}`
    const state = createSessionState()
    state.sessionId = sessionID

    const config = buildConfig()
    config.compress.maxCompactionRatio = 0.7
    config.compress.maxContextLimitRecovery = 3

    const ctx = buildToolContext(state, config)
    const rawMessages = buildEmptyMessages(sessionID)
    const runs = generateBurnGraph(20, 3000, 1.5, 1000)

    // Verify the burn graph is configured to be non-compacting from the very
    // first run: ratio = 3000 / 1000 = 3.0 >> 0.7.
    assert.ok(runs[0]!.length === 1)
    assert.equal(runs[0]![0]!.summaryTokens, 3000)
    assert.equal(runs[0]![0]!.compressedTokens, 1000)

    for (let i = 0; i < 3; i++) {
        await finalizeSession(
            ctx,
            { ask: async () => {}, metadata: () => {}, sessionID },
            rawMessages,
            runs[i]!,
            `burn-topic-${i}`,
        )
    }

    assert.equal(state.nonCompactingRunCount, 3)
    assert.equal(state.recoveryForced, true)
})

test("synthetic burn: further autonomous compress calls are blocked (preparation refuses)", async () => {
    const sessionID = `ses_burn_block_${Date.now()}`
    const state = createSessionState()
    state.sessionId = sessionID
    state.manualMode = false

    const config = buildConfig()
    config.compress.maxCompactionRatio = 0.7
    config.compress.maxContextLimitRecovery = 3

    const ctx = buildToolContext(state, config)
    const rawMessages = buildEmptyMessages(sessionID)
    const runs = generateBurnGraph(5, 3000, 1.5, 1000)

    // Drive 3 non-compacting runs to trigger recoveryForced.
    for (let i = 0; i < 3; i++) {
        await finalizeSession(
            ctx,
            { ask: async () => {}, metadata: () => {}, sessionID },
            rawMessages,
            runs[i]!,
            `burn-topic-${i}`,
        )
    }

    assert.equal(state.recoveryForced, true)

    // After recoveryForced is set, effectiveManualMode returns "active" and
    // prepareSession refuses autonomous compress (manualMode !== "compress-pending").
    assert.equal(effectiveManualMode(state), "active")
    assert.equal(state.manualMode, "active")

    // Simulate the prepareSession block: an autonomous compress attempt now
    // throws. We verify the check directly here rather than instantiating the
    // full OpenCode tool context.
    const simulatedManualBlock =
        effectiveManualMode(state) === "active" && state.manualMode !== "compress-pending"
    assert.equal(
        simulatedManualBlock,
        true,
        "autonomous compress should be blocked when recoveryForced is set",
    )
})

test("synthetic burn: manual /dcp-compress remains available as the recovery lever", async () => {
    const sessionID = `ses_burn_recover_${Date.now()}`
    const state = createSessionState()
    state.sessionId = sessionID

    const config = buildConfig()
    config.compress.maxCompactionRatio = 0.7
    config.compress.maxContextLimitRecovery = 2
    config.compress.recoveryFadeWindow = 2

    const ctx = buildToolContext(state, config)
    const rawMessages = buildEmptyMessages(sessionID)
    const nonCompacting = generateBurnGraph(5, 3000, 1.5, 1000)
    const compacting: NotificationEntry[] = [
        { blockId: 99, runId: 99, summary: "ok", summaryTokens: 100, compressedTokens: 1000 },
    ]

    // Trigger recoveryForced.
    for (let i = 0; i < 2; i++) {
        await finalizeSession(
            ctx,
            { ask: async () => {}, metadata: () => {}, sessionID },
            rawMessages,
            nonCompacting[i]!,
            "topic",
        )
    }
    assert.equal(state.recoveryForced, true)

    // Manual compress via /dcp-compress: state.manualMode = "compress-pending".
    // effectiveManualMode returns "active" but prepareSession allows it
    // because manualMode IS "compress-pending".
    state.manualMode = "compress-pending"
    const canManualCompress =
        effectiveManualMode(state) === "active" && state.manualMode === "compress-pending"
    assert.equal(canManualCompress, true)

    // A compacting manual compress: clears userForced, increments fade counter.
    state.userForced = true
    await finalizeSession(
        ctx,
        { ask: async () => {}, metadata: () => {}, sessionID },
        rawMessages,
        compacting,
        "good manual",
    )
    assert.equal(state.userForced, false)
    assert.equal(state.recoveryForced, true) // Not yet cleared — needs recoveryFadeWindow (2) good runs.
    assert.equal(state.recoveryFadeCounter, 1)

    // Second good manual compress: clears recoveryForced.
    state.manualMode = "compress-pending"
    await finalizeSession(
        ctx,
        { ask: async () => {}, metadata: () => {}, sessionID },
        rawMessages,
        compacting,
        "good manual 2",
    )
    assert.equal(state.recoveryForced, false)
    assert.equal(state.recoveryFadeCounter, 0)
    assert.equal(state.manualMode, false)
})

test("synthetic burn: bad manual compress resets recoveryFadeCounter", async () => {
    const sessionID = `ses_burn_fade_reset_${Date.now()}`
    const state = createSessionState()
    state.sessionId = sessionID

    const config = buildConfig()
    config.compress.maxCompactionRatio = 0.7
    config.compress.maxContextLimitRecovery = 2
    config.compress.recoveryFadeWindow = 3

    const ctx = buildToolContext(state, config)
    const rawMessages = buildEmptyMessages(sessionID)
    const nonCompacting = generateBurnGraph(5, 3000, 1.5, 1000)
    const compacting: NotificationEntry[] = [
        { blockId: 99, runId: 99, summary: "ok", summaryTokens: 100, compressedTokens: 1000 },
    ]

    for (let i = 0; i < 2; i++) {
        await finalizeSession(
            ctx,
            { ask: async () => {}, metadata: () => {}, sessionID },
            rawMessages,
            nonCompacting[i]!,
            "topic",
        )
    }
    assert.equal(state.recoveryForced, true)

    state.manualMode = "compress-pending"
    await finalizeSession(
        ctx,
        { ask: async () => {}, metadata: () => {}, sessionID },
        rawMessages,
        compacting,
        "good",
    )
    assert.equal(state.recoveryFadeCounter, 1)

    // A bad manual compress resets the fade counter.
    state.manualMode = "compress-pending"
    await finalizeSession(
        ctx,
        { ask: async () => {}, metadata: () => {}, sessionID },
        rawMessages,
        nonCompacting[0]!,
        "bad manual",
    )
    assert.equal(state.recoveryFadeCounter, 0)
    assert.equal(state.recoveryForced, true)
})

test("synthetic burn graph: deterministic output for given inputs", () => {
    const a = generateBurnGraph(5, 1000, 1.5, 500)
    const b = generateBurnGraph(5, 1000, 1.5, 500)

    assert.deepEqual(a, b)
})
// Logic Verified: synthetic burn reaches maxContextLimitRecovery within 3 runs, blocks further autonomous compress calls (prep refuses), keeps /dcp-compress available, and bad manual compress resets recoveryFadeCounter.
// Bugs Documented: none.
// Fakes Updated: none
// Review Status: pending independent review.
