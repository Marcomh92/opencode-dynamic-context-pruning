# BUG-007: `saveManualModeSetting` writes `manualMode` but not `userForced`, leaving persisted JSON inconsistent

## Summary

`saveManualModeSetting(sessionId, !!state.manualMode, logger)` writes only the cached boolean; `userForced` and `recoveryForced` are not persisted by this path. If the user runs `/dcp manual on` followed by `/dcp manual off` without any other action that triggers `saveSessionState`, the persisted file ends up with `manualMode: false, userForced: true` (a stale value from an earlier `coalesceSaveSessionState`). On reload, the user's "off" intent is silently undone.

## Location

- `lib/state/persistence.ts:407-418`
- `lib/commands/manual.ts:58-92` (caller)

## Current vs Expected Behavior

**Current**: `saveManualModeSetting` reads existing persisted state, updates only `state.manualMode = manualMode` and `lastUpdated`, then writes.
**Expected**: The v2 `userForced` and `recoveryForced` fields should be updated in lockstep with `manualMode`. The write should be atomic with respect to the user's toggle intent.

## Impact

- **Severity**: High (invariant broken — INV-8 user-forced clearing semantics)
- Runtime: in normal flow, `saveSessionState` runs alongside `saveManualModeSetting`, so the divergence is short-lived. But if OpenCode restarts during the narrow window, the user's `off` intent is silently reverted.
- User-observable: a session reload during the window restores `userForced=true`, automatically flipping back to manual mode.

## Reproduction

1. `/dcp manual on` → coalesced save persists `manualMode=true, userForced=true`.
2. `/dcp manual off` → `saveManualModeSetting` writes `manualMode=false, userForced=true` (stale).
3. Restart OpenCode → load restores `userForced=true` → effective mode is `"active"` despite the user's "off".

## Suggested Fix

At `lib/state/persistence.ts:415`, after the `state.manualMode = manualMode` line, add:

```ts
state.userForced = manualMode
```

Note: `recoveryForced` is correctly preserved (cleared only by `recoveryFadeWindow` or session restart, per `pipeline.ts:180-189`); `nonCompactingRunCount` and `recoveryFadeCounter` are also session-scoped and should be left alone.

## Status

Fixed 2026-08-07

## Resolution

`saveManualModeSetting` now persists `userForced` alongside `manualMode`; load path reads both.

## Cross-references

- Source investigator: compress + v2 fork-protocol / config + state persistence
- Source finding IDs: PERSIST-USERFORCED-1, CACHE-DRIFT-2 (write-path variant)
- Validator verdict: ✅ CONFIRMED
- Doc anchor: `docs/features/COMPRESSION.md` INV-8, `docs/features/STATE_PERSISTENCE.md` v2 protocol fields

## Architect Review (2026-08-07)

- **Verdict**: CONFIRMED
- **Severity**: kept High (INV-8 broken; silent reversion on restart)
- **Correct Fix**: as above — minimal one-line addition. The ponytail-style note (`// ponytail: v2 protocol — manualMode and userForced are toggled in lockstep by /dcp manual`) documents why both are touched.
- **Bonus**: `emptyPersistedState(manualMode)` at line 367 already initializes `userForced: manualMode` for the no-existing case; the bug is only the existing-state path. Shares root with BUG-006 and BUG-024; could route all manual-mode writes through one helper.
