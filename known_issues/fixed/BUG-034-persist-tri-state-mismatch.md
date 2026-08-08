# BUG-034: `saveManualModeSetting` coerces `manualMode` via `!!` to `boolean`; `saveSessionState` uses `=== "active"`

## Summary

Two writers disagree on the same field:

- `lib/commands/manual.ts:89`: `await saveManualModeSetting(sessionId, !!state.manualMode, logger)` — coerces `"compress-pending"` to `true`.
- `lib/state/persistence.ts:128`: `manualMode: sessionState.manualMode === "active"` — writes `false` for `"compress-pending"`.

## Location

- `lib/commands/manual.ts:89`
- `lib/state/persistence.ts:128`

## Current vs Expected Behavior

**Current**: Two writers disagree on the same fields; in practice, `handleManualToggleCommand` is not invoked while `compress-pending` is set, so the bug is theoretical.
**Expected**: Use `state.manualMode === "active"` consistently, or accept the tri-state in the writer.

## Impact

- **Severity**: Medium (writer disagreement)
- Runtime: theoretical; the divergent paths don't currently collide.
- User-observable: none today; risk if the paths ever do collide.

## Reproduction

Hard to reproduce without first triggering BUG-032 to set `manualMode = "compress-pending"`.

## Suggested Fix

At `lib/commands/manual.ts:89`:

```ts
await saveManualModeSetting(sessionId, state.manualMode === "active", logger)
```

(One-line change; aligns with `saveSessionState`.)

## Status

Fixed 2026-08-07

## Resolution

Unified boolean coercion across `saveManualModeSetting` / `saveSessionState`; one shape used at all write sites.

## Cross-references

- Source investigator: config + state persistence
- Source finding ID: PERSIST-MANUALMODE-MISMATCH-1
- Validator verdict: ✅ CONFIRMED
- Doc anchor: `docs/DESIGN_PRINCIPLES.md` DPP-016

## Architect Review (2026-08-07)

- **Verdict**: CONFIRMED
- **Severity**: kept Medium (writer disagreement is a landmine even if current paths don't collide)
- **Correct Fix**: equivalent to report.
- **Bonus**: shares root with BUG-030 (legacy field only) and BUG-032 (compress-pending handling).
- **Merge**: BUG-030 + BUG-032 + BUG-034 (manual-mode persistence cluster — pick one persistence shape and use it consistently).
