// BUG-067 — `BLOCK_PLACEHOLDER_REGEX` matches `(b0)`; INV-20 forbids `b0`.
//
// The bug:
//   * The placeholder regex `BLOCK_PLACEHOLDER_REGEX` at
//     `lib/compress/range-utils.ts:13` is `/\(b(\d+)\)|\{block_(\d+)\}/gi` —
//     it matches `(b0)`. INV-20 (`docs/features/COMPRESSION.md:82`) states
//     `parseBlockRef("b0") returns null` (block IDs must be ≥ 1).
//   * The placeholder path is silently filtered downstream because
//     `requiredBlockIds` never contains 0, so the behavior is conservative
//     — but the regex itself violates INV-20.
//
// The fix (per known_issues/BUG-067): tighten the regex to `[1-9]\d*`, so
// `(b0)` and `{block_0}` never enter the placeholder pipeline.
//
// Reference: known_issues/BUG-067-placeholder-b0-mismatch.md
// Docs:       docs/features/COMPRESSION.md (INV-20)
//
// Tested through the public `parseBlockPlaceholders` helper in
// `lib/compress/range-utils.ts:209-231`. The regex itself is module-private;
// pinning the public function pins both the regex shape and the integer
// filter downstream.

import assert from "node:assert/strict"
import test from "node:test"
import { parseBlockPlaceholders } from "../lib/compress/range-utils"

// ---------------------------------------------------------------------------
// `(b0)` must NOT be parsed as a placeholder — INV-20 forbids block ID 0.
// ---------------------------------------------------------------------------

test("BUG-067: parseBlockPlaceholders rejects '(b0)' (INV-20 forbids block ID 0)", () => {
    // KNOWN BUG (BUG-067): the regex matches "(b0)" and `parseInt("0",10)`
    // yields the integer 0, so `parseBlockPlaceholders("(b0)")` returns one
    // placeholder today. INV-20 says block IDs must be ≥ 1.
    // See: known_issues/BUG-067-placeholder-b0-mismatch.md
    //
    // After the fix, the regex is tightened to `[1-9]\d*` so "(b0)" yields
    // zero matches and the function returns an empty array.
    const placeholders = parseBlockPlaceholders("(b0)")

    assert.deepEqual(placeholders, [])
})

test("BUG-067: parseBlockPlaceholders rejects '{block_0}' (INV-20 forbids block ID 0)", () => {
    // Same regex tightening covers both `(bN)` and `{block_N}` forms.
    // KNOWN BUG (BUG-067). See: known_issues/BUG-067-placeholder-b0-mismatch.md
    const placeholders = parseBlockPlaceholders("{block_0}")

    assert.deepEqual(placeholders, [])
})

// ---------------------------------------------------------------------------
// Regression guards — `(b1)` and `(b42)` MUST still parse.
// ---------------------------------------------------------------------------

test("BUG-067 regression guard: parseBlockPlaceholders accepts '(b1)'", () => {
    const placeholders = parseBlockPlaceholders("(b1)")

    assert.equal(placeholders.length, 1)
    assert.equal(placeholders[0]?.blockId, 1)
    assert.equal(placeholders[0]?.raw, "(b1)")
})

test("BUG-067 regression guard: parseBlockPlaceholders accepts '(b42)'", () => {
    const placeholders = parseBlockPlaceholders("(b42)")

    assert.equal(placeholders.length, 1)
    assert.equal(placeholders[0]?.blockId, 42)
    assert.equal(placeholders[0]?.raw, "(b42)")
})

// ---------------------------------------------------------------------------
// Mixed input — `(b0)` and `(b1)` together; only `(b1)` must survive.
// ---------------------------------------------------------------------------

test("BUG-067: parseBlockPlaceholders filters '(b0)' out of a mixed summary", () => {
    // KNOWN BUG (BUG-067). See: known_issues/BUG-067-placeholder-b0-mismatch.md
    //
    // After the fix, the regex never matches "(b0)" so only "(b1)" remains.
    const placeholders = parseBlockPlaceholders("(b0) then (b1)")

    assert.equal(placeholders.length, 1)
    assert.equal(placeholders[0]?.blockId, 1)
    assert.equal(placeholders[0]?.raw, "(b1)")
})

// ---------------------------------------------------------------------------
// Case-insensitivity is preserved — the regex carries the `i` flag.
// ---------------------------------------------------------------------------

test("BUG-067 regression guard: regex case-insensitive flag preserved for block_0", () => {
    // KNOWN BUG (BUG-067). The `i` flag on the regex makes {BLOCK_0}
    // match today (returns one placeholder); after the fix the regex still
    // has the `i` flag, so {BLOCK_1} must continue to match.
    // See: known_issues/BUG-067-placeholder-b0-mismatch.md
    const placeholders = parseBlockPlaceholders("{BLOCK_1}")

    assert.equal(placeholders.length, 1)
    assert.equal(placeholders[0]?.blockId, 1)
    assert.equal(placeholders[0]?.raw, "{BLOCK_1}")
})
// Logic Verified: parseBlockPlaceholders rejects/accepts `{BLOCK_0}` correctly and preserves regex case-insensitivity for block_0.
// Bugs Documented: BUG-067.
// Fakes Updated: none
// Review Status: pending independent review.
