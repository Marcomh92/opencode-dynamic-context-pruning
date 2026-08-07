# BUG-075: `__DCP_MONOTONIC_VIOLATION__` hint lists all valid IDs, not strictly-greater

## Summary
The `validNextHint` at `lib/compress/range-utils.ts:86-90` is built from `listValidBoundaryIds(state)`, which is `state.messageIds.byRef.keys() ∪ active block refs`. Nothing filters to `> prevAnchorEnd`. So the hint includes IDs that fail the check the agent is trying to satisfy, making the self-correction path noisier than needed.

## Location
- `lib/compress/range-utils.ts:86-90`

## Current vs Expected Behavior
**Current**: Hint includes all valid IDs (some fail the monotonic check).
**Expected**: Filter `validNextIds` by `id.localeCompare(prevAnchorEnd, undefined, { numeric: true }) > 0` before formatting.

## Impact
- **Severity**: Suggestion (UX nit)
- Runtime: not affected.
- User-observable: model gets a noisy hint when self-correcting.

## Reproduction
Trigger a `__DCP_MONOTONIC_VIOLATION__` and inspect the hint.

## Suggested Fix
One-line filter in `lib/compress/range-utils.ts:86-90`:
```ts
const validNextIds = listValidBoundaryIds(state)
    .filter(id => id.localeCompare(prevAnchorEnd, undefined, { numeric: true }) > 0)
const validNextHint = validNextIds.length > 0
    ? `Valid next anchors: ${validNextIds.join(", ")}`
    : "Valid next anchors: (none — message refs not yet injected)"
```

## Status
Open

## Cross-references
- Source investigator: compress + v2 fork-protocol
- Source finding ID: HINT-ALL-VS-NEXT
- Validator verdict: ✅ CONFIRMED
- Doc anchor: `docs/DESIGN_PRINCIPLES.md` DPP-005

## Architect Review (2026-08-07)
- **Verdict**: CONFIRMED
- **Severity**: kept Suggestion (UX nit; model can still self-correct from a wider hint, just noisier)
- **Bonus**: applying `{numeric: true}` in the filter implicitly fixes `b10` < `b9` lexicographic issue at lines 99/105 — but only when the filter is engaged. Lines 99/105 themselves remain buggy. Extract a `compareBoundaryIds(a, b)` helper for consistency.
- **Merge**: BUG-075 + BUG-001 (same comparator at `range-utils.ts:99,105`). Apply `{numeric: true}` to lines 99/105 and BUG-001 closes.