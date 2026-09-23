import assert from "node:assert/strict"
import test from "node:test"
import { isFilePathProtected, isProtectedByFilePatterns } from "../lib/protected-patterns"
import { createSessionState, type WithParts } from "../lib/state"
import { deduplicate } from "../lib/strategies/deduplication"
import { Logger } from "../lib/logger"

// Tests for `protectedFilePatternsTools: string[]` — the new top-level
// config key that scopes `protectedFilePatterns` to a tool allowlist
// (Item 5 of docs/IMPROVEMENT_PLAN_CACHE_STRATEGY.md).
//
// The helper under test is `isProtectedByFilePatterns` (lib/protected-patterns.ts);
// it is the single guard that decides whether a tool call's parameters match
// `protectedFilePatterns` AFTER a positive tool-allowlist check. Five callers
// (deduplicate, purgeErrors, sweep ×2, appendProtectedTools) now route through
// this helper instead of duplicating the inline getFilePathsFromParameters +
// isFilePathProtected pair. These tests pin the allowlist semantics; if a
// future change removes or inverts the `!protectedFilePatternsTools.includes(tool)`
// guard, the matching test must fail.

// Documented default from lib/config.ts defaultConfig (the private
// `defaultConfig` is intentionally not exported, so the constant below is the
// only public anchor for the v2 default — change it here AND in lib/config.ts
// if a future version widens the allowlist).
const DEFAULT_PROTECTED_FILE_PATTERNS_TOOLS = ["read", "write", "edit", "apply_patch", "multiedit"]

const PLANS_PATTERN = "**/plans/**"
const PLANS_PATH = "/x/plans/y.md"

// ────────────────────────────────────────────────────────────────────────────
// 1. Default allowlist preserves current behaviour
// ────────────────────────────────────────────────────────────────────────────

test("isProtectedByFilePatterns with default allowlist protects a write to a matching plan path", () => {
    const protected_ = isProtectedByFilePatterns(
        "write",
        { filePath: PLANS_PATH },
        [PLANS_PATTERN],
        DEFAULT_PROTECTED_FILE_PATTERNS_TOOLS,
    )

    assert.equal(protected_, true)
})

// ────────────────────────────────────────────────────────────────────────────
// 2. Narrowed allowlist unprotects out-of-scope tools
// ────────────────────────────────────────────────────────────────────────────

test("isProtectedByFilePatterns with [read] unprotects a write to a matching plan path", () => {
    const protected_ = isProtectedByFilePatterns(
        "write",
        { filePath: PLANS_PATH },
        [PLANS_PATTERN],
        ["read"],
    )

    assert.equal(
        protected_,
        false,
        "write is not in the [read] allowlist, so file-pattern protection must not fire",
    )
})

test("isProtectedByFilePatterns with [read] still protects a read of a matching plan path", () => {
    const protected_ = isProtectedByFilePatterns(
        "read",
        { filePath: PLANS_PATH },
        [PLANS_PATTERN],
        ["read"],
    )

    assert.equal(protected_, true, "read is in scope and the path matches the pattern")
})

// ────────────────────────────────────────────────────────────────────────────
// 3. Empty allowlist disables pattern protection entirely
// ────────────────────────────────────────────────────────────────────────────

test("isProtectedByFilePatterns with [] disables protection for every tool", () => {
    const readProtected = isProtectedByFilePatterns(
        "read",
        { filePath: PLANS_PATH },
        [PLANS_PATTERN],
        [],
    )
    const writeProtected = isProtectedByFilePatterns(
        "write",
        { filePath: PLANS_PATH },
        [PLANS_PATTERN],
        [],
    )

    assert.equal(readProtected, false, "empty allowlist must not protect read")
    assert.equal(writeProtected, false, "empty allowlist must not protect write")
})

// ────────────────────────────────────────────────────────────────────────────
// Negative-path sanity: same tool/path with no patterns is a no-op
// ────────────────────────────────────────────────────────────────────────────

test("isProtectedByFilePatterns returns false when patterns list is empty regardless of allowlist", () => {
    const protected_ = isProtectedByFilePatterns(
        "write",
        { filePath: PLANS_PATH },
        [],
        DEFAULT_PROTECTED_FILE_PATTERNS_TOOLS,
    )

    assert.equal(protected_, false, "no patterns means nothing to match")
})

// ────────────────────────────────────────────────────────────────────────────
// Regression guard: isFilePathProtected (the inner helper) still answers
// directly when given an explicit filePath list — the new wrapper composes
// it with the tool-allowlist gate.
// ────────────────────────────────────────────────────────────────────────────

test("isFilePathProtected still answers true for a single matching POSIX path", () => {
    assert.equal(isFilePathProtected([PLANS_PATH], [PLANS_PATTERN]), true)
})

// ────────────────────────────────────────────────────────────────────────────
// 4. Integration-style: deduplicate marks a write for prune when the
//    narrowed allowlist excludes the write tool.
// ────────────────────────────────────────────────────────────────────────────

