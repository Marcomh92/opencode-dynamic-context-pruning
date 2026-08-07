# BUG-031: `recoveryForced` and streak counters ARE persisted+restored, contradicting v1→v2 boundary

## Summary
`saveSessionState` writes `recoveryForced`, `nonCompactingRunCount`, `recoveryFadeCounter`. `ensureSessionInitialized` reads them back verbatim. Comments at `lib/state/state.ts:196-199` and `docs/features/STATE_PERSISTENCE.md:53` claim `recoveryForced` is "intentionally NOT restored — they reset on every session load" and "Cleared by: session restart". The schema gate drops v1 files but does NOT drop v2/v3 files carrying `recoveryForced: true`. A session that hit `recoveryForced` yesterday still has `recoveryForced: true` after OpenCode restart.

## Location
- `lib/state/persistence.ts:130-133`
- `lib/state/state.ts:211-219`
- `docs/features/STATE_PERSISTENCE.md:53`

## Current vs Expected Behavior
**Current**: Persisted + restored on every load.
**Expected**: Either delete the persisted fields on `resetSessionState` (and on the load path's "fresh session" branch), or update the docs to reflect the cross-session persistence.

## Impact
- **Severity**: Medium (docs/code disagreement; user-observable behavior divergence)
- Runtime: a user who expected recovery to be in-session sees it survive OpenCode restart.
- User-observable: model remains blocked from autonomous compress across sessions.

## Reproduction
1. Trigger recovery (3 consecutive non-compacting runs).
2. Restart OpenCode.
3. Inspect `state.recoveryForced` — it's still `true`.

## Suggested Fix
At `lib/state/state.ts:208-219`, delete the `recoveryForced`, `nonCompactingRunCount`, `recoveryFadeCounter` restoration — the comment and docs then match the implementation:
```ts
// (remove these three blocks)
// if (typeof persisted.recoveryForced === "boolean") { state.recoveryForced = ... }
// if (typeof persisted.nonCompactingRunCount === "number") { state.nonCompactingRunCount = ... }
// if (typeof persisted.recoveryFadeCounter === "number") { state.recoveryFadeCounter = ... }
```
And update `lib/state/persistence.ts:130-132` to NOT persist these. The architect decision was explicit at `lib/state/state.ts:195-199`: align code with docs (option a) — recommended.

## Status
Open

## Cross-references
- Source investigator: config + state persistence
- Source finding ID: STATE-RECOVERYFORCED-PERSIST-1
- Validator verdict: ✅ CONFIRMED
- Doc anchor: `docs/features/STATE_PERSISTENCE.md` v2 protocol fields on `SessionState`, Persisted vs in-memory table

## Architect Review (2026-08-07)
- **Verdict**: CONFIRMED
- **Severity**: kept Medium (user-visible divergence from docs)
- **Correct Fix**: align code with docs (option a — the architect decision was explicit at `state.ts:195-199`). Update `persistence.ts:130-132` to NOT persist these.
- **Critique of report's fix**: option (a) is right; `resetSessionState` option (b) is wrong — that's the per-session change, not the cross-restart change the docs concern.
- **Bonus**: BUG-006 (manual-mode cache drift) shares the same "documented-but-not-implemented" category.