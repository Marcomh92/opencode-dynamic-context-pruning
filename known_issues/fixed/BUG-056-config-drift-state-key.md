# BUG-056: `docs/CONFIGURATION.md` references `state.maxAgeDays`; actual key is `compress.stateMaxAgeDays`

## Summary

The runtime defaults table at `docs/CONFIGURATION.md:42` says `state.maxAgeDays` is `null` (disabled). The actual config key is `compress.stateMaxAgeDays`. `VALID_CONFIG_KEYS` only contains `compress.stateMaxAgeDays`. A user following the docs to set `state.maxAgeDays: 30` would get an "Unknown keys" warning and the value would be ignored.

## Location

- `docs/CONFIGURATION.md:42`
- `lib/config.ts:808` (runtime key)
- `dcp.schema.json:274-281` (schema key)

## Current vs Expected Behavior

**Current**: Docs say `state.maxAgeDays`; runtime expects `compress.stateMaxAgeDays`.
**Expected**: Rename to `compress.stateMaxAgeDays` in the docs.

## Impact

- **Severity**: Low (docs drift)
- Runtime: not affected.
- User-observable: a user following the docs gets an "Unknown keys" warning.

## Reproduction

Read `docs/CONFIGURATION.md:42`. Compare to `lib/config.ts:808`.

## Suggested Fix

At `docs/CONFIGURATION.md:42`, change `state.maxAgeDays` → `compress.stateMaxAgeDays` in the table row. One-cell edit.

## Status

Fixed 2026-08-07

## Resolution

Updated `state.maxAgeDays` → `compress.stateMaxAgeDays` at `docs/CONFIGURATION.md:42` runtime defaults table.

## Cross-references

- Source investigator: config + state persistence
- Source finding ID: CONFIG-DRIFT-2
- Validator verdict: ✅ CONFIRMED
- Doc anchor: `docs/CONFIGURATION.md`

## Architect Review (2026-08-07)

- **Verdict**: CONFIRMED
- **Severity**: kept Low (user-observable consequence is mild)
- **Correct Fix**: equivalent to report — minimal one-cell edit.
- **Bonus**: `docs/DESIGN_PRINCIPLES.md:79` already uses the correct name `stateMaxAgeDays` — so the doc set is internally inconsistent. `docs/features/STATE_PERSISTENCE.md:17` uses the function-arg name `maxAgeDays` (correct, that's the function parameter name) — no drift there.
