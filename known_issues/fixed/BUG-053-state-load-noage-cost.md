# BUG-053: `loadManualModeSetting`/`saveManualModeSetting` pay schema-gate cost despite passing `null`

## Summary

Both functions call `loadSessionState(sessionId, logger, null)` to disable the age gate (correct per `STATE_PERSISTENCE.md`). They still pay the schema-version integer compare and the structural-validation/dedup pass. For a frequently-hit manual toggle path, this is one extra JSON parse per call. The perf budget `PER-008` does not list this surface.

## Location

- `lib/state/persistence.ts:398-418`

## Current vs Expected Behavior

**Current**: Full schema-gate pass for manual-mode helpers.
**Expected**: Either accept the cost as documented, or add a `loadSessionStateRaw` path that skips the schema/age gate when the caller knows the file is v-shaped.

## Impact

- **Severity**: Low (real-world cost is tiny — one disk read of a small file)
- Runtime: extra parse per manual toggle.
- User-observable: none.

## Reproduction

Inspect `lib/state/persistence.ts:398-418`. Both helpers go through the full `loadSessionState` path.

## Suggested Fix

Two options:

1. **No fix** — ponytail the cost:
    ```ts
    // ponytail: loadSessionState pays the schema/age gate cost even with maxAgeDays=null.
    // Manual toggle is a user-driven rare event; the cost is one ~10KB file parse.
    // Upgrade path: add loadSessionStateRaw that skips the gate for caller-known shapes.
    ```
2. **Add `loadSessionStateRaw(sessionId, logger)`** that skips schema/age gates (just `existsSync` + `readFile` + `JSON.parse`). Localized 10-line addition to `persistence.ts`.

Option 1 is the lazy answer; option 2 matches the report's suggested fix.

## Status

Fixed 2026-08-07

## Resolution

Added `// ponytail:` comment to `loadManualModeSetting`/`saveManualModeSetting` at `lib/state/persistence.ts:398-418`; cost accepted.

## Cross-references

- Source investigator: config + state persistence
- Source finding ID: STATE-LOAD-NOAGE-1
- Validator verdict: ✅ CONFIRMED
- Doc anchor: `docs/PERFORMANCE.md` PER-008 budgets

## Architect Review (2026-08-07)

- **Verdict**: PARTIAL (cost is real but tiny)
- **Severity**: **changed Low → Nitpick**. The perf concern is theoretical. Manual mode toggles are user-driven (typed at the prompt), not on the hot transform path.
- **Critique of report's fix**: adding `loadSessionStateRaw` is correct but premature for a user-driven path. The ponytail is more honest about the actual cost.
