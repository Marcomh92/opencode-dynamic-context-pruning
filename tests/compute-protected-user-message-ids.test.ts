import assert from "node:assert/strict"
import test from "node:test"
import type { PluginConfig } from "../lib/config"
import { computeProtectedUserMessageIds } from "../lib/messages/query"
import type { WithParts } from "../lib/state"

// BUG-096 — `computeProtectedUserMessageIds(config, messages)` is the single
// source of truth for the set of message IDs that should be treated as
// "protected user messages" under the last-N semantics. It returns a
// `Set<string>` of IDs; an empty set means "no protection applied".
//
// Contract pins (see `lib/messages/query.ts:111-137`):
//   - `protectUserMessages: false` → empty set regardless of count.
//   - Walks messages right-to-left; collects up to `count` real user
//     message IDs and stops at N hits.
//   - Synthetic (`part.synthetic: true`) and ignored (`part.ignored: true`)
//     user messages are skipped via `isIgnoredUserMessage` and do not
//     count toward N.
//   - `protectUserMessagesCount ?? 1` is the default; floor + max(1, ...)
//     clamps `0`, negatives, non-finite values, and fractions.
//   - Non-string `info.id` values are skipped (the `isMessageWithInfo`
//     type guard rejects them, so the message is skipped wholesale).
//   - Mixed roles — only `info.role === "user"` counts; assistant messages
//     are walked past without contributing to the set.
//   - Duplicate IDs are deduplicated by the `Set` constructor.

const SESSION = "ses_compute_protected_user_message_ids"

// ────────────────────────────────────────────────────────────────────────────
// Fixtures (mirror `tests/message-utils.test.ts:6-34` and
// `tests/protected-user-messages-count.test.ts:21-87`)
// ────────────────────────────────────────────────────────────────────────────

function buildMessage(
    role: "user" | "assistant",
    parts: WithParts["parts"],
    id: string,
): WithParts {
    const info =
        role === "user"
            ? {
                  id,
                  role,
                  sessionID: SESSION,
                  agent: "assistant",
                  model: { providerID: "anthropic", modelID: "claude-test" },
                  time: { created: 1 },
              }
            : {
                  id,
                  role,
                  sessionID: SESSION,
                  agent: "assistant",
                  time: { created: 1 },
              }

    return {
        info: info as WithParts["info"],
        parts,
    }
}

function userMessage(
    id: string,
    text: string,
    opts: { synthetic?: boolean; ignored?: boolean } = {},
): WithParts {
    const part: any = {
        id: `${id}-part`,
        sessionID: SESSION,
        messageID: id,
        type: "text",
        text,
    }
    if (opts.synthetic !== undefined) part.synthetic = opts.synthetic
    if (opts.ignored !== undefined) part.ignored = opts.ignored
    return buildMessage("user", [part], id)
}

function assistantMessage(id: string, text: string): WithParts {
    return buildMessage(
        "assistant",
        [
            {
                id: `${id}-part`,
                sessionID: SESSION,
                messageID: id,
                type: "text",
                text,
            },
        ],
        id,
    )
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
        experimental: { allowSubAgents: false, customPrompts: false, inheritOnFork: true },
        protectedFilePatterns: [],
        compress: {
            mode: "message",
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
            // Default is left undefined so test cases that exercise the
            // `protectUserMessagesCount ?? 1` branch can rely on the
            // production default. Individual tests override it.
            protectUserMessages: false,
            stripPatterns: [],
            maxCompactionRatio: 0.7,
            maxContextLimitRecovery: 3,
            recoveryFadeWindow: 5,
            forkSchemaVersion: 3,
            stateMaxAgeDays: null,
            stateRetentionDays: null,
        },
        strategies: {
            deduplication: { enabled: true, protectedTools: [] },
            purgeErrors: { enabled: true, turns: 4, protectedTools: [] },
        },
    }
}

// ────────────────────────────────────────────────────────────────────────────
// A. `protectUserMessages: false` short-circuits
// ────────────────────────────────────────────────────────────────────────────

test("computeProtectedUserMessageIds: protectUserMessages=false returns an empty set even with count=1", () => {
    const config = buildConfig()
    config.compress.protectUserMessages = false
    config.compress.protectUserMessagesCount = 1

    const messages = [
        userMessage("u-1", "msg-1"),
        userMessage("u-2", "msg-2"),
        userMessage("u-3", "msg-3"),
    ]

    const result = computeProtectedUserMessageIds(config, messages)
    assert.equal(result.size, 0, "protection disabled → empty set regardless of count")
    assert.ok(!result.has("u-3"), "no IDs are included when protectUserMessages is false")
})

