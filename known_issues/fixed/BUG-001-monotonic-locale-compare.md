# BUG-001: validateMonotonicEnd uses lexicographic localeCompare; `b10` < `b9` wrongly flagged

## Summary

`validateMonotonicEnd` in `lib/compress/range-utils.ts` compares boundary IDs with the default lexicographic `localeCompare`, violating PAT-006 (numeric-aware sort). Legitimate `b9 → b10` transitions are rejected as `__DCP_MONOTONIC_VIOLATION__`.

## Location

- `lib/compress/range-utils.ts:99-105`
- `lib/compress/message.ts:96` (mirror)

## Current vs Expected Behavior

**Current**: `newStart.localeCompare(prevAnchorEnd) <= 0` throws on any non-numeric comparison. `"b10".localeCompare("b9")` returns `-1`, so a valid `b9 → b10` progression is rejected.
**Expected**: `newStart.localeCompare(prevAnchorEnd, undefined, { numeric: true }) > 0` per PAT-006. The companion `listValidBoundaryIds` (line 32) does use numeric sort — the divergence is the bug.

## Impact

- **Severity**: High (invariant broken — DPP-005 + PAT-006 violated in the user-facing error path)
- Runtime: compress tool throws `__DCP_MONOTONIC_VIOLATION__` mid-session once block IDs reach `b10`. The hint message then tells the model the IDs are invalid when they are not.
- User-observable: model loops on self-correction, can't progress, or fails the entire compress batch.

## Reproduction

Existing tests use 4-digit-padded `mNNNN` references where lexicographic and numeric agree, so they don't trip the bug. A real session that creates 10+ compression blocks (`b1` through `bN`) will trigger it.

## Suggested Fix

Change both comparisons at `lib/compress/range-utils.ts:99, 105` to `localeCompare(prevAnchorEnd, undefined, { numeric: true })`. Apply the same change in `lib/compress/message.ts:96`.

## Status

Fixed 2026-08-07

## Resolution

Added `{ numeric: true }` to `localeCompare` at `lib/compress/range-utils.ts:99, 105`; closes BUG-075 hint filter too.

## Cross-references

- Source investigator: hooks + messages / compress + v2 fork-protocol
- Source finding IDs: PIPE-MONOTONIC-1, MONOTONIC-NUMERIC
- Validator verdict: ✅ CONFIRMED (two investigators, deduplicated)
- Doc anchor: `docs/PATTERNS.md` PAT-006, `docs/DESIGN_PRINCIPLES.md` DPP-005

## Architect Review (2026-08-07)

- **Verdict**: CONFIRMED
- **Severity**: kept High (DPP-005 invariant broken in user-facing error path)
- **Correct Fix**: `lib/compress/range-utils.ts:99, 105` only — add `undefined, { numeric: true }`:
    ```ts
    if (newStart.localeCompare(prevAnchorEnd, undefined, { numeric: true }) <= 0) { ... }
    if (newEnd.localeCompare(prevAnchorEnd, undefined, { numeric: true }) <= 0) { ... }
    ```
    No change needed at `lib/compress/message.ts:96` (it is a call to `validateMonotonicEnd`, not a comparator).
- **Critique of report's fix**: equivalent except it incorrectly asserts a parallel change at `message.ts:96`. One-file fix suffices.
- **Bonus**: companion `listValidBoundaryIds` at `range-utils.ts:32` already documents numeric-sort intent; add a `// ponytail:` comment at lines 99/105 to prevent recurrence. BUG-075's `{numeric: true}` fix overlaps here.
