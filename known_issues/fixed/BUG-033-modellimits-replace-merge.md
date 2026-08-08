# BUG-033: `modelMaxLimits` / `modelMinLimits` merge is replace-semantics; project layer adding one model wipes globals

## Summary

`mergeCompress` at `lib/config.ts:961-962` does `modelMaxLimits: override.modelMaxLimits ?? base.modelMaxLimits`. A project's `modelMaxLimits: {"c/d": 200}` wipes the global `modelMaxLimits: {"a/b": 100}`. The schema treats these as per-model overrides (the user can declare overrides for individual provider/model pairs), so users reasonably expect per-key merge (Set-union by key) rather than full replacement.

## Location

- `lib/config.ts:961-962`

## Current vs Expected Behavior

**Current**: Replace-semantics: project layer adding a single override silently deletes every global override.
**Expected**: Merge at the per-key level: `{ ...base.modelMaxLimits, ...override.modelMaxLimits }`. Document the semantic.

## Impact

- **Severity**: Medium (config semantics mismatch with user expectation)
- Runtime: not affected directly; the override just doesn't work as expected.
- User-observable: a user adding a project-level override for one model silently loses all global overrides.

## Reproduction

1. Global `dcp.jsonc` sets `modelMaxLimits: { "anthropic/claude-3-5-sonnet": 200000 }`.
2. Project `dcp.jsonc` sets `modelMaxLimits: { "openai/gpt-4o": 128000 }`.
3. Inspect resolved config — only the project entry remains.

## Suggested Fix

At `lib/config.ts:961-962`:

```ts
modelMaxLimits: { ...base.modelMaxLimits, ...override.modelMaxLimits },
modelMinLimits: { ...base.modelMinLimits, ...override.modelMinLimits },
```

Update `docs/CONFIGURATION.md` "Replace vs additive semantics" table to record these two as per-key additive.

## Status

Fixed 2026-08-07

## Resolution

Changed `mergeCompress` at `lib/config.ts:961-962` to per-key additive: `{ ...base.modelMaxLimits, ...override.modelMaxLimits }`; documented in CONFIGURATION.md.

## Cross-references

- Source investigator: config + state persistence
- Source finding ID: CFG-MODEL-LIMITS-MERGE-1
- Validator verdict: ✅ CONFIRMED
- Doc anchor: `docs/CONFIGURATION.md` Replace vs additive semantics table

## Architect Review (2026-08-07)

- **Verdict**: CONFIRMED
- **Severity**: kept Medium
- **Correct Fix**: equivalent to report.
- **Bonus**: `lib/config.ts:1061-1062` `deepCloneConfig` already copies the object — this isn't an aliasing bug; purely a merge-semantics bug. Audit `mergeCompress` / `mergeStrategies` for other object-valued keys (`protectTags` may have the same issue — quick check, not validated here).
