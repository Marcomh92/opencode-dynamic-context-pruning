import assert from "node:assert/strict"
import test from "node:test"
import { appendProtectedUserMessages } from "../lib/compress/protected-content"
import type { SearchContext, SelectionResolution } from "../lib/compress/types"
import { createSessionState, type WithParts } from "../lib/state"

// BUG-096 — `appendProtectedUserMessages` now applies a "last N" cap to the
// user messages it appends verbatim into the compression summary. N is the
// caller-supplied `count` argument (default `Number.POSITIVE_INFINITY`,
// preserving the legacy "all" behaviour). The cap counts only REAL user
// messages — synthetic / ignored user messages, and messages whose text is
// fully consumed by `stripPatterns`, are filtered out BEFORE the cap is
// applied. This file pins down that contract for the new `count` argument.

const SESSION = "ses_protected_user_count"

// ────────────────────────────────────────────────────────────────────────────
// Fixtures (mirrors tests/protected-user-messages-strip.test.ts:19-85)
// ────────────────────────────────────────────────────────────────────────────

function userTextPart(text: string, opts: { synthetic?: boolean; ignored?: boolean } = {}): any {
    const part: any = {
        id: `${SESSION}-p`,
        sessionID: SESSION,
        messageID: "",
        type: "text",
        text,
    }
    if (opts.synthetic !== undefined) part.synthetic = opts.synthetic
    if (opts.ignored !== undefined) part.ignored = opts.ignored
    return part
}

function userMessage(
    id: string,
    parts: Array<{ text: string; synthetic?: boolean; ignored?: boolean }>,
): WithParts {
    return {
        info: {
            id,
            role: "user",
            sessionID: SESSION,
            agent: "assistant",
            model: { providerID: "anthropic", modelID: "claude-test" },
            time: { created: 1 },
        } as WithParts["info"],
        parts: parts.map((p) => {
            const part = userTextPart(p.text)
            if (p.synthetic !== undefined) part.synthetic = p.synthetic
            if (p.ignored !== undefined) part.ignored = p.ignored
            part.messageID = id
            return part
        }),
    }
}

function buildSearchContext(messages: WithParts[]): SearchContext {
    const rawMessagesById = new Map<string, WithParts>()
    for (const m of messages) rawMessagesById.set(m.info.id, m)
    return {
        rawMessages: messages,
        rawMessagesById,
        rawIndexById: new Map(messages.map((m, i) => [m.info.id, i])),
        summaryByBlockId: new Map(),
    }
}

function selectionFor(messageIds: string[]): SelectionResolution {
    return {
        startReference: { kind: "message", rawIndex: 0, messageId: messageIds[0] },
        endReference: {
            kind: "message",
            rawIndex: messageIds.length - 1,
            messageId: messageIds[messageIds.length - 1],
        },
        messageIds,
        messageTokenById: new Map(),
        toolIds: [],
        requiredBlockIds: [],
    }
}

function emptyState() {
    const state = createSessionState()
    state.sessionId = SESSION
    return state
}

// ────────────────────────────────────────────────────────────────────────────
// A. Last-N basic (no stripPatterns)
// ────────────────────────────────────────────────────────────────────────────

test("appendProtectedUserMessages: count=2 keeps the last 2 of 5 real user messages", () => {
    const ids = ["u-1", "u-2", "u-3", "u-4", "u-5"]
    const messages = ids.map((id) => userMessage(id, [{ text: `msg-${id.slice(2)}` }]))

    const summary = appendProtectedUserMessages(
        "BASE",
        selectionFor(ids),
        buildSearchContext(messages),
        emptyState(),
        true,
        [],
        2,
    )

    // The last 2 of selection order (u-4, u-5) are kept; the first 3
    // (u-1, u-2, u-3) are NOT appended.
    assert.ok(summary.includes("msg-4"), "the 4th user message is included")
    assert.ok(summary.includes("msg-5"), "the 5th user message is included")
    assert.doesNotMatch(summary, /\nmsg-1\n/, "the 1st user message is excluded")
    assert.doesNotMatch(summary, /\nmsg-2\n/, "the 2nd user message is excluded")
    assert.doesNotMatch(summary, /\nmsg-3\n/, "the 3rd user message is excluded")
    assert.ok(summary.startsWith("BASE"), "the caller-supplied prefix is preserved")
})

// ────────────────────────────────────────────────────────────────────────────
// B. count=1
// ────────────────────────────────────────────────────────────────────────────

