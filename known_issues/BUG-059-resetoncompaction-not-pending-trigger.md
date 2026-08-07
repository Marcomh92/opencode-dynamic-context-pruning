# BUG-059: `resetOnCompaction` doesn't clear `pendingManualTrigger`

## Summary
When a compaction event is detected, `resetOnCompaction` clears `toolParameters`, `prune.tools`, `prune.messages`, `messageIds`, `nudges`. It does NOT clear `pendingManualTrigger`. If a user issued `/dcp-compress` immediately before compaction, the pending trigger is still set and would be applied on the next transform, instructing the model to compress content that was just compacted away.

## Location
- `lib/state/utils.ts:384-397`

## Current vs Expected Behavior
**Current**: `pendingManualTrigger` survives compaction.
**Expected**: Add `state.pendingManualTrigger = null` to the reset.

## Impact
- **Severity**: Low (narrow race window)
- Runtime: stale prompt applied post-compaction.
- User-observable: model receives a manual-trigger prompt for content that no longer exists.

## Reproduction
1. Issue `/dcp-compress`.
2. Before the transform fires, trigger a compaction.
3. Observe `state.pendingManualTrigger` is still set.

## Suggested Fix
At `lib/state/utils.ts:384-397`, add `state.pendingManualTrigger = null;` as the last statement:
```ts
export function resetOnCompaction(state: SessionState): void {
    state.toolParameters.clear()
    state.prune.tools = new Map<string, number>()
    state.prune.messages = createPruneMessagesState()
    state.messageIds = { byRawId: new Map(), byRef: new Map(), nextRef: 1 }
    state.nudges = { contextLimitAnchors: new Set(), turnNudgeAnchors: new Set(), iterationNudgeAnchors: new Set() }
    state.pendingManualTrigger = null  // ← added
}
```

## Status
Open

## Cross-references
- Source investigator: config + state persistence
- Source finding ID: STATE-RESETONCOMPACTION-1
- Validator verdict: ✅ CONFIRMED
- Doc anchor: `docs/features/STATE_PERSISTENCE.md` Compaction handling section

## Architect Review (2026-08-07)
- **Verdict**: CONFIRMED
- **Severity**: kept Low (real but narrow — requires `/dcp-compress` to be invoked within the same session and a compaction to interleave before the next transform fire)
- **Correct Fix**: equivalent to report.
- **Bonus**: `manualMode` (`"compress-pending"` transient) survives `resetOnCompaction` too, but `lib/state/state.ts:251-260` (the `effectiveManualMode` recompute path) re-derives it after load, so the persistence-side is OK. `resetSessionState` (`lib/state/state.ts:118-159`) DOES clear `state.pendingManualTrigger = null` (line 128). The reset asymmetry between compaction and session reset is the real smell.