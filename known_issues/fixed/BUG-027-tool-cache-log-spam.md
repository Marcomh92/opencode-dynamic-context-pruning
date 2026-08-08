# BUG-027: `syncToolCache` emits one `logger.info` line per cached tool part; thousands of log writes per fire with debug enabled

## Summary

Three `logger.info` calls in `lib/state/tool-cache.ts`:19, 64, 70 run on the hot path. Line 64 fires once per tool part cached — a session with 100 visible tool parts emits 100 lines per fire. Combined with `await writeFile` (`Logger.write`), this is hundreds-to-thousands of disk writes per fire for debug-enabled sessions.

## Location

- `lib/state/tool-cache.ts:19, 64, 70`

## Current vs Expected Behavior

**Current**: Per-tool `logger.info` lines on the hot path.
**Expected**: Replace the per-id `logger.info` with a single summary line at the end of `syncToolCache`, or downgrade to `logger.debug`.

## Impact

- **Severity**: Medium (perf + log noise)
- Runtime: not affected when debug is off.
- User-observable: long debug sessions fill disk; daily log file becomes unreadable.

## Reproduction

Enable debug in `dcp.jsonc`, run a session with 100+ tool parts, inspect `~/.config/opencode/logs/dcp/daily/`.

## Suggested Fix

Downgrade both `logger.info` calls to `logger.debug` (PER-008 hot-path invariant):

```ts
// lib/state/tool-cache.ts:64
logger.debug(
    `Cached tool id: ${part.callID} (turn ${turnCounter}${tokenCount !== undefined ? `, ${tokenCount} tokens` : ""})`,
)
// lib/state/tool-cache.ts:70
logger.debug(`Synced cache - size: ${state.toolParameters.size}, currentTurn: ${state.currentTurn}`)
```

Ponytail: drop the per-call summary; the periodic diagnostic event already records cache size.

## Status

Fixed 2026-08-07

## Resolution

Demoted `syncToolCache` per-part `logger.info` to `logger.debug` at `lib/state/tool-cache.ts:64, 70`.

## Cross-references

- Source investigator: hooks + messages
- Source finding ID: TOOLCACHE-LOGSPAM-1 (companion: PIPE-LINECOUNT-1 for the transform hook side)
- Validator verdict: ✅ CONFIRMED
- Doc anchor: `docs/PERFORMANCE.md` PER-001, PER-008, `docs/PATTERNS.md` PAT-001 ponytail

## Architect Review (2026-08-07)

- **Verdict**: CONFIRMED
- **Severity**: kept Medium (PER-008 violation; debug-mode disk noise)
- **Correct Fix**: simpler version is just changing both `info`→`debug`.
- **Critique of report's fix**: equivalent. The "batched per N" suggestion is overkill.
- **Bonus**: `lib/hooks.ts:161-172` (the diagnostic fire) also `logger.info`s per transform — same fix rationale (BUG-064).