test("appendProtectedUserMessages: count=1 keeps only the last real user message", () => {
    const ids = ["u-1", "u-2", "u-3", "u-4", "u-5"]
    const messages = ids.map((id) => userMessage(id, [{ text: `msg-${id.slice(2)}` }]))

    const summary = appendProtectedUserMessages(
        "BASE",
        selectionFor(ids),
        buildSearchContext(messages),
        emptyState(),
        true,
        [],
        1,
    )

    assert.ok(summary.includes("msg-5"), "only the last user message is included")
    for (const n of ["msg-1", "msg-2", "msg-3", "msg-4"]) {
        assert.doesNotMatch(summary, new RegExp(`\\n${n}\\n`), `${n} is excluded under count=1`)
    }
})

// ────────────────────────────────────────────────────────────────────────────
// C. count=3
// ────────────────────────────────────────────────────────────────────────────

test("appendProtectedUserMessages: count=3 keeps the last 3 of 5 real user messages", () => {
    const ids = ["u-1", "u-2", "u-3", "u-4", "u-5"]
    const messages = ids.map((id) => userMessage(id, [{ text: `msg-${id.slice(2)}` }]))

    const summary = appendProtectedUserMessages(
        "BASE",
        selectionFor(ids),
        buildSearchContext(messages),
        emptyState(),
        true,
        [],
        3,
    )

    assert.ok(summary.includes("msg-3"), "the 3rd user message is included")
    assert.ok(summary.includes("msg-4"), "the 4th user message is included")
    assert.ok(summary.includes("msg-5"), "the 5th user message is included")
    assert.doesNotMatch(summary, /\nmsg-1\n/, "the 1st user message is excluded")
    assert.doesNotMatch(summary, /\nmsg-2\n/, "the 2nd user message is excluded")
})

// ────────────────────────────────────────────────────────────────────────────
// D. count > available
// ────────────────────────────────────────────────────────────────────────────

test("appendProtectedUserMessages: count > available messages appends all (no padding, no error)", () => {
    const ids = ["u-1", "u-2"]
    const messages = ids.map((id) => userMessage(id, [{ text: `msg-${id.slice(2)}` }]))

    const summary = appendProtectedUserMessages(
        "BASE",
        selectionFor(ids),
        buildSearchContext(messages),
        emptyState(),
        true,
        [],
        5,
    )

    assert.ok(summary.includes("msg-1"), "the only real user message #1 is included")
    assert.ok(summary.includes("msg-2"), "the only real user message #2 is included")
    // The selection order is u-1, u-2 — verify both appear, in order.
    const idx1 = summary.indexOf("msg-1")
    const idx2 = summary.indexOf("msg-2")
    assert.ok(idx1 >= 0 && idx2 > idx1, "both messages are appended in selection order")
})

// ────────────────────────────────────────────────────────────────────────────
// E. Synthetic user messages don't count toward N
// ────────────────────────────────────────────────────────────────────────────

test("appendProtectedUserMessages: synthetic user messages are excluded and do not count toward N", () => {
    // 5 user messages; u-2 and u-4 are synthetic. Real messages: u-1, u-3, u-5.
    // count=2 → last 2 of the 3 real messages: u-3, u-5.
    const messages = [
        userMessage("u-1", [{ text: "msg-1" }]),
        userMessage("u-2", [{ text: "msg-2", synthetic: true }]),
        userMessage("u-3", [{ text: "msg-3" }]),
        userMessage("u-4", [{ text: "msg-4", synthetic: true }]),
        userMessage("u-5", [{ text: "msg-5" }]),
    ]

    const summary = appendProtectedUserMessages(
        "BASE",
        selectionFor(["u-1", "u-2", "u-3", "u-4", "u-5"]),
        buildSearchContext(messages),
        emptyState(),
        true,
        [],
        2,
    )

    // The cap is applied to the REAL messages only, so the last 2 real
    // messages (u-3, u-5) are kept.
    assert.ok(summary.includes("msg-3"), "the 3rd real user message is included")
    assert.ok(summary.includes("msg-5"), "the 5th real user message is included")
    // u-1 is the 1st real message but the cap=2 cuts it off.
    assert.doesNotMatch(summary, /\nmsg-1\n/, "msg-1 is excluded by the count=2 cap")
    // The synthetic messages must NEVER appear in the protected section.
    assert.doesNotMatch(
        summary,
        /\nmsg-2\n/,
        "synthetic user message #2 must not appear in the protected section",
    )
    assert.doesNotMatch(
        summary,
        /\nmsg-4\n/,
        "synthetic user message #4 must not appear in the protected section",
    )
})

// ────────────────────────────────────────────────────────────────────────────
// F. Ignored user messages don't count toward N
// ────────────────────────────────────────────────────────────────────────────

