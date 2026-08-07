# BUG-058: `findOpencodeDir` POSIX-only check in `lib/config.ts`

## Summary
Same root cause as BUG-016 but in a different file. `lib/config.ts:829-843` `findOpencodeConfigDir` walks up by `dirname(current)` checking `current !== "/"` to guard against walking past the filesystem root. On Windows, paths are `C:\…`, so the check is always true. Termination relies on the secondary `if (parent === current) break`.

## Location
- `lib/config.ts:829-843`

## Current vs Expected Behavior
**Current**: Two termination conditions; one POSIX-only, one universal.
**Expected**: Rely solely on `parent === current` as the termination condition.

## Impact
- **Severity**: Low (companion to BUG-016)
- Runtime: not affected currently.
- User-observable: same as BUG-016 — latent infinite-loop risk on a single-platform surface.

## Reproduction
Inspect `lib/config.ts:829-843`. Same as BUG-016.

## Suggested Fix
At `lib/config.ts:831`, change `while (current !== "/") {` → `while (true) {`. Keep the `if (parent === current) break` as the sole termination. One-character change.

## Status
Open

## Cross-references
- Source investigator: config + state persistence
- Source finding ID: CFG-FINDOPENCODE-WIN-1 (companion to BUG-016)
- Validator verdict: ⚠️ PARTIAL (real concern but mitigated by secondary break)
- Doc anchor: `docs/CONFIGURATION.md`

## Architect Review (2026-08-07)
- **Verdict**: CONFIRMED
- **Severity**: kept Low (latent risk only; secondary break saves it today)
- **Correct Fix**: equivalent to BUG-016's fix.
- **Bonus**: the two `findOpencodeDir` copies (`lib/config.ts:829`, `lib/prompts/store.ts:153`) are identical implementations — a future cleanup could extract to a shared util.
- **Merge**: BUG-058 + BUG-016 (companion at `lib/config.ts`; same fix shape; close as duplicate once one lands).