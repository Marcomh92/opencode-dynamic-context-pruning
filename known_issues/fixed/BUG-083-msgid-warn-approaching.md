# BUG-083: Log a warning when `MESSAGE_REF_MAX_INDEX` is approached

## Summary

Long-running sessions near the 9999 limit get no warning. Surface a counter and a warn at 5000 (or earlier) to give the user time to compact.

## Location

- `lib/message-ids.ts:155-171`

## Current vs Expected Behavior

**Current**: `allocateNextMessageRef` throws at `MESSAGE_REF_MAX_INDEX = 9999` with no warning before the threshold.
**Expected**: Warn at e.g. 5000 / 7500 / 9000; surface a counter.

## Impact

- **Severity**: Suggestion (UX)
- Runtime: not affected.
- User-observable: user gets a heads-up before capacity is reached.

## Reproduction

Long session approaching 9999 messages; observe no warning.

## Suggested Fix

Ponytail: emit from `lib/hooks.ts` where `logger` is in scope. `lib/hooks.ts:179` (inside `createChatMessageTransformHandler`):

```ts
assignMessageRefs(state, output.messages)

// ponytail: one-shot capacity warn; fires before the uncaught throw at message-ids.ts:169.
if (state.messageIds.nextRef >= 9000 && !state.messageIds.warned9000) {
    logger.warn("Message ID capacity approaching limit; consider compressing older history", {
        sessionId: state.sessionId,
        used: state.messageIds.nextRef,
        max: 9999,
    })
    state.messageIds.warned9000 = true
}
```

Adding `warned9000: boolean` to `state.messageIds` requires a `forkSchemaVersion` bump. Or use an in-memory Map keyed by `sessionId` if persistence isn't desired.

## Status

Fixed 2026-08-07

## Resolution

One-shot `logger.warn` at `nextRef >= 9000` in `lib/hooks.ts:179`; in-memory `Set<number>` tracks fired thresholds.

## Cross-references

- Source investigator: prompts + UI + TUI + subagents
- Source finding ID: S-MSG-ID-LOG-1
- Validator verdict: ✅ CONFIRMED
- Doc anchor: `docs/PERFORMANCE.md` PER-008 budgets

## Architect Review (2026-08-07)

- **Verdict**: CONFIRMED
- **Severity**: kept Suggestion (UX)
- **Correct Fix**: emit from `lib/hooks.ts` where `logger` is in scope, not from `allocateNextMessageRef` (which doesn't have a `logger` parameter). One-shot `warned9000` flag prevents log spam.
- **Critique of report's fix**: `if (candidate >= 9000) logger.warn(...)` inside `allocateNextMessageRef` requires adding a `logger` parameter. Plumbing it through is a wider diff than emitting from `lib/hooks.ts`. No "warned once" guard in the report's snippet.
- **Bonus**: persisting `warned9000` in `state.messageIds` requires a `forkSchemaVersion` bump. In-memory-only is acceptable. Consider tiered thresholds (5000/7500/9000) — a `Set<number>` of fired thresholds is the minimal-diff path.
