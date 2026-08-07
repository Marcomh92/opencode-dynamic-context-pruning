# BUG-057: `STORAGE_DIR` module-level constant is dead code

## Summary
`STORAGE_DIR` is declared at module top of `lib/state/persistence.ts:55` to capture `process.env.XDG_DATA_HOME` at import time. The ponytail comment explains why a per-call resolver is needed. All callers use `resolveStorageDir()` or `getSessionFilePath()` (which calls `resolveStorageDir`). The `STORAGE_DIR` constant is never read after declaration.

## Location
- `lib/state/persistence.ts:55-76`

## Current vs Expected Behavior
**Current**: Dead constant exists; comment is the "why" record.
**Expected**: Either delete the constant, or keep it as the only "canonical" storage path (and have `resolveStorageDir` re-export it).

## Impact
- **Severity**: Low (dead code)
- Runtime: not affected.
- User-observable: none.

## Reproduction
```sh
grep -n STORAGE_DIR lib/state/persistence.ts
# 1 match — the declaration itself.
```

## Suggested Fix
Delete lines 55-61 of `lib/state/persistence.ts` (the `STORAGE_DIR` const) and update the comment at lines 63-67 to drop the reference to `STORAGE_DIR`. The `resolveStorageDir` body is the canonical source. Ponytail comment about test isolation stays on `resolveStorageDir`.

## Status
Open

## Cross-references
- Source investigator: config + state persistence
- Source finding ID: STATE-EMPTY-CACHE-1
- Validator verdict: ✅ CONFIRMED
- Doc anchor: `docs/PATTERNS.md` PAT-001 ponytail rule

## Architect Review (2026-08-07)
- **Verdict**: CONFIRMED
- **Severity**: kept Low (dead code only)
- **Correct Fix**: deletion is cleaner. An alternative would be to make `STORAGE_DIR` canonical and have `resolveStorageDir` re-read it — but that defeats the actual rationale (per-call env read).