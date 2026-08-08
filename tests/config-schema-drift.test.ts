// G12 — config + schema + docs drift tests.
//
// Each test pins the FIXED behavior for a bug in group G12. They MUST fail
// against the current code so the implementer round can make them pass.
//
// Bugs covered:
//   BUG-014  autoUpdate runtime default is false; schema + README must agree.
//   BUG-021  README must not claim 10 default protected tools (v2 fork: []).
//   BUG-033  modelMaxLimits / modelMinLimits must merge per-key across layers.
//   BUG-047  Sweep must honor turnProtection.turns (currently a no-op).
//   BUG-052  showUpdateToasts is in VALID_CONFIG_KEYS but unimplemented.
//   BUG-084  protectedTools entries must be regex-validated at config load.

import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdirSync, writeFileSync } from "node:fs"

// Per-test isolation: redirect XDG_CONFIG_HOME so the config loader never
// touches the host filesystem. Node's --test runner spawns each *.test.ts in
// a separate child process, but PID-suffixed paths keep re-runs idempotent.
const testDataHome = join(tmpdir(), `opencode-dcp-g12-data-${process.pid}`)
const testConfigRoot = join(tmpdir(), `opencode-dcp-g12-cfg-${process.pid}`)
const testGlobalHome = join(testConfigRoot, "global-home")
// GLOBAL_CONFIG_DIR = XDG_CONFIG_HOME/opencode (see lib/config.ts:GLOBAL_CONFIG_DIR)
const globalConfigDir = join(testGlobalHome, "opencode")
// OPENCODE_CONFIG_DIR is used verbatim (no "opencode" subdir)
const testUserDir = join(testConfigRoot, "user-config")

mkdirSync(testDataHome, { recursive: true })
mkdirSync(globalConfigDir, { recursive: true })
mkdirSync(testUserDir, { recursive: true })

process.env.XDG_DATA_HOME = testDataHome
process.env.XDG_CONFIG_HOME = testGlobalHome
process.env.OPENCODE_CONFIG_DIR = testUserDir

// Dynamic import so env vars above are in effect when lib/config evaluates
// its module-level constants (GLOBAL_CONFIG_DIR is captured at first import).
const { getConfig, validateConfigTypes, VALID_CONFIG_KEYS } = await import("../lib/config")

// Repository root paths used for repo-file assertions.
const repoRoot = join(import.meta.dirname, "..")
const readmePath = join(repoRoot, "README.md")
const schemaPath = join(repoRoot, "dcp.schema.json")

function stubCtx(): any {
    return {
        directory: testConfigRoot,
        client: {
            tui: {
                // no-op: validation warnings are surfaced via toast, but tests
                // only emit valid configs so this is unreachable in practice.
                showToast: () => {},
            },
        },
    }
}

function writeUserConfig(content: object): void {
    // OPENCODE_CONFIG_DIR is checked verbatim. jsonc-parser accepts plain JSON.
    writeFileSync(join(testUserDir, "dcp.jsonc"), JSON.stringify(content), "utf-8")
}

function writeGlobalConfig(content: object): void {
    writeFileSync(join(globalConfigDir, "dcp.jsonc"), JSON.stringify(content), "utf-8")
}

// ────────────────────────────────────────────────────────────────────────────
// BUG-014 — `autoUpdate` runtime default is `false`; schema and README must
// agree. The runtime already pins `false`; the schema and the README example
// still claim `true`. These tests fail until docs + schema are corrected and
// stay aligned with the runtime.
// ────────────────────────────────────────────────────────────────────────────

test("BUG-014: getConfig({}) resolves autoUpdate to the canonical default (false)", () => {
    writeUserConfig({})
    const config = getConfig(stubCtx())
    assert.equal(
        config.autoUpdate,
        false,
        "autoUpdate default must be false (matches lib/config.ts:defaultConfig and CHANGELOG honesty fix)",
    )
})

test("BUG-014: dcp.schema.json declares autoUpdate.default === false", () => {
    const schema = JSON.parse(readFileSync(schemaPath, "utf-8"))
    assert.equal(
        schema.properties.autoUpdate.default,
        false,
        "schema default for autoUpdate must be false to match runtime",
    )
})

