# BUG-020: INV-20 `parseBlockRef("b0")` returns null not asserted in any test

## Summary

INV-20 in `docs/features/COMPRESSION.md:82` states `parseBlockRef("b0") returns null` (block IDs must be ≥1). `parseBlockRef` is implemented at `lib/message-ids.ts:60-68` with the regex `/^b([1-9]\d*)$/`. Grep for `parseBlockRef` in `tests/*.test.ts` returns zero matches. No test pins the boundary.

## Location

- `lib/message-ids.ts:60-68`
- `lib/message-ids.ts:5` (`BLOCK_REF_REGEX = /^b([1-9]\d*)$/`)
- Callers: `lib/commands/decompress.ts:27`, `lib/commands/recompress.ts:27`, `lib/message-ids.ts:81`

## Current vs Expected Behavior

**Current**: `parseBlockRef` exported, called by command handlers, no test pinning the contract.
**Expected**: A dedicated test file (`tests/message-ids.test.ts`) asserting the boundary, including numeric-aware sort order.

## Impact

- **Severity**: High (test gap on a documented contract)
- Runtime: not affected directly.
- User-observable: a future change loosening the regex (e.g., accepting `b0`) would silently break INV-20.

## Reproduction

```sh
grep -l "parseBlockRef" tests/*.test.ts
# No matches.
```

## Suggested Fix

Append to existing `tests/message-ids.test.ts` (the file already exists; it covers `assignMessageRefs` and `checkSession` only). Ponytail-friendly minimum:

```ts
test("INV-20: parseBlockRef('b0') returns null", () => {
    assert.equal(parseBlockRef("b0"), null)
})
test("parseBlockRef('b1') returns 1", () => assert.equal(parseBlockRef("b1"), 1))
test("parseBlockRef('b12') returns 12", () => assert.equal(parseBlockRef("b12"), 12))
test("parseBlockRef('B1') returns 1 (case-normalized)", () => assert.equal(parseBlockRef("B1"), 1))
test("parseBlockRef('m0001') returns null (m-prefix not b-prefix)", () =>
    assert.equal(parseBlockRef("m0001"), null))
```

Co-test `formatBlockRef(0)` throws to close the round-trip.

## Status

Fixed 2026-08-07

## Resolution

INV-20 boundary tests added for `parseBlockRef`/`formatBlockRef`; appended to existing `tests/message-ids.test.ts`.

## Cross-references

- Source investigator: tests + CI + format + deps
- Source finding ID: INV-COVERAGE-2
- Validator verdict: ✅ CONFIRMED
- Doc anchor: `docs/features/COMPRESSION.md` INV-20

## Architect Review (2026-08-07)

- **Verdict**: CONFIRMED
- **Severity**: kept High (INV-20 is a published invariant; a regex loosening would silently corrupt block-graph references)
- **Correct Fix**: equivalent to report — append to existing file rather than creating duplicate. Co-test `formatBlockRef(0)` throws.
- **Bonus**: `parseBoundaryId` and `formatMessageIdTag` in same file are also untested; worth co-locating.
