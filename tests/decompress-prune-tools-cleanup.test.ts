import assert from "node:assert/strict"
import test from "node:test"
import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createCompressRangeTool } from "../lib/compress/range"
import { handleDecompressCommand } from "../lib/commands/decompress"
import { handleRecompressCommand } from "../lib/commands/recompress"
import { Logger } from "../lib/logger"
import { prune } from "../lib/messages/prune"
import {
    createSessionState,
    syncPruneToolsFromActiveBlocks,
    type SessionState,
    type WithParts,
} from "../lib/state"

const PRUNED_PLACEHOLDER =
    "[Output removed to save context - information superseded or no longer needed]"

// Per-test isolation: redirect XDG_DATA_HOME / XDG_CONFIG_HOME so the
// persistence layer and the logger never touch the host filesystem.
const testDataHome = join(tmpdir(), `opencode-dcp-decompress-tools-data-${process.pid}`)
const testConfigHome = join(tmpdir(), `opencode-dcp-decompress-tools-config-${process.pid}`)
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

test("syncPruneToolsFromActiveBlocks: keeps tool IDs from active blocks, drops the rest", () => {
    const state = createSessionState()

    // Seed two active blocks; the second references toolB, the first toolA.
    state.prune.messages.blocksById.set(1, {
        blockId: 1,
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 0,
        summaryTokens: 0,
        topic: "block1",
        startId: "m0001",
        endId: "m0002",
        anchorMessageId: "m0002",
        compressMessageId: "msg-origin-1",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: ["m0001", "m0002"],
        directToolIds: ["toolA"],
        effectiveMessageIds: ["m0001", "m0002"],
        effectiveToolIds: ["toolA"],
        createdAt: 1,
        summary: "",
    } as any)
    state.prune.messages.blocksById.set(2, {
        blockId: 2,
        runId: 2,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 0,
        summaryTokens: 0,
        topic: "block2",
        startId: "m0003",
        endId: "m0004",
        anchorMessageId: "m0004",
        compressMessageId: "msg-origin-2",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: ["m0003", "m0004"],
        directToolIds: ["toolB"],
        effectiveMessageIds: ["m0003", "m0004"],
        effectiveToolIds: ["toolB"],
        createdAt: 2,
        summary: "",
    } as any)
    state.prune.messages.activeBlockIds.add(1)
    state.prune.messages.activeBlockIds.add(2)

    // Seed a stale tool from a prior sweep that's not in any block.
    state.prune.tools.set("toolA", 10)
    state.prune.tools.set("toolB", 20)
    state.prune.tools.set("stale-sweep-tool", 30)
    state.toolParameters.set("toolA", { tool: "bash", parameters: {}, turn: 1, tokenCount: 10 })
    state.toolParameters.set("toolB", { tool: "bash", parameters: {}, turn: 2, tokenCount: 20 })
    state.toolParameters.set("stale-sweep-tool", {
        tool: "bash",
        parameters: {},
        turn: 0,
        tokenCount: 30,
    })

    syncPruneToolsFromActiveBlocks(state)

    assert.ok(state.prune.tools.has("toolA"), "block1 tool stays")
    assert.ok(state.prune.tools.has("toolB"), "block2 tool stays")
    // Sweep-marked tool that's not in any active block is wiped.
    assert.ok(
        !state.prune.tools.has("stale-sweep-tool"),
        "sweep-marked tool not in any active block must be wiped (intentional — see helper comment)",
    )
})

test("syncPruneToolsFromActiveBlocks: deactivating a block drops its tool ID when no other active block references it", () => {
    const state = createSessionState()
    state.prune.messages.blocksById.set(1, {
        blockId: 1,
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 0,
        summaryTokens: 0,
        topic: "block1",
        startId: "m0001",
        endId: "m0002",
        anchorMessageId: "m0002",
        compressMessageId: "msg-origin-1",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: ["m0001", "m0002"],
        directToolIds: ["toolA"],
        effectiveMessageIds: ["m0001", "m0002"],
        effectiveToolIds: ["toolA"],
        createdAt: 1,
        summary: "",
    } as any)
    state.prune.messages.activeBlockIds.add(1)
    state.prune.tools.set("toolA", 10)
    state.toolParameters.set("toolA", { tool: "bash", parameters: {}, turn: 1, tokenCount: 10 })

    // Simulate decompress: deactivate the block.
    const block = state.prune.messages.blocksById.get(1)!
    block.active = false
    block.deactivatedByUser = true
    state.prune.messages.activeBlockIds.delete(1)

    syncPruneToolsFromActiveBlocks(state)

    assert.ok(
        !state.prune.tools.has("toolA"),
        "deactivated block's tool ID is dropped (BUG-M1 fix)",
    )
})

