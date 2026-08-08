# BUG-067: `BLOCK_PLACEHOLDER_REGEX` matches `(b0)`; INV-20 forbids `b0`

## Summary

The placeholder regex `BLOCK_PLACEHOLDER_REGEX` at `lib/compress/range-utils.ts:13` is `/\(b(\d+)\)|\{block_(\d+)\}/gi` — it matches `(b0)`. INV-20 (`docs/features/COMPRESSION.md:82`) says `parseBlockRef("b0") returns null` (IDs ≥1). The placeholder path is silently filtered by `validateSummaryPlaceholders` since `requiredBlockIds` never contains 0, so the behavior is conservative.

## Location

- `lib/compress/range-utils.ts:13`
- `lib/compress/range-utils.ts:209-231` (`parseBlockPlaceholders`)

## Current vs Expected Behavior

**Current**: Regex matches `(b0)`; placeholder is silently dropped.
**Expected**: Tighten the regex to `[1-9]\d*`, or document the asymmetry.

## Impact

- **Severity**: Nitpick (silent drop)
- Runtime: not affected — placeholder is silently filtered.
- User-observable: none.

## Reproduction

Try a summary containing `(b0)` and `(b1)`. Observe `(b1)` resolved, `(b0)` silently dropped.

## Suggested Fix

At `lib/compress/range-utils.ts:13`:

```ts
const BLOCK_PLACEHOLDER_REGEX = /\(b([1-9]\d*)\)|\{block_([1-9]\d*)\}/gi
```

## Status

Fixed 2026-08-07

## Resolution

Tightened `BLOCK_PLACEHOLDER_REGEX` to forbid `b0` at `lib/compress/range-utils.ts:13`: `/\(b([1-9]\d*)\)|\{block_([1-9]\d*)\}/gi`.

## Cross-references

- Source investigator: compress + v2 fork-protocol
- Source finding ID: PLACEHOLDER-B0
- Validator verdict: ⚠️ PARTIAL (wrong INV cited — INV-20 not INV-18; regex behavior is real but conservative)
- Doc anchor: `docs/features/COMPRESSION.md` INV-20

## Architect Review (2026-08-07)

- **Verdict**: CONFIRMED (with self-correction on anchor — INV-20 not INV-18)
- **Severity**: kept Nitpick
- **Correct Fix**: equivalent to report.
- **Bonus**: `parseBlockPlaceholders` at lines 209-231 does `Number.parseInt(blockIdPart, 10)` then `if (!Number.isInteger(parsed)) continue` — the integer check is now dead (regex enforces digits). Could be tightened, but YAGNI; leave as-is for forward-compat if someone swaps regex later.
