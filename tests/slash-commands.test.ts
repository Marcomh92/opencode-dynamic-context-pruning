import assert from "node:assert/strict"
import test from "node:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdirSync } from "node:fs"
import { createCommandExecuteHandler } from "../lib/hooks"
import {
    handleContextCommand,
    handleHelpCommand,
    handleManualToggleCommand,
    handleStatsCommand,
    handleSweepCommand,
} from "../lib/commands"
import { createSessionState } from "../lib/state"
import { Logger } from "../lib/logger"
import type { PluginConfig } from "../lib/config"
import type { WithParts } from "../lib/state"

const testDataHome = join(tmpdir(), `opencode-dcp-slash-command-data-${process.pid}`)
const testConfigHome = join(tmpdir(), `opencode-dcp-slash-command-config-${process.pid}`)
process.env.XDG_DATA_HOME = testDataHome
process.env.XDG_CONFIG_HOME = testConfigHome
mkdirSync(testDataHome, { recursive: true })
mkdirSync(testConfigHome, { recursive: true })

function buildConfig(permission: "allow" | "deny" = "allow"): PluginConfig {
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
            mode: "message",
            permission,
            showCompression: false,
            maxContextLimit: 150000,
            minContextLimit: 50000,
            nudgeFrequency: 5,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            protectedTools: [],
            protectTags: false,
            protectUserMessages: false,
            recoveryFadeWindow: 5,
        },
        strategies: {
            deduplication: { enabled: true, protectedTools: [] },
            purgeErrors: { enabled: true, turns: 4, protectedTools: [] },
        },
    }
}

function buildUserMessage(sessionID: string, text = "Keep this context."): WithParts {
    return {
        info: {
            id: `msg-user-${sessionID}`,
            role: "user",
            sessionID,
            agent: "assistant",
            model: { providerID: "anthropic", modelID: "claude-test" },
            time: { created: 1 },
        } as any,
        parts: [
            {
                id: `part-user-${sessionID}`,
                messageID: `msg-user-${sessionID}`,
                sessionID,
                type: "text",
                text,
            } as any,
        ],
    }
}

function buildToolMessage(sessionID: string, callID: string): WithParts {
    return {
        info: {
            id: `msg-tool-${callID}`,
            role: "assistant",
            sessionID,
            agent: "assistant",
            time: { created: 2 },
        } as any,
        parts: [
            {
                id: `part-step-${callID}`,
                messageID: `msg-tool-${callID}`,
                sessionID,
                type: "step-start",
            },
            {
                id: `part-tool-${callID}`,
                messageID: `msg-tool-${callID}`,
                sessionID,
                type: "tool",
                tool: "bash",
                callID,
                state: { status: "completed", input: { command: "pwd" }, output: "workspace" },
            } as any,
        ],
    }
}

function buildClient(messages: WithParts[], promptBodies: any[]): any {
    return {
        session: {
            messages: async () => ({ data: messages }),
            get: async () => ({ data: { parentID: null } }),
            prompt: async (request: any) => {
                promptBodies.push(request)
                return { data: undefined }
            },
        },
    }
}

function buildCommandContext(
    client: any,
    state: ReturnType<typeof createSessionState>,
    config: PluginConfig,
    sessionId: string,
    messages: WithParts[],
): any {
    return { client, state, config, logger: new Logger(false), sessionId, messages }
}

async function executeSlashCommand(
    command: string,
    args: string,
    config: PluginConfig = buildConfig(),
): Promise<{ state: ReturnType<typeof createSessionState>; output: any; prompts: any[] }> {
    const sessionId = `ses_slash_${command.replace(/\W/g, "_")}_${Date.now()}_${Math.random()}`
    const messages = [buildUserMessage(sessionId)]
    const prompts: any[] = []
    const client = buildClient(messages, prompts)
    const state = createSessionState()
    const output = { parts: [] as any[] }
    const handler = createCommandExecuteHandler(
        client,
        state,
        new Logger(false),
        config,
        process.cwd(),
        { global: undefined, agents: {} },
    )

    await handler({ command, sessionID: sessionId, arguments: args }, output)
    return { state, output, prompts }
}

// BUG-018: each of the user-facing command handlers is driven directly with
// the same mock OpenCode client shape used by command.execute.before.
test("BUG-018: /dcp manual on and off mutate state and inject notifications", async () => {
    const sessionId = `ses_manual_${Date.now()}_${Math.random()}`
    const state = createSessionState()
    state.sessionId = sessionId
    const messages = [buildUserMessage(sessionId)]
    const prompts: any[] = []
    const ctx = buildCommandContext(
        buildClient(messages, prompts),
        state,
        buildConfig(),
        sessionId,
        messages,
    )

    await handleManualToggleCommand(ctx, "on")
    assert.equal(state.userForced, true)
    assert.equal(state.manualMode, "active")
    assert.match(prompts.at(-1)?.body.parts[0].text ?? "", /Manual mode is now ON/)

    await handleManualToggleCommand(ctx, "off")
    assert.equal(state.userForced, false)
    assert.equal(state.manualMode, false)
    assert.match(prompts.at(-1)?.body.parts[0].text ?? "", /Manual mode is now OFF/)
})

