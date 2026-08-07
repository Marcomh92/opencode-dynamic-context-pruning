# BUG-052: `showUpdateToasts` in `VALID_CONFIG_KEYS` but unimplemented

## Summary
`lib/config.ts:108` lists `showUpdateToasts` in `VALID_CONFIG_KEYS`. The runtime interface `PluginConfig` does not declare it. `mergeLayer` does not read it. `defaultConfig` does not set it. A user writing `{ "showUpdateToasts": true }` in `dcp.jsonc` gets no warning and no effect.

## Location
- `lib/config.ts:108`

## Current vs Expected Behavior
**Current**: Accepted as a valid key with no behavior.
**Expected**: Either remove from `VALID_CONFIG_KEYS`, or implement the field.

## Impact
- **Severity**: Low (silently ignored)
- Runtime: not affected.
- User-observable: a user expects the field to do something.

## Reproduction
```sh
grep -rn "showUpdateToasts" lib/
# Only one match — in VALID_CONFIG_KEYS.
```

## Suggested Fix
Remove from `VALID_CONFIG_KEYS` — simplest and consistent with the principle "user's dcp.jsonc is the single source of truth":
```diff
 VALID_CONFIG_KEYS = new Set([
     "$schema",
     "enabled",
     "autoUpdate",
     "debug",
-    "showUpdateToasts",
     "pruneNotification",
```
If the feature is wanted, add to `PluginConfig` interface (around `lib/config.ts:75-100`) and to `defaultConfig` (`lib/config.ts:778-790`), then wire in `mergeLayer` / `mergeCompress`.

## Status
Open

## Cross-references
- Source investigator: config + state persistence
- Source finding ID: CFG-VALIDKEYS-DRIFT-1
- Validator verdict: ✅ CONFIRMED
- Doc anchor: `docs/CONFIGURATION.md` Validation section

## Architect Review (2026-08-07)
- **Verdict**: CONFIRMED
- **Severity**: kept Low (silent acceptance of a no-op key is a docs/config drift, not a runtime bug)
- **Correct Fix**: removal is the lazy answer (Ponytail); wiring is the upgrade path.
- **Bonus**: same pattern probably exists for any future keys added to `VALID_CONFIG_KEYS` without implementing. A compile-time guard could prevent this.