function buildConfigWithProtectedFilePatternsTools(tools: string[]) {
    return {
        enabled: true,
        debug: false,
        pruneNotification: "off",
        pruneNotificationType: "chat",
        commands: { enabled: true, protectedTools: [] },
        manualMode: { enabled: false, automaticStrategies: true },
        turnProtection: { enabled: false, turns: 4 },
        experimental: { allowSubAgents: false, customPrompts: false },
        protectedFilePatterns: [PLANS_PATTERN],
        protectedFilePatternsTools: tools,
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
            protectUserMessagesCount: 1,
        },
        strategies: {
            deduplication: { enabled: true, protectedTools: [] },
            purgeErrors: { enabled: true, turns: 4, protectedTools: [] },
        },
    } as any
}

function userMsg(id: string, created: number): WithParts {
    return {
        info: {
            id,
            role: "user",
            sessionID: "ses_protected_file_patterns_tools",
            agent: "assistant",
            model: { providerID: "anthropic", modelID: "test" },
            time: { created },
        } as any,
        parts: [{ type: "text", text: "u" } as any],
    }
}

function assistantToolMsg(
    id: string,
    callID: string,
    tool: string,
    parameters: Record<string, unknown>,
    created: number,
): WithParts {
    return {
        info: {
            id,
            role: "assistant",
            sessionID: "ses_protected_file_patterns_tools",
            agent: "assistant",
            time: { created },
        } as any,
        parts: [
            {
                id: `prt-${id}`,
                messageID: id,
                sessionID: "ses_protected_file_patterns_tools",
                type: "tool",
                tool,
                callID,
                state: { status: "completed", input: parameters, output: "ok" },
            } as any,
        ],
    }
}

const logger = new Logger(false)

test("deduplicate marks a write to a plan file for prune when protectedFilePatternsTools excludes write", () => {
    // Two duplicate `write` tool calls to /x/plans/y.md. With
    // protectedFilePatternsTools=["read"], the write tool is NOT in scope,
    // so isProtectedByFilePaths lets the call through to the dedup marker
    // and the older duplicate is marked for pruning.
    const state = createSessionState()
    state.toolIdList = []

    const rawMessages: WithParts[] = [
        userMsg("u-1", 1),
        assistantToolMsg("a-1", "call-write-1", "write", { filePath: PLANS_PATH }, 2),
        userMsg("u-2", 3),
        assistantToolMsg("a-2", "call-write-2", "write", { filePath: PLANS_PATH }, 4),
    ]
    state.toolParameters.set("call-write-1", {
        tool: "write",
        parameters: { filePath: PLANS_PATH },
        turn: 1,
    })
    state.toolParameters.set("call-write-2", {
        tool: "write",
        parameters: { filePath: PLANS_PATH },
        turn: 2,
    })

    deduplicate(state, logger, buildConfigWithProtectedFilePatternsTools(["read"]), rawMessages)

    assert.ok(
        state.prune.tools.has("call-write-1"),
        "older write duplicate must be marked for pruning because write is out of the [read] scope",
    )
})

test("deduplicate spares a write to a plan file when protectedFilePatternsTools includes write (default)", () => {
    // Same fixture, but with the full default allowlist — write IS in scope,
    // so the file-pattern check protects the call and dedup never marks it.
    const state = createSessionState()
    state.toolIdList = []

    const rawMessages: WithParts[] = [
        userMsg("u-1", 1),
        assistantToolMsg("a-1", "call-write-1", "write", { filePath: PLANS_PATH }, 2),
        userMsg("u-2", 3),
        assistantToolMsg("a-2", "call-write-2", "write", { filePath: PLANS_PATH }, 4),
    ]
    state.toolParameters.set("call-write-1", {
        tool: "write",
        parameters: { filePath: PLANS_PATH },
        turn: 1,
    })
    state.toolParameters.set("call-write-2", {
        tool: "write",
        parameters: { filePath: PLANS_PATH },
        turn: 2,
    })

    deduplicate(
        state,
        logger,
        buildConfigWithProtectedFilePatternsTools(DEFAULT_PROTECTED_FILE_PATTERNS_TOOLS),
        rawMessages,
    )

    assert.equal(
        state.prune.tools.has("call-write-1"),
        false,
        "write duplicate must NOT be marked when write is in the allowlist and the path matches",
    )
})
// Logic Verified: isProtectedByFilePatterns gates pattern protection on `protectedFilePatternsTools.includes(tool)` first, then delegates to isFilePathProtected; the default allowlist preserves the legacy behaviour for read/write/edit/apply_patch/multiedit; narrowing to ["read"] unprotects every other tool; [] disables protection entirely; deduplicate observes the same gate via the five call sites that route through the helper.
// Bugs Documented: none.
// Fakes Updated: none
// Review Status: pending independent review.
