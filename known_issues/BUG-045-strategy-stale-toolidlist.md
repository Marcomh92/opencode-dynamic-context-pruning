# BUG-045: Strategies in compress pipeline use possibly stale `state.toolIdList`

## Summary
Both strategies (`lib/strategies/deduplication.ts:30-33`, `lib/strategies/purge-errors.ts:33-36`) early-return when `state.toolIdList.length === 0`. In the chat-transform hook, `buildToolIdList` is called immediately before `prune`, so the list is fresh. In the compress pipeline (`lib/compress/pipeline.ts:94-95`), `buildToolIdList` is NOT called before `deduplicate`/`purgeErrors`. The strategies operate on whatever `toolIdList` was left from the last chat-transform fire (potentially minutes old). They then mark zero tools for pruning, even though there might be duplicates in the raw messages.

## Location
- `lib/strategies/deduplication.ts:30-33`
- `lib/strategies/purge-errors.ts:33-36`
- `lib/compress/pipeline.ts:94-95`

## Current vs Expected Behavior
**Current**: Stale `toolIdList` used by strategies in the compress pipeline.
**Expected**: Either populate `state.toolIdList` from the freshly fetched `rawMessages` before calling the strategies, or pass `rawMessages` to a strategy-local helper.

## Impact
- **Severity**: Low-Medium (compress pipeline under-deduplicates)
- Runtime: the compress tool may not deduplicate or purge errors it should.
- User-observable: latent under-marking of duplicate/erroring tool calls.

## Reproduction
Hard to reproduce reliably; depends on timing of chat-transform vs compress calls.

## Suggested Fix
At `lib/compress/pipeline.ts:92-95`, insert `buildToolIdList` between `assignMessageRefs` and the strategy calls:
```ts
assignMessageRefs(ctx.state, rawMessages)
buildToolIdList(ctx.state, rawMessages)  // mirrors lib/hooks.ts:182
deduplicate(ctx.state, ctx.logger, ctx.config, rawMessages)
purgeErrors(ctx.state, ctx.logger, ctx.config, rawMessages)
```

## Status
Open

## Cross-references
- Source investigator: hooks + messages
- Source finding ID: STRAT-MUTE-1
- Validator verdict: ✅ CONFIRMED
- Doc anchor: `docs/features/PRUNING.md` INV-P5

## Architect Review (2026-08-07)
- **Verdict**: CONFIRMED
- **Severity**: kept Low-Medium
- **Correct Fix**: equivalent to report — `buildToolIdList(ctx.state, rawMessages)` before strategies. Mirrors `lib/hooks.ts:182`.