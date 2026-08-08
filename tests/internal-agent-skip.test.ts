import assert from "node:assert/strict"
import test from "node:test"
import { createSystemPromptHandler, isInternalAgentSystem } from "../lib/hooks"
import { createSessionState } from "../lib/state"
import { Logger } from "../lib/logger"

function buildConfig(): any {
    return {
        experimental: { allowSubAgents: false },
        compress: { permission: "allow", protectedTools: [] },
    }
}

function buildPrompts(): any {
    return {
        reload() {},
        getRuntimePrompts() {
            return {
                system: "DCP must not be injected into internal agents.",
                compressRange: "",
                compressMessage: "",
                contextLimitNudge: "",
                turnNudge: "",
                iterationNudge: "",
                manualExtension: "",
                subagentExtension: "",
            }
        },
    }
}

test("BUG-026: a title-generator substring remains classified as an internal agent", () => {
    assert.equal(
        isInternalAgentSystem(["OpenCode title-generator metadata: You are a title generator"]),
        true,
    )
})

test("BUG-026: internal-agent signatures tolerate whitespace, Unicode, and mixed case", () => {
    const variants = [
        "You are a title generator   \t",
        "You are a title generator\u00a0— résumé",
        "YOU ARE A TITLE GENERATOR\u00a0",
    ]

    for (const prompt of variants) {
        assert.equal(
            isInternalAgentSystem([prompt]),
            true,
            `internal title-generator prompt should be classified consistently: ${JSON.stringify(prompt)}`,
        )
    }
})

test("BUG-026: a quoted signature in an ordinary system prompt is not enough", () => {
    assert.equal(isInternalAgentSystem(["The user quoted: You are a title generator"]), false)
})

test("BUG-026: mixed-case internal signature prevents system-prompt injection", async () => {
    const state = createSessionState()
    const handler = createSystemPromptHandler(
        state,
        new Logger(false),
        buildConfig(),
        buildPrompts(),
    )
    const output = { system: ["YOU ARE A TITLE GENERATOR\u00a0"] }

    await handler({ model: { limit: { context: 100000 } } }, output)

    assert.deepEqual(output.system, ["YOU ARE A TITLE GENERATOR\u00a0"])
})

// Logic Verified: internal-agent signature preservation, edge-case classification, and injection skip behavior.
// Bugs Documented: BUG-026-internal-agent-signatures-brittle.md.
// Fakes Updated: minimal prompt store stub isolates the system hook from filesystem overrides.
// Review Status: pending implementer round.
