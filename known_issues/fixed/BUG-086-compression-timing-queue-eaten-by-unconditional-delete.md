# BUG-086: compression-timing queue eaten by unconditional delete

**Status:** Fixed 2026-08-07
**Severity:** Medium
**Component:** lib/compress/timing.ts

## Problem

`applyPendingCompressionDurations` did `pendingByCallId.delete(key)` unconditionally inside the loop, even when `applied === 0`. This destroyed queued entries that were supposed to survive until a later `ensureSessionInitialized` call could apply them. Test "event hook queues duration updates until the matching session is loaded" (tests/hooks-permission.test.ts:549) failed.

## Root cause

Regressed by the BUG-010 fix (commit 8b4f19d): the conditional `if (applied > 0) { ... delete }` was replaced with unconditional delete to prevent leak. The leak fix over-corrected and broke the queueing contract.

## Fix

- Restore conditional deletion: only delete on `applied > 0`.
- Add FIFO size cap (128) on `pendingByCallId` to prevent the original BUG-010 leak while preserving queueing semantics.

## Files

- lib/compress/timing.ts (fixed)
- tests/hooks-permission.test.ts (now passes)
- known_issues/fixed/BUG-010-pending-timing-map-leak.md (originating fix)

## Resolution

Restored conditional deletion in `applyPendingCompressionDurations` (only delete when `applied > 0`); added FIFO cap of 128 to prevent the original BUG-010 leak while preserving queueing semantics.
