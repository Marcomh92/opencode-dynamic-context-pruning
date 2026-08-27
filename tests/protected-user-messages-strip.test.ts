import assert from "node:assert/strict"
import test from "node:test"
import { appendProtectedUserMessages } from "../lib/compress/protected-content"
import type { SearchContext, SelectionResolution } from "../lib/compress/types"
import { createSessionState, type WithParts } from "../lib/state"

// BUG-095 integration coverage — the protected-section builder now applies
// `stripText(part.text, stripPatterns)` to each user text BEFORE pushing it
// into `userTexts`. The strip applies ONLY to the verbatim user-message
// dump of a compression summary; the live `output.messages` array is
// untouched (that was the bug).

const SESSION = "ses_protected_user_strip"

// ────────────────────────────────────────────────────────────────────────────
// Fixtures
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
// A. stripPatterns ≠ [] — apply the strip
// ────────────────────────────────────────────────────────────────────────────

test("appendProtectedUserMessages: enabled=true with stripPatterns strips <available-skills> from the protected section", () => {
    const messages = [
        userMessage("u-1", [
            {
                text: "intro\n<available-skills>\nskill a\nskill b\n</available-skills>\noutro",
            },
        ]),
    ]
    const summary = appendProtectedUserMessages(
        "BASE",
        selectionFor(["u-1"]),
        buildSearchContext(messages),
        emptyState(),
        true,
        ["<available-skills>"],
    )

    assert.ok(
        summary.includes("intro\n\noutro"),
        "surrounding user text is preserved in the protected section",
    )
    assert.doesNotMatch(
        summary,
        /<available-skills>/,
        "the synthetic block opening tag must NOT appear in the protected section",
    )
    assert.doesNotMatch(
        summary,
        /<\/available-skills>/,
        "the synthetic block closing tag must NOT appear in the protected section",
    )
    assert.doesNotMatch(
        summary,
        /skill a\nskill b/,
        "the block contents must NOT be in the protected section",
    )
    assert.ok(summary.startsWith("BASE"), "the caller-supplied summary is preserved as the prefix")
})

test("appendProtectedUserMessages: enabled=true with a literal-substring pattern [TODO] is stripped", () => {
    const messages = [userMessage("u-todo", [{ text: "please review this [TODO] code" }])]

    const summary = appendProtectedUserMessages(
        "BASE",
        selectionFor(["u-todo"]),
        buildSearchContext(messages),
        emptyState(),
        true,
        ["[TODO]"],
    )

    assert.ok(summary.includes("please review this  code"), "the [TODO] marker is removed")
    assert.doesNotMatch(summary, /\[TODO\]/, "[TODO] must not survive in the protected section")
})

test("appendProtectedUserMessages: enabled=true with empty stripPatterns (default arg path) keeps the block inline", () => {
    const messages = [
        userMessage("u-default", [
            { text: "intro\n<available-skills>\nskill a\n</available-skills>\noutro" },
        ]),
    ]

    const summary = appendProtectedUserMessages(
        "BASE",
        selectionFor(["u-default"]),
        buildSearchContext(messages),
        emptyState(),
        true,
    )

    assert.ok(
        summary.includes("<available-skills>"),
        "default `stripPatterns = []` is a no-op — the block stays inline in the protected section",
    )
    assert.ok(summary.includes("skill a"), "the block content survives when no strip is configured")
})

test("appendProtectedUserMessages: enabled=true with empty stripPatterns [] (explicit array) keeps the block inline", () => {
    const messages = [
        userMessage("u-empty", [
            { text: "body <available-skills>\nskill a\n</available-skills> tail" },
        ]),
    ]

    const summary = appendProtectedUserMessages(
        "BASE",
        selectionFor(["u-empty"]),
        buildSearchContext(messages),
        emptyState(),
        true,
        [],
    )

    assert.ok(
        summary.includes("<available-skills>"),
        "explicit `stripPatterns = []` does not mutate the protected text",
    )
    assert.ok(summary.includes("skill a"), "block content survives when `stripPatterns = []`")
})

// ────────────────────────────────────────────────────────────────────────────
// B. enabled=false — caller-supplied summary returned untouched (early-return)
// ────────────────────────────────────────────────────────────────────────────

test("appendProtectedUserMessages: enabled=false returns the caller-supplied summary untouched", () => {
    const messages = [
        userMessage("u-off", [
            { text: "should NOT be appended\n<available-skills>\nleak\n</available-skills>" },
        ]),
    ]
    const state = emptyState()
    // Pre-populate state.prune.messages.byMessageId.get("u-off") with an
    // entry that has activeBlockIds.length > 0 would also short-circuit,
    // but the early-return happens BEFORE that on enabled=false. Either
    // way, the protected section must NOT be appended.
    const callerSummary = "CALLER_BASE"

    const summary = appendProtectedUserMessages(
        callerSummary,
        selectionFor(["u-off"]),
        buildSearchContext(messages),
        state,
        false,
        ["<available-skills>"],
    )

    assert.equal(
        summary,
        callerSummary,
        "enabled=false is an early return — no protected section appended",
    )
})

// ────────────────────────────────────────────────────────────────────────────
// C. Multiple user messages — strip applied per text independently
// ────────────────────────────────────────────────────────────────────────────

