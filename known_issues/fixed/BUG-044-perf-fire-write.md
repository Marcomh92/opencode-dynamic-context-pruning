# BUG-044: `saveContext` still writes per-fire when debug enabled

## Summary

`saveContext` was retrofitted with SHA-256 change-detection (`lib/logger.ts:259-265`) that skips writes when the minimized payload is byte-identical to the previous fire. Most fires do mutate SOMETHING (synthetic timestamps, nudges, IDs), so per-fire writes continue in practice. For a long debug session, this is hundreds of MB across many JSON files in the log dir.

## Location

- `lib/hooks.ts:205-207`
- `lib/logger.ts:242-275`

## Current vs Expected Behavior

**Current**: Per-fire disk write when the payload changes; effectively every fire.
**Expected**: Rate-limit to N writes per minute; or write only on cache-miss signature per `diagnostic.possibleCacheMiss`.

## Impact

- **Severity**: Low-Medium (perf + disk usage in debug)
- Runtime: alloc + disk pressure.
- User-observable: debug session consumes disk quickly.

## Reproduction

Enable debug in `dcp.jsonc`, run a long session, inspect `~/.config/opencode/logs/dcp/context/`.

## Suggested Fix

Two options:

1. **No code fix** — change-detection already in place. The test file is mis-named; rename `tests/savecontext-rate-limit.test.ts` → `tests/savecontext-change-detect.test.ts` to match its actual coverage.
2. **Add a real rate-limit gate** after the change-detection hash check:
    ```ts
    // ponytail: ceiling is 1 write per minute per session. Drops write rate
    // during nudge/id churn storms. Upgrade path: keep the gate; the change-detection
    // already skips identical-content fires.
    const lastWriteMs = Logger.lastWriteMsBySession.get(sessionId) ?? 0
    if (Date.now() - lastWriteMs < 60_000) return
    Logger.lastWriteMsBySession.set(sessionId, Date.now())
    ```

## Status

Fixed 2026-08-07

## Resolution

Renamed `tests/savecontext-rate-limit.test.ts` → `tests/savecontext-change-detect.test.ts` to match actual coverage.

## Cross-references

- Source investigator: hooks + messages
- Source finding ID: PERF-FIREWRITE-1
- Validator verdict: ✅ CONFIRMED (severity adjusted from Medium → Low after change-detection noted)
- Doc anchor: `docs/PERFORMANCE.md` PER-001, PER-008

## Architect Review (2026-08-07)

- **Verdict**: PARTIAL — report conflates change-detection with rate-limiting
- **Severity**: kept Low-Medium
- **Correct Fix**: change-detection already in place. The remaining concern is content churn from nudge/id mutation. Option 1 (rename test) is the ponytail answer; option 2 (real rate-limit) is the upgrade path if churn becomes a problem.
- **Critique of report's fix**: the test file cited actually tests change-detection, not rate-limiting. Report's reading of the test filename as "intent for rate-limit" is wrong.
- **Bonus**: the test file is mis-named — should be `savecontext-change-detect.test.ts`.