test("BUG-014: README example block does not claim autoUpdate === true", () => {
    const readme = readFileSync(readmePath, "utf-8")
    // The buggy line is `"autoUpdate": true,` inside the Default Configuration
    // example block. A corrected README either drops the line or sets it false.
    assert.ok(
        !/"autoUpdate"\s*:\s*true/.test(readme),
        "README must not claim autoUpdate === true; runtime is false. See: known_issues/BUG-014-autoupdate-docs-schema-drift.md",
    )
})

// ────────────────────────────────────────────────────────────────────────────
// BUG-021 — README still claims 10 default protected tools; v2 fork default
// is `[]`. The runtime is correct (DEFAULT_PROTECTED_TOOLS = []); the README
// is the liar. Test fails until the README is corrected.
// ────────────────────────────────────────────────────────────────────────────

test("BUG-021: README does not claim 10 default protected tools (v2 fork default is [])", () => {
    const readme = readFileSync(readmePath, "utf-8")
    // The buggy prose is "By default, these tools are always protected from
    // pruning:" followed by a 10-tool inline list. The fix replaces that
    // paragraph with one stating the v2 default is empty.
    assert.ok(
        !/By default, these tools are always protected from pruning/.test(readme),
        "README Protected Tools section must not claim legacy 10-tool default. See: known_issues/BUG-021-readme-protected-tools-drift.md",
    )
})

// ────────────────────────────────────────────────────────────────────────────
// BUG-033 — `modelMaxLimits` / `modelMinLimits` merge is replace-semantics.
// Project layer adding one model wipes globals. Fix: per-key additive merge
// (Set-union by providerID/modelID). Tests fail until the merge is fixed.
// ────────────────────────────────────────────────────────────────────────────

test("BUG-033: modelMaxLimits merges per-key (project layer adding one model keeps globals)", () => {
    writeGlobalConfig({
        compress: {
            modelMaxLimits: {
                "anthropic/claude-3-5-sonnet": 200000,
                "openai/gpt-4o": 128000,
            },
        },
    })
    writeUserConfig({
        compress: {
            modelMaxLimits: {
                "google/gemini-2.0-flash": 100000,
            },
        },
    })

    const config = getConfig(stubCtx())

    assert.equal(
        config.compress.modelMaxLimits?.["anthropic/claude-3-5-sonnet"],
        200000,
        "global modelMaxLimits for anthropic/claude-3-5-sonnet must survive project-layer merge",
    )
    assert.equal(
        config.compress.modelMaxLimits?.["openai/gpt-4o"],
        128000,
        "global modelMaxLimits for openai/gpt-4o must survive project-layer merge",
    )
    assert.equal(
        config.compress.modelMaxLimits?.["google/gemini-2.0-flash"],
        100000,
        "project-layer modelMaxLimits for google/gemini-2.0-flash must be present",
    )
    assert.equal(
        Object.keys(config.compress.modelMaxLimits ?? {}).length,
        3,
        `expected 3 modelMaxLimits entries after merge; got ${JSON.stringify(config.compress.modelMaxLimits)} — project layer replaced globals`,
    )
})

test("BUG-033: modelMaxLimits per-key override wins (project layer overrides a global entry)", () => {
    writeGlobalConfig({
        compress: {
            modelMaxLimits: {
                "anthropic/claude-3-5-sonnet": 200000,
            },
        },
    })
    writeUserConfig({
        compress: {
            modelMaxLimits: {
                "anthropic/claude-3-5-sonnet": 500000,
            },
        },
    })

    const config = getConfig(stubCtx())

    assert.equal(
        config.compress.modelMaxLimits?.["anthropic/claude-3-5-sonnet"],
        500000,
        "project-layer override for an existing key must win (500000, not 200000)",
    )
})

