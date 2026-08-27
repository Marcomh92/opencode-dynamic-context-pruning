import assert from "node:assert/strict"
import test from "node:test"
import { appendProtectedPromptInfo } from "../lib/compress/protected-content"
import type { SearchContext, SelectionResolution } from "../lib/compress/types"
import { createSessionState, type WithParts } from "../lib/state"

// BUG-095 integration coverage — the protected-prompt-info builder now
// applies `stripText(extractProtectedPromptInfo(part.text), stripPatterns)`
// to each `<protect>...</protect>` extraction before pushing it into the
// protected section. The strip applies ONLY to the compression-summary
// text, never to the live `output.messages` array (that was the bug).

const SESSION = "ses_protected_prompt_strip"

// ────────────────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────────────────

function userMessage(id: string, text: string, opts: { synthetic?: boolean } = {}): WithParts {
    const part: any = {
        id: `${id}-p`,
        sessionID: SESSION,
        messageID: id,
        type: "text",
        text,
    }
    if (opts.synthetic !== undefined) part.synthetic = opts.synthetic
    return {
        info: {
            id,
            role: "user",
            sessionID: SESSION,
            agent: "assistant",
            model: { providerID: "anthropic", modelID: "claude-test" },
            time: { created: 1 },
        } as WithParts["info"],
        parts: [part],
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
// A. stripPatterns ≠ [] — apply the strip inside extracted <protect> bodies
// ────────────────────────────────────────────────────────────────────────────

test("appendProtectedPromptInfo: enabled=true with stripPatterns strips <available-skills> from a <protect> block body", () => {
    const messages = [
        userMessage(
            "u-protect-1",
            "before\n<protect>\n<available-skills>\nleaked skill body\n</available-skills>\nkeep this\n</protect>\nafter",
        ),
    ]

    const summary = appendProtectedPromptInfo(
        "BASE",
        selectionFor(["u-protect-1"]),
        buildSearchContext(messages),
        emptyState(),
        true,
        ["<available-skills>"],
    )

    // The `keep this` literal from the <protect> body must survive.
    assert.ok(
        summary.includes("keep this"),
        "<protect> body content (minus the strip) is in the protected section",
    )

    // The block must be removed from the protected section.
    assert.doesNotMatch(
        summary,
        /<available-skills>/,
        "<available-skills> opening tag must NOT appear in the protected section",
    )
    assert.doesNotMatch(
        summary,
        /<\/available-skills>/,
        "<available-skills> closing tag must NOT appear in the protected section",
    )
    assert.doesNotMatch(
        summary,
        /leaked skill body/,
        "block contents must NOT leak into the protected section",
    )

    // The surrounding text outside the <protect> block does NOT get
    // appended to the protected section; only the <protect> extraction does.
    assert.doesNotMatch(
        summary,
        /\nbefore\n/,
        "text before <protect> is not appended to the protected section",
    )
    assert.doesNotMatch(
        summary,
        /\nafter\n/,
        "text after </protect> is not appended to the protected section",
    )

    assert.ok(summary.startsWith("BASE"), "the caller-supplied summary is preserved as the prefix")
})

test("appendProtectedPromptInfo: enabled=true with a literal-substring pattern [TODO] is stripped from the <protect> body", () => {
    const messages = [userMessage("u-todo", "<protect>\nplease review [TODO] later\n</protect>")]

    const summary = appendProtectedPromptInfo(
        "BASE",
        selectionFor(["u-todo"]),
        buildSearchContext(messages),
        emptyState(),
        true,
        ["[TODO]"],
    )

    assert.ok(
        summary.includes("please review  later"),
        "the [TODO] marker is removed from the <protect> body",
    )
    assert.doesNotMatch(summary, /\[TODO\]/, "[TODO] must not survive in the protected section")
})

// ────────────────────────────────────────────────────────────────────────────
// B. enabled=true with empty stripPatterns (default + explicit)
// ────────────────────────────────────────────────────────────────────────────

test("appendProtectedPromptInfo: enabled=true with empty stripPatterns (default arg) preserves <protect> body verbatim", () => {
    const messages = [
        userMessage(
            "u-default",
            "<protect>\nbody with <available-skills>\nleak\n</available-skills> intact\n</protect>",
        ),
    ]

    const summary = appendProtectedPromptInfo(
        "BASE",
        selectionFor(["u-default"]),
        buildSearchContext(messages),
        emptyState(),
        true,
    )

    assert.ok(
        summary.includes("<available-skills>"),
        "default `stripPatterns = []` is a no-op — block stays inside the <protect> body",
    )
    assert.ok(summary.includes("leak"), "block content survives when no strip is configured")
    assert.ok(summary.includes("body with"), "the rest of the <protect> body is unchanged")
})

test("appendProtectedPromptInfo: enabled=true with explicit [] stripPatterns preserves <protect> body verbatim", () => {
    const messages = [
        userMessage(
            "u-empty",
            "<protect>\nliteral <available-skills>\nx\n</available-skills> body\n</protect>",
        ),
    ]

    const summary = appendProtectedPromptInfo(
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
    assert.ok(summary.includes("literal"), "the surrounding <protect> body is unchanged")
})

// ────────────────────────────────────────────────────────────────────────────
// C. enabled=false — caller-supplied summary returned untouched (early-return)
// ────────────────────────────────────────────────────────────────────────────

test("appendProtectedPromptInfo: enabled=false returns the caller-supplied summary untouched", () => {
    const messages = [
        userMessage(
            "u-off",
            "<protect>\nmust NOT be appended\n<available-skills>\nleak\n</available-skills>\n</protect>",
        ),
    ]
    const callerSummary = "CALLER_BASE"

    const summary = appendProtectedPromptInfo(
        callerSummary,
        selectionFor(["u-off"]),
        buildSearchContext(messages),
        emptyState(),
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
// D. No <protect> tag — no contribution even when stripPatterns is non-empty
// ────────────────────────────────────────────────────────────────────────────

test("appendProtectedPromptInfo: user message with no <protect> tag does not contribute text even when stripPatterns is non-empty", () => {
    const messages = [
        userMessage("u-no-protect", "just plain text with no <protect> tag, [TODO] here"),
    ]

    const summary = appendProtectedPromptInfo(
        "BASE",
        selectionFor(["u-no-protect"]),
        buildSearchContext(messages),
        emptyState(),
        true,
        ["[TODO]"],
    )

    assert.equal(
        summary,
        "BASE",
        "no <protect> blocks ⇒ no extraction ⇒ caller summary returned untouched (no protected section appended)",
    )
})

// ────────────────────────────────────────────────────────────────────────────
// E. Multiple <protect> blocks in same user message — each stripped
//    independently
// ────────────────────────────────────────────────────────────────────────────

test("appendProtectedPromptInfo: multiple <protect> blocks in the same user message are each stripped independently", () => {
    const messages = [
        userMessage(
            "u-many",
            "<protect>first <available-skills>\nleak-A\n</available-skills> body</protect>\n" +
                "noise between <protect>second <available-skills>\nleak-B\n</available-skills> body</protect>",
        ),
    ]

    const summary = appendProtectedPromptInfo(
        "BASE",
        selectionFor(["u-many"]),
        buildSearchContext(messages),
        emptyState(),
        true,
        ["<available-skills>"],
    )

    // Lazy quantifier ensures both <protect> blocks are extracted
    // independently and the nested <available-skills> in each is stripped.
    assert.ok(summary.includes("first  body"), "first <protect> body has the block stripped")
    assert.ok(summary.includes("second  body"), "second <protect> body has the block stripped")
    assert.doesNotMatch(
        summary,
        /<available-skills>|<\/available-skills>/,
        "neither <available-skills> opening nor closing tag survives",
    )
    assert.doesNotMatch(
        summary,
        /leak-A|leak-B/,
        "neither inner-block contents leak into the protected section",
    )
})

// ────────────────────────────────────────────────────────────────────────────
// F. Idempotency — strip applied to already-stripped content is a no-op
// ────────────────────────────────────────────────────────────────────────────

test("appendProtectedPromptInfo: idempotent — calling twice with the same stripPatterns yields the same output", () => {
    const messages = [
        userMessage("u-once", "<protect>\nintro <a>x</a> body [TODO] outro\n</protect>"),
    ]
    const searchContext = buildSearchContext(messages)
    const selection = selectionFor(["u-once"])
    const state = emptyState()
    const summary = "BASE"

    const once = appendProtectedPromptInfo(summary, selection, searchContext, state, true, [
        "<a>",
        "[TODO]",
    ])
    const twice = appendProtectedPromptInfo(summary, selection, searchContext, state, true, [
        "<a>",
        "[TODO]",
    ])

    assert.ok(
        once.includes("intro  body  outro"),
        "first call strips both patterns inside the <protect> body",
    )
    assert.equal(twice, once, "second call produces the same result — strip is idempotent")
    assert.doesNotMatch(once, /<a>|\[TODO\]/, "no patterns survive in the protected section")
})

test("appendProtectedPromptInfo: strip on already-stripped <protect> content is a no-op (regression guard)", () => {
    const messages = [
        userMessage("u-clean", "<protect>\nalready clean body, nothing to strip\n</protect>"),
    ]

    const summary = appendProtectedPromptInfo(
        "BASE",
        selectionFor(["u-clean"]),
        buildSearchContext(messages),
        emptyState(),
        true,
        ["<available-skills>", "[TODO]"],
    )

    assert.ok(
        summary.includes("already clean body"),
        "<protect> body is preserved when no patterns match",
    )
    assert.ok(
        summary.includes("nothing to strip"),
        "<protect> body verbatim when patterns are absent",
    )
})

// ────────────────────────────────────────────────────────────────────────────
// G. Existing gate behavior preserved — `isIgnoredUserMessage` still skips
//    synthetic user messages even when `stripPatterns` is non-empty.
// ────────────────────────────────────────────────────────────────────────────

test("appendProtectedPromptInfo: synthetic user messages do not contribute text even when stripPatterns is non-empty", () => {
    const messages = [
        userMessage("u-synthetic", "<protect>\nignore me [TODO]\n</protect>", { synthetic: true }),
    ]

    const summary = appendProtectedPromptInfo(
        "BASE",
        selectionFor(["u-synthetic"]),
        buildSearchContext(messages),
        emptyState(),
        true,
        ["[TODO]"],
    )

    assert.equal(
        summary,
        "BASE",
        "synthetic user messages are gated out before the strip is ever consulted",
    )
})

// Logic Verified: appendProtectedPromptInfo applies stripText(extractProtectedPromptInfo(part.text), stripPatterns) to each `<protect>...</protect>` extraction before pushing it into the protected section. The strip respects the new `stripPatterns` parameter (defaulting to `[]`), tolerates multi-line `<available-skills>...</available-skills>` blocks and literal substrings like `[TODO]` inside `<protect>` bodies, leaves the body untouched when patterns is empty (both default-arg and explicit `[]`), strips each `<protect>` block independently when multiple appear in one message, is idempotent under repeated calls, and preserves the existing `isIgnoredUserMessage` gate (synthetic user messages are still skipped even when stripPatterns is non-empty). The `enabled=false` early-return returns the caller-supplied summary unchanged. Messages with no `<protect>` tag do not contribute to the protected section regardless of `stripPatterns`.
// Bugs Documented: none.
// Fakes Updated: none.
// Review Status: pending independent review.
