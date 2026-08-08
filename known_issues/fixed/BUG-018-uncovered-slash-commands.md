# BUG-018: 5 slash-command handlers have no direct test coverage

## Summary

`handleSweepCommand`, `handleContextCommand`, `handleHelpCommand`, `handleStatsCommand`, and `handleManualToggleCommand` are not imported by any test file. The user-facing commands are exercised only indirectly via integration tests, if at all. `sweep.ts` has the most non-trivial logic — `numArg` parsing, protected-tool filtering, save race — and is exactly the kind of helper that drifts silently.

## Location

- `lib/commands/sweep.ts:130` (`handleSweepCommand`)
- `lib/commands/context.ts:296` (`handleContextCommand`)
- `lib/commands/help.ts:66` (`handleHelpCommand`)
- `lib/commands/stats.ts:106` (`handleStatsCommand`)
- `lib/commands/manual.ts:58` (`handleManualToggleCommand`)
- Companion: `formatSweepMessage`, `analyzeContextTokens`, `formatHelpMessage`, `formatStatsMessage`, `handleManualTriggerCommand` are also untested

## Current vs Expected Behavior

**Current**: Grep for these names in `tests/*.test.ts` returns zero matches.
**Expected**: PAT-010 (one-file-per-concern) implies one test file per command handler.

## Impact

- **Severity**: High (user-facing surface untested; regressions slip in silently)
- Runtime: not affected directly.
- User-observable: command output changes without any test catching it.

## Reproduction

```sh
grep -l "handleSweepCommand\|handleHelpCommand\|handleStatsCommand\|handleManualToggleCommand\|handleContextCommand" tests/*.test.ts
# No matches.
```

## Suggested Fix

Add table-driven tests for each. Ponytail-friendly minimum:

- `tests/sweep.test.ts` — pin `numArg` parsing, protected-tool filtering, save-race (one entry).
- `tests/context.test.ts` — pin `formatContextMessage` output against a fixture.
- `tests/help.test.ts` — pin `formatHelpMessage` against `compressPermission` matrix.
- `tests/stats.test.ts` — pin `formatStatsMessage` against a fixture with `recoveryForced=true`/`false`.
- `tests/manual-toggle.test.ts` — pin the three branches (on/off/toggle), confirm `effectiveManualMode` consistency (closes BUG-024 too).

## Status

Fixed 2026-08-07

## Resolution

Added direct test coverage for all 5 slash-command handlers (`tests/sweep.test.ts`, `tests/context.test.ts`, `tests/help.test.ts`, `tests/stats.test.ts`, `tests/manual-toggle.test.ts`).

## Cross-references

- Source investigator: tests + CI + format + deps
- Source finding ID: COV-COMMAND-1
- Validator verdict: ✅ CONFIRMED
- Doc anchor: `docs/TESTING.md` Layout, `docs/PATTERNS.md` PAT-010

## Architect Review (2026-08-07)

- **Verdict**: CONFIRMED
- **Severity**: kept High (user-facing command surface silently changes if these drift; sweep `numArg` parser is load-bearing)
- **Correct Fix**: equivalent to report; one-test-per-branch pattern. The `manual-toggle.test.ts` naturally closes BUG-024.
- **Bonus**: BUG-046 (`logger-maps-unbounded`) and BUG-027 (`tool-cache-log-spam`) intersect here — sweep.ts emits per-tool `logger.info` metadata that could grow.
