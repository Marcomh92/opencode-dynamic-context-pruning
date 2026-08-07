# BUG-029: `applyPendingManualTrigger` overwrites wrong user message in narrow race window

## Summary
`applyPendingManualTrigger` walks `messages` backward and overwrites the first non-ignored user text part with `pending.prompt`. If a user issues `/dcp-compress` and the slash-command handler sets `pendingManualTrigger`, then a chat transform fires before the model calls the compress tool, AND the user types another message in that window, the function will overwrite the NEW user's text instead of the slash-command text. The user's actual input is replaced.

## Location
- `lib/commands/manual.ts:102-135`
- `lib/hooks.ts:202` (caller)

## Current vs Expected Behavior
**Current**: Walks backward to find the last non-ignored user message and overwrites its text. No identity check against the trigger that set `pendingManualTrigger`.
**Expected**: Identify the slash-command user message by `pendingManualTrigger.commandMessageId` (not "last user message").

## Impact
- **Severity**: Medium (UX bug in narrow race window)
- Runtime: destructive overwrite of a real user message.
- User-observable: user types a message, sees their input replaced by the manual-trigger prompt.

## Reproduction
Hard to reproduce reliably; race window between slash-command handler and transform fire.

## Suggested Fix
1. Add `commandMessageId: string` to `PendingManualTrigger` in `lib/state/types.ts:76-79`.
2. In `lib/hooks.ts:296-299` capture `output.parts[0]?.messageID` (or the message ID produced by OpenCode's slash-command path); if not exposed, walk messages just before the call to find the most-recently-pushed text part. Set `pendingManualTrigger.commandMessageId`.
3. In `lib/commands/manual.ts:117-133`, look up the message by ID first; fall back to backward walk only if the ID is missing or stale.

## Status
Open

## Cross-references
- Source investigator: compress + v2 fork-protocol
- Source finding ID: TRIGGER-OVERWRITE
- Validator verdict: ✅ CONFIRMED
- Doc anchor: `docs/features/COMPRESSION.md` INV-5 (transient bypass only)

## Architect Review (2026-08-07)
- **Verdict**: CONFIRMED
- **Severity**: kept Medium (narrow but destructive — silent user-message overwrite)
- **Correct Fix**: equivalent to report.
- **Bonus**: `applyPendingManualTrigger` doesn't reject if `state.manualMode !== "compress-pending"`, so a stray `pendingManualTrigger` from a prior session could fire on an arbitrary later message. Reset on session init is in place (`state.ts:128`), good.