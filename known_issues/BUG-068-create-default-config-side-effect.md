# BUG-068: `createDefaultConfig()` writes `dcp.jsonc` to disk unprompted on first run

## Summary
When no global config exists, the plugin silently writes `$XDG_CONFIG_HOME/opencode/dcp.jsonc` containing only the `$schema` reference. This is a side-effect at plugin init the user did not opt into; if a user intentionally removes their config to fall back to defaults, the file is recreated on the next plugin load. No notification is shown.

## Location
- `lib/config.ts:885-895`
- `lib/config.ts:1119-1121` (caller)

## Current vs Expected Behavior
**Current**: First run creates `dcp.jsonc` unprompted.
**Expected**: Skip file creation when the global config dir does not exist; let users opt in by creating the file themselves.

## Impact
- **Severity**: Nitpick (intentional first-run side effect)
- Runtime: not affected.
- User-observable: a user clearing config gets it recreated.

## Reproduction
Delete `$XDG_CONFIG_HOME/opencode/dcp.jsonc`, restart OpenCode. Observe: file recreated.

## Suggested Fix
Option A (minimal): delete the `if (!configPaths.global) createDefaultConfig()` block at `lib/config.ts:1119-1121`. First-run users see defaults only.
Option B (preserve intent, add signal): keep the write but emit `logger.info("Created default dcp.jsonc at ...")`.

Ponytail: option A is correct under the hard rule "no unrequested side-effects at plugin init."

## Status
Open

## Cross-references
- Source investigator: OpenCode integration + permissions
- Source finding ID: CREATE-DEFAULT-13
- Validator verdict: ✅ CONFIRMED (real but intentional)
- Doc anchor: None

## Architect Review (2026-08-07)
- **Verdict**: CONFIRMED
- **Severity**: kept Nitpick (intentional behavior, no data loss)
- **Bonus**: if kept, document in `docs/CONFIGURATION.md` under the config-loading section.