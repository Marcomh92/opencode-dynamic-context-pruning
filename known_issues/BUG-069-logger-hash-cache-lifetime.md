# BUG-069: `Logger.lastMinimizedHashBySession` only clearable via test hook

## Summary
The static Map at module load accumulates one entry per session id for the lifetime of the Node process. The `clearSaveContextCache` test-only static method exists but is not callable from production code. The ponytail comment in `lib/logger.ts:14-16` claims "Cap only if observed."

## Location
- `lib/logger.ts:14-16`

## Current vs Expected Behavior
**Current**: Map grows linearly with session count for the lifetime of the process.
**Expected**: Either drop entries whose sessionId has not been seen in N minutes, or cap at e.g. 500 entries (LRU). At minimum, document the ceiling explicitly.

## Impact
- **Severity**: Nitpick (acknowledged ceiling)
- Runtime: ~150 bytes per entry.
- User-observable: slowly growing memory in long-lived processes.

## Reproduction
Inspect `Logger.lastMinimizedHashBySession.size` after N sessions.

## Suggested Fix
No code change required; the ponytail comment IS the documented ceiling. The report's "Cap with LRU eviction" is over-engineering — ~150B × N sessions is negligible for a typical session count. Ponytail already says "Cap only if observed."

## Status
Open

## Cross-references
- Source investigator: OpenCode integration + permissions
- Source finding ID: LOG-HASH-LIFETIME-15 (companion to BUG-046)
- Validator verdict: ✅ CONFIRMED
- Doc anchor: `docs/PATTERNS.md` PAT-001 ponytail rule

## Architect Review (2026-08-07)
- **Verdict**: CONFIRMED
- **Severity**: kept Nitpick
- **Bonus**: BUG-046 (logger maps unbounded) covers additional logger-internal static state in the same file (the `error` and `data` maps in `private write` — actually those are locals, not statics). The two share the same root: module-level `Logger` state without lifecycle. A single bounded-eviction helper would address both.
- **Merge**: BUG-046 + BUG-069 (unbounded static maps in `Logger`).