// ────────────────────────────────────────────────────────────────────────────
// B. Default count = 1 (production default)
// ────────────────────────────────────────────────────────────────────────────

test("computeProtectedUserMessageIds: default count returns only the last real user message", () => {
    const config = buildConfig()
    config.compress.protectUserMessages = true
    config.compress.protectUserMessagesCount = undefined

    const messages = [
        userMessage("u-1", "msg-1"),
        userMessage("u-2", "msg-2"),
        userMessage("u-3", "msg-3"),
    ]

    const result = computeProtectedUserMessageIds(config, messages)
    assert.deepEqual([...result], ["u-3"], "only the last real user message ID is in the set")
})

// ────────────────────────────────────────────────────────────────────────────
// C. count=5 with 5 available
// ────────────────────────────────────────────────────────────────────────────

test("computeProtectedUserMessageIds: count=5 returns all 5 IDs when 5 real user messages exist", () => {
    const config = buildConfig()
    config.compress.protectUserMessages = true
    config.compress.protectUserMessagesCount = 5

    const ids = ["u-1", "u-2", "u-3", "u-4", "u-5"]
    const messages = ids.map((id) => userMessage(id, `msg-${id.slice(2)}`))

    const result = computeProtectedUserMessageIds(config, messages)
    assert.equal(result.size, 5, "all 5 IDs are in the set")
    for (const id of ids) {
        assert.ok(result.has(id), `${id} is in the set under count=5`)
    }
})

// ────────────────────────────────────────────────────────────────────────────
// D. count > available
// ────────────────────────────────────────────────────────────────────────────

test("computeProtectedUserMessageIds: count=10 with only 2 user messages returns both IDs", () => {
    const config = buildConfig()
    config.compress.protectUserMessages = true
    config.compress.protectUserMessagesCount = 10

    const messages = [userMessage("u-1", "msg-1"), userMessage("u-2", "msg-2")]

    const result = computeProtectedUserMessageIds(config, messages)
    assert.equal(result.size, 2, "both IDs are in the set when count exceeds available")
    assert.ok(result.has("u-1"))
    assert.ok(result.has("u-2"))
})

// ────────────────────────────────────────────────────────────────────────────
// E. count=0 clamps to 1 via `?? 1` + `Math.max(1, Math.floor(...))`
// ────────────────────────────────────────────────────────────────────────────

test("computeProtectedUserMessageIds: count=0 clamps to 1 (returns the last 1 only)", () => {
    const config = buildConfig()
    config.compress.protectUserMessages = true
    config.compress.protectUserMessagesCount = 0

    const messages = [
        userMessage("u-1", "msg-1"),
        userMessage("u-2", "msg-2"),
        userMessage("u-3", "msg-3"),
    ]

    const result = computeProtectedUserMessageIds(config, messages)
    assert.equal(result.size, 1, "count=0 is clamped to 1 (Math.max(1, Math.floor(0)) === 1)")
    assert.deepEqual([...result], ["u-3"], "only the last user message is in the set")
})

// ────────────────────────────────────────────────────────────────────────────
// F. Negative count clamps to 1
// ────────────────────────────────────────────────────────────────────────────

test("computeProtectedUserMessageIds: count=-3 clamps to 1 (returns the last 1 only)", () => {
    const config = buildConfig()
    config.compress.protectUserMessages = true
    config.compress.protectUserMessagesCount = -3

    const messages = [
        userMessage("u-1", "msg-1"),
        userMessage("u-2", "msg-2"),
        userMessage("u-3", "msg-3"),
    ]

    const result = computeProtectedUserMessageIds(config, messages)
    assert.equal(
        result.size,
        1,
        "negative count is clamped to 1 (Math.max(1, Math.floor(-3)) === 1)",
    )
    assert.deepEqual([...result], ["u-3"], "only the last user message is in the set")
})

// ────────────────────────────────────────────────────────────────────────────
// G. Fractional count floors to integer
// ────────────────────────────────────────────────────────────────────────────

