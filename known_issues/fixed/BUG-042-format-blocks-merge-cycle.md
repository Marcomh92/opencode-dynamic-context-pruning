# BUG-042: Format drift blocks all PRs until reformatted; needs a meta-PR

## Summary

Companion to BUG-004: while the 223-file drift exists (up from 140 at audit time), no contributor can open a PR without first running `prettier --write` on 223 unrelated files. A meta-PR is required to close the drift; the meta-PR will touch every file in the repo and will be hard to review.

## Location

- Repository-wide (consequence of BUG-004)
- `.github/workflows/pr-checks.yml:25-26`

## Current vs Expected Behavior

**Current**: Contributors blocked by a gate whose only failure is in prior commits.
**Expected**: One-shot meta-PR to format the tree; subsequent contributors see a clean baseline.

## Impact

- **Severity**: Medium (consequence of BUG-004; tracked separately for closing process)
- Runtime: not affected.
- User-observable: PR queue stalls.

## Reproduction

Open any PR; CI runs `format:check` and fails before any other check.

## Suggested Fix

1. Add `.prettierignore` first (no such file exists today):
    ```
    # .prettierignore
    package-lock.json
    dist/
    node_modules/
    ```
2. Run `npx prettier --write .` in a single commit.
3. Open the meta-PR; merge quickly with admin override if needed.
4. Once baseline is clean, any drift is the contributor's responsibility.

## Status

Fixed 2026-08-07

## Resolution

Closed as duplicate of BUG-004; same root cause (Prettier drift) resolved by that fix.

## Cross-references

- Source investigator: tests + CI + format + deps
- Source finding ID: FORMAT-FAIL-BLOCKING (companion to BUG-004)
- Validator verdict: ✅ CONFIRMED
- Doc anchor: `AGENTS.md` Commands table

## Architect Review (2026-08-07)

- **Verdict**: CONFIRMED (premise) with materially wrong count
- **Severity**: kept Medium
- **Correct Fix**: must add `.prettierignore` **before** running `prettier --write .` — otherwise the meta-PR re-fails the gate when `npm install` rewrites `package-lock.json` in npm's own format.
- **Critique of report's fix**: incomplete and self-defeating. There is NO `.prettierignore` in the repo (verified). Running bare `prettier --write .` reformats `package-lock.json`; the next `npm install`/`npm ci` rewrites it; the gate breaks again immediately.
- **Bonus**: close BUG-042 as duplicate of BUG-004 once the meta-PR lands.
- **Merge**: BUG-042 + BUG-004 (same root cause, single remedy, single PR).
