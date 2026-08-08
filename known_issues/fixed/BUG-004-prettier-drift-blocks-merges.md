# BUG-004: 223 files failing `npm run format:check`, blocking all PR merges

## Summary

`npm run format:check` reports `Code style issues found in 223 files.` (up from 140 at audit time). Prettier drift has accumulated across the repository. CI (`.github/workflows/pr-checks.yml:25-26`) runs `format:check` with no `continue-on-error`, so every PR is blocked until a meta-PR reformats the whole tree.

## Location

- `.github/workflows/pr-checks.yml:25-26` (CI gate)
- `package.json:33` (Prettier config)
- All source, test, docs, and config files

## Current vs Expected Behavior

**Current**: 140 files have formatting drift. A contributor opening any PR must run `prettier --write` on 140 unrelated files first, or their PR cannot merge.
**Expected**: `npm run format:check` passes cleanly on a fresh checkout; the gate is meaningful, not self-inflicted.

## Impact

- **Severity**: High (CI gate blocks all PRs)
- Runtime: not affected.
- User-observable: contributors cannot ship changes; review queue stalls.

## Reproduction

```sh
npm run format:check
# Code style issues found in 140 files. Run Prettier with --write to fix.
```

## Suggested Fix

1. **First**: add `.prettierignore` (no such file exists today; `package-lock.json` is among the 223 flagged files and `npm install` will rewrite it):
    ```
    # .prettierignore
    package-lock.json
    dist/
    node_modules/
    ```
2. One-shot PR: `npx prettier --write .`
3. Tighten CI to fail on any new drift (the existing gate becomes meaningful).
4. Optional: configure Husky pre-commit hook with `--cache` to keep drift from returning.

## Status

Fixed 2026-08-07

## Resolution

Added `.prettierignore` and ran `npx prettier --write .` meta-PR; `npm run format:check` now passes.

## Cross-references

- Source investigator: tests + CI + format + deps
- Source finding ID: FORMAT-FAIL-1 (companion: FORMAT-FAIL-BLOCKING tracks the merge-cycle consequence)
- Validator verdict: ✅ CONFIRMED
- Doc anchor: `AGENTS.md` Commands table, `docs/TESTING.md`

## Architect Review (2026-08-07)

- **Verdict**: PARTIAL — the underlying issue is CONFIRMED but the count is stale (223 not 140)
- **Severity**: kept High (the blocker is real; only the number is wrong)
- **Correct Fix**: as above; the report's "bare `prettier --write .`" suggestion is **incomplete** without `.prettierignore` (the meta-PR will re-fail the gate when `npm install` rewrites `package-lock.json`).
- **Bonus**: this is the meta-PR that blocks every other PR fix. Do first. `package.json:32` writes via `prettier --write .` (no `--cache`); pre-commit hook with `--cache` would prevent drift.
- **Merge**: same root cause as BUG-042; BUG-042 should be closed as duplicate once this lands.
