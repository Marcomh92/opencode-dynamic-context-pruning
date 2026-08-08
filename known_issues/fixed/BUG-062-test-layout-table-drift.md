# BUG-062: `docs/TESTING.md` layout table incomplete vs actual test directory

## Summary

`docs/TESTING.md:18-30` enumerates a layout table with rows covering roughly 31 test files. The actual `tests/` directory contains 32 `.test.ts` files (one missing file: `tests/prune-tools-propagation.test.ts`). AGENTS.md also says "33 node:test files" — both counts are off.

## Location

- `docs/TESTING.md:18-30`

## Current vs Expected Behavior

**Current**: Layout table misses a few test files.
**Expected**: Layout table mirrors the directory 1:1.

## Impact

- **Severity**: Low (documentation drift)
- Runtime: not affected.
- User-observable: future readers confused.

## Reproduction

Compare `Get-ChildItem tests/*.test.ts` to `docs/TESTING.md:18-30`.

## Suggested Fix

At `docs/TESTING.md:18-30`, add one row for `prune-tools-propagation.test.ts`. Best home: extend the "Compress" row OR add a "Propagation" row, e.g.:

```
| Propagation | `prune-tools-propagation.test.ts` |
```

Or extend the Compress row to enumerate it. Also fix AGENTS.md count (line 66 says "33 node:test files" but actual is 32).

## Status

Fixed 2026-08-07

## Resolution

Added missing `prune-tools-propagation.test.ts` row to `docs/TESTING.md:18-30` layout table; fixed AGENTS.md count from 33 to 32.

## Cross-references

- Source investigator: tests + CI + format + deps
- Source finding ID: LAYOUT-TABLE-DRIFT-1
- Validator verdict: ⚠️ PARTIAL (drift is real but counts vary)
- Doc anchor: `docs/TESTING.md` Layout

## Architect Review (2026-08-07)

- **Verdict**: PARTIAL — drift is real but smaller than reported
- **Severity**: kept Low (the drift is a single missing row)
- **Critique of report's fix**: report's count "33 actual vs ~31 in the table" is off by one (actual is 32; gap is 1, not a "handful"). Also fix AGENTS.md count drift.
- **Bonus**: `docs/TESTING.md:20` (Hooks row) lists `hooks-permission.test.ts`; line 27 (Permissions row) also lists it — the double-listing is fine if intentional cross-reference but worth flagging as ambiguous. The "Coverage gaps" section (`docs/TESTING.md:53-58`) doesn't list `lib/state/state.ts::resetSessionState` or `compressionTiming` — relevant given BUG-060 and BUG-059.
