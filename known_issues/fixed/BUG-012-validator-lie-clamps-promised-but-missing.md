# BUG-012: Validator says "will be clamped to 1" for 4 keys but `mergeCompress`/`mergeStrategies`/`mergeLayer` never clamp

## Summary

DPP-012 promises "bad values fall back" via `clampRatio` / `clampMin1` / `clampNullOrNonNeg`. The validator emits a user-visible toast saying `(will be clamped to 1)` for three keys — `compress.nudgeFrequency`, `compress.iterationNudgeThreshold`, `strategies.purgeErrors.turns` — but the merge functions use plain `??` fallback and never clamp. (The `turnProtection.turns` validator does NOT claim clamping — see architect review.) A user writing `"nudgeFrequency": 0` gets a misleading toast and the value stays at 0.

## Location

- `lib/config.ts:403-409` (`compress.nudgeFrequency`)
- `lib/config.ts:461-470` (`compress.iterationNudgeThreshold`)
- `lib/config.ts:696-706` (`strategies.purgeErrors.turns`)
- `lib/config.ts:258-264` (`turnProtection.turns`)

## Current vs Expected Behavior

**Current**: Validator toast claims clamping; merge uses `??` and preserves the user's bad value.
**Expected**: Either apply `clampMin1` in the merge function, or drop the "(will be clamped)" wording if clamping is intentionally not done.

## Impact

- **Severity**: High (DPP-012 partial violation; user sees misleading toast)
- Runtime: invalid values flow into runtime logic. Nudge frequency of 0 means "inject every turn"; iteration threshold of 0 means "always nudge"; turns of 0 means "purge every error instantly" or "no turn protection".
- User-observable: behavior diverges from the toast's promise; users assume the value was corrected.

## Reproduction

Edit `dcp.jsonc` to `"compress": { "nudgeFrequency": 0 }`. Restart OpenCode. Observe the validation toast and inspect the runtime value via `/dcp stats`.

## Suggested Fix

Apply `clampMin1` in the merge for the three keys the validator mentions:

```ts
// mergeCompress
nudgeFrequency: clampMin1(override.nudgeFrequency ?? base.nudgeFrequency),
iterationNudgeThreshold: clampMin1(override.iterationNudgeThreshold ?? base.iterationNudgeThreshold),
```

```ts
// mergeStrategies
turns: clampMin1(override.purgeErrors?.turns ?? base.purgeErrors.turns),
```

For `turnProtection.turns` (which the validator does NOT mention as clamped), either add `clampMin1` to the merge for consistency, or leave the merge as-is (current runtime behavior — invalid values flow through).

## Status

Fixed 2026-08-07

## Resolution

Validator text aligned with merge-site behavior; clamps now apply at all four `mergeCompress`/`mergeStrategies` sites.

## Cross-references

- Source investigator: config + state persistence
- Source finding ID: CFG-VALIDATOR-LIE-1
- Validator verdict: ✅ CONFIRMED
- Doc anchor: `docs/DESIGN_PRINCIPLES.md` DPP-012, `docs/CONFIGURATION.md` Validation section

## Architect Review (2026-08-07)

- **Verdict**: PARTIAL — 3 of 4 keys confirmed; `turnProtection.turns` validator does NOT make the misleading claim
- **Severity**: kept High (validator lies to users; merge fails to honor contract)
- **Correct Fix**: three sites only (not four). `lib/config.ts:407, 468` for `nudgeFrequency` / `iterationNudgeThreshold`; `lib/config.ts:938` for `purgeErrors.turns`. Note: `lib/strategies/purge-errors.ts:46` already defends at runtime via `Math.max(1, ...)` — but the other two have NO such defense.
- **Critique of report's fix**: equivalent but lists 4 sites instead of 3. Remove `turnProtection.turns` from the list (or add `clampMin1` there for consistency).
- **Bonus**: `purge-errors.ts:46` (`Math.max(1, ...)`) is a runtime defense for one of three keys — the inconsistency is itself a smell. Apply `clampMin1` everywhere at merge time (consistent) or remove runtime defense and rely on validator (also consistent).
