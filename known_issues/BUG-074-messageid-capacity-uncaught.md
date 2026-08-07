# BUG-074: `Message ID alias capacity exceeded` is uncaught throw mid-session

## Summary
The throw at `lib/message-ids.ts:160-171` is unrecoverable. A long session that exceeds 9999 visible messages will surface this to the LLM as a thrown error in the transform hook. OpenCode's behavior on a hook throw is not documented here; the plugin's transform pipeline does not wrap the call in try/catch.

## Location
- `lib/message-ids.ts:160-171`

## Current vs Expected Behavior
**Current**: Hard throw on capacity exceeded; no fallback.
**Expected**: When capacity is exceeded, fall back to a 5-digit ref or skip ID injection for new messages (warn once). Alternatively, evict compacted refs (see BUG-025).

## Impact
- **Severity**: Suggestion (capacity edge case)
- Runtime: a long session breaks mid-flight.
- User-observable: LLM call fails with `Message ID alias capacity exceeded`.

## Reproduction
Run a session with 9999+ visible messages.

## Suggested Fix
Two-stage minimal fix. Ponytail: sentinel + caller `continue`.

```ts
// lib/message-ids.ts:155-171
function allocateNextMessageRef(state: SessionState): string {
    // ...loop...

    // ponytail: degrade gracefully rather than throwing through the transform pipeline.
    // Return empty sentinel; caller skips ID injection for this message.
    return ""
}
```

```ts
// lib/message-ids.ts:146 (inside assignMessageRefs)
const ref = allocateNextMessageRef(state)
if (ref === "") continue  // capacity exhausted; skip silently
state.messageIds.byRawId.set(rawMessageId, ref)
state.messageIds.byRef.set(ref, rawMessageId)
assigned++
```

## Status
Open

## Cross-references
- Source investigator: hooks + messages
- Source finding ID: ID-ALIAS-1
- Validator verdict: ✅ CONFIRMED
- Doc anchor: `docs/PERFORMANCE.md` PER-008 budgets

## Architect Review (2026-08-07)
- **Verdict**: PARTIAL (impact understated)
- **Severity**: **escalate Suggestion → Medium**. The bug report's own "Impact" section states "LLM call fails with `Message ID alias capacity exceeded`" — that matches the severity legend's "Medium = functional gap". Same cluster as BUG-025 and BUG-028.
- **Correct Fix**: two fixes needed — sentinel return + caller `continue`. Report's `return null` is a type error (return type is `string`); "5-digit fallback" requires widening `MESSAGE_REF_WIDTH` across `formatMessageRef`, `MESSAGE_REF_REGEX`, `parseMessageRef`, and every block-graph serialization site — bigger diff than the sentinel.
- **Bonus**: add a `logger.warn(...)` before the sentinel return to surface capacity pressure to operators.
- **Merge**: BUG-025 + BUG-074 + BUG-028 (transform pipeline fragility cluster). Fix order: BUG-025 first (eviction makes cap unreachable), BUG-074 as defense in depth, BUG-028 outer try/catch as the catch-all.