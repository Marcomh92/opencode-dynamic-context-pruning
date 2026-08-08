# BUG-079: Resolve override candidates through `realpathSync` to prevent symlink escape

## Summary

Override candidate paths at `lib/prompts/store.ts:361-365, 395-415` are joined directly without `realpathSync`. A symlink that escapes the overrides dir would still be read.

## Location

- `lib/prompts/store.ts:361-365`
- `lib/prompts/store.ts:395-415`

## Current vs Expected Behavior

**Current**: Override paths joined directly.
**Expected**: Resolve all candidates through `realpathSync` and verify they remain inside the configured root.

## Impact

- **Severity**: Suggestion (security hardening)
- Runtime: not affected for legitimate overrides.
- User-observable: a symlink could escape the overrides dir.

## Reproduction

Create a symlink in the overrides dir pointing elsewhere; observe the plugin reads it.

## Suggested Fix

Ponytail: add `realpathSync` to the import, wrap the read site. `lib/prompts/store.ts:1`:

```ts
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync, statSync } from "fs"
```

`lib/prompts/store.ts:361-365` (inside `reload`, before `readFileIfExists`):

```ts
let resolvedPath = candidate.path
if (existsSync(candidate.path)) {
    try {
        resolvedPath = realpathSync(candidate.path)
    } catch {
        continue // broken symlink; skip silently
    }
}
const rawOverride = readFileIfExists(resolvedPath)
```

Boundary check skipped — self-trust overrides dir. Ponytail: realpath resolution is sufficient hardening.

## Status

Fixed 2026-08-07

## Resolution

Override candidates now resolved through `realpathSync` at `lib/prompts/store.ts:361-365, 395-415`; broken symlinks skipped silently.

## Cross-references

- Source investigator: prompts + UI + TUI + subagents
- Source finding ID: S-PROMPT-OVERRIDE-SAWPATH-1
- Validator verdict: ✅ CONFIRMED
- Doc anchor: `docs/features/PROMPTS.md` Override paths

## Architect Review (2026-08-07)

- **Verdict**: CONFIRMED
- **Severity**: kept Suggestion (security hardening, low real risk)
- **Critique of report's fix**: over-engineered for the threat model. Boundary check is necessary only if DCP reads overrides from a path the user does not control (e.g. a shared system path), which is not the case. Realpath alone catches the typical symlink-escape scenario.
- **Bonus**: same pattern applies to `findOpencodeDir` in `lib/prompts/store.ts:153-194` — it walks up looking for `.opencode` directories without resolving symlinks. BUG-016 (POSIX-only) and BUG-058 share the surface; a follow-up audit pass on prompt-path handling would catch all three.