test("computeProtectedUserMessageIds: count=2.7 floors to 2 (returns the last 2)", () => {
    const config = buildConfig()
    config.compress.protectUserMessages = true
    config.compress.protectUserMessagesCount = 2.7

    const ids = ["u-1", "u-2", "u-3", "u-4", "u-5"]
    const messages = ids.map((id) => userMessage(id, `msg-${id.slice(2)}`))

    const result = computeProtectedUserMessageIds(config, messages)
    assert.equal(result.size, 2, "count=2.7 floors to 2 → 2 IDs")
    assert.deepEqual([...result], ["u-5", "u-4"], "the last 2 real user messages are in the set")
})

// ────────────────────────────────────────────────────────────────────────────
// H. `Number.POSITIVE_INFINITY` quirk — collapses to 1
// ────────────────────────────────────────────────────────────────────────────

test("computeProtectedUserMessageIds: count=Number.POSITIVE_INFINITY collapses to 1 (NOT all — minor inconsistency)", () => {
    // The runtime `!Number.isFinite(raw)` check in `computeProtectedUserMessageIds`
    // collapses `Infinity` to 1. This is a minor inconsistency with
    // `appendProtectedUserMessages` (which handles `Infinity` correctly via the
    // `!Number.isFinite(count)` slice branch). The config-driven path never
    // produces `Infinity` because `clampMin1` (`lib/config.ts:1189-1192`)
    // rejects non-finite values at config-load time, so this quirk is
    // unreachable in practice. We pin it here to document the behaviour.
    const config = buildConfig()
    config.compress.protectUserMessages = true
    config.compress.protectUserMessagesCount = Number.POSITIVE_INFINITY

    const ids = ["u-1", "u-2", "u-3", "u-4", "u-5"]
    const messages = ids.map((id) => userMessage(id, `msg-${id.slice(2)}`))

    const result = computeProtectedUserMessageIds(config, messages)
    assert.equal(result.size, 1, "Infinity collapses to 1 — only the last message ID is in the set")
    assert.deepEqual([...result], ["u-5"], "only the last user message is in the set")
})

// ────────────────────────────────────────────────────────────────────────────
// I. Synthetic user messages are excluded and do not count toward N
// ────────────────────────────────────────────────────────────────────────────

test("computeProtectedUserMessageIds: synthetic user messages are excluded and do not count toward N", () => {
    // 5 user messages; u-2 and u-4 are synthetic. Real messages: u-1, u-3, u-5.
    // count=2 → last 2 of the 3 real messages: u-3, u-5.
    const config = buildConfig()
    config.compress.protectUserMessages = true
    config.compress.protectUserMessagesCount = 2

    const messages = [
        userMessage("u-1", "msg-1"),
        userMessage("u-2", "msg-2", { synthetic: true }),
        userMessage("u-3", "msg-3"),
        userMessage("u-4", "msg-4", { synthetic: true }),
        userMessage("u-5", "msg-5"),
    ]

    const result = computeProtectedUserMessageIds(config, messages)
    assert.equal(result.size, 2, "synthetic messages don't count toward N")
    assert.ok(result.has("u-3"), "the 3rd real user message is in the set")
    assert.ok(result.has("u-5"), "the 5th real user message is in the set")
    assert.ok(!result.has("u-1"), "the 1st real user message is excluded by the count=2 cap")
    assert.ok(!result.has("u-2"), "the 2nd (synthetic) message is excluded")
    assert.ok(!result.has("u-4"), "the 4th (synthetic) message is excluded")
})

// ────────────────────────────────────────────────────────────────────────────
// J. Ignored user messages are excluded and do not count toward N
// ────────────────────────────────────────────────────────────────────────────

test("computeProtectedUserMessageIds: ignored user messages are excluded and do not count toward N", () => {
    // 5 user messages; u-2 and u-4 are ignored. Real messages: u-1, u-3, u-5.
    // count=2 → last 2 of the 3 real messages: u-3, u-5.
    const config = buildConfig()
    config.compress.protectUserMessages = true
    config.compress.protectUserMessagesCount = 2

    const messages = [
        userMessage("u-1", "msg-1"),
        userMessage("u-2", "msg-2", { ignored: true }),
        userMessage("u-3", "msg-3"),
        userMessage("u-4", "msg-4", { ignored: true }),
        userMessage("u-5", "msg-5"),
    ]

    const result = computeProtectedUserMessageIds(config, messages)
    assert.equal(result.size, 2, "ignored messages don't count toward N")
    assert.ok(result.has("u-3"), "the 3rd real user message is in the set")
    assert.ok(result.has("u-5"), "the 5th real user message is in the set")
    assert.ok(!result.has("u-1"), "the 1st real user message is excluded by the count=2 cap")
    assert.ok(!result.has("u-2"), "the 2nd (ignored) message is excluded")
    assert.ok(!result.has("u-4"), "the 4th (ignored) message is excluded")
})