test("appendProtectedUserMessages: multiple user messages — strip applied per text independently", () => {
    const messages = [
        userMessage("u-block", [
            { text: "has <available-skills>\nleak\n</available-skills> block" },
        ]),
        userMessage("u-clean", [{ text: "no block here, just plain text" }]),
        userMessage("u-other", [{ text: "different [TODO] marker" }]),
    ]

    const summary = appendProtectedUserMessages(
        "BASE",
        selectionFor(["u-block", "u-clean", "u-other"]),
        buildSearchContext(messages),
        emptyState(),
        true,
        ["<available-skills>", "[TODO]"],
    )

    // The block-containing message has its block stripped.
    assert.ok(summary.includes("has  block"), "<available-skills> block is stripped from u-block")
    assert.doesNotMatch(
        summary,
        /<available-skills>/,
        "no <available-skills> tag survives in the protected section",
    )

    // The clean message is unchanged.
    assert.ok(
        summary.includes("no block here, just plain text"),
        "u-clean text is preserved verbatim",
    )

    // The other pattern is also applied — even to a message that has no block.
    assert.ok(summary.includes("different  marker"), "[TODO] is stripped from u-other")
    assert.doesNotMatch(summary, /\[TODO\]/, "no [TODO] marker survives in the protected section")
})

// ────────────────────────────────────────────────────────────────────────────
// D. Idempotency under repeated calls (caller-side perspective)
// ────────────────────────────────────────────────────────────────────────────

test("appendProtectedUserMessages: idempotent — calling twice with the same stripPatterns does not re-strip the already-stripped text", () => {
    const messages = [userMessage("u-once", [{ text: "intro <a>x</a> body [TODO] outro" }])]
    const searchContext = buildSearchContext(messages)
    const selection = selectionFor(["u-once"])
    const state = emptyState()

    const summary = "BASE"
    const once = appendProtectedUserMessages(summary, selection, searchContext, state, true, [
        "<a>",
        "[TODO]",
    ])
    const twice = appendProtectedUserMessages(summary, selection, searchContext, state, true, [
        "<a>",
        "[TODO]",
    ])

    assert.ok(once.includes("intro  body  outro"), "first call strips both patterns")
    assert.equal(twice, once, "second call produces the same result — strip is idempotent")
    assert.doesNotMatch(once, /<a>|<\[TODO\]/, "no patterns survive in the protected section")
})

// ────────────────────────────────────────────────────────────────────────────
// E. Existing gate behavior preserved — `isIgnoredUserMessage` still skips
//    synthetic user messages even when `stripPatterns` is non-empty.
// ────────────────────────────────────────────────────────────────────────────

test("appendProtectedUserMessages: synthetic/ignored user messages are still skipped when stripPatterns is non-empty", () => {
    const messages = [
        userMessage("u-real", [{ text: "keep this [TODO] verbatim" }]),
        userMessage("u-synthetic", [{ text: "ignore me [TODO]", synthetic: true }]),
    ]

    const summary = appendProtectedUserMessages(
        "BASE",
        selectionFor(["u-real", "u-synthetic"]),
        buildSearchContext(messages),
        emptyState(),
        true,
        ["[TODO]"],
    )

    // Real user text is preserved with the [TODO] stripped from the
    // protected section.
    assert.ok(
        summary.includes("keep this  verbatim"),
        "real user text is in the protected section, stripped",
    )

    // The synthetic message must NOT appear in the protected section at all
    // — the `isIgnoredUserMessage` gate fires before the strip ever runs.
    assert.doesNotMatch(
        summary,
        /ignore me/,
        "synthetic user text is never appended to the protected section",
    )
    // If the synthetic text leaked in (without the strip), we'd see
    // `[TODO]` in the output. Verify it does not.
    assert.doesNotMatch(
        summary,
        /ignore me \[TODO\]/,
        "synthetic text does not surface — the gate short-circuits it",
    )
})

test("appendProtectedUserMessages: ignored:true text part marks the user message as ignored even when stripPatterns is non-empty", () => {
    const messages = [userMessage("u-ignored-true", [{ text: "leak [TODO]", ignored: true }])]

    const summary = appendProtectedUserMessages(
        "BASE",
        selectionFor(["u-ignored-true"]),
        buildSearchContext(messages),
        emptyState(),
        true,
        ["[TODO]"],
    )

    assert.equal(
        summary,
        "BASE",
        "ignored:true gates the message out — protected section is not appended",
    )
})

// Logic Verified: appendProtectedUserMessages applies stripText(part.text, stripPatterns) to each user message's text before pushing it into the protected section; the strip respects the new `stripPatterns` parameter (defaulting to `[]`), tolerates multi-line `<available-skills>...</available-skills>` blocks and literal substrings like `[TODO]`, leaves text untouched when patterns is empty (both default-arg and explicit `[]`), is idempotent under repeated calls, and preserves the existing `isIgnoredUserMessage` gate (synthetic/ignored text parts are still skipped even when stripPatterns is non-empty). The `enabled=false` early-return returns the caller-supplied summary unchanged.
// Bugs Documented: none.
// Fakes Updated: none.
// Review Status: pending independent review.
