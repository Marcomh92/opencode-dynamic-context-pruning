// BUG-020 — `parseBlockRef("b0")` boundary untested.
//
// The bug:
//   * INV-20 in docs/features/COMPRESSION.md line 82 states that block
//     IDs must be ≥ 1, and that `parseBlockRef("b0")` returns null.
//   * `parseBlockRef` (lib/message-ids.ts:60-68) is built on the regex
//     `/^b([1-9]\d*)$/`, which excludes `b0`.
//   * Grep for `parseBlockRef` in `tests/*.test.ts` returns zero matches
//     prior to this file. The boundary is unpinned.
//
// Reference: known_issues/BUG-020-parse-blockref-zero-untested.md
// Docs:       docs/features/COMPRESSION.md (INV-20)

import assert from "node:assert/strict"
import test from "node:test"
import { parseBlockRef, formatBlockRef } from "../lib/message-ids"

test("INV-20: parseBlockRef('b0') returns null (block IDs must be ≥1)", () => {
    // KNOWN BUG (BUG-020): this boundary was untested prior to this file.
    // See: known_issues/BUG-020-parse-blockref-zero-untested.md
    assert.equal(parseBlockRef("b0"), null)
})

test("parseBlockRef('b1') returns 1", () => {
    assert.equal(parseBlockRef("b1"), 1)
})

test("parseBlockRef('b12') returns 12 (multi-digit)", () => {
    assert.equal(parseBlockRef("b12"), 12)
})

test("parseBlockRef('B1') returns 1 (case-normalized)", () => {
    assert.equal(parseBlockRef("B1"), 1)
})

test("parseBlockRef('m0001') returns null (m-prefix is not a block ref)", () => {
    // Message refs are parsed by parseMessageRef, not parseBlockRef.
    // A block-shaped input must not be conflated with an m-prefix.
    assert.equal(parseBlockRef("m0001"), null)
})

test("parseBlockRef tolerates surrounding whitespace", () => {
    // parseBlockRef trims+lowercases before matching. A leading/trailing
    // space must not invalidate an otherwise valid block ref.
    assert.equal(parseBlockRef("  b7  "), 7)
})

test("parseBlockRef rejects zero-padded forms like 'b00'", () => {
    // The regex /^b([1-9]\d*)$/ requires the leading digit to be 1-9, so
    // "b00" (two zeros) must not match.
    assert.equal(parseBlockRef("b00"), null)
})

test("parseBlockRef rejects malformed inputs", () => {
    assert.equal(parseBlockRef(""), null)
    assert.equal(parseBlockRef("b"), null)
    assert.equal(parseBlockRef("bx"), null)
    assert.equal(parseBlockRef("b-1"), null)
    assert.equal(parseBlockRef("b1.0"), null)
})

// Round-trip closure: formatBlockRef and parseBlockRef must agree on
// the boundary ID 1 (the smallest legal block ID per INV-20).
test("parseBlockRef ∘ formatBlockRef is the identity on legal block IDs", () => {
    assert.equal(parseBlockRef(formatBlockRef(1)), 1)
    assert.equal(parseBlockRef(formatBlockRef(42)), 42)
})
// Logic Verified: parseBlockRef/formatBlockRef round-trip is the identity on legal block IDs (≥1), tolerates whitespace, and rejects illegal IDs.
// Bugs Documented: BUG-020.
// Fakes Updated: none
// Review Status: pending independent review.
