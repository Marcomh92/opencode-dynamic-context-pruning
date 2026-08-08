# BUG-032: `handleManualToggleCommand` no-arg branch can clear a pending `manualMode === "compress-pending"`

## Summary

The `else` branch in `handleManualToggleCommand` (`lib/commands/manual.ts:76-79`) treats `state.manualMode` as a boolean toggle: `state.manualMode = state.manualMode ? false : "active"`. If a prior `/dcp-compress` set `state.manualMode = "compress-pending"` (the transient bypass flag, DPP-016 + PAT-007), this branch unconditionally collapses it to `false`. The `pendingManualTrigger` remains set, so `applyPendingManualTrigger` still injects the manual prompt on the next transform. The model calls `compress`, but `prepareSession` (line 65) now blocks it because `manualMode !== "compress-pending"`. The user's pending manual compress is silently broken.

## Location

- `lib/commands/manual.ts:76-79`

## Current vs Expected Behavior

**Current**: Toggles regardless of the tri-state value.
**Expected**: Refuse the toggle (no-op) while `state.manualMode === "compress-pending"`, or set `state.pendingManualTrigger = null` first.

## Impact

- **Severity**: Medium (DPP-016 + PAT-007 partial violation)
- Runtime: user's pending manual compress is silently blocked.
- User-observable: `/dcp-compress` was issued, but `compress` call gets blocked.

## Reproduction

1. `/dcp-compress` (sets `manualMode = "compress-pending"`, `pendingManualTrigger` set).
2. Before the transform fire, `/dcp manual` (no arg, toggles).
3. Model calls `compress` — gets blocked by `prepareSession`.

## Suggested Fix

At `lib/commands/manual.ts:76-79`, early-return on `compress-pending` with a user-visible message so the silent-refuse is observable:

```ts
} else {
    if (state.manualMode === "compress-pending") {
        const params = getCurrentParams(state, messages, logger)
        await sendIgnoredMessage(
            client, sessionId,
            "Cannot toggle manual mode while a compress is pending; let the compress complete first.",
            params, logger,
        )
        return
    }
    state.manualMode = state.manualMode ? false : "active"
    state.userForced = !!state.manualMode
}
```

## Status

Fixed 2026-08-07

## Resolution

No-arg toggle branch in `handleManualToggleCommand` re-checks `manualMode === "compress-pending"` before clearing.

## Cross-references

- Source investigator: config + state persistence
- Source finding ID: CMD-MANUAL-COMPRESS-PENDING-1
- Validator verdict: ✅ CONFIRMED
- Doc anchor: `docs/DESIGN_PRINCIPLES.md` DPP-016, `docs/PATTERNS.md` PAT-007

## Architect Review (2026-08-07)

- **Verdict**: PARTIAL
- **Severity**: kept Medium
- **Correct Fix**: include the `sendIgnoredMessage` user-visible notification so the silent-refuse is observable. Report's fix just `return`s — leaves user with no feedback.
- **Critique of report's fix**: the report claims "compress call gets blocked" but the mechanism is conditional on `recoveryForced`. The more general failure mode is misclassification as autonomous — same fix, but the user needs a message to know why.
- **Bonus**: shares root with BUG-034 (manual-mode persistence writers disagree on `"compress-pending"`).
- **Merge**: BUG-030 + BUG-032 + BUG-034 (manual-mode persistence cluster).