test("BUG-018: /dcp stats returns an observable statistics response", async () => {
    const { prompts } = await executeSlashCommand("dcp", "stats")

    assert.equal(prompts.length, 1)
    assert.match(prompts[0]?.body.parts[0].text ?? "", /DCP Statistics/)
    assert.match(prompts[0]?.body.parts[0].text ?? "", /All-time:/)
})

test("BUG-018: /dcp context reports the current context breakdown", async () => {
    const { prompts } = await executeSlashCommand("dcp", "context")

    assert.equal(prompts.length, 1)
    assert.match(prompts[0]?.body.parts[0].text ?? "", /DCP Context Analysis/)
    assert.match(prompts[0]?.body.parts[0].text ?? "", /Current context:/)
})

test("BUG-018: /dcp help reports the command surface", async () => {
    const { prompts } = await executeSlashCommand("dcp", "help")

    assert.equal(prompts.length, 1)
    assert.match(prompts[0]?.body.parts[0].text ?? "", /DCP Commands/)
    assert.match(prompts[0]?.body.parts[0].text ?? "", /\/dcp-compress/)
})

test("BUG-018: /dcp sweep last-N marks the selected tool and reports the result", async () => {
    const sessionId = `ses_sweep_${Date.now()}_${Math.random()}`
    const messages = [buildUserMessage(sessionId), buildToolMessage(sessionId, "call-sweep")]
    const state = createSessionState()
    state.sessionId = sessionId
    const prompts: any[] = []

    await handleSweepCommand({
        ...buildCommandContext(
            buildClient(messages, prompts),
            state,
            buildConfig(),
            sessionId,
            messages,
        ),
        args: ["1"],
        workingDirectory: process.cwd(),
    })

    assert.equal(state.prune.tools.has("call-sweep"), true)
    assert.match(prompts[0]?.body.parts[0].text ?? "", /Swept the last 1 tool/)
})

test("BUG-018: /dcp-compress creates the transient pending trigger and rewrites parts", async () => {
    const { state, output, prompts } = await executeSlashCommand(
        "dcp-compress",
        "architecture focus",
    )

    assert.equal(state.manualMode, "compress-pending")
    assert.equal(state.pendingManualTrigger?.sessionId, state.sessionId)
    assert.match(state.pendingManualTrigger?.prompt ?? "", /architecture focus/)
    assert.deepEqual(output.parts, [{ type: "text", text: "/dcp-compress architecture focus" }])
    assert.equal(prompts.length, 0)
})

// Error/empty branches: notification failures are swallowed by the command
// boundary, while sweep reports the missing-user condition instead of mutating state.
test("BUG-018: command handlers cover notification failure and invalid/empty inputs", async () => {
    const sessionId = `ses_command_error_${Date.now()}_${Math.random()}`
    const state = createSessionState()
    state.sessionId = sessionId
    const messages = [buildUserMessage(sessionId)]
    const failingClient = {
        session: {
            prompt: async () => {
                throw new Error("mock prompt failure")
            },
        },
    }
    const config = buildConfig()
    const logger = new Logger(false)

    await assert.doesNotReject(() =>
        handleContextCommand(
            buildCommandContext(failingClient, state, config, sessionId, messages),
        ),
    )
    await assert.doesNotReject(() =>
        handleHelpCommand(buildCommandContext(failingClient, state, config, sessionId, messages)),
    )
    await assert.doesNotReject(() =>
        handleStatsCommand(buildCommandContext(failingClient, state, config, sessionId, messages)),
    )
    await assert.doesNotReject(() =>
        handleManualToggleCommand(
            buildCommandContext(failingClient, state, config, sessionId, messages),
            "unexpected",
        ),
    )

    const emptyPrompts: any[] = []
    await handleSweepCommand({
        client: buildClient([], emptyPrompts),
        state: createSessionState(),
        config,
        logger,
        sessionId,
        messages: [],
        args: [],
        workingDirectory: process.cwd(),
    })
    assert.match(emptyPrompts[0]?.body.parts[0].text ?? "", /no user message found/i)
})

test("BUG-018: disabled permission is an explicit command error path with no side effect", async () => {
    const { state, output, prompts } = await executeSlashCommand(
        "dcp-compress",
        "should not run",
        buildConfig("deny"),
    )

    assert.equal(state.pendingManualTrigger, null)
    assert.equal(state.manualMode, false)
    assert.deepEqual(output.parts, [])
    assert.equal(prompts.length, 0)
})

// Logic Verified: direct command handler coverage for manual, stats, context, help, sweep, and compress trigger paths.
// Bugs Documented: BUG-018-uncovered-slash-commands.md.
// Fakes Updated: in-memory OpenCode client captures session messages and ignored prompts.
// Review Status: pending implementer round.
