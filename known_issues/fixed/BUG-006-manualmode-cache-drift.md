# BUG-006: DPP-017 cache drift: `state.manualMode` written directly instead of via `effectiveManualMode(state)`

## Summary

Multiple code paths write `state.manualMode` directly without re-deriving from `userForced || recoveryForced`. When `/dcp manual off` runs while `recoveryForced=true`, the cache becomes `false` while `effectiveManualMode(state)` returns `"active"`. Downstream readers (nudges, strategies, system prompt, help text, TUI dialogs) all see stale "off" and behave as if autonomous compress is permitted.

## Location

- `lib/commands/manual.ts:70-78` (writer, root cause)
- `lib/messages/inject/inject.ts:45` (reader: nudges)
- `lib/hooks.ts:98` (reader: system prompt `MANUAL_MODE_SYSTEM_EXTENSION`)
- `lib/commands/help.ts:53` (reader: ON/OFF display)
- `lib/strategies/deduplication.ts:22` (reader: strategies gate)
- `lib/strategies/purge-errors.ts:25` (reader: strategies gate)

## Current vs Expected Behavior

**Current**: `handleManualToggleCommand` sets `state.manualMode = false` and `state.userForced = false` directly. When `state.recoveryForced === true`, the cache diverges from the canonical source of truth.
**Expected**: All writers must route through a helper that re-derives the cache from `userForced || recoveryForced` after every flag mutation, per DPP-017. The canonical reader is `effectiveManualMode(state)`.

## Impact

- **Severity**: High (invariant broken — DPP-017)
- Runtime: nudges inject into recovery-mode sessions; strategies run when they should pause; system prompt missing manual-mode extension; help text shows "OFF" while compress is actually blocked.
- User-observable: model attempts autonomous compress during recovery, gets blocked by `prepareSession` hard-throw; UI text disagrees with actual behavior.

## Reproduction

Manual: enter recovery (3 consecutive non-compacting runs), then `/dcp manual off`. Observe: nudges still injected, help text shows "OFF".

## Suggested Fix

Reuse the existing `effectiveManualMode(state)` helper from `lib/compress/pipeline.ts:46` (one fewer function than introducing `applyManualModeFlags`):

1. In `lib/commands/manual.ts:65, 71, 77` — after updating `userForced`/`recoveryForced`, call `state.manualMode = effectiveManualMode(state)`.
2. In `lib/messages/inject/inject.ts:45`, `lib/hooks.ts:98`, `lib/commands/help.ts:53`, `lib/strategies/deduplication.ts:22`, `lib/strategies/purge-errors.ts:25` — switch readers from `state.manualMode` to `effectiveManualMode(state)`.

## Status

Fixed 2026-08-07

## Resolution

All `state.manualMode` writers now route through `effectiveManualMode(state)`; readers also switched to it (DPP-017 enforced).

## Cross-references

- Source investigator: hooks + messages / compress + v2 fork-protocol / config + state persistence
- Source finding IDs: HOOK-MANUALCACHE-1 (canonical), CACHE-DRIFT-1, NUDGE-DRIFT, STRATEGIES-DRIFT, HELP/DIALOG-DRIFT, INJECT-CACHE-READ-1, STATE-MANUALMODE-CACHE-1
- Validator verdict: ✅ CONFIRMED (cluster deduplicated)
- Doc anchor: `docs/DESIGN_PRINCIPLES.md` DPP-017, `docs/PATTERNS.md` PAT-007

## Architect Review (2026-08-07)

- **Verdict**: CONFIRMED
- **Severity**: kept High (DPP-017 invariant violation in user-facing error path during recovery)
- **Correct Fix**: reuse `effectiveManualMode(state)` from `pipeline.ts:46` rather than introducing a new helper. One fewer function, single source of truth.
- **Critique of report's fix**: the proposed `applyManualModeFlags` helper is fine; reusing the existing export is one fewer function.
- **Bonus**: `lib/compress/pipeline.ts:127` legitimately writes `state.manualMode = ...` directly (the compress-pending transient must not be collapsed). Leave that path alone; only route `manual.ts` through `effectiveManualMode`. Companion: BUG-007 (persistence), BUG-024 (root cause), BUG-050 (consolidation).