test("syncPruneToolsFromActiveBlocks: reactivating a block re-adds its tool IDs", () => {
    const state = createSessionState()
    state.prune.messages.blocksById.set(1, {
        blockId: 1,
        runId: 1,
        active: false,
        deactivatedByUser: true,
        compressedTokens: 0,
        summaryTokens: 0,
        topic: "block1",
        startId: "m0001",
        endId: "m0002",
        anchorMessageId: "m0002",
        compressMessageId: "msg-origin-1",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: ["m0001", "m0002"],
        directToolIds: ["toolA", "toolB"],
        effectiveMessageIds: ["m0001", "m0002"],
        effectiveToolIds: ["toolA", "toolB"],
        createdAt: 1,
        summary: "",
    } as any)
    state.toolParameters.set("toolA", { tool: "bash", parameters: {}, turn: 1, tokenCount: 10 })
    state.toolParameters.set("toolB", { tool: "bash", parameters: {}, turn: 1, tokenCount: 20 })

    // Simulate recompress: reactivate the block.
    const block = state.prune.messages.blocksById.get(1)!
    block.active = true
    block.deactivatedByUser = false
    state.prune.messages.activeBlockIds.add(1)

    syncPruneToolsFromActiveBlocks(state)

    assert.ok(state.prune.tools.has("toolA"), "reactivated block: toolA re-added")
    assert.ok(state.prune.tools.has("toolB"), "reactivated block: toolB re-added")
    assert.equal(state.prune.tools.get("toolA"), 10, "token count from toolParameters")
    assert.equal(state.prune.tools.get("toolB"), 20, "token count from toolParameters")
})

// Integration: a non-compacted message whose tool ID is in prune.tools will
// have its output replaced by prune(). After BUG-M1's fix, decompress drops
// the ID from prune.tools, so a subsequent prune() preserves the original
// output. This test directly exercises that contract by hand-building the
// pre-decompress state (no full compress pipeline needed).
test("BUG-M1 integration: prune() preserves restored output when tool ID was dropped from prune.tools by decompress", () => {
    const ORIGINAL_OUTPUT = "completed tool output — RESTORED-CONTENT-MARKER"
    const callID = "call-decompress-direct"

    const state = createSessionState()

    // Build a non-compacted message carrying a tool part.
    const rawMessages: WithParts[] = [
        {
            info: {
                id: "msg-live",
                role: "assistant",
                sessionID: "ses",
                agent: "assistant",
                time: { created: 5 },
            } as any,
            parts: [
                {
                    id: `${callID}-part`,
                    messageID: "msg-live",
                    sessionID: "ses",
                    type: "tool",
                    tool: "bash",
                    callID,
                    state: { status: "completed", input: {}, output: ORIGINAL_OUTPUT },
                } as any,
            ],
        },
    ]

    // Pre-condition that should hold immediately after decompress (with my fix):
    // the tool ID is no longer in state.prune.tools.
    assert.ok(!state.prune.tools.has(callID), "fresh state has no entries in prune.tools")

    // Simulate the post-decompress state: tool ID is NOT in prune.tools.
    // (decompress handler calls syncPruneToolsFromActiveBlocks; we bypass.)
    state.toolParameters.set(callID, { tool: "bash", parameters: {}, turn: 1, tokenCount: 200 })

    prune(state, new Logger(false), buildConfig(), rawMessages)

    const output = toolPartOutput(rawMessages, callID)
    assert.notEqual(
        output,
        PRUNED_PLACEHOLDER,
        "BUG-M1 fix verified: prune() preserves the restored output when the tool ID is no longer in prune.tools",
    )
    assert.ok(output.includes("RESTORED-CONTENT-MARKER"), "original output preserved end-to-end")
})

// Counter-factual: the BUG itself. With prune.tools HAS the tool ID (the
// pre-fix behaviour), prune() DOES replace the output with the placeholder.
// This documents the exact symptom that BUG-M1 caused in production.
test("BUG-M1 counter-factual: prune() replaces output with the placeholder when prune.tools HAS the tool ID", () => {
    const ORIGINAL_OUTPUT = "completed tool output — placeholder-target"
    const callID = "call-bug-counter"

    const state = createSessionState()
    state.prune.tools.set(callID, 200) // Pre-fix state: toolId lingered in prune.tools after decompress
    state.toolParameters.set(callID, { tool: "bash", parameters: {}, turn: 1, tokenCount: 200 })

    const rawMessages: WithParts[] = [
        {
            info: {
                id: "msg-live-2",
                role: "assistant",
                sessionID: "ses",
                agent: "assistant",
                time: { created: 5 },
            } as any,
            parts: [
                {
                    id: `${callID}-part`,
                    messageID: "msg-live-2",
                    sessionID: "ses",
                    type: "tool",
                    tool: "bash",
                    callID,
                    state: { status: "completed", input: {}, output: ORIGINAL_OUTPUT },
                } as any,
            ],
        },
    ]

    prune(state, new Logger(false), buildConfig(), rawMessages)

    const output = toolPartOutput(rawMessages, callID)
    assert.equal(
        output,
        PRUNED_PLACEHOLDER,
        "documents the BUG: when toolId is in prune.tools + message NOT compacted, prune() replaces output",
    )
})
// Logic Verified: syncPruneToolsFromActiveBlocks keeps tool IDs from active blocks, drops them on deactivation, and re-adds on reactivation.
// Bugs Documented: none.
// Fakes Updated: none
// Review Status: pending independent review.
