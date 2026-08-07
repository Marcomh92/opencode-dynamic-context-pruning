# BUG-025: m-NNNN refs not reclaimed when blocks are deactivated

## Summary
`assignMessageRefs` only inserts into `byRawId`/`byRef`; no delete path. `nextRef` is only incremented on allocation. When `filterCompressedRanges` drops a compacted message or `/dcp decompress` deactivates a block, the m-NNNN stays allocated. The 9999 cap (`MESSAGE_REF_MAX_INDEX`) becomes reachable faster than expected.

## Location
- `lib/message-ids.ts:119-153` (writer, no eviction)
- `lib/commands/decompress.ts` (decompression path)

## Current vs Expected Behavior
**Current**: refs are never reclaimed; `nextRef` only grows.
**Expected**: When a block is deactivated, evict m-NNNN entries for messages that have no other active block referencing them. `state.prune.messages.byMessageId` already provides the cross-reference.

## Impact
- **Severity**: Medium (capacity risk under sustained compress-decompress cycles)
- Runtime: not affected until 9999 cap is reached.
- User-observable: `Message ID alias capacity exceeded` thrown mid-session, breaking the LLM call (no try/catch around the pipeline).

## Reproduction
A long session with frequent compress/decompress cycles; eventually hit the 9999 cap.

## Suggested Fix
None of the three options in the report is strictly correct in isolation. The cleanest minimal fix is the outer try/catch from BUG-028 (the bigger-picture fix). For `assignMessageRefs` itself, document the cap with a ponytail comment:
```ts
// lib/message-ids.ts:119
// ponytail: cap at 9999; sufficient for any realistic session. Eviction on
// block deactivation (option 2 of the report) is the upgrade path if cap pressure rises.
```
BUG-074 (graceful sentinel on capacity) is the defense-in-depth fix.

## Status
Open

## Cross-references
- Source investigator: hooks + messages
- Source finding IDs: PIPE-ANCHOR-1, MSGID-COMPRESSBURN-1 (same root cause)
- Validator verdict: ✅ CONFIRMED
- Doc anchor: `docs/features/PRUNING.md` INV-P1, INV-P2, `docs/PERFORMANCE.md` PER-008 budgets

## Architect Review (2026-08-07)
- **Verdict**: CONFIRMED (but suggested fix option 1 is unsafe)
- **Severity**: kept Medium (9999 messages is ~1000 turns of dense work; practically low)
- **Correct Fix**: gate behind BUG-028's try/catch; document `assignMessageRefs` with ponytail comment. Option 1 (`byMessageId.activeBlockIds.length > 0`) is **unsafe** — `byMessageId` tracks both active and previously-compacted messages, so skipping would deny legitimate new IDs.
- **Bonus**: BUG-074 (`Message ID alias capacity exceeded` is uncaught throw) is the direct pairing. Fixing BUG-028 fully neutralizes this.
- **Merge**: BUG-025 + BUG-074 + BUG-028 (transform pipeline fragility cluster).