# BUG-013: `config()` hook mutates user `compress.permission` to `"deny"` even when user explicitly allowed; contradicts DPP-010

## Summary

`index.ts:93-106` overwrites `config.compress.permission = "deny"` whenever the host has `*:deny`, even when the user has set `compress: "allow"` in `dcp.jsonc`. The mutation is sticky: subsequent `config()` calls see `"deny"` already and never re-evaluate. DPP-010 states "A later user `allow` in `dcp.jsonc` re-enables it", but the code disables the tool, unregisters slash commands, removes system-prompt injection, and removes `compress` from `experimental.primary_tools` permanently.

## Location

- `index.ts:93-106`
- (companion sticky mutation at `index.ts:98` — same root cause)

## Current vs Expected Behavior

**Current**: `config.compress.permission = "deny"` is written directly into the shared object. The `previousPermission` guard only suppresses a warn log, not the policy override.
**Expected**: Either detect an explicit user override and skip the flip, or gate downstream decisions on a locally-scoped `effectiveDenied` derived from `resolveEffectiveCompressPermission`. Do NOT mutate the shared object.

## Impact

- **Severity**: High (DPP-010 violation; disables tool despite user override)
- Runtime: tool unregistered, slash commands unregistered, system instructions omitted, `primary_tools` cleared.
- User-observable: a user with `compress: "allow"` and a host `*:deny` sees the tool gone with no path to re-enable.

## Reproduction

1. Set host `opencode.json` to `{"permission": {"*": "deny"}}`.
2. Set user `dcp.jsonc` to `{"compress": {"permission": "allow"}}`.
3. Start OpenCode. Observe: tool gone, no re-enable path.

## Suggested Fix

At `index.ts:93-106`, derive a boolean instead of mutating the shared `config` object:

```ts
config: async (opencodeConfig) => {
    const hostPermission = opencodeConfig.permission
    const previousPermission = config.compress.permission
    const effectiveDenied =
        (previousPermission !== "deny" && compressDisabledByOpencode(hostPermission)) ||
        previousPermission === "deny"

    if (previousPermission !== "deny" && effectiveDenied) {
        logger.warn("DCP: compress disabled by host permission baseline ...", { ... })
    }
    // downstream: replace every `config.compress.permission !== "deny"` with `!effectiveDenied`
}
```

Then gate `index.ts:82` (tool registration), `index.ts:108` (slash commands), `index.ts:121` (primary_tools), `index.ts:133-138` (permission injection) on `!effectiveDenied`. Hard rule satisfied: `config.compress.permission` is no longer mutated.

## Status

Fixed 2026-08-07

## Resolution

Permission check honors explicit user `compress: "allow"` before falling back to host `*:deny` (DPP-010).

## Cross-references

- Source investigator: OpenCode integration + permissions
- Source finding ID: PERM-DENY-1 (canonical, absorbs TOOL-MUT-7 sticky-state consequence)
- Validator verdict: ✅ CONFIRMED
- Doc anchor: `docs/DESIGN_PRINCIPLES.md` DPP-010, `docs/features/OPENCODE_INTEGRATION.md` Permissions, `docs/CONFIGURATION.md` Host permission baseline

## Architect Review (2026-08-07)

- **Verdict**: CONFIRMED
- **Severity**: kept High (breaks DPP-010 documented host-baseline-then-user-allow invariant)
- **Correct Fix**: derive `effectiveDenied` as a local boolean; one fewer line than the report's `let` approach.
- **Critique of report's fix**: equivalent — both express the resolution as a derived boolean.
- **Bonus**: companion to BUG-035 (first-injection gap). If BUG-035 fixes the order of `compressDisabledByOpencode` evaluation, the fix here still applies; both are siblings in the same cluster.
