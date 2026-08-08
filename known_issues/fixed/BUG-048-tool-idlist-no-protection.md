# BUG-048: `buildToolIdList` returns raw IDs without honoring protected tools

## Summary

`buildToolIdList` (`lib/messages/utils.ts:164-181`) does NOT honor `config.compress.protectedTools`, `config.strategies.*.protectedTools`, or subagent-only filters. The output `state.toolIdList` is the raw list. Consumers (`deduplicate`, `purgeErrors`, `sweep`) re-filter — so end behavior is correct, but `state.toolIdList` does not represent "prunable tool IDs".

## Location

- `lib/messages/utils.ts:164-181`

## Current vs Expected Behavior

**Current**: Returns all visible tool IDs.
**Expected**: Either filter at the source, or document the contract: `toolIdList` is "all visible tool IDs"; consumers must filter.

## Impact

- **Severity**: Low (consumers re-filter correctly)
- Runtime: not affected.
- User-observable: code reader confusion.

## Reproduction

Inspect `lib/messages/utils.ts:164-181`. No `protectedTools` filter.

## Suggested Fix

No code change (consumers re-filter correctly). Add documentation in `lib/messages/utils.ts`:

```ts
// ponytail: returns ALL visible tool IDs — protected tools included.
// Consumers (deduplicate, purge-errors, sweep) re-filter via isToolNameProtected
// and isFilePathProtected. Don't add a filter here without auditing every caller.
export function buildToolIdList(state: SessionState, messages: WithParts[]): string[] {
```

Makes the contract explicit and prevents a future caller from assuming the list is pre-filtered.

## Status

Fixed 2026-08-07

## Resolution

Added `// ponytail:` doc comment to `buildToolIdList` at `lib/messages/utils.ts:164-181` documenting that consumers re-filter.

## Cross-references

- Source investigator: hooks + messages
- Source finding ID: TOOLIDLIST-NOPROTECT-1
- Validator verdict: ✅ CONFIRMED
- Doc anchor: `docs/features/PRUNING.md` Pipeline order

## Architect Review (2026-08-07)

- **Verdict**: CONFIRMED (but code behavior is already correct)
- **Severity**: kept Low (code reader confusion only)
- **Bonus**: BUG-047, BUG-048, BUG-043 are all docs gaps in the pruning pipeline — one docs pass on `docs/features/PRUNING.md` Pipeline order section covers all three.
