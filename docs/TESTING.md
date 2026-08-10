# TESTING

Test philosophy, layout, and conventions. The test suite is the spec for the plugin's contract; tests are read like docs.

## Run

| Command                 | Purpose                 | Notes                                                                |
| ----------------------- | ----------------------- | -------------------------------------------------------------------- |
| `npm test`              | Run the full suite.     | `node --import tsx --test tests/*.test.ts`. ~4.3 s, 198/198 passing. |
| `npm run typecheck`     | Typecheck library code. | Excludes `tests/` by design (`tsconfig.json` `include`).             |
| `npm run format:check`  | Prettier check.         | `.prettierrc` settings.                                              |
| `npm run check:package` | Pre-publish gate.       | Builds and runs `scripts/verify-package.mjs`.                        |

`npm test` is the only test entrypoint. `tests/test-dcp-cache.sh` is a bash integration script that exercises live providers and is not part of the suite.

## Layout

| Concern                   | Test file(s)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hooks                     | `hooks-permission.test.ts`, `system-prompt-handler.test.ts`, `internal-agent-skip.test.ts`, `slash-commands.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Compress                  | `compress-message.test.ts`, `compress-range.test.ts`, `compress-range-placeholders.test.ts`, `compress-protocol.test.ts`, `compression-groups.test.ts`, `compression-targets.test.ts`, `validator-wiring.test.ts`, `decompress-prune-tools-cleanup.test.ts`, `compress-pipeline-robustness.test.ts`, `prune-tools-propagation.test.ts`                                                                                                                                                                                                                                           |
| Token math                | `token-counting.test.ts`, `token-usage.test.ts`, `prune-blockmark-symmetry.test.ts`, `prune-tools-token-count.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Messages                  | `message-utils.test.ts`, `message-ids.test.ts`, `message-priority.test.ts`, `append-idempotency.test.ts`, `message-id-capacity.test.ts`, `block-placeholder-zero.test.ts`, `parse-block-ref-zero.test.ts`, `monotonic-validation.test.ts`                                                                                                                                                                                                                                                                                                                                        |
| Config                    | `config-merge-protected-tools.test.ts`, `clampers.test.ts`, `config-schema-drift.test.ts`, `docs-config-drift.test.ts`, `type-safety.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| State                     | `state-schema-version.test.ts`, `state-max-age.test.ts`, `state-persistence-hygiene.test.ts`, `load-session-state-skips-subagents.test.ts`, `recovery-not-persisted.test.ts`, `bug-088-load-all-session-stats.test.ts`                                                                                                                                                                                                                                                                                                                                                           |
| Persistence               | `coalesce-save-session.test.ts`, `savecontext-rate-limit.test.ts`, `savecontext-rate-limit-bug002.test.ts`, `savecontext-fire-rate.test.ts`, `stats-race.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                |
| Permissions               | `host-permissions.test.ts`, `hooks-permission.test.ts`, `permission-gates.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| UI                        | `notification-header.test.ts`, `desktop-notifications.test.ts`, `prompts.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Synthetic (fork-protocol) | `synthetic-compress-burn.test.ts`, `synthetic-user-message-stability.test.ts`, `subagent-cache.test.ts`, `subagent-cache-key.test.ts`, `subagent-sdk-timeout.test.ts`, `manual-mode-consistency.test.ts`, `tool-id-list-protected.test.ts`                                                                                                                                                                                                                                                                                                                                       |
| Fork protocol             | `session-fork.test.ts`, `session-fork-inherit.test.ts`, `bug-092-fork-candidate-scan-mtime-filter.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Misc                      | `update.test.ts`, `protected-patterns.test.ts`, `dead-code-audit.test.ts`, `source-coverage-meta.test.ts`, `test-audit-trailers.test.ts`, `logger-hygiene.test.ts`, `transform-pipeline-robustness.test.ts`, `wrap-restore-roundtrip.test.ts`, `timing-helpers.test.ts`, `build-script-cross-platform.test.ts`, `bundled-prompt-hash.test.ts`, `bundled-prompt-symmetry.test.ts`, `ci-workflow-runs-npm-test.test.ts`, `format-check.test.ts`, `no-tiktoken-usage.test.ts`, `find-opencode-dir-cross-platform.test.ts`, `cross-model-metadata.test.ts`, `nitpicks-batch.test.ts` |

## Conventions

| Rule                                                                                      | Source                                                                                                             |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Bare `node:test`. No framework. No config file.                                           | AGENTS.md                                                                                                          |
| `import assert from "node:assert/strict"` and `import test from "node:test"`.             | `tests/*.test.ts`                                                                                                  |
| `afterEach(...)` only when needed; no `describe` / `before*` / `test.only` / `test.skip`. | `tests/coalesce-save-session.test.ts:21`, `tests/savecontext-rate-limit.test.ts:18`, `tests/stats-race.test.ts:26` |
| One file per concern. New tests are added after the implementation round is stable.       | AGENTS.md                                                                                                          |
| Inline `buildConfig`, `buildMessage`, `buildToolPart` helpers; no `fixtures/` dir.        | `tests/token-usage.test.ts:10`, `tests/compress-message.test.ts:20`, `tests/synthetic-compress-burn.test.ts:62`    |
| Filesystem tests redirect `XDG_DATA_HOME` and `XDG_CONFIG_HOME` into per-pid temp dirs.   | `tests/coalesce-save-session.test.ts:10-17`                                                                        |
| Audit-trail trailer for contract tests.                                                   | `tests/coalesce-save-session.test.ts:74-77`                                                                        |
| `// ponytail:` annotations on deliberately-simple helpers.                                | `tests/synthetic-compress-burn.test.ts:34-35`                                                                      |
| Issue numbers in test names for regression tests.                                         | `tests/message-priority.test.ts:542,575,622`                                                                       |

## Style

- Prefer table-style inputs over `for` loops of `test(...)`. Each row is its own test case.
- Prefer `assert.equal` / `assert.deepEqual` for primitives and structure; `assert.match` for regex.
- Each `test(...)` has a one-line `name` that names the contract. Names read like a spec.

## Coverage gaps

| Area                              | Reason                                        |
| --------------------------------- | --------------------------------------------- |
| `lib/strategies/deduplication.ts` | Indirectly covered by integration tests only. |
| `lib/strategies/purge-errors.ts`  | Indirectly covered by integration tests only. |

These are known. A new test file should be created when a future change touches the file directly.

## Adding a test

1. Match the file to the concern in the layout table.
2. Use the XDG sandbox if the test touches the filesystem.
3. Use inline builders for fixtures.
4. Add the issue number to the test name if the test is a regression.
5. Add the four-line audit trailer if the test is a contract test.
6. Do not run the new test in parallel with an active implementation round. AGENTS.md delegates new tests to a `06-test_creator` after the implementation is stable.
