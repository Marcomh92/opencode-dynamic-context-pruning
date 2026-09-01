import assert from "node:assert/strict"
import test from "node:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Per-test isolation: redirect the OpenCode plugin's config / state directories
// to temp paths so lib/config (and anything it touches on module load) never
// reaches the host filesystem. Node's --test runner spawns each *.test.ts in a
// separate child process; the PID suffix prevents stale fixtures across reruns.
const testDataHome = join(tmpdir(), `opencode-dcp-permgates-data-${process.pid}`)
const testConfigRoot = join(tmpdir(), `opencode-dcp-permgates-cfg-${process.pid}`)
const testGlobalHome = join(testConfigRoot, "global-home")
const testUserDir = join(testConfigRoot, "user-config")

mkdirSync(testDataHome, { recursive: true })
mkdirSync(testGlobalHome, { recursive: true })
mkdirSync(testUserDir, { recursive: true })

process.env.XDG_DATA_HOME = testDataHome
process.env.XDG_CONFIG_HOME = testGlobalHome
process.env.OPENCODE_CONFIG_DIR = testUserDir
// startAutoUpdate() reads this; with it set, the network probe in the plugin
// factory is inert (no fetch/abort noise under file:// install).
process.env.DCP_LOCAL_FORK = "1"

// Static imports of node:* modules are hoisted — they don't read env vars.
// Dynamic import of production modules below runs AFTER the env mutations
// above, which is what lib/config relies on (GLOBAL_CONFIG_DIR is captured
// at first import).
const { createChatMessageTransformHandler, createSystemPromptHandler } =
    await import("../lib/hooks")
const { Logger } = await import("../lib/logger")
const { createSessionState } = await import("../lib/state")
type WithParts = (typeof import("../lib/state"))["WithParts"]
const typeOnly = await import("../lib/config")
type PluginConfig = typeOnly.PluginConfig
const indexModule = await import("../index")
const server = indexModule.default

// ─── Shared fixtures ────────────────────────────────────────────────────────

function buildConfig(permission: "allow" | "ask" | "deny" = "allow"): PluginConfig {
    return {
        enabled: true,
        autoUpdate: false,
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
            permission,
            showCompression: false,
            maxContextLimit: 150000,
            minContextLimit: 50000,
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
    } as PluginConfig
}

function buildMessage(
    id: string,
    role: "user" | "assistant",
    text: string,
): WithParts {
    return {
        info: {
            id,
            role,
            sessionID: "session-1",
            agent: "assistant",
            time: { created: 1 },
        } as WithParts["info"],
        parts: [
            {
                id: `${id}-part`,
                messageID: id,
                sessionID: "session-1",
                type: "text",
                text,
            },
        ],
    }
}

function promptsStub() {
    return {
        reload() {},
        getRuntimePrompts() {
            return {
                system: "DCP injected prompt",
                compressRange: "",
                compressMessage: "",
                contextLimitNudge: "",
                turnNudge: "",
                iterationNudge: "",
                manualExtension: "",
                subagentExtension: "",
            }
        },
    } as any
}

function writeUserConfig(content: object): void {
    // OPENCODE_CONFIG_DIR is checked verbatim; jsonc-parser accepts plain JSON.
    writeFileSync(join(testUserDir, "dcp.jsonc"), JSON.stringify(content), "utf-8")
}

function stubCtx(directory: string): any {
    return {
        directory,
        client: {
            tui: {
                // no-op: validation warnings are surfaced via toast; this test
                // only emits valid configs, so the path is unreachable.
                showToast: () => {},
            },
        },
    }
}

// ────────────────────────────────────────────────────────────────────────────
// BUG-008 — `isInternalAgentSystem` honored in the message-transform handler
// ────────────────────────────────────────────────────────────────────────────

