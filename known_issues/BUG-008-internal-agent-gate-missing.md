# BUG-008: `isInternalAgentSystem` only in system-prompt handler, missing from message-transform handler

## Summary
DPP-009 requires internal OpenCode agents (title generators, summarizers) to be skipped. The check exists in `createSystemPromptHandler` but not in `createChatMessageTransformHandler`. Internal agents whose only call is `experimental.chat.messages.transform` get the full DCP transform: refs allocated, prune run, nudges injected, IDs stamped.

## Location
- `lib/hooks.ts:109-209` (entire `createChatMessageTransformHandler`)
- `lib/hooks.ts:79` (where the gate IS in the system handler)

## Current vs Expected Behavior
**Current**: The 13-step transform pipeline (`stripHallucinations` → ... → `stripStaleMetadata`) runs unconditionally. The `isInternalAgentSystem(output.system)` check is absent.
**Expected**: Same gate as `createSystemPromptHandler` — early return when the system prompt is recognized as an internal-agent prompt.

## Impact
- **Severity**: High (DPP-009 partial violation)
- Runtime: refs allocated for every internal-agent scratch message burn the 9999 alias cap faster; prune/sweep work runs on content the model will never see; prompt-cache prefix mutated by per-fire tag appends (PER-001 cost).
- User-observable: increased cache-miss rate in sessions that use title generators or summarizers; potential "Message ID alias capacity exceeded" mid-session.

## Reproduction
Manual: invoke a title-generator or summarizer subagent in a session. Observe: m-NNNN tags injected into its prompt; state.messageIds populated.

## Suggested Fix
Add at the top of `createChatMessageTransformHandler` (return statement). Caveat: the message-transform handler does NOT receive `output.system` directly; the gate needs `state.lastSystem` (set during `createSystemPromptHandler`). Use cached state access rather than adding a new OpenCode hook surface:
```ts
if (state.lastSystem && isInternalAgentSystem(state.lastSystem)) {
    return
}
```
Apply the same gate to `createTextCompleteHandler` if the same surface applies (see BUG-020).

## Status
Open

## Cross-references
- Source investigator: hooks + messages
- Source finding ID: HOOK-INTERNALAGENT-1 (related: HOOK-INTERNALAGENT-2 — brittle signature list)
- Validator verdict: ✅ CONFIRMED
- Doc anchor: `docs/DESIGN_PRINCIPLES.md` DPP-009, `docs/features/PRUNING.md` Boundaries table

## Architect Review (2026-08-07)
- **Verdict**: CONFIRMED
- **Severity**: kept High (DPP-009 partial violation; cache-miss tax + alias-cap pressure)
- **Correct Fix**: as above — gate needs `state.lastSystem` because `output.system` is not on the transform input. Caching is simpler than a new OpenCode hook surface.
- **Critique of report's fix**: assumes `output.system` is available on the transform input — it isn't.
- **Bonus**: the diagnostic `try/catch` at `hooks.ts:147-175` should sit AFTER the gate. Companion to BUG-020 (same pattern in `createTextCompleteHandler`).