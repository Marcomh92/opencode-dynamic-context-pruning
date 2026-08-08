# BUG-046: `Logger.lastMinimizedHashBySession` Map grows unbounded across sessions

## Summary

`lib/logger.ts:13-16` declares a module-level Map shared across Logger instances. The ponytail comment acknowledges "unbounded by design; Cap only if observed." For TUI/desktop sidecars that share a process, the process lifetime is the system uptime.

## Location

- `lib/logger.ts:13-16, 261-265`

## Current vs Expected Behavior

**Current**: Map grows linearly with session count.
**Expected**: Evict entries on session switch (already detected in `checkSession`); or cap at N sessions with FIFO eviction.

## Impact

- **Severity**: Low (acknowledged ceiling)
- Runtime: ~150 bytes per entry (64-hex hash + typical sessionId + Map overhead).
- User-observable: slowly growing memory in long-lived processes.

## Reproduction

Inspect `Logger.lastMinimizedHashBySession.size` after N sessions.

## Suggested Fix

Ponytail ceiling already marked in the source. If you decide to cap, the FIFO eviction in `saveContext` is the most localized option:

```ts
// ponytail: cap at 500 sessions with FIFO eviction. The fork constructs one
// Logger per session so the map sees one entry per session lifetime.
// Upgrade path: move to an LRU if hot sessions churn.
if (Logger.lastMinimizedHashBySession.size > 500) {
    const firstKey = Logger.lastMinimizedHashBySession.keys().next().value
    if (firstKey !== undefined) Logger.lastMinimizedHashBySession.delete(firstKey)
}
```

But this is optional — the existing ponytail marker is the cheaper answer.

## Status

Fixed 2026-08-07

## Resolution

Bounded `lastMinimizedHashBySession` with FIFO eviction at 500 sessions in `lib/logger.ts`; closes BUG-069 too.

## Cross-references

- Source investigator: hooks + messages
- Source finding ID: LOGGER-MINHASH-1
- Validator verdict: ✅ CONFIRMED
- Doc anchor: `docs/PATTERNS.md` PAT-001 ponytail rule

## Architect Review (2026-08-07)

- **Verdict**: CONFIRMED (but already marked as acknowledged ceiling)
- **Severity**: kept Low (by-design behavior with explicit upgrade path)
- **Bonus**: same shape as BUG-069 (related Map unbounded growth); both should be considered in any "Map ceiling audit" sweep.
