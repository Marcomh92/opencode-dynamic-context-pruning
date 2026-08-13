# BUG-094: `isIgnoredUserMessage` did not recognise `part.synthetic`, so synthetic user messages from third-party plugins were protected verbatim under `compress.protectUserMessages: true`

## Summary

The `isIgnoredUserMessage` predicate in `lib/messages/query.ts` was the only "skip" gate for user messages (established by `docs/features/PRUNING.md` INV-P7). It checked `part.ignored` only. Synthetic user messages injected by external plugins (e.g. `opencode-agent-skills`, `opencode-agent-delegation`) carry `part.synthetic: true` to signal "hide from UI" but do not necessarily set `part.ignored: true`. With `compress.protectUserMessages: true`, these injections were treated as real user messages and preserved verbatim in compression summaries, polluting the protected-text section.

## Location

- `lib/messages/query.ts:38-63` — `isIgnoredUserMessage` predicate
- `lib/messages/query.ts:65-76` — `isProtectedUserMessage` (consumer that inherited the bug)
- All 16 call sites of `isIgnoredUserMessage` were reachable for the same synthetic-injection flow

## Current vs Expected Behavior

**Before:** `if (!part.ignored) return false` — synthetic-only parts were not recognised.

**Expected:** Synthetic text parts (`part.synthetic === true`) should be treated as ignored alongside `part.ignored === true`, matching the existing convention at `lib/messages/manual-trigger.ts:75` which already accepts `part.ignored || part.synthetic` for the manual-trigger rewrite.

## Impact

- **Severity:** Low-Medium. User-visible only when `compress.protectUserMessages: true` AND a third-party plugin injects synthetic user messages with `synthetic: true` but `ignored: false` (or absent). The protected-text section would include the synthetic injection verbatim, which is the wrong default — the injection is system metadata, not a real user message.
- **Runtime:** no crash, no invariant broken. Only the protected section content is wrong.
- **User-observable:** protected-section blob in compression summaries contains `<available-skills>…</available-skills>` / `<available-subagents>…</available-subagents>` blocks that should not have been preserved.

## Reproduction

1. Enable `compress.protectUserMessages: true` in `dcp.jsonc`.
2. Activate a plugin that injects synthetic user messages with `part.synthetic: true` (e.g. `opencode-agent-skills`).
3. Trigger a compress on a range that includes the synthetic injection.
4. Inspect the summary's "The following user messages were sent in this conversation verbatim:" section — it contains the synthetic body.

## Suggested Fix

Extend the existing predicate in `lib/messages/query.ts:54` to recognise `part.synthetic` as an additional ignore signal:

```ts
if (!part.ignored && !part.synthetic) {
    return false
}
```

This is a one-line change. The convention already exists at `lib/messages/manual-trigger.ts:75` (`part.ignored || part.synthetic`), so the polarity reversal (`!part.ignored && !part.synthetic`) is consistent with the project's existing two-flag treatment.

## Status

Fixed 2026-08-13

## Resolution

Extended `isIgnoredUserMessage` in `lib/messages/query.ts:54` to also treat text parts with `part.synthetic === true` as ignore signals. The fix automatically propagates to all 16 call sites of `isIgnoredUserMessage` (`isProtectedUserMessage`, `appendProtectedUserMessages`, `appendProtectedPromptInfo`, `buildPriorityMap`, `injectCompressNudges`, `injectMessageIds`, `getLastUserMessage`, `findLastNonIgnoredMessage`, `applyPendingManualTrigger`, `assignMessageRefs`, `cacheSystemPromptTokens`, `collectTurnNudgeAnchors`, `compress/search.ts`, `compress/message-utils.ts`, `compress/pipeline.ts`, `commands/sweep.ts`, `commands/context.ts`).

Regression: 8 new test cases in `tests/message-utils.test.ts` covering synthetic-only, both-flags, mixed non-synthetic, mixed non-text part, multiple synthetic parts, and three negative guards (`synthetic: false`, no flag, assistant message).

## Cross-references

- `docs/features/PRUNING.md` INV-P7 — establishes `isIgnoredUserMessage` as the canonical skip gate
- `lib/messages/manual-trigger.ts:75` — pre-existing `part.ignored || part.synthetic` convention in the manual-trigger rewrite path
- `known_issues/fixed/BUG-049-async-ignored-type-cast.md` — established the struct shape `part.ignored?: boolean` access convention from `TextPart`
- `node_modules/@opencode-ai/sdk/dist/v2/gen/types.gen.d.ts:517-532` — `TextPart.synthetic?: boolean` declared SDK field
- `lib/messages/query.ts:65-76` — `isProtectedUserMessage` is the user-visible surfacing of the bug