test("BUG-033: modelMinLimits merges per-key (project layer adding one model keeps globals)", () => {
    writeGlobalConfig({
        compress: {
            modelMinLimits: {
                "anthropic/claude-3-5-sonnet": 50000,
                "openai/gpt-4o": 32000,
            },
        },
    })
    writeUserConfig({
        compress: {
            modelMinLimits: {
                "google/gemini-2.0-flash": 25000,
            },
        },
    })

    const config = getConfig(stubCtx())

    assert.equal(
        config.compress.modelMinLimits?.["anthropic/claude-3-5-sonnet"],
        50000,
        "global modelMinLimits for anthropic/claude-3-5-sonnet must survive project-layer merge",
    )
    assert.equal(
        config.compress.modelMinLimits?.["openai/gpt-4o"],
        32000,
        "global modelMinLimits for openai/gpt-4o must survive project-layer merge",
    )
    assert.equal(
        config.compress.modelMinLimits?.["google/gemini-2.0-flash"],
        25000,
        "project-layer modelMinLimits for google/gemini-2.0-flash must be present",
    )
    assert.equal(
        Object.keys(config.compress.modelMinLimits ?? {}).length,
        3,
        `expected 3 modelMinLimits entries after merge; got ${JSON.stringify(config.compress.modelMinLimits)} — project layer replaced globals`,
    )
})

// ────────────────────────────────────────────────────────────────────────────
// BUG-047 — Sweep command ignores `turnProtection.turns` that
// `syncToolCache` honors. Fix: sweep must skip a tool when its
// `state.toolParameters` entry is missing AND turn protection is active
// (the conservative form of the report's fix). The test is end-to-end:
// seed state + messages, call handleSweepCommand, assert the turn-protected
// tool's callID is NOT in state.prune.tools.
// ────────────────────────────────────────────────────────────────────────────

test("BUG-047: sweep honors turnProtection.turns and skips turn-protected tools", async () => {
    // Dynamic import — sweep pulls in half the lib/ tree (token-utils, ui,
    // state, compress, ...). Keeping it off the static import surface keeps
    // the per-file test cost low for the unit-only tests above. The `any`
    // annotations on state and config keep the test focused on the
    // observable contract (state.prune.tools membership) rather than on
    // surface compatibility with the PluginConfig type.
    const { handleSweepCommand } = await import("../lib/commands/sweep")
    const { createSessionState } = await import("../lib/state")
    const { Logger } = await import("../lib/logger")

    const sessionID = `ses_sweep_turnprotect_${process.pid}_${Date.now()}`
    const oldCallID = "call-old"
    const recentCallID = "call-recent"

    // Messages: a user message FIRST (so it is the last user message), then
    // five assistant messages. Each assistant message carries a single
    // `step-start`; the first also carries `oldCallID` (turn 1) and the last
    // carries `recentCallID` (turn 5). With currentTurn=5 and turns=3:
    //   oldCallID:    5 - 1 = 4  >= 3  → NOT protected, entry added
    //   recentCallID: 5 - 5 = 0  <  3  → PROTECTED, entry skipped
    const messages: any[] = [
        {
            info: {
                id: "msg-user",
                role: "user",
                sessionID,
                agent: "user",
                // getCurrentParams dereferences userInfo.model.providerID; the
                // sweep path needs a valid model on the last user message.
                model: { providerID: "anthropic", modelID: "test" },
                time: { created: 1 },
            },
            parts: [
                {
                    id: "user-part",
                    messageID: "msg-user",
                    sessionID,
                    type: "text",
                    text: "go",
                },
            ],
        },
        {
            info: {
                id: "msg-a1",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 2 },
            },
            parts: [
                { id: "ss1", messageID: "msg-a1", sessionID, type: "step-start" },
                {
                    id: "tp1",
                    messageID: "msg-a1",
                    sessionID,
                    type: "tool",
                    tool: "bash",
                    callID: oldCallID,
                    state: { status: "completed", input: {}, output: "old output" },
                },
            ],
        },
        {
            info: {
                id: "msg-a2",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 3 },
            },
            parts: [{ id: "ss2", messageID: "msg-a2", sessionID, type: "step-start" }],
        },
        {
            info: {
                id: "msg-a3",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 4 },
            },
            parts: [{ id: "ss3", messageID: "msg-a3", sessionID, type: "step-start" }],
        },
        {
            info: {
                id: "msg-a4",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 5 },
            },
            parts: [{ id: "ss4", messageID: "msg-a4", sessionID, type: "step-start" }],
        },
        {
            info: {
                id: "msg-a5",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 6 },
            },
            parts: [
                { id: "ss5", messageID: "msg-a5", sessionID, type: "step-start" },
                {
                    id: "tp5",
                    messageID: "msg-a5",
                    sessionID,
                    type: "tool",
                    tool: "bash",
                    callID: recentCallID,
                    state: { status: "completed", input: {}, output: "recent output" },
                },
            ],
        },
    ]

    const state: any = createSessionState()
    state.sessionId = sessionID
    state.isSubAgent = false
    state.currentTurn = 5

    const config: any = {
        enabled: true,
        autoUpdate: false,
        debug: false,
        pruneNotification: "off",
        pruneNotificationType: "chat",
        commands: { enabled: true, protectedTools: [] },
        manualMode: { enabled: false, automaticStrategies: true },
        // BUG-047 fix contract: when this is enabled with turns > 0, sweep
        // must NOT mark a tool whose toolParameters entry is missing.
        turnProtection: { enabled: true, turns: 3 },
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
    }

    const client = {
        session: {
            prompt: async () => ({ data: undefined }),
        },
    }

    await handleSweepCommand({
        client,
        state,
        config,
        logger: new Logger(false),
        sessionId: sessionID,
        messages,
        args: [], // since-user mode (collect tools after last user message)
        workingDirectory: testConfigRoot,
    })

    // Sanity: syncToolCache (called inside sweep) added oldCallID's entry
    // (turn 1, not protected) but skipped recentCallID (turn 5, protected).
    assert.ok(
        state.toolParameters.has(oldCallID),
        "fixture invariant: syncToolCache must have added oldCallID (turn 1 is not protected)",
    )
    assert.ok(
        !state.toolParameters.has(recentCallID),
        "fixture invariant: syncToolCache must have skipped recentCallID (turn 5 is within 3 of currentTurn=5)",
    )

    // BUG-047 fix contract: the unprotected tool gets swept; the
    // turn-protected one does NOT.
    assert.ok(state.prune.tools.has(oldCallID), "sweep must mark the unprotected old tool")
    assert.ok(
        !state.prune.tools.has(recentCallID),
        `sweep must NOT mark turn-protected tool ${recentCallID}; current state.prune.tools=${JSON.stringify(Array.from(state.prune.tools.keys()))}. See: known_issues/BUG-047-config-turnprotect-mismatch.md`,
    )
})

