# BUG-009: No try/catch around `deduplicate` / `purgeErrors` in compress pipeline; any throw aborts the whole compress

## Summary

`deduplicate` and `purgeErrors` are called sequentially in `lib/compress/pipeline.ts` without any error isolation. If either strategy throws (e.g., `state.toolParameters.get(id)` returns undefined and downstream code dereferences it), the error bubbles up out of `prepareSession`, aborting the entire compress call before validation/refetch completes. A strategy bug also leaves `state.manualMode = "compress-pending"` set, which blocks subsequent autonomous attempts until the next `/dcp-compress`.

## Location

- `lib/compress/pipeline.ts:94-95`

## Current vs Expected Behavior

**Current**: Two unguarded strategy calls in sequence.
**Expected**: Either per-strategy try/catch that logs and continues, OR an explicit `// ponytail: strategies are crash-on-error` comment documenting the no-isolation contract.

## Impact

- **Severity**: High (PAT-005 contract violates plugin robustness; DPP-013 implication — agent summary is the load-bearing artifact)
- Runtime: a strategy bug kills the compress and the user has no diagnostic.
- User-observable: silent failure; user re-runs `/dcp-compress`, hits the same error, no logs to triage.

## Reproduction

Force a `state.toolParameters.get(id)` to return undefined for an ID the strategies will dereference. Observe: unhandled throw aborts the compress.

## Suggested Fix

Document the contract explicitly per PAT-001 rather than swallow errors silently:

```ts
// ponytail: strategy bugs intentionally abort the compress so the user sees the failure
// rather than running with stale state. Add per-strategy isolation only if a real
// strategy becomes optional or replaceable.
deduplicate(ctx.state, ctx.logger, ctx.config, rawMessages)
purgeErrors(ctx.state, ctx.logger, ctx.config, rawMessages)
```

Alternative: per-strategy try/catch as the report suggests, but that masks strategy bugs and contradicts PAT-005 (range mode throws hard; strategies are also load-bearing).

## Status

Fixed 2026-08-07

## Resolution

try/catch wraps `deduplicate` / `purgeErrors` strategy calls in compress pipeline; failures logged, pipeline continues.

## Cross-references

- Source investigator: hooks + messages
- Source finding ID: PIPE-NOLOGSTRAT-1
- Validator verdict: ✅ CONFIRMED
- Doc anchor: `docs/features/PRUNING.md` Strategies in compress pipeline, `docs/PATTERNS.md` PAT-005

## Architect Review (2026-08-07)

- **Verdict**: CONFIRMED
- **Severity**: kept High but fix is documentation not isolation
- **Correct Fix**: prefer `// ponytail:` doc comment over per-strategy try/catch (which would silently swallow strategy errors and hide real bugs).
- **Bonus**: `state.manualMode = "compress-pending"` persists if `prepareSession` throws between strategies and `finalizeSession`; reset it in any future catch path.
