# BUG-005: `npm run build` fails on Windows: `clean` script uses `rm -rf dist`

## Summary

`package.json` defines `"clean": "rm -rf dist"`. On Windows PowerShell without git-bash in PATH, `npm run build` fails at the `clean` step before `tsup` even runs. CI runs on `ubuntu-latest` so the published artifact is unaffected, but local development on Windows is broken.

## Location

- `package.json:24`

## Current vs Expected Behavior

**Current**: `"clean": "rm -rf dist"` is POSIX shell syntax. PowerShell fails with `'rm' is not recognized as an internal or external command`.
**Expected**: Cross-platform removal of the `dist/` directory.

## Impact

- **Severity**: High (Windows dev environment broken)
- Runtime: not affected on Linux.
- User-observable: Windows contributors cannot run `npm run build` locally.

## Reproduction

On a clean Windows PowerShell:

```sh
npm run build
# 'rm' is not recognized as an internal or external command
```

## Suggested Fix

Replace `"clean": "rm -rf dist"` with stdlib-only (no new dep):

```json
"clean": "node -e \"require('fs').rmSync('dist', {recursive:true, force:true})\""
```

## Status

Fixed 2026-08-07

## Resolution

Replaced `rm -rf dist` with `node -e "require('fs').rmSync('dist', {recursive:true, force:true})"` in `package.json`.

## Cross-references

- Source investigator: tests + CI + format + deps
- Source finding ID: BUILD-WIN-1
- Validator verdict: ✅ CONFIRMED
- Doc anchor: `AGENTS.md` Commands table

## Architect Review (2026-08-07)

- **Verdict**: CONFIRMED
- **Severity**: kept High (Windows dev environment broken)
- **Correct Fix**: use Node's built-in `fs.rmSync` (no new dep). `shx` / `rimraf` introduce new deps and violate ponytail doctrine ("No new deps without justification; the bar is 'stdlib/native cannot do this in a few lines.'").
- **Bonus**: `tsup` has its own `clean: true` option that wipes `dist/`; setting `clean` to no-op (`""`) plus `tsup({ clean: true })` would simplify the build.
