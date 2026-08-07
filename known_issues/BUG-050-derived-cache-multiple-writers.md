# BUG-050: Multiple writers set `state.manualMode` without `effectiveManualMode`; should consolidate

## Summary
Every place that mutates `userForced`/`recoveryForced` should re-derive `manualMode` via `effectiveManualMode(state)`. Currently only `pipeline.ts:197` does so explicitly. Other writers:
- `lib/commands/manual.ts:65, 71, 77` — direct assignment (root cause: see BUG-024)
- `lib/state/state.ts:179, 202` — correct on initial load but doesn't account for `recoveryForced`
- `lib/hooks.ts:295` — sets `"compress-pending"` (single writer, OK)

## Location
- `lib/commands/manual.ts:64-79` (root cause)
- `lib/state/state.ts:178-180, 200-222, 257-260`

## Current vs Expected Behavior
**Current**: Multiple writers, no consolidated helper.
**Expected**: Single `applyManualModeFlags(state)` helper that re-derives the cache from `userForced || recoveryForced` after every flag mutation.

## Impact
- **Severity**: Low (consequence of BUG-006 + BUG-024; tracked separately for the consolidation task)
- Runtime: same as BUG-006.
- User-observable: same as BUG-006.

## Reproduction
See BUG-006.

## Suggested Fix
Hoist the derivation to a local helper in `lib/commands/manual.ts` and use it after every flag mutation:
```ts
function applyManualModeFlags(state: SessionState): void {
    state.manualMode = state.userForced || state.recoveryForced ? "active" : false
}

if (modeArg === "on") {
    state.userForced = true
} else if (modeArg === "off") {
    state.userForced = false
} else {
    state.userForced = !state.userForced
}
applyManualModeFlags(state)
```
Lines 65 and 71 (and the no-arg toggle at 77) need this fix. `lib/state/state.ts:179, 202, 222, 260` and `lib/compress/pipeline.ts:127, 197` already use the derivation correctly.

## Status
Open

## Cross-references
- Source investigator: hooks + messages
- Source finding ID: CFG-DERIVED-CONSISTENCY-1
- Validator verdict: ✅ CONFIRMED
- Doc anchor: `docs/DESIGN_PRINCIPLES.md` DPP-017, `docs/PATTERNS.md` PAT-007

## Architect Review (2026-08-07)
- **Verdict**: CONFIRMED
- **Severity**: kept Low
- **Correct Fix**: helper + two-line replacement. Don't touch `state.ts` or `pipeline.ts` — they already use the derivation.
- **Critique of report's fix**: equivalent.
- **Bonus**: related to BUG-006 and BUG-024 (manualMode cache drift chain). All three resolve with one helper + `git grep "state.manualMode ="` audit.
- **Merge**: BUG-006 + BUG-024 + BUG-050 (manualMode cache drift cluster).