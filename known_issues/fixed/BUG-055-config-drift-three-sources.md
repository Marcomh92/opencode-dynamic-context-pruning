# BUG-055: `docs/CONFIGURATION.md` says "up to three sources" but lists four layers

## Summary

The prose at `docs/CONFIGURATION.md:7-12` says "up to three sources" while the numbered list enumerates four layers (built-in defaults, global, OPENCODE_CONFIG_DIR, project). Counting is off by one across the docs.

## Location

- `docs/CONFIGURATION.md:7-12`

## Current vs Expected Behavior

**Current**: Prose and list disagree on count.
**Expected**: Change "up to three sources" to "up to four sources" (or drop the built-in defaults from the list — they are not a "source" in the user-facing sense).

## Impact

- **Severity**: Low (documentation drift)
- Runtime: not affected.
- User-observable: confusing for new readers.

## Reproduction

Read `docs/CONFIGURATION.md:7-12`.

## Suggested Fix

At `docs/CONFIGURATION.md:7`, change `up to three sources` → `up to four sources`. The built-in defaults ARE one of the layers the code merges (see `mergeCompress` etc. in `lib/config.ts`); dropping them from the list would mislead readers.

## Status

Fixed 2026-08-07

## Resolution

Changed `up to three sources` → `up to four sources` at `docs/CONFIGURATION.md:7`.

## Cross-references

- Source investigator: config + state persistence
- Source finding ID: CONFIG-DRIFT-1
- Validator verdict: ✅ CONFIRMED
- Doc anchor: `docs/CONFIGURATION.md`

## Architect Review (2026-08-07)

- **Verdict**: CONFIRMED
- **Severity**: kept Low
- **Correct Fix**: one-word change is the smallest correct diff. Report's alternative ("drop built-in defaults from the list") is wrong — defaults are real, they ship in code.
- **Bonus**: `docs/CONFIGURATION.md:46-52` lists _four_ override paths for prompts (`global`, `configDir`, `project`, `defaults`) — consistent with the four-layer model. So "four sources" matches the doc's own internal vocabulary.
