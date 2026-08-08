# BUG-072: `stripPromptComments` doesn't normalize trailing whitespace

## Summary

`lib/prompts/store.ts:231-237` `stripPromptComments` matches `//...//` patterns but doesn't normalize per-line whitespace. Lines without the comment pattern are preserved verbatim. `toEditablePromptText` calls `.trim()` after `stripPromptComments`, which handles the start/end trim, but per-line whitespace stays. Cosmetic.

## Location

- `lib/prompts/store.ts:231-237`

## Current vs Expected Behavior

**Current**: Per-line whitespace preserved.
**Expected**: Document the behavior; or normalize.

## Impact

- **Severity**: Nitpick (cosmetic)
- Runtime: not affected.
- User-observable: whitespace in override files.

## Reproduction

Edit an override file with trailing spaces on non-comment lines. Inspect the result.

## Suggested Fix

No code change. The function is correct as-is; add the comment in `docs/features/PROMPTS.md` instead. YAGNI on normalization (cosmetic, no functional impact, would add complexity).

## Status

Fixed 2026-08-07

## Resolution

Documented per-line whitespace preservation in `docs/features/PROMPTS.md` (no code change; cosmetic only).

## Cross-references

- Source investigator: prompts + UI + TUI + subagents
- Source finding ID: N-STRIP-COMMENTS-PRESERVES-WS-1
- Validator verdict: ✅ CONFIRMED
- Doc anchor: `docs/features/PROMPTS.md` Style guidance for overrides

## Architect Review (2026-08-07)

- **Verdict**: CONFIRMED
- **Severity**: kept Nitpick
- **Bonus**: `normalizeReminderPromptContent` (lines 214-229) and `unwrapDcpTagIfWrapped` (lines 201-212) both rely on the same whitespace-preservation invariant — any future normalize change must not break those.
