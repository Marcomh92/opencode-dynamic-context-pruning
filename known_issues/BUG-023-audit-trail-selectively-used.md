# BUG-023: Only 3 test files have PAT-012 audit-trail trailers; many contract-style tests lack them

## Summary
PAT-012 in `docs/PATTERNS.md` says contract tests close with a four-line trailer (`// Logic Verified:`, `// Bugs Documented:`, `// Fakes Updated:`, `// Review Status:`). Only three test files have it: `tests/coalesce-save-session.test.ts:74-77`, `tests/append-idempotency.test.ts:91-94`, `tests/synthetic-user-message-stability.test.ts:44-47`. Many other "contract tests" (`compress-protocol.test.ts`, `state-schema-version.test.ts`, `compress-message.test.ts`) lack the trailer. Either the trailers are reserved for a stricter subset (in which case the doc should be clearer) or they're missing on the new contract tests.

## Location
- `tests/coalesce-save-session.test.ts:74-77`
- `tests/append-idempotency.test.ts:91-94`
- `tests/synthetic-user-message-stability.test.ts:44-47`

## Current vs Expected Behavior
**Current**: Selective use of trailers. Doc implies broad coverage.
**Expected**: Either expand trailer use to cover more contract tests, or narrow `PAT-012` to "selectively used".

## Impact
- **Severity**: High (audit trail missing on contract tests)
- Runtime: not affected.
- User-observable: future auditors cannot rely on trailers to identify contract tests.

## Reproduction
```sh
grep -l "Logic Verified:" tests/*.test.ts
# 3 matches.
```

## Suggested Fix
Option 2 (narrow the PAT-012 doc) is the ponytail-aligned minimum — edit `docs/PATTERNS.md` PAT-012 to say:
> "selectively used on the most critical contract tests — coalesce-save, append-idempotency, synthetic-user-message-stability are the reference set; add when a test pins a documented invariant (e.g., INV-*, DPP-*)."
The other option (add trailers to more files) is more work and more maintenance debt for marginal benefit. PAT-012's value is reviewer-signal, not enforcement.

## Status
Open

## Cross-references
- Source investigator: tests + CI + format + deps
- Source finding ID: PAT-012-MISS
- Validator verdict: ✅ CONFIRMED
- Doc anchor: `docs/PATTERNS.md` PAT-012, `docs/TESTING.md` Conventions

## Architect Review (2026-08-07)
- **Verdict**: CONFIRMED
- **Severity**: **changed High → Low**. Doc drift, not test debt. The three existing trailers work as audit anchors; expanding them is not free.
- **Correct Fix**: prefer option 2 (narrow the doc). The three existing trailers do not represent all contract tests — `compress-protocol.test.ts`, `state-schema-version.test.ts`, `compress-message.test.ts` are also contract tests without trailers. Narrowing the doc to reality is correct.
- **Bonus**: BUG-040 (`inv-coverage-missing-tags`) — `tests/compress-protocol.test.ts:308-326` tests `effectiveManualMode` against INV-8 but doesn't carry a PAT-012 trailer. If option 1 (expand trailers) is chosen, that file is the natural next candidate.
- **Merge**: BUG-023 + BUG-040 (both comment-only coverage items).