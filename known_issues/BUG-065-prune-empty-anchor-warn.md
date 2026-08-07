# BUG-065: Synthetic summary dropped with warn when no preceding user message

## Summary
`filterCompressedRanges` pushes a synthetic only if `getLastUserMessage(messages, msgIndex)` returns non-null. For an anchor with no preceding non-ignored user message, the synthetic is silently dropped and a `warn` is logged. The block remains active in state. A subsequent `injectMessageIds` step doesn't see the synthetic. Future transforms re-attempt the lookup.

## Location
- `lib/messages/prune.ts:194-216`

## Current vs Expected Behavior
**Current**: Synthetic dropped with warn; underlying state inconsistent.
**Expected**: If no user message found, fall back to the next user message in the stream (or the anchor message itself) to host the synthetic; or deactivate the block.

## Impact
- **Severity**: Nitpick (rare scenario)
- Runtime: stale active block without synthetic materialization.
- User-observable: block persists but produces no summary.

## Reproduction
Hard to reproduce without specific session state.

## Suggested Fix
Deactivate the block on empty anchor rather than leave it dangling. At `lib/messages/prune.ts:212-216`:
```ts
} else {
    logger.warn("No user message found for compress summary; deactivating block", {
        anchorMessageId: msgId,
        blockId: (summary as { blockId?: unknown }).blockId,
    })
    const blockId = (summary as { blockId?: number }).blockId
    if (typeof blockId === "number") {
        state.prune.messages.blocksById.get(blockId)!.active = false
    }
}
```

## Status
Open

## Cross-references
- Source investigator: hooks + messages
- Source finding ID: PRUNE-EMPTYANCHOR-1
- Validator verdict: ✅ CONFIRMED
- Doc anchor: `docs/features/PRUNING.md` INV-P2

## Architect Review (2026-08-07)
- **Verdict**: CONFIRMED
- **Severity**: kept Nitpick (rare scenario, no data corruption)
- **Critique of report's fix**: "fall back to the next user message" is **wrong** — looking forward could re-host the synthetic on a later user message that has nothing to do with the anchor, breaking the invariant that a synthetic substitutes for the assistant message that owns the block. Deactivate-the-block is the correct path.
- **Bonus**: branch is reachable via `isIgnoredUserMessage` storms (subagent skipped user messages, ignored reminder tags) — see `lib/messages/query.ts:38-50`. Worth a one-line comment when fixing.