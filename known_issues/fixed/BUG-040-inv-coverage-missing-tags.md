# BUG-040: INV-5/6/7/8 covered indirectly but no test references `INV-N` identifiers

## Summary

Looking at the inline comments in `tests/compress-protocol.test.ts:328` (`#573 monotonicity`), `compress-protocol.test.ts:454` (`#573 net-compaction`), these tests implement INV-1, INV-6, INV-7, INV-8. They are good tests, but no test references its INV-N identifier and the comments mention issue numbers, not invariants. `grep INV-` in `tests/` returns zero matches. This makes audits of the docs against tests brittle.

## Location

- `tests/compress-protocol.test.ts:308-326` (effectiveManualMode — INV-8)
- `tests/compress-protocol.test.ts:454-540` (net-compaction — INV-6)
- `tests/compress-protocol.test.ts:577-626` (recovery fade — INV-7)
- `tests/synthetic-compress-burn.test.ts:123, 161, 206` (recoveryForced)

## Current vs Expected Behavior

**Current**: Tests exist but are not tagged with the INV identifier they pin.
**Expected**: A one-line header at the top of each contract test listing the documented INV-\* ids it covers.

## Impact

- **Severity**: Medium (audit hygiene)
- Runtime: not affected.
- User-observable: future audits cannot easily map tests to invariants.

## Reproduction

```sh
grep -l "INV-" tests/*.test.ts
# No matches.
```

## Suggested Fix

Comment-only headers as proposed. Minor imprecision in the report's mapping (the more direct INV-8 tests are at `:243` and `:275`, not `:308`). Map per-line:

```ts
// INV-6: net-compaction guard (summaryTokens < removedTokens * maxCompactionRatio)
// INV-7: recovery fade window
// INV-8: userForced clearing semantics
```

## Status

Fixed 2026-08-07

## Resolution

Added `INV-N` identifier comments to relevant tests in `tests/compress-protocol.test.ts` and `tests/synthetic-compress-burn.test.ts`.

## Cross-references

- Source investigator: tests + CI + format + deps
- Source finding ID: COV-INV-5-6-7-8
- Validator verdict: ✅ CONFIRMED
- Doc anchor: `docs/features/COMPRESSION.md` INV-5..8

## Architect Review (2026-08-07)

- **Verdict**: CONFIRMED (low value)
- **Severity**: **changed Medium → Low**. Pure audit hygiene; comments only, zero runtime or correctness impact.
- **Bonus**: the framing in the report treats "comments mention issue numbers, not invariants" as a deficiency — but issue numbers in test names are the documented convention, PAT-013 (`docs/PATTERNS.md:101-103`) and `docs/TESTING.md:44`. INV tags should be _added alongside_, not presented as a correction.
- **Merge**: BUG-023 + BUG-040 (PAT-012 / INV coverage; both comment-only). NOT merge with BUG-039 (which hides a real bug, not just an INV-tag gap).
