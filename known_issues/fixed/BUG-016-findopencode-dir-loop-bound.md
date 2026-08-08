# BUG-016: `findOpencodeDir` `while (current !== "/")` is POSIX-only and dead on Windows

## Summary

`findOpencodeDir` walks up by `dirname(current)` checking `current !== "/"` to guard against walking past the filesystem root. On Windows, paths are `C:\…`, so the check is always true and the loop terminates only when `parent === current`. The function still works on Windows; the `current !== "/"` arm is dead code on Windows and unnecessary on POSIX. A future refactor that drops the secondary `parent === current` guard would loop forever on Windows or on POSIX when `workingDirectory` is `/`.

## Location

- `lib/prompts/store.ts:153-173`
- (also: `lib/config.ts:829-843` for the parallel `findOpencodeConfigDir`)

## Current vs Expected Behavior

**Current**: Two termination conditions; one POSIX-only, one universal. Loops end safely via `parent === current`.
**Expected**: Rely solely on `parent === current` as the termination condition.

## Impact

- **Severity**: High (latent infinite-loop risk on a single-platform surface)
- Runtime: not affected currently — the secondary break saves it. A refactor that drops it would freeze the plugin.
- User-observable: none today; dangerous on Windows if the secondary break is removed.

## Reproduction

Inspect `lib/prompts/store.ts:153-173`: walk the logic with `workingDirectory = "C:\\Users\\foo"`. The `while (current !== "/")` is always true.

## Suggested Fix

Apply identical fix to both files: replace `while (current !== "/")` with `while (true)` and keep `if (parent === current) break` as the sole termination.

```ts
function findOpencodeDir(startDir: string): string | null {
    let current = startDir
    while (true) {
        const candidate = join(current, ".opencode")
        if (existsSync(candidate) && statSync(candidate).isDirectory()) {
            return candidate
        }
        const parent = dirname(current)
        if (parent === current) break // already at filesystem root
        current = parent
    }
    return null
}
```

Apply identically to `lib/config.ts:829-843`.

## Status

Fixed 2026-08-07

## Cross-references

- Source investigator: prompts + UI + TUI + subagents
- Source finding ID: H-WIN-PATH-LOOP-1
- Validator verdict: ✅ CONFIRMED
- Doc anchor: `docs/features/PROMPTS.md` Override paths, `docs/CONFIGURATION.md` Project config walk

## Architect Review (2026-08-07)

- **Verdict**: CONFIRMED
- **Severity**: kept High (latent infinite-loop risk on a single-platform surface)
- **Correct Fix**: equivalent to report — the universal guard replaces the POSIX-only arm.
- **Bonus**: both copies (`prompts/store.ts:153` and `config.ts:829`) are nearly identical (~14 lines, 8 shared). A shared helper in `lib/fs-utils.ts` would close the hazard in one place.
- **Merge**: BUG-016 + BUG-058 (companion at `lib/config.ts`).

## Resolution

`findOpencodeDir` uses `while (true)` with parent-equality root guard in `lib/config.ts` and `lib/prompts/store.ts`.
