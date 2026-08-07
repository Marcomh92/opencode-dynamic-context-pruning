# BUG-043: `stripStaleMetadata` may drop caller metadata on cross-model switches

## Summary
`stripStaleMetadata` (`lib/messages/reasoning-strip.ts:9-40`) preserves `metadata` only when the assistant message is the same `modelID`/`providerID` as the LAST USER message's model. Cross-model switches drop `metadata` from text/tool/reasoning parts. Whether this drops caller metadata depends on whether OpenCode populates `part.metadata` with caller info — the codebase doesn't show evidence that it does. DCP itself reads from `part.state.metadata` (which is preserved), so this is a near-miss for DCP's own data flow. But third-party tools may put data in `part.metadata` (e.g., `task` tool records `metadata.sessionId`).

## Location
- `lib/messages/reasoning-strip.ts:9-40`

## Current vs Expected Behavior
**Current**: Cross-model switches drop `metadata` from text/reasoning/tool parts.
**Expected**: Document whether the strip should also clear `part.state.metadata` for full parity with OpenCode's `differentModel` handling.

## Impact
- **Severity**: Low-Medium (depends on OpenCode contract; the codebase shows no evidence OpenCode populates `part.metadata` with caller identity)
- Runtime: not affected for DCP's own reads.
- User-observable: third-party tools that put data in `part.metadata` lose it on model switch.

## Reproduction
Use a tool that writes to `part.metadata`, switch models mid-session, observe metadata loss.

## Suggested Fix
No code fix needed. Add a one-line ponytail comment to `reasoning-strip.ts` clarifying the contract:
```ts
// ponytail: mirrors opencode's differentModel handling — drops provider-internal
// part.metadata on cross-model switches. part.state.metadata (the load-bearing
// per-call state) is preserved because it lives on a different surface.
```
Optionally document the contract in `docs/features/PRUNING.md`.

## Status
Open

## Cross-references
- Source investigator: hooks + messages
- Source finding ID: PIPE-STRIPMETA-1
- Validator verdict: ⚠️ PARTIAL (severity overstated without OpenCode contract verification)
- Doc anchor: `docs/features/PRUNING.md` Pipeline order note

## Architect Review (2026-08-07)
- **Verdict**: PARTIAL
- **Severity**: **changed Low-Medium → Low**. Runtime impact is nil for DCP's own reads; only theoretical risk is third-party callers using `part.metadata`, of which there are none in the codebase. The codebase shows no evidence OpenCode populates `part.metadata` with caller identity.
- **Correct Fix**: doc comment, not a behavior change. Verify the OpenCode contract via research if you want full closure.
- **Bonus**: same root as BUG-048 — both flag missing contracts in the pruning pipeline; one documentation pass in `docs/features/PRUNING.md` could resolve both.