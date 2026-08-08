# BUG-084: Validate `protectedTools` entries at config load with regex

## Summary

Type is `string[]` but tool names are typically `[a-zA-Z0-9_-]+`. Add a regex check to reject space/newline characters that would break the `<...>` wrapping.

## Location

- `lib/config.ts:320-326, 434-440, 664-670, 708-714`

## Current vs Expected Behavior

**Current**: Only `Array.isArray` is checked; entries pass through unchecked.
**Expected**: Per-item regex validation at config load.

## Impact

- **Severity**: Suggestion (defensive)
- Runtime: not affected for legitimate entries.
- User-observable: a malformed entry is rejected at load with a clear error.

## Reproduction

Edit `dcp.jsonc` to `"protectedTools": ["my tool"]`. Observe: silently accepted; downstream matching breaks.

## Suggested Fix

Ponytail: shared helper. `lib/config.ts`:

```ts
const TOOL_NAME_REGEX = /^\S+$/ // any non-whitespace; matches SDK tool naming conventions
function validateStringArrayItems(entries: unknown, key: string, errors: ValidationError[]): void {
    if (!Array.isArray(entries)) return
    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i]
        if (typeof entry !== "string" || !TOOL_NAME_REGEX.test(entry)) {
            errors.push({
                key: `${key}[${i}]`,
                expected: `non-empty tool name without whitespace (regex ${TOOL_NAME_REGEX.source})`,
                actual: JSON.stringify(entry),
            })
        }
    }
}
// invoke after each of the 4 protectedTools Array.isArray checks
```

## Status

Fixed 2026-08-07

## Resolution

Added `validateStringArrayItems` helper with `/^\S+$/` regex at `lib/config.ts`; invoked at all 4 `protectedTools` validation sites.

## Cross-references

- Source investigator: prompts + UI + TUI + subagents
- Source finding ID: S-PROTECTED-TOOLS-VALIDATOR-1
- Validator verdict: ✅ CONFIRMED
- Doc anchor: `docs/CONFIGURATION.md` Validation section, DPP-007

## Architect Review (2026-08-07)

- **Verdict**: CONFIRMED
- **Severity**: kept Suggestion (defensive validation)
- **Critique of report's fix**: `/^[a-zA-Z0-9_-]+$/` is too tight — excludes dots, which some OpenCode tool providers use. The actual downstream concern is whitespace (which would break the backtick-wrap and silently miss `isToolNameProtected` exact-set membership). `/^\S+$/` matches the SDK's looser naming and catches the real bug.
- **Bonus**: `compress.protectedFilePatterns` uses the same glob matcher (`lib/protected-patterns.ts:10-58`) but needs a _different_ validation regex — file patterns may contain `*`, `?`, `/`, etc. Split into two helpers: `validateStringArrayItems` (for `protectedTools`) and `validateGlobPatterns` (for `protectedFilePatterns`). The four `protectedTools` checks are duplicated four times in `lib/config.ts` — a single `validateProtectedToolsConfig` helper would DRY the validation. `dcp.schema.json` should also reflect the regex constraint at the JSON Schema level.
