# BUG-003: PR CI workflow omits `npm test`

## Summary

`.github/workflows/pr-checks.yml` runs `format:check`, `typecheck`, `build`, and `npm audit`, but never `npm test`. A test regression like BUG-002 can merge to main undetected.

## Location

- `.github/workflows/pr-checks.yml:25-35`

## Current vs Expected Behavior

**Current**: PR pipeline runs format + typecheck + build + audit only. The `npm test` script defined in `package.json:31` is never invoked.
**Expected**: `npm test` runs before `build` so regressions are caught at PR time rather than at publish time (the `publish.yml` workflow does run tests, but only pre-publish).

## Impact

- **Severity**: High (regressions slip into main)
- Runtime: not affected — this is a CI gate defect.
- User-observable: a failing test merges silently; the documented "198/198 passing" claim drifts from reality.

## Reproduction

Inspect `.github/workflows/pr-checks.yml` — no `npm test` step exists.

## Suggested Fix

Add the following step between typecheck and build:

```yaml
- name: Run tests
  run: npm test
```

`~/.npm` caching is already enabled via `actions/setup-node@v4 cache: "npm"`; no extra caching step needed.

## Status

Fixed 2026-08-07

## Resolution

Added `npm test` step between typecheck and build in `.github/workflows/pr-checks.yml`.

## Cross-references

- Source investigator: tests + CI + format + deps
- Source finding ID: CI-GAP-1
- Validator verdict: ✅ CONFIRMED
- Doc anchor: `docs/TESTING.md` Run section

## Architect Review (2026-08-07)

- **Verdict**: CONFIRMED
- **Severity**: kept High (test regressions landing on master is the risk)
- **Correct Fix**: equivalent to report; suggestion about additional `~/.npm` caching is redundant (already in cache config).
- **Bonus**: `publish.yml` runs tests pre-publish but a broken test only blocks release, not merge.
