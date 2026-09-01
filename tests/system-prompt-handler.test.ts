import assert from "node:assert/strict"
import test from "node:test"
import { createSystemPromptHandler, isInternalAgentSystem } from "../lib/hooks"
import type { PluginConfig } from "../lib/config"
import { Logger } from "../lib/logger"
import { createSessionState } from "../lib/state"

function buildConfig(permission: "allow" | "ask" | "deny" = "allow"): PluginConfig {
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
    }
}

function buildPromptsStub() {
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

test("isInternalAgentSystem returns false when prompts include a normal system prompt", () => {
    const prompts = ["You are a title generator", "You are a helpful coding assistant"]
    assert.equal(isInternalAgentSystem(prompts), false)
})

test("isInternalAgentSystem returns true when every prompt matches an internal signature", () => {
    const prompts = [
        "You are a title generator",
        "You are a helpful AI assistant tasked with summarizing conversations",
    ]
    assert.equal(isInternalAgentSystem(prompts), true)
})

test("isInternalAgentSystem returns false for an empty prompt list", () => {
    assert.equal(isInternalAgentSystem([]), false)
})

test("system prompt handler injects when output.system mixes internal + normal prompts", async () => {
    const handler = createSystemPromptHandler(
        createSessionState(),
        new Logger(false),
        buildConfig("allow"),
        buildPromptsStub(),
    )

    const output = {
        system: [
            "You are a title generator for the conversation",
            "You are a helpful coding assistant. Follow user instructions.",
        ],
    }

    await handler({ model: { limit: { context: 100000 } } } as any, output)

    const last = output.system[output.system.length - 1] ?? ""
    assert.match(last, /DCP injected prompt/)
})

test("system prompt handler skips when every output.system prompt is internal", async () => {
    const handler = createSystemPromptHandler(
        createSessionState(),
        new Logger(false),
        buildConfig("allow"),
        buildPromptsStub(),
    )

    const output = {
        system: ["You are a title generator for the conversation"],
    }

    await handler({ model: { limit: { context: 100000 } } } as any, output)

    assert.equal(output.system.length, 1)
    assert.doesNotMatch(output.system[0] ?? "", /DCP injected prompt/)
})
// Logic Verified: isInternalAgentSystem detects internal signatures, and the system-prompt handler injects/skips DCP based on the mixed vs all-internal signature.
// Bugs Documented: none.
// Fakes Updated: none
// Review Status: pending independent review.