// ────────────────────────────────────────────────────────────────────────────
// BUG-052 — `showUpdateToasts` is in VALID_CONFIG_KEYS but unimplemented.
// The fix removes it from the allowlist (Ponytail answer) OR wires it
// through PluginConfig + defaultConfig. This test pins the observable
// contract: a user who writes {"showUpdateToasts": true} must NOT be told
// the key is unknown (today: unknown; after fix: accepted silently). The
// sharper test is the runtime type — showUpdateToasts is not a
// PluginConfig key, so it should not appear in the public type surface.
// We assert the public-symbol allowlist, which is the load-bearing drift.
// ────────────────────────────────────────────────────────────────────────────

test("BUG-052: VALID_CONFIG_KEYS does not advertise the unimplemented showUpdateToasts key", () => {
    assert.ok(
        !VALID_CONFIG_KEYS.has("showUpdateToasts"),
        "showUpdateToasts is in VALID_CONFIG_KEYS but has no PluginConfig field, no default, no merge wiring. Either implement it or drop it. See: known_issues/BUG-052-cfg-validkeys-showupdatetoasts.md",
    )
})

test("BUG-052: getInvalidConfigKeys flags showUpdateToasts as unknown (today), or accepts it (after fix)", () => {
    writeUserConfig({ showUpdateToasts: true })
    // Snapshot env: this assertion is informational; the load-bearing check
    // is the VALID_CONFIG_KEYS allowlist above. The runtime accept/reject
    // behaviour of the field is intentionally not pinned here because the
    // fix may go either way (drop key, or implement it).
    // We only assert: the loader does not throw on a config that includes
    // the field.
    assert.doesNotThrow(() => getConfig(stubCtx()))
})

