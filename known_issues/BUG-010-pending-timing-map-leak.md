# BUG-010: `compressionTiming.pendingByCallId` leaks entries forever when no matching block exists

## Summary
`applyPendingCompressionDurations` in `lib/compress/timing.ts` deletes entries from `pendingByCallId` only when `attachCompressionDuration > 0`. If a compress block was deactivated (`/dcp decompress`) before the `message.part.updated` event with `status: "completed"` arrives, no block has matching `(compressMessageId, compressCallId)`, `attachCompressionDuration` returns 0, and the entry stays in the map for the lifetime of the session state.

## Location
- `lib/compress/timing.ts:57-76`

## Current vs Expected Behavior
**Current**: `if (applied > 0) { updates += applied; state.compressionTiming.pendingByCallId.delete(key) }` — entries only delete on successful attach.
**Expected**: Bounded or always-evict. One tick of "ghost" durationMs writes is harmless; the entry should be deleted regardless of attach outcome.

## Impact
- **Severity**: High (per-session memory leak)
- Runtime: a long session with many compress-decompress cycles accumulates orphaned entries. Bounded only by `resetSessionState` on session switch.
- User-observable: slowly growing memory; eventually noticeable in long-lived TUI/desktop sidecar processes.

## Reproduction
Run a session with N compress calls, then `/dcp decompress` on all of them before the completion events arrive. Inspect `state.compressionTiming.pendingByCallId.size`.

## Suggested Fix
Unconditional delete (simpler than FIFO cap):
```ts
// lib/compress/timing.ts:70-73
attachCompressionDuration(state.prune.messages, entry.messageId, entry.callId, entry.durationMs)
state.compressionTiming.pendingByCallId.delete(key)
```
Add `// ponytail: ghost-entry delete; one tick of durationMs writes may not land on a block, but the map must stay bounded.` Note: Map iteration during delete is spec-safe.

## Status
Open

## Cross-references
- Source investigator: hooks + messages
- Source finding ID: STATE-PENDINGTIMING-1
- Validator verdict: ✅ CONFIRMED
- Doc anchor: `docs/features/STATE_PERSISTENCE.md` Compression handling section, `docs/PERFORMANCE.md` PER-008 budgets

## Architect Review (2026-08-07)
- **Verdict**: CONFIRMED
- **Severity**: kept High (per-session memory leak in long-lived TUI processes)
- **Correct Fix**: unconditional delete (symmetric with sibling `startsByCallId` which already does this). FIFO eviction cap is overkill.
- **Bonus**: `startsByCallId` (line 25-27) already uses unconditional delete — this is a sibling-bug. BUG-060 is the related orphan surface.