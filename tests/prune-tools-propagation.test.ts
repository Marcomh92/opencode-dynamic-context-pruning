import assert from "node:assert/strict"
import test from "node:test"
import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createCompressRangeTool } from "../lib/compress/range"
import { createSessionState, type SessionState, type WithParts } from "../lib/state"
import { Logger } from "../lib/logger"

// Per-test isolation: redirect XDG_DATA_HOME / XDG_CONFIG_HOME so the
// persistence layer and the logger never touch the host filesystem.
const testDataHome = join(tmpdir(), `opencode-dcp-prune-tools-data-${process.pid}`)
const testConfigHome = join(tmpdir(), `opencode-dcp-prune-tools-config-${process.pid}`)
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
            mode: "range", permission: "allow", showCompression: false,
            maxContextLimit: 150000, minContextLimit: 50000, nudgeFrequency: 5,
            iterationNudgeThreshold: 15, nudgeForce: "soft", protectedTools: [],
            protectTags: false, protectUserMessages: false,
        },
        strategies: { deduplication: { enabled: true, protectedTools: [] }, purgeErrors: { enabled: true, turns: 4, protectedTools: [] } },
    } as any
}

function messages(sessionID: string, offset = 0, callID = "call-direct"): WithParts[] {
    const output = "completed tool output ".repeat(300)
    return [1, 2, 3, 4].map((n) => {
        const sequence = n + offset
        const id = `msg-${sequence}`
        return {
            info: {
                id, role: n % 2 ? "user" : "assistant", sessionID, agent: "assistant",
                ...(n % 2 ? { model: { providerID: "anthropic", modelID: "test" } } : {}),
                time: { created: sequence },
            } as any,
            parts: n === 2
                ? [{ id: `tool-part-${sequence}`, messageID: id, sessionID, type: "tool", tool: "bash", callID, state: { status: "completed", input: {}, output } } as any]
                : [{ id: `text-${sequence}`, messageID: id, sessionID, type: "text", text: `message ${sequence}` } as any],
        }
    })
}

function toolFor(state: SessionState, sessionID: string, rawMessages: WithParts[]) {
    return createCompressRangeTool({
        client: { session: { messages: async () => ({ data: rawMessages }), get: async () => ({ data: { parentID: null } }) } },
        state, logger: new Logger(false), config: buildConfig(),
        prompts: { reload() {}, getRuntimePrompts: () => ({ compressRange: "", compressMessage: "" }) },
    } as any)
}

async function compressWith(
    state: SessionState,
    sessionID: string,
    offset = 0,
    callID = "call-direct",
) {
    const rawMessages = messages(sessionID, offset, callID)
    const tool = toolFor(state, sessionID, rawMessages)
    state.sessionId = sessionID
    state.isSubAgent = false
    state.toolParameters.set(callID, { tool: "bash", parameters: {}, turn: offset + 1, tokenCount: offset + 321 })
    await tool.execute(
        {
            topic: "tool propagation",
            content: [{
                startId: `m${String(offset + 1).padStart(4, "0")}`,
                endId: `m${String(offset + 4).padStart(4, "0")}`,
                summary: "Compressed tool output.",
            }],
        },
        { ask: async () => {}, metadata: () => {}, sessionID, messageID: `compress-message-${offset}` } as any,
    )
}

test("compression propagates every direct tool ID into prune.tools with its token count", async () => {
    const state = createSessionState()
    await compressWith(state, `ses_tool_propagation_${Date.now()}`)

    const block = [...state.prune.messages.blocksById.values()][0]
    assert.ok(block)
    assert.ok(block.directToolIds.includes("call-direct"))
    assert.equal(state.prune.tools.get("call-direct"), 321)
})

test("compression does not overwrite a pre-pruned tool token count", async () => {
    const state = createSessionState()
    state.prune.tools.set("call-direct", 999)
    await compressWith(state, `ses_tool_preserve_${Date.now()}`)

    assert.equal(state.prune.tools.get("call-direct"), 999)
})

test("sequential compression blocks preserve earlier tools while adding later tools", async () => {
    const state = createSessionState()
    const sessionID = `ses_tool_multiblock_${Date.now()}`

    await compressWith(state, sessionID, 0, "call-first")
    await compressWith(state, sessionID, 4, "call-second")

    const blocks = [...state.prune.messages.blocksById.values()]
    assert.equal(blocks.length, 2)
    assert.deepEqual(blocks[0]?.directToolIds, ["call-first"])
    assert.deepEqual(blocks[1]?.directToolIds, ["call-second"])
    assert.equal(state.prune.tools.get("call-first"), 321)
    assert.equal(state.prune.tools.get("call-second"), 325)
})
