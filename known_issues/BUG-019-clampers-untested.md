# BUG-019: `clampRatio` / `clampMin1` / `clampNullOrNonNeg` not unit-tested

## Summary
DPP-012 states fork-protocol fields are clamped, not rejected. The clampers `clampRatio`, `clampMin1`, `clampNullOrNonNeg` (`lib/config.ts:988-1004`) implement the clamps. They are not exported, and no test imports them. The merge callers exercise them only through integration paths. Edge cases — NaN, `-1`, `Infinity`, `null`, `string`, `0` — have no direct test. A refactor that drops a clamp would not be caught.

## Location
- `lib/config.ts:988` (`clampRatio`)
- `lib/config.ts:995` (`clampMin1`)
- `lib/config.ts:1000` (`clampNullOrNonNeg`)

## Current vs Expected Behavior
**Current**: Clampers are not exported; tests cannot import them.
**Expected**: Export the clampers, add a table-driven unit test asserting each edge case.

## Impact
- **Severity**: High (DPP-012 has no automated check; one regression slips through silently)
- Runtime: not affected directly.
- User-observable: a `maxCompactionRatio` of `NaN` or `Infinity` could silently break the net-compaction guard.

## Reproduction
Inspect `tests/*.test.ts` for `clampRatio`, `clampMin1`, `clampNullOrNonNeg` — zero matches.

## Suggested Fix
Two-step ponytail-friendly minimum:
1. Export the three clampers from `lib/config.ts`:
   ```ts
   export function clampRatio(value: number): number { ... }
   export function clampMin1(value: number): number { ... }
   export function clampNullOrNonNeg(value: number | null | undefined): number | null { ... }
   ```
2. Add `tests/config-clampers.test.ts` with table-driven cases including `clampRatio(NaN) === 0.7` edge.

## Status
Open

## Cross-references
- Source investigator: tests + CI + format + deps
- Source finding ID: INV-COVERAGE-1
- Validator verdict: ✅ CONFIRMED
- Doc anchor: `docs/DESIGN_PRINCIPLES.md` DPP-012, `docs/CONFIGURATION.md` Validation

## Architect Review (2026-08-07)
- **Verdict**: CONFIRMED
- **Severity**: kept High (DPP-012 has zero automated check)
- **Correct Fix**: equivalent to report. Worth adding `clampRatio(NaN) === 0.7` to the edge cases.
- **Bonus**: BUG-012 (validator toast lies about clamping) is the more dangerous sibling — the validator *promises* `clampMin1` for `nudgeFrequency`/`iterationNudgeThreshold`/`purgeErrors.turns` but the merge uses `??` not `clampMin1`. Closing BUG-019 does NOT close BUG-012 (separate fixes).
- **Merge**: BUG-019 + BUG-012 (DPP-012 enforcement gap; sequence: close BUG-019 first with tests, then audit merge sites).