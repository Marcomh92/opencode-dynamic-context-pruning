# BUG-002: savecontext-rate-limit test fails due to ms-resolution filename collision

## Summary

The `saveContext writes again when minimized messages change` test in `tests/savecontext-rate-limit.test.ts` fails because `lib/logger.ts` derives filenames from `new Date().toISOString()` at millisecond precision. Two `saveContext` calls separated only by `await nextTick()` can land in the same millisecond, producing the same filename and overwriting each other.

## Location

- `tests/savecontext-rate-limit.test.ts:47-54`
- `lib/logger.ts:271-273`

## Current vs Expected Behavior

**Current**: Filename = `${timestamp}.json` where timestamp = `new Date().toISOString().replace(/[:.]/g, "-")` (millisecond precision). The test calls `await logger.saveContext()` twice and expects `files(sessionId).length === 2`, but only one file remains because both writes target the same filename.
**Expected**: Each distinct save produces a distinct filename.

## Impact

- **Severity**: High (test contradicts documented "198/198 passing" claim; CI trusts the count but a real regression is silently broken)
- Runtime: not affected in production — this is a test-suite flake plus a real bug surface in the debug-log path.
- User-observable: `npm test` reports the test failing but the suite summary may still claim pass count.

## Reproduction

```sh
node --import tsx --test tests/savecontext-rate-limit.test.ts
```

Observe: `actual: 1 !== expected: 2` for `files(sessionId).length`.

## Suggested Fix

Append a monotonic counter or `performance.now()`-based suffix to the filename in `lib/logger.ts:271-273`. Example:

```ts
const timestamp = `${new Date().toISOString().replace(/[:.]/g, "-")}-${++this.saveSeq}`
```

Add a regression test that asserts distinct calls produce distinct paths.

## Status

Fixed 2026-08-07

## Resolution

Appended monotonic `saveSeq` counter to saveContext filename in `lib/logger.ts:271-272`; regression test added.

## Cross-references

- Source investigator: tests + CI + format + deps
- Source finding ID: TEST-FAIL-1 (related: PONYTAIL-STALE-2 — same root cause, comment understated entry size)
- Validator verdict: ✅ CONFIRMED + real test failure observed
- Doc anchor: `docs/TESTING.md` Run section, `docs/PATTERNS.md` PAT-001 ponytail convention

## Architect Review (2026-08-07)

- **Verdict**: CONFIRMED
- **Severity**: kept High (CI trust on test counts is the core risk)
- **Correct Fix**: prefer a monotonic counter over `performance.now()` (deterministic, shorter, unambiguous):
    ```ts
    // lib/logger.ts:271-272
    const timestamp = `${new Date().toISOString().replace(/[:.]/g, "-")}-${++this.saveSeq}`
    ```
    where `saveSeq` is a module- or instance-level counter. Add a `// ponytail:` comment naming the ceiling.
- **Critique of report's fix**: equivalent. The `performance.now()` suffix is a valid alternative; a monotonic integer is shorter.
- **Bonus**: the test's `nextTick()` helper is weaker than production needs; consider `setTimeout(1)` or two distinct sessionIds.
