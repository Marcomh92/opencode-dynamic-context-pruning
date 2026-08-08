# BUG-022: `lib/compress/timing.ts` exports 4 helpers with zero direct test coverage

## Summary

`buildCompressionTimingKey`, `consumeCompressionStart`, `resolveCompressionDuration`, `applyPendingCompressionDurations` (and the sibling `attachCompressionDuration` in `lib/compress/state.ts:30-51`) are exported but never imported by any test. Bugs in monotonic-duration attribution would not be caught before reaching production session stats.

## Location

- `lib/compress/timing.ts:1-end`
- `lib/compress/state.ts:30-51` (`attachCompressionDuration`)

## Current vs Expected Behavior

**Current**: Timing helpers are integration-tested indirectly (they're called from `lib/hooks.ts:21-24` and `lib/compress/pipeline.ts:12`), but no unit test pins their contracts.
**Expected**: A `tests/compress-timing.test.ts` file with table-driven cases.

## Impact

- **Severity**: High (test gap on a load-bearing surface)
- Runtime: not affected directly.
- User-observable: duration stats may drift silently; recovery timing may misreport.

## Reproduction

```sh
grep -l "buildCompressionTimingKey\|consumeCompressionStart\|resolveCompressionDuration\|applyPendingCompressionDurations\|attachCompressionDuration" tests/*.test.ts
# No matches.
```

## Suggested Fix

Add `tests/compress-timing.test.ts`. Ponytail-friendly minimum covers:

- `buildCompressionTimingKey("m1", "c1")` ≠ `buildCompressionTimingKey("m2", "c1")` ≠ `buildCompressionTimingKey("m1", "c2")`.
- `consumeCompressionStart` on missing key → `undefined`; on second call → `undefined` (delete semantics).
- `resolveCompressionDuration(undefined, undefined, undefined)` → `undefined`.
- `applyPendingCompressionDurations` deletes entries even when attach returns 0 (closes BUG-010).

Plus a small `attachCompressionDuration` test from `lib/compress/state.ts`.

## Status

Fixed 2026-08-07

## Resolution

Unit tests added for all four helpers in `lib/compress/timing.ts`.

## Cross-references

- Source investigator: tests + CI + format + deps
- Source finding ID: COV-TIMING-1
- Validator verdict: ✅ CONFIRMED
- Doc anchor: `docs/TESTING.md` Layout, `docs/PATTERNS.md` PAT-010

## Architect Review (2026-08-07)

- **Verdict**: CONFIRMED
- **Severity**: kept High (drives session stats and recovery timing; drift here corrupts `/dcp stats` output without signal)
- **Correct Fix**: equivalent to report; "deletes entries regardless of attach outcome (closes BUG-010)" is exactly the right invariant to test.
- **Bonus**: `lib/compress/state.ts:30-51` (`attachCompressionDuration`) shares the same untested surface. Same test file.