// ────────────────────────────────────────────────────────────────────────────
// K. Empty messages array
// ────────────────────────────────────────────────────────────────────────────

test("computeProtectedUserMessageIds: empty messages array returns an empty set", () => {
    const config = buildConfig()
    config.compress.protectUserMessages = true
    config.compress.protectUserMessagesCount = 5

    const result = computeProtectedUserMessageIds(config, [])
    assert.equal(result.size, 0, "no messages → empty set regardless of count")
})

// ────────────────────────────────────────────────────────────────────────────
// L. Non-string info.id is skipped
// ────────────────────────────────────────────────────────────────────────────

test("computeProtectedUserMessageIds: messages with non-string info.id are skipped (defensive)", () => {
    const config = buildConfig()
    config.compress.protectUserMessages = true
    config.compress.protectUserMessagesCount = 5

    // The first message has a numeric `info.id`. `isMessageWithInfo` rejects
    // it (the type guard requires `typeof info.id === "string"`) so the
    // whole message is bypassed — the production code does
    // `if (!isMessageWithInfo(msg)) continue` BEFORE the per-id type check.
    const numericIdMessage = userMessage("u-1", "msg-1")
    numericIdMessage.info = { ...numericIdMessage.info, id: 123 as any }

    const messages: WithParts[] = [
        numericIdMessage,
        userMessage("u-2", "msg-2"),
        userMessage("u-3", "msg-3"),
    ]

    const result = computeProtectedUserMessageIds(config, messages)
    assert.equal(result.size, 2, "the numeric-id message is rejected by the type guard")
    assert.ok(result.has("u-2"), "u-2 is in the set")
    assert.ok(result.has("u-3"), "u-3 is in the set")
})

// ────────────────────────────────────────────────────────────────────────────
// M. Mixed roles — only user messages count
// ────────────────────────────────────────────────────────────────────────────

test("computeProtectedUserMessageIds: mixed roles — only user messages count toward N", () => {
    const config = buildConfig()
    config.compress.protectUserMessages = true
    config.compress.protectUserMessagesCount = 2

    const messages = [
        userMessage("u-1", "msg-1"),
        userMessage("u-2", "msg-2"),
        assistantMessage("a-3", "assistant reply"),
        userMessage("u-4", "msg-4"),
        userMessage("u-5", "msg-5"),
    ]

    const result = computeProtectedUserMessageIds(config, messages)
    assert.equal(result.size, 2, "only the last 2 user messages are in the set")
    assert.ok(result.has("u-4"), "u-4 (last user #2) is in the set")
    assert.ok(result.has("u-5"), "u-5 (last user #1) is in the set")
    assert.ok(!result.has("a-3"), "the assistant message is never included")
    assert.ok(!result.has("u-1"), "u-1 is excluded by the count=2 cap")
    assert.ok(!result.has("u-2"), "u-2 is excluded by the count=2 cap")
})

// ────────────────────────────────────────────────────────────────────────────
// N. Duplicate IDs are deduplicated
// ────────────────────────────────────────────────────────────────────────────

test("computeProtectedUserMessageIds: duplicate IDs are deduplicated by the Set constructor", () => {
    const config = buildConfig()
    config.compress.protectUserMessages = true
    config.compress.protectUserMessagesCount = 2

    // Three distinct messages all sharing `info.id = "msg-x"`. The Set
    // dedupes; even though the loop would attempt to walk 3 IDs (since
    // `result.size` stays at 1 throughout), only one entry is produced.
    const messages = [
        userMessage("msg-x", "msg-1"),
        userMessage("msg-x", "msg-2"),
        userMessage("msg-x", "msg-3"),
    ]

    const result = computeProtectedUserMessageIds(config, messages)
    assert.equal(result.size, 1, "three messages with the same id collapse to one Set entry")
    assert.ok(result.has("msg-x"), "the single shared id is in the set")
})

// Logic Verified: computeProtectedUserMessageIds correctly computes the set of the last N real user message IDs; synthetic/ignored user messages are skipped; non-finite and out-of-range count values are clamped to 1; mixed roles and non-string IDs are handled defensively.
// Bugs Documented: BUG-096
// Fakes Updated: none
// Review Status: pending independent review.
