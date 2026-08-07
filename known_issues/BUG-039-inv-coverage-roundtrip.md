# BUG-039: INV-10 `wrapCompressedSummary` ↔ `restoreSummary` round-trip not tested

## Summary
`wrapCompressedSummary` is exercised by `tests/compress-range-placeholders.test.ts` and `tests/token-usage.test.ts` for setup, but neither asserts the round-trip with `restoreSummary` (`lib/compress/range-utils.ts:373-384`). The `restoreSummary` function is not exported, so no test imports it. A change to the header/footer format would silently break the production path.

## Location
- `lib/compress/state.ts:53-61` (`wrapCompressedSummary`)
- `lib/compress/range-utils.ts:373-384` (`restoreSummary`)

## Current vs Expected Behavior
**Current**: `wrapCompressedSummary` is tested for setup; `restoreSummary` round-trip is not.
**Expected**: A dedicated test asserting round-trip on plain summary, summary containing the literal header string (must not be misinterpreted), and empty body.

## Impact
- **Severity**: Medium (test gap on a documented contract)
- Runtime: not affected directly.
- User-observable: future regression would silently break restoration.

## Reproduction
```sh
grep -l "restoreSummary" tests/*.test.ts
# No matches.
```

## Suggested Fix
Export `restoreSummary` and add a table-driven test. **Critical**: empirical confirmation needed before shipping — the report's fix is directionally right but architect traced by hand and found the regex is asymmetric: `restoreSummary` strips the closing `</dcp-message-id>` but **leaves the opening `<dcp-message-id ...>` tag entirely** (the regex at `range-utils.ts:382` matches only the footer).

Two-step fix:
1. Add the round-trip test from the report. **Run it; it WILL fail** to confirm the asymmetric-regex bug.
2. Then fix the regex at `lib/compress/range-utils.ts:382` to also strip the opening tag (the bug the test will surface).

## Status
Open

## Cross-references
- Source investigator: tests + CI + format + deps
- Source finding ID: INV-COVERAGE-3
- Validator verdict: ✅ CONFIRMED
- Doc anchor: `docs/features/COMPRESSION.md` INV-10

## Architect Review (2026-08-07)
- **Verdict**: CONFIRMED — and it conceals a live production bug
- **Severity**: **escalate from Medium → high priority**. The hand-traced regex asymmetry is a real correctness defect, not just a test gap. `restoreSummary` returns `[Compressed conversation section]\nBody\n\n\n` from the round-trip instead of just `Body`.
- **Bonus**: `block.summary` stores the wrapped form (`range.ts:180` → `:199`), so the bug fires in production during nested-block re-compression. Empirical confirmation (run the test, see it fail) is recommended before shipping.
- **Priority**: this is the highest-impact correctness bug found in this batch — fix first.