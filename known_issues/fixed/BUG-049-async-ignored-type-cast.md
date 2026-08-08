# BUG-049: `isIgnoredUserMessage` casts `(part as any).ignored`

## Summary

The `ignored` property is not declared on the `Part` union. The `(part as any).ignored` cast at `lib/messages/query.ts:53` silently bypasses TypeScript's structural check. If OpenCode renames `ignored` → `noReply` or moves it to `part.metadata`, the plugin would silently treat notification messages as non-ignored and inject IDs into them, polluting the model context.

## Location

- `lib/messages/query.ts:38-59` (`isIgnoredUserMessage`)

## Current vs Expected Behavior

**Current**: `(part as any).ignored` cast.
**Expected**: Declare the `ignored` property on a custom extended part type, or use `part.type === "text" && "ignored" in part && part.ignored === true`.

## Impact

- **Severity**: Low (DPP-014 partial risk)
- Runtime: not affected today.
- User-observable: silent pollution if OpenCode changes the contract.

## Reproduction

Inspect `lib/messages/query.ts:53`.

## Suggested Fix

Drop the cast at `lib/messages/query.ts:52-56`:

```ts
for (const part of parts) {
    if (!part.ignored) return false
}
```

Equivalent for `lib/ui/utils.ts:221` (companion in BUG-038). The for-loop over `parts` already narrows on `part.type`; direct access compiles in `lib/commands/manual.ts:124` and `lib/logger.ts:186` already.

## Status

Fixed 2026-08-07

## Resolution

Dropped `(part as any).ignored` cast at `lib/messages/query.ts:53`; direct access compiles.

## Cross-references

- Source investigator: hooks + messages
- Source finding ID: ASYNC-IGNOREDTYPE-1
- Validator verdict: ✅ CONFIRMED
- Doc anchor: `docs/DESIGN_PRINCIPLES.md` DPP-014

## Architect Review (2026-08-07)

- **Verdict**: PARTIAL (cast is inconsistent with two other sites that use `part.ignored` directly)
- **Severity**: kept Low
- **Correct Fix**: drop the cast entirely — direct access already compiles in 2 other sites.
- **Critique of report's fix**: the suggested `(part as TextPart).ignored === true` is equivalent to direct access but adds noise.
- **Bonus**: same anti-pattern at `lib/ui/utils.ts:221`. A `git grep -n "as any) .ignored"` would catch both.
- **Merge**: BUG-038 + BUG-049 (`as any` cast removal; together with BUG-073's broader audit).
