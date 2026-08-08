import test from "node:test"
import assert from "node:assert/strict"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdirSync, writeFileSync } from "node:fs"

// Per-test isolation: redirect XDG_CONFIG_HOME so the config loader never
// touches the host filesystem. Node's --test runner spawns each *.test.ts in
// a separate child process, so cross-file env-var leakage is not a concern,
// but we still use PID-suffixed paths so re-runs don't collide with stale
// fixtures on disk.
const testDataHome = join(tmpdir(), `opencode-dcp-config-merge-data-${process.pid}`)
const testConfigRoot = join(tmpdir(), `opencode-dcp-config-merge-cfg-${process.pid}`)
// GLOBAL_CONFIG_DIR = XDG_CONFIG_HOME/opencode (see lib/config.ts:GLOBAL_CONFIG_DIR)
const testGlobalHome = join(testConfigRoot, "global-home")
// OPENCODE_CONFIG_DIR is used verbatim (no "opencode" subdir)
const testUserDir = join(testConfigRoot, "user-config")

mkdirSync(testDataHome, { recursive: true })
mkdirSync(testGlobalHome, { recursive: true })
mkdirSync(testUserDir, { recursive: true })

process.env.XDG_DATA_HOME = testDataHome
process.env.XDG_CONFIG_HOME = testGlobalHome
process.env.OPENCODE_CONFIG_DIR = testUserDir

// Dynamic import so env vars above are in effect when lib/config evaluates
// its module-level constants (GLOBAL_CONFIG_DIR is captured at first import).
// Static imports of node:test / node:assert / node:fs are hoisted above this
// line — those don't touch lib/config, so the env vars are safe.
const { getConfig } = await import("../lib/config")

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

// ponytail: this file proves the new contract — protectedTools in the user's
// dcp.jsonc is the single source of truth. Pre-fix, the merge in
// mergeCompress / mergeCommands / mergeStrategies was additive and silently
// kept ["task","skill","todowrite","todoread"] alive. These tests fail loudly
// the moment any future change re-introduces that behavior.

// ────────────────────────────────────────────────────────────────────────────
// Regression: empty user override must not leak defaults
// ────────────────────────────────────────────────────────────────────────────

test("config-merge: user protectedTools: [] yields empty effective config", () => {
    writeUserConfig({
        compress: { protectedTools: [] },
        commands: { protectedTools: [] },
        strategies: {
            deduplication: { protectedTools: [] },
            purgeErrors: { protectedTools: [] },
        },
    })

    const config = getConfig(stubCtx())

    assert.deepEqual(
        config.compress.protectedTools,
        [],
        "compress.protectedTools must be [] when user provides []",
    )
    assert.deepEqual(
        config.commands.protectedTools,
        [],
        "commands.protectedTools must be [] when user provides []",
    )
    assert.deepEqual(
        config.strategies.deduplication.protectedTools,
        [],
        "deduplication.protectedTools must be [] when user provides []",
    )
    assert.deepEqual(
        config.strategies.purgeErrors.protectedTools,
        [],
        "purgeErrors.protectedTools must be [] when user provides []",
    )
})

// ────────────────────────────────────────────────────────────────────────────
// Regression: the original bug — user provides one entry, expects just that
// one, but pre-fix got [user, ...legacy default] silently merged in
// ────────────────────────────────────────────────────────────────────────────

test("config-merge: user protectedTools: ['task'] replaces defaults (length must be 1, not 4)", () => {
    writeUserConfig({
        compress: { protectedTools: ["task"] },
    })

    const config = getConfig(stubCtx())

    assert.equal(
        config.compress.protectedTools.length,
        1,
        `expected 1 entry (the user-provided ["task"]); got ${JSON.stringify(config.compress.protectedTools)} — defaults leaked back through`,
    )
    assert.deepEqual(config.compress.protectedTools, ["task"])
})

// ────────────────────────────────────────────────────────────────────────────
// No-user-config path: must not silently inject legacy defaults either
// ────────────────────────────────────────────────────────────────────────────

test("config-merge: no user override yields empty arrays (no hidden defaults)", () => {
    writeUserConfig({})

    const config = getConfig(stubCtx())

    assert.equal(
        config.compress.protectedTools.length,
        0,
        "compress.protectedTools must be empty without user override",
    )
    assert.equal(
        config.commands.protectedTools.length,
        0,
        "commands.protectedTools must be empty without user override",
    )
    assert.equal(
        config.strategies.deduplication.protectedTools.length,
        0,
        "deduplication.protectedTools must be empty without user override",
    )
    assert.equal(
        config.strategies.purgeErrors.protectedTools.length,
        0,
        "purgeErrors.protectedTools must be empty without user override",
    )
})
// Logic Verified: user `protectedTools: []` yields an empty effective config (replace-semantics, no hidden defaults).
// Bugs Documented: none.
// Fakes Updated: none
// Review Status: pending independent review.
