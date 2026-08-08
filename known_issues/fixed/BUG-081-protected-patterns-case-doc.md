# BUG-081: Document case-sensitivity policy for protected patterns

## Summary

Globs inherit the underlying filesystem. On Windows this is case-insensitive; on POSIX case-sensitive. Surface the platform policy in the docs.

## Location

- `docs/CONFIGURATION.md`
- `lib/protected-patterns.ts:10-58` (case-sensitive matching)

## Current vs Expected Behavior

**Current**: Docs say nothing about case-sensitivity; `lib/protected-patterns.ts` is case-sensitive.
**Expected**: Document the platform case-sensitivity policy.

## Impact

- **Severity**: Suggestion (docs)
- Runtime: not affected.
- User-observable: users on Windows may expect different matching behavior.

## Reproduction

Read `docs/CONFIGURATION.md` and `lib/protected-patterns.ts`. No case-sensitivity policy documented.

## Suggested Fix

Add a paragraph to `docs/CONFIGURATION.md` after line 23 (the merge-semantics table):

```md
## Pattern matching

`compress.protectedFilePatterns` and the tool-name patterns inside `compress.protectedTools` use
the custom glob matcher in `lib/protected-patterns.ts`. The matcher is **case-sensitive on every
platform** — the underlying regex does not use the `i` flag. To match case-insensitively, list
the patterns explicitly (e.g. `["*.md", "*.MD"]` for both `.md` and `.MD` suffixes).

Note: on case-insensitive filesystems (Windows, default macOS HFS+/APFS), the _file system_
folds case, but the matcher does not. A pattern like `README.md` matches the literal string
`README.md`, not `readme.md`.
```

## Status

Fixed 2026-08-07

## Resolution

Added Pattern Matching section to `docs/CONFIGURATION.md` documenting case-sensitive matcher for `protectedFilePatterns` and `protectedTools`.

## Cross-references

- Source investigator: prompts + UI + TUI + subagents
- Source finding ID: S-PROTECTED-PATTERNS-DOCS-1
- Validator verdict: ✅ CONFIRMED
- Doc anchor: `docs/CONFIGURATION.md` Protected patterns section

## Architect Review (2026-08-07)

- **Verdict**: CONFIRMED
- **Severity**: kept Suggestion (docs drift)
- **Critique of report's fix**: correct and minimal; report doesn't mention `compress.protectedTools` — both should be covered for consistency.
- **Bonus**: same matcher is used by both `protectedFilePatterns` (file paths) and `compress.protectedTools` (tool names). Doc addition should cover both. Matcher doesn't handle Unicode normalization (NFC vs NFD); macOS HFS+ uses NFD, Linux ext4 uses NFC. Out of scope for Suggestion.