test("appendProtectedUserMessages: ignored user messages are excluded and do not count toward N", () => {
    // 5 user messages; u-2 and u-4 are ignored. Real messages: u-1, u-3, u-5.
    // count=2 → last 2 of the 3 real messages: u-3, u-5.
    const messages = [
        userMessage("u-1", [{ text: "msg-1" }]),
        userMessage("u-2", [{ text: "msg-2", ignored: true }]),
        userMessage("u-3", [{ text: "msg-3" }]),
        userMessage("u-4", [{ text: "msg-4", ignored: true }]),
        userMessage("u-5", [{ text: "msg-5" }]),
    ]

    const summary = appendProtectedUserMessages(
        "BASE",
        selectionFor(["u-1", "u-2", "u-3", "u-4", "u-5"]),
        buildSearchContext(messages),
        emptyState(),
        true,
        [],
        2,
    )

    assert.ok(summary.includes("msg-3"), "the 3rd real user message is included")
    assert.ok(summary.includes("msg-5"), "the 5th real user message is included")
    assert.doesNotMatch(summary, /\nmsg-1\n/, "msg-1 is excluded by the count=2 cap")
    assert.doesNotMatch(
        summary,
        /\nmsg-2\n/,
        "ignored user message #2 must not appear in the protected section",
    )
    assert.doesNotMatch(
        summary,
        /\nmsg-4\n/,
        "ignored user message #4 must not appear in the protected section",
    )
})

// ────────────────────────────────────────────────────────────────────────────
// G. stripPatterns fully consumes text → filtered AND doesn't count
// ────────────────────────────────────────────────────────────────────────────

test("appendProtectedUserMessages: messages fully consumed by stripPatterns are excluded and do not count toward N", () => {
    // u-3 is ONLY the available-skills block. After stripping, the result
    // is empty — so u-3 is filtered out of `userTexts` AND doesn't count
    // toward N. Real non-fully-stripped messages: u-1, u-2, u-4, u-5.
    // count=2 → last 2 of those 4: u-4, u-5.
    const messages = [
        userMessage("u-1", [{ text: "msg-1" }]),
        userMessage("u-2", [{ text: "msg-2" }]),
        userMessage("u-3", [{ text: "<available-skills>foo</available-skills>" }]),
        userMessage("u-4", [{ text: "msg-4" }]),
        userMessage("u-5", [{ text: "msg-5" }]),
    ]

    const summary = appendProtectedUserMessages(
        "BASE",
        selectionFor(["u-1", "u-2", "u-3", "u-4", "u-5"]),
        buildSearchContext(messages),
        emptyState(),
        true,
        ["<available-skills>"],
        2,
    )

    assert.ok(summary.includes("msg-4"), "the 4th real user message is included")
    assert.ok(summary.includes("msg-5"), "the 5th real user message is included")
    assert.doesNotMatch(
        summary,
        /foo/,
        "the fully-stripped content of u-3 must not appear in the protected section",
    )
    // u-3 itself contributes 0 surviving text. u-1 and u-2 are pushed to
    // userTexts but the count=2 cap cuts them out.
    assert.doesNotMatch(summary, /\nmsg-1\n/, "msg-1 is excluded by the count=2 cap")
    assert.doesNotMatch(summary, /\nmsg-2\n/, "msg-2 is excluded by the count=2 cap")
})

// ────────────────────────────────────────────────────────────────────────────
// H. enabled=false short-circuits
// ────────────────────────────────────────────────────────────────────────────

test("appendProtectedUserMessages: enabled=false short-circuits regardless of count", () => {
    const ids = ["u-1", "u-2", "u-3", "u-4", "u-5"]
    const messages = ids.map((id) => userMessage(id, [{ text: `msg-${id.slice(2)}` }]))

    const summary = appendProtectedUserMessages(
        "BASE",
        selectionFor(ids),
        buildSearchContext(messages),
        emptyState(),
        false,
        [],
        2,
    )

    assert.equal(
        summary,
        "BASE",
        "enabled=false is an early return — no protected section appended",
    )
})

// ────────────────────────────────────────────────────────────────────────────
// I. count=0 is NOT clamped internally — the function trusts its count arg
// ────────────────────────────────────────────────────────────────────────────

