# BUG-014: `autoUpdate` runtime default is `false`; README and JSON schema say `true`; no test pins the contract

## Summary

`lib/config.ts:770` sets `autoUpdate: false`. `dcp.schema.json:20` and `README.md:80` still record `true`. `docs/CONFIGURATION.md:41` documents this as "known docs drift", but no automated test asserts the runtime default. A future contributor tightening the schema or fixing the README could silently re-introduce the silent HTTPS probe that was the original bug.

## Location

- `lib/config.ts:770` (runtime: `false`)
- `dcp.schema.json:18-22` (schema: `true`)
- `README.md:80` (example block: `true`)
- `docs/CONFIGURATION.md:41` (acknowledges drift)

## Current vs Expected Behavior

**Current**: Three documents disagree; one test would close the gap but none exists.
**Expected**: Schema, README, and runtime match. The runtime default should be enforced by a unit test.

## Impact

- **Severity**: High (drift + missing test on a security-relevant surface)
- Runtime: not affected currently — the runtime is `false`.
- User-observable: a user reading the README expects auto-update to be on. The plugin silently does not auto-update. The drift is intentional but undocumented at the test layer.

## Reproduction

```sh
grep autoUpdate package.json README.md dcp.schema.json lib/config.ts tests/
# Three different answers; tests/ has zero matches.
```

## Suggested Fix

1. Canonical default is `false` (matches `MY_CHANGELOG.md:95` honesty fix and runtime).
2. Update `dcp.schema.json:18-22` — change `"default": true` → `"default": false`.
3. Update `README.md:80` — change `"autoUpdate": true` → `"autoUpdate": false`.
4. Add `tests/config-defaults.test.ts` asserting `defaultConfig.autoUpdate === false`.

## Status

Fixed 2026-08-07

## Resolution

Aligned README and `dcp.schema.json` to runtime default `autoUpdate: false`; `tests/config-defaults.test.ts` pins it.

## Cross-references

- Source investigator: tests + CI + format + deps / config + state persistence
- Source finding ID: AUTO-UPDATE-DRIFT-1 (canonical, absorbs CONFIG-DRIFT-3)
- Validator verdict: ✅ CONFIRMED
- Doc anchor: `docs/CONFIGURATION.md` Runtime defaults, `AGENTS.md` Hard rules

## Architect Review (2026-08-07)

- **Verdict**: CONFIRMED
- **Severity**: **changed High → Low-Medium**. Drift is intentional, runtime is correct, `docs/CONFIGURATION.md:41` already documents it. Schema/README correction + one-liner test is sufficient; High overstates user impact (no silent HTTPS probe fires today — `startAutoUpdate` is gated by `config.autoUpdate === true`).
- **Correct Fix**: equivalent to report; canonical = `false`.
- **Bonus**: same drift surface as BUG-052 (`showUpdateToasts` in `VALID_CONFIG_KEYS` but unimplemented); both should land in the same correction commit. `VALID_CONFIG_KEYS` in `lib/config.ts:106` lists `autoUpdate` correctly.