test("BUG-008: chat message transform is a no-op when the prior system prompt is an internal agent signature", async () => {
    // KNOWN BUG (BUG-008): The internal-agent gate is only applied in the
    // system-prompt handler. The message-transform handler runs the full
    // 13-step pipeline for internal-agent sessions, allocating message refs,
    // pruning, injecting IDs. The fix caches the last seen system prompts on
    // state and short-circuits the transform handler the same way
    // createSystemPromptHandler does.
    // See: known_issues/BUG-008-internal-agent-gate-missing.md

    const state = createSessionState()
    // The fix introduces `state.lastSystem: string[] | undefined` populated
    // by createSystemPromptHandler. We set it via `as any` to simulate the
    // case where the most recent system transform was an internal agent.
    ;(state as any).lastSystem = [
        "You are a title generator for the conversation",
    ]
    // Anchor a real session so checkSession / syncCompressPermissionState don't
    // re-initialize and clobber the simulated state.
    state.sessionId = "session-1"
    state.isSubAgent = false

    const handler = createChatMessageTransformHandler(
        { session: { get: async () => ({}) } } as any,
        state,
        new Logger(false),
        buildConfig("allow"),
        promptsStub(),
        { global: undefined, agents: {} },
    )

    const output = {
        messages: [
            buildMessage("assistant-1", "assistant", "alpha omega"),
            buildMessage("user-1", "user", "next turn"),
        ],
    }

    await handler({}, output)

    // Contract: the transform must NOT have touched message refs, allocation
    // counters, or compression-block bookkeeping for an internal-agent system.
    assert.equal(
        state.messageIds.byRawId.size,
        0,
        "internal-agent system must not allocate message refs",
    )
    assert.equal(
        state.messageIds.byRef.size,
        0,
        "internal-agent system must not populate byRef map",
    )
    assert.equal(
        state.messageIds.nextRef,
        1,
        "internal-agent system must not bump the nextRef counter",
    )
    assert.equal(
        state.prune.messages.blocksById.size,
        0,
        "internal-agent system must not allocate compression blocks",
    )
    assert.equal(
        state.prune.messages.nextBlockId,
        1,
        "internal-agent system must not bump nextBlockId",
    )

    // And the original message parts must remain free of any injected
    // message-id tags. Pre-fix the transform mutates user text parts to
    // append <dcp-message-id m-NNNN ...> tags.
    for (const message of output.messages) {
        for (const part of message.parts) {
            if (part.type === "text") {
                assert.doesNotMatch(
                    part.text,
                    /dcp-message-id/,
                    "internal-agent system must not inject message-id tags into message text",
                )
            }
        }
    }
})

// ────────────────────────────────────────────────────────────────────────────
// BUG-013 — `config()` hook must NOT mutate user `compress.permission`
// ────────────────────────────────────────────────────────────────────────────

test("BUG-013: user explicit `compress.permission: 'allow'` survives host *:deny + compress: deny", async () => {
    // KNOWN BUG (BUG-013): The config() hook in index.ts mutates
    // config.compress.permission = "deny" whenever the host denies, even when
    // the user has explicitly opted in via dcp.jsonc. The mutation is sticky
    // and silently unregisters the tool, slash commands, primary_tools, and
    // permission entries. The fix derives a local effectiveDenied boolean and
    // leaves the user's config object untouched.
    // See: known_issues/BUG-013-perm-deny-overwrites-user-allow.md

    writeUserConfig({ compress: { permission: "allow" } })

    const hooks = await (server as any)(stubCtx(testConfigRoot))
    const configHook = hooks.config

    assert.equal(
        typeof configHook,
        "function",
        "plugin factory must expose a config() hook",
    )

    const opencodeConfig: any = {
        permission: { "*": "deny", compress: "deny" },
    }

    await configHook(opencodeConfig)

    // Observable side-effects when the user's `allow` is preserved:
    //   * slash commands are added to opencodeConfig.command
    //   * `compress` is added to opencodeConfig.experimental.primary_tools
    //   * opencodeConfig.permission.compress mirrors the user's allow (not
    //     the host's deny)
    //
    // Pre-fix, the config() hook sets `config.compress.permission = "deny"`
    // on the shared user-config object before these checks, so the slash
    // commands are NOT added and the permission entry mirrors "deny".
    assert.ok(
        opencodeConfig.command && opencodeConfig.command.dcp,
        "user explicit `allow` must keep the /dcp slash command registered despite host deny",
    )
    assert.ok(
        opencodeConfig.command && opencodeConfig.command["dcp-compress"],
        "user explicit `allow` must keep the /dcp-compress slash command registered despite host deny",
    )
    const primaryTools: string[] =
        opencodeConfig.experimental?.primary_tools ?? []
    assert.ok(
        primaryTools.includes("compress"),
        `user explicit \`allow\` must keep \`compress\` in primary_tools (got ${JSON.stringify(primaryTools)})`,
    )
    assert.equal(
        opencodeConfig.permission?.compress,
        "allow",
        `user explicit \`allow\` must survive host deny; opencodeConfig.permission.compress was ${JSON.stringify(opencodeConfig.permission?.compress)}`,
    )
})