test("appendProtectedUserMessages: count=0 returns all messages (slice(-0) === slice(0) quirk)", () => {
    // `Array.prototype.slice(-0)` is exactly `Array.prototype.slice(0)` in
    // JavaScript (ECMA spec: -0 is converted to 0). The function therefore
    // trusts the count it is given and emits ALL messages — there is no
    // internal clamp. Clamping is the caller's responsibility, handled by
    // `clampMin1` in the config layer (`lib/config.ts`) and by the inline
    // `Math.max(1, Math.floor(...))` in `computeProtectedUserMessageIds`
    // (`lib/messages/query.ts`). Production code: `lib/compress/protected-content.ts:58-59`.
    const ids = ["u-1", "u-2", "u-3", "u-4", "u-5"]
    const messages = ids.map((id) => userMessage(id, [{ text: `msg-${id.slice(2)}` }]))

    const summary = appendProtectedUserMessages(
        "BASE",
        selectionFor(ids),
        buildSearchContext(messages),
        emptyState(),
        true,
        [],
        0,
    )

    // All 5 messages are appended — `slice(-0) === slice(0)` returns the
    // whole array, not an empty slice.
    assert.ok(summary.startsWith("BASE"), "the caller-supplied prefix is preserved")
    for (const n of ["msg-1", "msg-2", "msg-3", "msg-4", "msg-5"]) {
        assert.ok(summary.includes(n), `all 5 messages are included under count=0 (missing: ${n})`)
    }
})

// ────────────────────────────────────────────────────────────────────────────
// J. count=Number.POSITIVE_INFINITY yields the legacy "all" behaviour
// ────────────────────────────────────────────────────────────────────────────

test("appendProtectedUserMessages: count=Number.POSITIVE_INFINITY appends every real user message", () => {
    const ids = ["u-1", "u-2", "u-3", "u-4", "u-5"]
    const messages = ids.map((id) => userMessage(id, [{ text: `msg-${id.slice(2)}` }]))

    const summary = appendProtectedUserMessages(
        "BASE",
        selectionFor(ids),
        buildSearchContext(messages),
        emptyState(),
        true,
        [],
        Number.POSITIVE_INFINITY,
    )

    for (const n of ["msg-1", "msg-2", "msg-3", "msg-4", "msg-5"]) {
        assert.ok(
            summary.includes(n),
            `all 5 user messages are appended under count=Number.POSITIVE_INFINITY (missing: ${n})`,
        )
    }
})

// ────────────────────────────────────────────────────────────────────────────
// K. Partial-strip — a message with mixed content is included, stripped
//    portion removed
// ────────────────────────────────────────────────────────────────────────────

test("appendProtectedUserMessages: a message with mixed text + inline stripped block is included with the block removed", () => {
    // u-3 is "before <available-skills>foo</available-skills> after". The
    // strip consumes only the inline block; the surviving text
    // "before  after" is non-empty, so u-3 IS pushed to `userTexts`.
    // count=5 → all 5 messages included; u-3 appears with the block
    // stripped out.
    const messages = [
        userMessage("u-1", [{ text: "msg-1" }]),
        userMessage("u-2", [{ text: "msg-2" }]),
        userMessage("u-3", [{ text: "before <available-skills>foo</available-skills> after" }]),
        userMessage("u-4", [{ text: "msg-4" }]),
        userMessage("u-5", [{ text: "msg-5" }]),
    ]

    const summary = appendProtectedUserMessages(
        "BASE",
        selectionFor(["u-1", "u-2", "u-3", "u-4", "u-5"]),
        buildSearchContext(messages),
        emptyState(),
        true,
        ["<available-skills>"],
        5,
    )

    // u-1, u-2, u-4, u-5 carry the literal text "msg-N" and are appended
    // unchanged. u-3 has the literal text "before <available-skills>...
    // after"; after the strip it becomes "before  after", which does NOT
    // contain the substring "msg-3". We verify u-3's presence via the
    // surviving "before  after" string and the absence of the stripped
    // tags below.
    for (const n of ["msg-1", "msg-2", "msg-4", "msg-5"]) {
        assert.ok(summary.includes(n), `${n} is included under count=5`)
    }
    assert.ok(
        summary.includes("before  after"),
        "u-3's inline <available-skills> block is removed; surrounding text is preserved",
    )
    assert.doesNotMatch(
        summary,
        /<available-skills>/,
        "the block tag is gone from the protected section",
    )
    assert.doesNotMatch(summary, /foo/, "the block content is gone from the protected section")
})

// Logic Verified: appendProtectedUserMessages correctly applies the last-N cap to real user messages; synthetic/ignored user messages and messages fully consumed by stripPatterns are filtered out and do not count toward N; the default Number.POSITIVE_INFINITY preserves the legacy "all" behavior.
// Bugs Documented: BUG-096
// Fakes Updated: none
// Review Status: pending independent review.