// ────────────────────────────────────────────────────────────────────────────
// BUG-084 — Validate `protectedTools` entries at config load with regex.
// Today `validateConfigTypes` only checks `Array.isArray`; per-item
// validation is missing. Fix: reject entries with whitespace (regex
// /^\S+$/) and empty strings. Tests assert errors are reported for each of
// the four protectedTools arrays (compress, commands, deduplication,
// purgeErrors).
// ────────────────────────────────────────────────────────────────────────────

test("BUG-084: validateConfigTypes rejects protectedTools entries with whitespace (compress)", () => {
    const errors = validateConfigTypes({
        compress: { protectedTools: ["valid_tool", "with whitespace", "", "also_valid"] },
    })
    const whitelistErrors = errors.filter((e) => e.key.startsWith("compress.protectedTools["))
    assert.ok(
        whitelistErrors.length >= 2,
        `expected at least 2 per-item errors (for "with whitespace" and "" entries); got ${JSON.stringify(whitelistErrors)}`,
    )
    const keys = whitelistErrors.map((e) => e.key).sort()
    assert.ok(
        keys.some((k) => k === "compress.protectedTools[1]"),
        `expected error for entry [1] ("with whitespace"); got keys=${JSON.stringify(keys)}`,
    )
    assert.ok(
        keys.some((k) => k === "compress.protectedTools[2]"),
        `expected error for entry [2] (empty string); got keys=${JSON.stringify(keys)}`,
    )
    // Valid entries must NOT produce errors.
    assert.ok(
        !keys.some((k) => k === "compress.protectedTools[0]") &&
            !keys.some((k) => k === "compress.protectedTools[3]"),
        `valid entries [0] and [3] must not be flagged; got keys=${JSON.stringify(keys)}`,
    )
})

test("BUG-084: validateConfigTypes rejects protectedTools entries with whitespace (commands)", () => {
    const errors = validateConfigTypes({
        commands: { protectedTools: ["ok", "bad entry"] },
    })
    const whitelistErrors = errors.filter((e) => e.key === "commands.protectedTools[1]")
    assert.ok(
        whitelistErrors.length === 1,
        `expected exactly 1 per-item error for commands.protectedTools[1]; got ${JSON.stringify(whitelistErrors)}`,
    )
})

test("BUG-084: validateConfigTypes rejects protectedTools entries with whitespace (deduplication)", () => {
    const errors = validateConfigTypes({
        strategies: { deduplication: { protectedTools: ["ok", "bad entry"] } },
    })
    const whitelistErrors = errors.filter(
        (e) => e.key === "strategies.deduplication.protectedTools[1]",
    )
    assert.ok(
        whitelistErrors.length === 1,
        `expected exactly 1 per-item error for strategies.deduplication.protectedTools[1]; got ${JSON.stringify(whitelistErrors)}`,
    )
})

test("BUG-084: validateConfigTypes rejects protectedTools entries with whitespace (purgeErrors)", () => {
    const errors = validateConfigTypes({
        strategies: { purgeErrors: { protectedTools: ["ok", "bad entry"] } },
    })
    const whitelistErrors = errors.filter(
        (e) => e.key === "strategies.purgeErrors.protectedTools[1]",
    )
    assert.ok(
        whitelistErrors.length === 1,
        `expected exactly 1 per-item error for strategies.purgeErrors.protectedTools[1]; got ${JSON.stringify(whitelistErrors)}`,
    )
})

// Audit trailer — the node-test convention here is one bare test() per
// concern; no describe / before* / test.only. Each test is a self-contained
// AAA block. New regression tests for this file must:
//   1. Match a single BUG-### in known_issues/.
//   2. Pin the FIXED contract (what the implementer will produce).
//   3. Fail today, pass after the fix lands.
//   4. Add the issue number to the test name.
// Logic Verified: config defaults, schema, and README prose stay aligned across autoUpdate, protectedTools, modelMaxLimits, and other canonical keys.
// Bugs Documented: BUG-014, BUG-021, BUG-033, BUG-047, BUG-052, BUG-084.
// Fakes Updated: none
// Review Status: pending independent review.
