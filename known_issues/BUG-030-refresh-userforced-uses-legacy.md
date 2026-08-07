# BUG-030: `loadManualModeSetting` reads legacy `manualMode` field only, ignoring v2 `userForced`

## Summary
`loadManualModeSetting` at `lib/state/persistence.ts:398-405` inspects only the legacy `manualMode` boolean. `refreshManualMode` (called from `ensureSessionInitialized`) overwrites `state.userForced` with the value returned by `loadManualModeSetting`. If a v2 file ever reaches the loader with `userForced: true, manualMode: false` (the BUG-007 producer), `refreshManualMode` overwrites the loaded `userForced: true` with `false`. The cache is then re-derived correctly, but the `userForced` source-of-truth is lost. Compounder on BUG-007.

## Location
- `lib/state/persistence.ts:398-405`
- `lib/state/state.ts:245-261`

## Current vs Expected Behavior
**Current**: `loadManualModeSetting` reads `state.manualMode` only.
**Expected**: Prefer `state.userForced` when present, fall back to `state.manualMode` for v1 files.

## Impact
- **Severity**: Medium (compounder on BUG-007)
- Runtime: only matters if a v2 file reaches the loader with the inconsistent shape.
- User-observable: `userForced` source-of-truth lost across reload.

## Reproduction
Hard to reproduce without first triggering BUG-007.

## Suggested Fix
At `lib/state/persistence.ts:398-405`:
```ts
export async function loadManualModeSetting(
    sessionId: string,
    logger: Logger,
): Promise<boolean | undefined> {
    const state = await loadSessionState(sessionId, logger, null)
    if (typeof state?.userForced === "boolean") return state.userForced
    return typeof state?.manualMode === "boolean" ? state.manualMode : undefined
}
```

## Status
Open

## Cross-references
- Source investigator: config + state persistence
- Source finding ID: STATE-REFRESH-USERFORCED-1 (compounder on BUG-007)
- Validator verdict: ✅ CONFIRMED
- Doc anchor: `docs/features/STATE_PERSISTENCE.md` v2 protocol fields, Persisted vs in-memory table

## Architect Review (2026-08-07)
- **Verdict**: CONFIRMED
- **Severity**: kept Medium (load-path correctness)
- **Correct Fix**: equivalent to report.
- **Bonus**: shares root with BUG-034 (manual-mode persistence writers disagree).
- **Merge**: BUG-030 + BUG-032 + BUG-034 (manual-mode persistence cluster).