// ────────────────────────────────────────────────────────────────────────────
// BUG-035 — First-injection of a session in the system-prompt handler honors
// host permission check
// ────────────────────────────────────────────────────────────────────────────

test("BUG-035: first-injection system prompt respects host `compress: deny` even with user `allow`", async () => {
    // KNOWN BUG (BUG-035): createSystemPromptHandler resolves effective
    // permission by short-circuiting on `state.sessionId === input.sessionID`.
    // On the very first transform of a session, state.sessionId is null, so
    // the predicate falls through to the raw config.compress.permission —
    // skipping the host-permission check entirely. The fix calls
    // resolveEffectiveCompressPermission(config.compress.permission,
    // hostPermissions) at the top of the handler so the first injection of
    // any session is gated by the host's opencode.json permission rules.
    // See: known_issues/BUG-035-hook-perm-first-injection-gap.md
    // (Architect-narrowed: per-agent rules also matter; this test asserts
    // the narrow global-rule gap, which is what reproduces today.)

    const state = createSessionState()
    // Deliberately NOT set state.sessionId — leave it null. This is the
    // first-injection branch: `state.sessionId !== input.sessionID`.
    assert.equal(state.sessionId, null)

    const config = buildConfig("allow")
    const hostPermissions = {
        global: { "*": "deny", compress: "deny" },
        agents: {},
    }

    // The fix introduces a hostPermissions parameter to
    // createSystemPromptHandler. Current signature takes only 4 args; cast
    // the factory to any so this test can compile against both signatures
    // (the extra arg is ignored pre-fix, used post-fix).
    const handler = (createSystemPromptHandler as any)(
        state,
        new Logger(false),
        config,
        promptsStub(),
        hostPermissions,
    )

    const basePrompt = "You are a helpful coding assistant."
    const output = { system: [basePrompt] }

    await handler(
        {
            sessionID: "session-first",
            model: { limit: { context: 100000 } },
        } as any,
        output,
    )

    // Contract: the system prompt must NOT have been augmented with the
    // DCP-injected tail. Pre-fix the handler uses raw config.compress.permission
    // (= "allow") and short-circuits the host check, so DCP IS injected.
    assert.equal(output.system.length, 1, "exactly one system prompt expected")
    assert.equal(
        output.system[0],
        basePrompt,
        `first injection must not append DCP prompt when host denies compress; got: ${JSON.stringify(output.system[0])}`,
    )
    assert.doesNotMatch(
        output.system[0],
        /DCP injected prompt/,
        "first injection must not include DCP prompt text when host denies compress",
    )
})

// ─── Footer ─────────────────────────────────────────────────────────────────

// Logic Verified:
//   * BUG-008: chat-message-transform handler short-circuits for internal
//     agent systems (DPP-009 partial coverage).
//   * BUG-013: user `compress.permission: "allow"` survives host `*:deny`
//     without being mutated by the config() hook (DPP-010 invariant).
//   * BUG-035: first-injection of a session in the system-prompt handler
//     honors the host permission check (narrower-than-reported scope).
//
// Bugs Documented: BUG-008, BUG-013, BUG-035.
//
// Fakes Updated: none.
//
// Review Status: tests written pre-implementer; expected to fail in current
// code and pass after the corresponding fixes land.
// Logic Verified: chat-message transform short-circuits for internal agent systems, user explicit `allow` survives host `*:deny`, and first-injection system prompt respects host `compress: deny`.
// Bugs Documented: BUG-008, BUG-013, BUG-035.
// Fakes Updated: none
// Review Status: pending independent review.
