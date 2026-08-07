# BUG-082: Add runtime assertion that `INTERNAL_PROMPT_EXTENSIONS` keys disjoint from `PROMPT_KEYS`

## Summary
Catches future maintainer mistakes that would accidentally let user edits override runtime extensions.

## Location
- `lib/prompts/store.ts:140-151`

## Current vs Expected Behavior
**Current**: `INTERNAL_PROMPT_EXTENSIONS` keys (`manualExtension`, `subagentExtension`) are disjoint from `PROMPT_KEYS` by construction, but no runtime check enforces it.
**Expected**: A runtime assertion at module load.

## Impact
- **Severity**: Suggestion (defensive)
- Runtime: not affected.
- User-observable: a future rename gets caught immediately.

## Reproduction
Add an `INTERNAL_PROMPT_EXTENSIONS` key that collides with a `PROMPT_KEYS` value; observe no warning.

## Suggested Fix
Module-load assertion in `lib/prompts/store.ts` after line 138:
```ts
// ponytail: defensive invariant; runs once at module load. DPP-015 forbids user overrides
// from colliding with runtime extensions.
for (const extKey of Object.keys(INTERNAL_PROMPT_EXTENSIONS) as Array<keyof typeof INTERNAL_PROMPT_EXTENSIONS>) {
    if ((PROMPT_KEYS as readonly string[]).includes(extKey)) {
        throw new Error(
            `INTERNAL_PROMPT_EXTENSIONS key '${extKey}' collides with PROMPT_KEYS; runtime extensions must be disjoint from user-overridable keys (DPP-015)`,
        )
    }
}
```

## Status
Open

## Cross-references
- Source investigator: prompts + UI + TUI + subagents
- Source finding ID: S-RUNTIME-EXT-ASSERT-1
- Validator verdict: ✅ CONFIRMED
- Doc anchor: `docs/DESIGN_PRINCIPLES.md` DPP-015, `docs/features/PROMPTS.md`

## Architect Review (2026-08-07)
- **Verdict**: CONFIRMED
- **Severity**: kept Suggestion (defensive)
- **Critique of report's fix**: two issues — `extKey as any` is ironic (BUG-073 criticizes this; use `keyof typeof INTERNAL_PROMPT_EXTENSIONS`); placement inside `createBundledRuntimePrompts` is wrong — module load is the right site.
- **Bonus**: the same disjoint check could apply to `RANGE_FORMAT_EXTENSION` and `MESSAGE_FORMAT_EXTENSION` (`lib/prompts/extensions/tool.ts`). Add the same check for those constants.