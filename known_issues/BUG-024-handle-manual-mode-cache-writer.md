# BUG-024: `handleManualToggleCommand` writes `state.manualMode` directly (not via `effectiveManualMode`); root cause of the DPP-017 cache cluster

## Summary
`handleManualToggleCommand` at `lib/commands/manual.ts:64-79` writes `state.manualMode` directly without re-deriving from `userForced || recoveryForced`. This is the root-cause writer of the DPP-017 cache cluster documented in BUG-006. Other writers (`pipeline.ts:197`, `state.ts:222`, `state.ts:260`) correctly use `effectiveManualMode(state)`. The three branches in `manual.ts` (`on`, `off`, no-arg toggle) all bypass the helper.

## Location
- `lib/commands/manual.ts:64-79`

## Current vs Expected Behavior
**Current**: Direct `state.manualMode = ...` assignment in three branches.
**Expected**: A single `applyManualModeFlags(state)` helper that re-derives the cache from `userForced || recoveryForced` after every flag mutation.

## Impact
- **Severity**: High (root cause of BUG-006 cluster)
- Runtime: cache drift visible to all readers.
- User-observable: same as BUG-006 — nudges, strategies, system prompt, help text all diverge from canonical.

## Reproduction
See BUG-006 reproduction.

## Suggested Fix
At the top of `handleManualToggleCommand`, after the if/else branches:
```ts
state.manualMode = effectiveManualMode(state)
```
Same one-line addition at `lib/state/state.ts:222` and `:260` (which currently use inline `state.userForced || state.recoveryForced ? "active" : false` expressions — functionally correct but bypassing the canonical helper).

## Status
Open

## Cross-references
- Source investigator: config + state persistence
- Source finding ID: STATE-MANUALMODE-CACHE-1
- Validator verdict: ✅ CONFIRMED (root cause of BUG-006 cluster)
- Doc anchor: `docs/DESIGN_PRINCIPLES.md` DPP-017, `docs/PATTERNS.md` PAT-007

## Architect Review (2026-08-07)
- **Verdict**: CONFIRMED (with sub-claim correction)
- **Severity**: kept High — root cause of BUG-006 cluster
- **Correct Fix**: extends BUG-006 fix to also touch `state/state.ts:222, 260`. The report claims they "correctly use the helper" when they actually use the inline expression (functionally equivalent but bypasses the canonical helper).
- **Critique of report's fix**: incomplete for `state.ts:222/260` — the report's claim is wrong. Closing `manual.ts` is highest-impact; closing the inline expressions is hygiene.
- **Bonus**: `lib/hooks.ts:295` writes `state.manualMode = "compress-pending"` (the third tri-state value); the new helper must NOT clobber it. Pin in a test: `effectiveManualMode` returns `"active" | false` only, never `"compress-pending"`. `lib/tui/data.ts:43, 50, 70` has the same inline-expression pattern.
- **Merge**: BUG-024 + BUG-006 + BUG-050 (same manualMode cache drift cluster).