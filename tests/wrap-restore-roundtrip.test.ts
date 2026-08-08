import assert from "node:assert/strict"
import test from "node:test"
import type { CompressionBlock } from "../lib/state"
import {
    appendMissingBlockSummaries,
    injectBlockPlaceholders,
    parseBlockPlaceholders,
} from "../lib/compress/range-utils"
import { wrapCompressedSummary } from "../lib/compress/state"
import type { BoundaryReference } from "../lib/compress/types"

// ---------------------------------------------------------------------------
// BUG-039 — wrapCompressedSummary ↔ restoreSummary round-trip is lossless
//
// `wrapCompressedSummary` (lib/compress/state.ts:53-61) writes the body
// between a header line and a footer tag. `restoreSummary`
// (lib/compress/range-utils.ts:373-384) is the inverse.
//
// `restoreSummary` is module-internal (not exported). Per the task brief,
// when a helper is not exported the test must exercise it through a public
// transform that uses both functions. `injectBlockPlaceholders` (line 276)
// and `appendMissingBlockSummaries` (line 332) both call `restoreSummary`
// internally on `target.summary` (which is the wrapped form). Driving these
// public APIs is the contract surface for INV-10 in
// docs/features/COMPRESSION.md.
//
// The pre-fix regex at line 382 is asymmetric: it matches a footer
// fragment but the wrap writes a full opening+closing tag pair. The regex
// leaves the opening tag and any leading newlines behind. The fix widens
// the regex to consume the whole tag. These tests pin down the post-fix
// behaviour.
// ---------------------------------------------------------------------------

function createBlock(blockId: number, body: string): CompressionBlock {
    return {
        blockId,
        runId: blockId,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 0,
        summaryTokens: 0,
        topic: `Block ${blockId}`,
        startId: "m0001",
        endId: "m0002",
        anchorMessageId: `msg-${blockId}`,
        compressMessageId: `compress-${blockId}`,
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: [],
        directToolIds: [],
        effectiveMessageIds: [`msg-${blockId}`],
        effectiveToolIds: [],
        createdAt: blockId,
        summary: wrapCompressedSummary(blockId, body),
    }
}

function messageBoundary(messageId: string, rawIndex: number): BoundaryReference {
    return { kind: "message", messageId, rawIndex }
}

const OPEN_TAG_RE = new RegExp("<dcp-message-id>")

/** Drive the round-trip through the public `injectBlockPlaceholders` API.
 *  Asserts the expanded summary contains the original body cleanly with no
 *  leftover wrapping artifacts. */
function assertRoundTripViaInject(blockId: number, body: string): void {
    const summaryByBlockId = new Map([[blockId, createBlock(blockId, body)]])
    const summary = `prefix (b${blockId}) suffix`
    const placeholders = parseBlockPlaceholders(summary)
    assert.equal(placeholders.length, 1, "parseBlockPlaceholders must find one placeholder")

    const injected = injectBlockPlaceholders(
        summary,
        placeholders,
        summaryByBlockId,
        messageBoundary("msg-pre", 0),
        messageBoundary("msg-post", 1),
    )

    // The exact body text must be present, surrounded by the prefix and
    // suffix with no extra wrapping artifacts.
    assert.equal(
        injected.expandedSummary,
        `prefix ${body} suffix`,
        `round-trip lost fidelity for body: ${JSON.stringify(body)}`,
    )
    assert.doesNotMatch(
        injected.expandedSummary,
        OPEN_TAG_RE,
        "expanded summary must not contain a leftover opening tag",
    )
    assert.deepEqual(injected.consumedBlockIds, [blockId])
}

test("BUG-039: wrap↔restore round-trip is lossless for a plain ASCII body", () => {
    assertRoundTripViaInject(1, "Body text")
})

test("BUG-039: wrap↔restore round-trip is lossless for a multi-line body", () => {
    const body = "Line one\nLine two\nLine three"
    assertRoundTripViaInject(2, body)
})

test("BUG-039: wrap↔restore round-trip is lossless for a body with backticks", () => {
    const body = "Inline `code` and a fenced block:\n```ts\nconst x = 1\n```"
    assertRoundTripViaInject(3, body)
})

test("BUG-039: wrap↔restore round-trip is lossless for a body with markdown", () => {
    const body = "# Heading\n\n- item one\n- item two\n\n**bold** and *italic*."
    assertRoundTripViaInject(4, body)
})

test("BUG-039: wrap↔restore round-trip is lossless for an empty body", () => {
    // wrap(b, "") returns the header line plus the footer tag. restore must
    // return "". The pre-fix regex leaves the opening tag artifact behind,
    // so this test fails pre-fix.
    const block = createBlock(7, "")
    const restoredViaRestore = injectBlockPlaceholders(
        "before (b7) after",
        parseBlockPlaceholders("before (b7) after"),
        new Map([[7, block]]),
        messageBoundary("msg-a", 0),
        messageBoundary("msg-b", 1),
    )
    assert.equal(
        restoredViaRestore.expandedSummary,
        "before  after",
        "empty body must round-trip to empty string with no leftover wrapping",
    )
})

test("BUG-039: round-trip via appendMissingBlockSummaries also strips all wrapping", () => {
    // appendMissingBlockSummaries is the second public path that calls
    // restoreSummary. It builds an injection block formatted as a heading
    // followed by the restored body, so the restored body must be
    // byte-identical to the original.
    const body = "Restored body with `code` and a list:\n- one\n- two"
    const summaryByBlockId = new Map([[42, createBlock(42, body)]])
    const result = appendMissingBlockSummaries("ignored", [42], summaryByBlockId, [])

    // The result must contain the body byte-for-byte with no leftover
    // header or footer artifacts.
    assert.ok(
        result.expandedSummary.includes(body),
        "body must appear verbatim inside the appended block summary",
    )
    assert.doesNotMatch(
        result.expandedSummary,
        OPEN_TAG_RE,
        "no opening tag must remain in the appended block summary",
    )
    assert.deepEqual(result.consumedBlockIds, [42])
})

test("BUG-039: a body containing the literal header text round-trips cleanly", () => {
    // If a user summary happens to mention the literal header text, restore
    // must not confuse it with the actual header. The header match anchors
    // at the START of the string and is non-overlapping with body content.
    const body = "Earlier I wrote [Compressed conversation section] as an example."
    assertRoundTripViaInject(11, body)
})

// Logic Verified:
//   BUG-039: wrapCompressedSummary ↔ restoreSummary is lossless across a
//            range of bodies (plain, multi-line, backticks, markdown, empty,
//            header-like). The pre-fix asymmetric regex at
//            lib/compress/range-utils.ts:382 is now asserted to be gone.
// Bugs Documented: none (already documented in known_issues/BUG-039).
// Fakes Updated: none.
// Review Status: not yet independently reviewed.
// Logic Verified: prompt-wrap ↔ restore is lossless across plain/multi-line/backtick/markdown/empty bodies, and appendMissingBlockSummaries strips wrapping too.
// Bugs Documented: BUG-039.
// Fakes Updated: none
// Review Status: pending independent review.
