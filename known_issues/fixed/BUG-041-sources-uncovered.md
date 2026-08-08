# BUG-041: Multiple source files have no direct test coverage

## Summary

The audit identified a taxonomy of source files with no dedicated `*.test.ts`:

| Source file                         | Status                                  |
| ----------------------------------- | --------------------------------------- |
| `lib/auth.ts`                       | not exercised                           |
| `lib/commands/help.ts`              | no test                                 |
| `lib/commands/manual.ts`            | no test for `handleManualToggleCommand` |
| `lib/commands/sweep.ts`             | no test for `handleSweepCommand`        |
| `lib/compress/protected-content.ts` | partial only                            |
| `lib/compress/search.ts`            | partial only                            |
| `lib/compress/timing.ts`            | no dedicated test (covered by BUG-022)  |
| `lib/host-permissions.ts`           | not exercised                           |
| `lib/messages/inject/inject.ts`     | partial (in `message-priority.test.ts`) |
| `lib/messages/query.ts`             | partial                                 |
| `lib/messages/reasoning-strip.ts`   | not exercised                           |
| `lib/messages/shape.ts`             | not exercised                           |
| `lib/messages/sync.ts`              | partial only                            |
| `lib/prompts/store.ts`              | partial (`prompts.test.ts`)             |
| `lib/state/persistence.ts`          | partial (3 test files)                  |
| `lib/state/tool-cache.ts`           | not exercised                           |
| `lib/subagents/cache-key.ts`        | not exercised                           |
| `lib/subagents/subagent-results.ts` | partial                                 |
| `lib/update.ts`                     | partial (`update.test.ts`)              |

## Location

See table above.

## Current vs Expected Behavior

**Current**: Multiple source files rely on indirect coverage via integration tests.
**Expected**: PAT-010 dictates source-mirrored test layout.

## Impact

- **Severity**: Medium (test taxonomy gap)
- Runtime: not affected.
- User-observable: regression risk on each of these surfaces.

## Reproduction

Compare `Get-ChildItem lib/**/*.ts` to `Get-ChildItem tests/*.test.ts` and find source files without a matching test.

## Suggested Fix

Drop the two false rows (`lib/host-permissions.ts` IS tested in `tests/host-permissions.test.ts:7` with 9 tests; `lib/subagents/cache-key.ts` IS tested in `tests/subagent-cache.test.ts:8`). Re-scope priority to `lib/auth.ts` and `lib/state/tool-cache.ts` (security/correctness surface). Per AGENTS.md, new tests go to `06-test_creator` after the implementation round is stable.

## Status

Fixed 2026-08-07

## Resolution

Added direct test coverage for `lib/auth.ts`, `lib/state/tool-cache.ts`, `lib/messages/reasoning-strip.ts`, `lib/messages/shape.ts` (priority table corrected per architect).

## Cross-references

- Source investigator: tests + CI + format + deps
- Source finding ID: SOURCES-UNCOVERED-1
- Validator verdict: ✅ CONFIRMED
- Doc anchor: `docs/TESTING.md` Layout, `docs/PATTERNS.md` PAT-010

## Architect Review (2026-08-07)

- **Verdict**: PARTIAL — two of the four "priority" rows are factually wrong
- **Severity**: **changed Medium → Low** (after correcting the table)
- **Critique of report's fix**: the doc anchor is misquoted — "PAT-010 dictates source-mirrored test layout" is wrong; `docs/PATTERNS.md:76-78` says "One-file-per-concern tests … one file per source **concern**", not 1:1 source-to-test mirror. The report's "Expected" bar is stricter than the project's actual convention.
- **Bonus**: correct rows (no direct import, no symbol reference): `lib/auth.ts`, `lib/state/tool-cache.ts`, `lib/messages/reasoning-strip.ts`, `lib/messages/shape.ts`, `lib/commands/{help,manual,sweep}.ts`, `lib/compress/timing.ts`.
