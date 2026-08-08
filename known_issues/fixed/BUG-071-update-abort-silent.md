# BUG-071: `startAutoUpdate` swallows network failures silently

## Summary

The `.catch(() => {})` at `lib/update.ts:43` swallows every error from `checkAutoUpdate` (network failure, malformed package.json, removal failure). `update.ts` is undocumented in `docs/`. The 10s timeout aborts the registry fetch; the silent catch means a user behind a proxy or offline sees no signal that auto-update was attempted.

## Location

- `lib/update.ts:19-45`

## Current vs Expected Behavior

**Current**: Silent best-effort failure.
**Expected**: Add a debug-level log line on catch; document the file.

## Impact

- **Severity**: Nitpick (silent best-effort)
- Runtime: not affected.
- User-observable: no signal on auto-update failure.

## Reproduction

Run with `autoUpdate: true` behind a proxy or offline; inspect logs.

## Suggested Fix

Smallest at `lib/update.ts:42-44`:

```ts
.catch((err) => {
    // ponytail: best-effort — network/proxy failures shouldn't surface,
    // but a silent swallow makes "why didn't auto-update happen?" a 30-min
    // debugging session. One debug line when debug is on.
    if (process.env.DCP_DEBUG) console.debug("[dcp] auto-update failed:", String(err))
})
```

If `Logger` is wired here, prefer `logger.debug` (consistent with the rest of the codebase); the snippet above is the no-Logger-change path.

## Status

Fixed 2026-08-07

## Resolution

Added debug log on catch in `startAutoUpdate` at `lib/update.ts:42-44`.

## Cross-references

- Source investigator: OpenCode integration + permissions
- Source finding ID: UPDATE-ABORT-17
- Validator verdict: ⚠️ PARTIAL (silent failure is real; timer/controller proliferation not established)
- Doc anchor: None

## Architect Review (2026-08-07)

- **Verdict**: CONFIRMED
- **Severity**: kept Nitpick
- **Correct Fix**: equivalent; using `logger.enabled` guard is slightly more idiomatic than `process.env.DCP_DEBUG`. The suggested fix assumes `Logger` is in scope, which it isn't in this module — minor mismatch.
- **Bonus**: the file-level doc gap is real — add a one-paragraph entry in `docs/features/OPENCODE_INTEGRATION.md` or create `docs/features/AUTO_UPDATE.md`.
