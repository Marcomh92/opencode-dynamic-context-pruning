# BUG-061: `applyPendingManualTrigger` runs after `injectMessageIds`, leaving trigger prompt without m-NNNN

## Summary

The transform pipeline orders: `injectExtendedSubAgentResults` → `injectCompressNudges` → `injectMessageIds` → `applyPendingManualTrigger`. The pending trigger rewrites the user message's `text` field with the trigger prompt, but `injectMessageIds` has already walked `output.messages` and assigned `mNNNN` refs based on the original text. The rewritten text appears under a stale or missing ref.

## Location

- `lib/hooks.ts:191-202`
- `lib/commands/manual.ts:102-135`

## Current vs Expected Behavior

**Current**: `applyPendingManualTrigger` runs last and overwrites text already tagged.
**Expected**: Re-run `assignMessageRefs` for the rewritten text, or move `applyPendingManualTrigger` before `injectMessageIds`.

## Impact

- **Severity**: Low (manual-trigger path only)
- Runtime: trigger prompt lacks a `dcp-message-id`.
- User-observable: model references a stale id for the trigger prompt.

## Reproduction

Issue `/dcp-compress`, observe the rewritten user message lacks a fresh m-NNNN.

## Suggested Fix

At `lib/hooks.ts:201-202`, swap the order:

```ts
applyPendingManualTrigger(state, output.messages, logger)
injectMessageIds(state, config, output.messages, compressionPriorities)
```

Rationale: the trigger prompt is the FINAL text the user message will carry in this transform. Tagging it after overwrite is the only way to get a fresh `mNNNN` for the new text.

## Status

Fixed 2026-08-07

## Resolution

Pipeline re-ordered: `applyPendingManualTrigger` runs before `injectMessageIds`; trigger prompt now receives m-NNNN.

## Cross-references

- Source investigator: OpenCode integration + permissions
- Source finding ID: APPLY-POST-ID-11 (companion to BUG-029)
- Validator verdict: ✅ CONFIRMED
- Doc anchor: `docs/PATTERNS.md` PAT-003 in-place mutation

## Architect Review (2026-08-07)

- **Verdict**: CONFIRMED
- **Severity**: kept Low (real but only affects the manual-trigger path)
- **Correct Fix**: swap is simpler than re-running `assignMessageRefs` inside `applyPendingManualTrigger` (which adds work per fire for a path that is rare).
- **Bonus**: distinct from BUG-029 (which is about selecting the WRONG user message in a narrow race — Medium severity). BUG-029's fix doesn't help here, and BUG-061's fix doesn't help BUG-029. After the swap, `state.pendingManualTrigger` is cleared before `injectMessageIds` reads the message — the cleared state is read-only, so no ordering hazard with the save path.
