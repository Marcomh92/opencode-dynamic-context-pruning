# BUG-064: `logger.info("DCP transform fire")` fires per transform when debug enabled

## Summary
The fire log writes to disk on every transform hook fire, gated only on `config.debug`. The diagnostic event is built unconditionally; only the disk write is suppressed by `logger.enabled`. With debug on, the daily log file grows by N lines per session where N = number of LLM calls.

## Location
- `lib/hooks.ts:161-172`

## Current vs Expected Behavior
**Current**: Per-fire `logger.info` writes to disk when debug.
**Expected**: Gate the `logger.info` on a debounced timer, or only log when `prefixChanged || possibleCacheMiss` is true.

## Impact
- **Severity**: Nitpick (perf + log noise)
- Runtime: not affected when debug is off.
- User-observable: noisy debug log.

## Reproduction
Enable debug, inspect daily log file size.

## Suggested Fix
At `lib/hooks.ts:158-172`, wrap the `logger.info` call in a condition:
```ts
await logger.diagnostic(event as unknown as Record<string, unknown>)
// ponytail: only mirror to daily log when something interesting changed;
// every-fire mirror balloons the log without debug signal value.
if (event.prefixChanged || event.possibleCacheMiss) {
    logger.info("DCP transform fire", { /* same data object */ })
}
```
Use the existing event object — don't call `buildDiagnosticEvent` twice.

## Status
Open

## Cross-references
- Source investigator: hooks + messages
- Source finding ID: PIPE-LINECOUNT-1
- Validator verdict: ✅ CONFIRMED
- Doc anchor: `docs/PERFORMANCE.md` PER-008, `docs/DESIGN_PRINCIPLES.md` DPP-011

## Architect Review (2026-08-07)
- **Verdict**: CONFIRMED
- **Severity**: kept Nitpick (doc anchor cited PER-008 is misaligned; PER-008 lists budgets, not log volume)
- **Critique of report's fix**: equivalent. "Move to `logger.debug`" alternative doesn't help — `logger.debug` writes to the same daily log under the same `enabled` gate.
- **Bonus**: BUG-027 (tool-cache log spam) shares the same pattern (unconditional info per event under debug) — same root cause, different code path.