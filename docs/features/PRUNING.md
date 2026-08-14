# PRUNING

The transform hook's pipeline that replaces obsolete tool outputs with synthetic summaries. Pruning is logical: only `output.messages` is mutated. See `lib/messages/` and `lib/strategies/`.

## Pipeline order

`experimental.chat.messages.transform` runs in this exact order (`lib/hooks.ts:248-281`):

1. `stripHallucinations`
2. `stripPatterns` (config-driven; see INV-P7 note below)
3. `cacheSystemPromptTokens`
4. `assignMessageRefs`
5. `syncCompressionBlocks`
6. `syncToolCache`
7. `buildToolIdList`
8. `prune`
9. `injectExtendedSubAgentResults`
10. `buildPriorityMap`
11. `injectCompressNudges`
12. `injectMessageIds`
13. `applyPendingManualTrigger`
14. `stripStaleMetadata`

Strategies (`deduplicate`, `purgeErrors`) run only inside the `compress` tool pipeline (`lib/compress/pipeline.ts:94-95`), not in the transform hook.

## Prune behavior

| Behavior                                    | Trigger                                                                                 | Source                                                       |
| ------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Replace `state.prune.tools` tool outputs    | `state.prune.tools.has(callID)` ∧ status `completed` ∧ tool ∉ `{question, edit, write}` | `lib/messages/prune.ts:73-97`                                |
| Replace `question` tool inputs              | tool `question`, status `completed`                                                     | `lib/messages/prune.ts:99-126`                               |
| Replace errored tool inputs (string fields) | status `error`, any string input key                                                    | `lib/messages/prune.ts:128-157`                              |
| Whole-message removal (compressed ranges)   | `pruneEntry.activeBlockIds.length > 0`                                                  | `lib/messages/prune.ts:159-233`                              |
| Synthetic summary injection at anchor       | `activeByAnchorMessageId` hit, summary well-formed                                      | `lib/messages/prune.ts:178-218`                              |
| `replaceBlockIdsWithBlocked` rewrite        | only when `config.compress.mode === "message"`                                          | `lib/messages/prune.ts:201`, `lib/messages/utils.ts:183-185` |
| Duplicate tool marking                      | same `(tool, normalized-params)` signature ≥2 occurrences; keep last                    | `lib/strategies/deduplication.ts:16-94`                      |
| Old-error tool marking                      | `metadata.status === "error"` ∧ `currentTurn − metadata.turn ≥ turns`                   | `lib/strategies/purge-errors.ts:19-88`                       |
| Subagent result extension                   | cache hit only (no fetch on miss)                                                       | `lib/messages/inject/subagent-results.ts:23-64`              |

Replacement strings are module-locals at `lib/messages/prune.ts:9-12`.

## Invariants

| ID      | Rule                                                                                                                                                                                            | Source                                                                    |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| INV-P1  | `prune` opens every pass with `if (isMessageCompacted(state, msg)) continue`.                                                                                                                   | `lib/messages/prune.ts:30-32, 75-77, 101-103, 130-132`                    |
| INV-P2  | `createSyntheticUserMessage` always sets `time.created = 0`. Documented caveat: a synthetic can be flagged compacted after a real compaction.                                                   | `lib/messages/utils.ts:33-48`                                             |
| INV-P3  | Synthetic IDs are SHA-256 of `seed` truncated to 16 hex chars.                                                                                                                                  | `lib/messages/utils.ts:11-14`                                             |
| INV-P4  | `appendToTextPart` / `appendToToolPart` use `endsWith()` to suppress re-append. Earlier occurrences are re-appended.                                                                            | `lib/messages/utils.ts:120-122, 144-146`                                  |
| INV-P5  | `deduplicate` / `purgeErrors` early-return when `state.toolIdList.length === 0`.                                                                                                                | `lib/strategies/deduplication.ts:31`, `lib/strategies/purge-errors.ts:35` |
| INV-P6  | `buildPriorityMap` returns an empty Map when `config.compress.mode !== "message"`.                                                                                                              | `lib/messages/priority.ts:25-27`                                          |
| INV-P7  | `isMessageCompacted` and `isIgnoredUserMessage` are the only "skip" gates. `isIgnoredUserMessage` also treats text parts with `part.synthetic: true` as ignored (twin of `part.ignored: true`). | `lib/state/utils.ts:12-25`, `lib/messages/query.ts:38-63`                 |
| INV-P8  | Subagent injection is cache-only; fetch on miss is removed (M4).                                                                                                                                | `lib/messages/inject/subagent-results.ts:18-22`                           |
| INV-P9  | `syncPruneToolsFromActiveBlocks` rebuilds `state.prune.tools` from active blocks' `directToolIds`.                                                                                              | `lib/state/utils.ts:365-382`                                              |
| INV-P10 | `addAnchor` requires `anchorIndex − latestAnchorIndex ≥ interval`.                                                                                                                              | `lib/messages/inject/utils.ts:165-193`                                    |
| INV-P11 | `getNudgeFrequency` and `getIterationNudgeThreshold` clamp to `≥1`.                                                                                                                             | `lib/messages/inject/utils.ts:37-43`                                      |
| INV-P12 | Range-mode nudges skip empty / pending-only assistants.                                                                                                                                         | `lib/messages/inject/utils.ts:228-247`                                    |
| INV-P13 | Priority map dedup key is `ref`, not `rawMessageId`.                                                                                                                                            | `lib/messages/priority.ts:82-99`                                          |

`stripPatterns` (pipeline step 2) is **not** a skip gate — it runs after the skip gates have already accepted the message and mutates `part.text` / completed `state.output` in place. It complements the BUG-094 protect-gate fix: the flag-level fix removes a synthetic message from the protected-text section, while `stripPatterns` removes a synthetic block from the LLM-bound context entirely (so it cannot reach a compression summary via any path). See `docs/CONFIGURATION.md` "Strip patterns" for the block-name / literal-substring semantics.

## Boundaries

| Boundary                                     | Behavior                                                                                                      |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `compressPermission === "deny"`              | Both nudge and id-injection bail.                                                                             |
| `state.manualMode` true                      | Nudges off. Strategies honor `config.manualMode.automaticStrategies`.                                         |
| Subagent session                             | Skipped upstream.                                                                                             |
| Empty / malformed summary                    | `logger.warn` and skip; no synthetic inserted.                                                                |
| Unknown `rawMessageId`                       | Skipped; no priority entry.                                                                                   |
| `purgeErrors.turns` < 1                      | Validator warns; `Math.max(1, …)` clamps at runtime.                                                          |
| `nudgeFrequency` / `iterationNudgeThreshold` | Clamped to `≥1`.                                                                                              |
| `compress.summaryBuffer` falsy               | `getActiveSummaryTokenUsage` returns undefined.                                                               |
| Max/min context limit resolution             | Per-model override → global; `number` or `${number}%`; undefined `modelContextLimit` skips percentage branch. |

## Dependencies

| Module                                    | Depends on                                                                                                                                                                                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `lib/messages/prune.ts`                   | `state/utils.isMessageCompacted`, `messages/query.getLastUserMessage`, `messages/utils.*`, `@opencode-ai/sdk/v2` `UserMessage`                                                                                                 |
| `lib/messages/priority.ts`                | `token-utils.countAllMessageTokens`, `state/utils.isMessageCompacted`, `messages/query.*`                                                                                                                                      |
| `lib/messages/sync.ts`                    | `state.SessionState`, `logger.Logger` only                                                                                                                                                                                     |
| `lib/messages/inject/inject.ts`           | `message-ids.formatMessageIdTag`, `compress-permission.compressPermission`, `state/persistence.coalesceSaveSessionState`, `messages/query.*`, `messages/utils.*`, `prompts/store.RuntimePrompts`, `prompts/extensions/nudge.*` |
| `lib/messages/inject/utils.ts`            | `token-utils.getCurrentTokenUsage`, `state/utils.getActiveSummaryTokenUsage`, `messages/priority.*`, `messages/utils.*`, `messages/query.*`                                                                                    |
| `lib/messages/inject/subagent-results.ts` | `subagents/subagent-results.mergeSubagentResult`, `subagents/cache-key.buildSubAgentCacheKey`, `messages/utils.stripHallucinationsFromString`                                                                                  |
| `lib/strategies/deduplication.ts`         | `protected-patterns.*`, `token-utils.getTotalToolTokens`                                                                                                                                                                       |
| `lib/strategies/purge-errors.ts`          | `protected-patterns.*`, `state.currentTurn` / `state.toolParameters`                                                                                                                                                           |

## Conventions

- In-place mutation is the norm for `messages` arrays. `prune`, `filterMessagesInPlace`, `stripHallucinations`, and `stripStaleMetadata` all mutate length. `stripPatterns` mutates `part.text` / `state.output` fields without changing array length. Callers must accept array identity change.
- `part.state.output` is mutated directly by `pruneToolOutputs` and `injectExtendedSubAgentResults`, never both on the same part: the latter `continue`s if `state.prune.tools.has(callID)`.
- The `protectedTools` default is `[]` in the v2 fork. Feature owners must opt in. See `DPP-007`.
- Ponytail markers: `lib/messages/inject/subagent-results.ts:20-22` documents the removed fetch as a deliberate simplification; `lib/messages/utils.ts:33-47` documents the `time.created = 0` sentinel with its caveat.

## Test coverage

| Concern                                                                                                        | Test file                                        |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Synthetic-message byte-stability, `time.created === 0` sentinel                                                | `tests/synthetic-user-message-stability.test.ts` |
| Append idempotency (exact tail vs non-tail re-append)                                                          | `tests/append-idempotency.test.ts`               |
| Message priority / ID injection / range+message mode nudge placement (incl. issue #463 empty-assistant)        | `tests/message-priority.test.ts`                 |
| `isIgnoredUserMessage` semantics                                                                               | `tests/message-utils.test.ts`                    |
| Block-ID `BLOCKED` rewrite under message mode                                                                  | `tests/message-priority.test.ts`                 |
| Hallucination stripping regex coverage                                                                         | `tests/message-priority.test.ts`                 |
| `stripPatterns` block-name + literal-substring modes, idempotency, skip semantics for pending/non-string parts | `tests/strip-patterns.test.ts`                   |
| Compress block → `prune.tools` propagation                                                                     | `tests/prune-tools-propagation.test.ts`          |
| Decompress → prune.tools cleanup regression                                                                    | `tests/decompress-prune-tools-cleanup.test.ts`   |
| Subagent cache injection (no fetch)                                                                            | `tests/subagent-cache.test.ts`                   |
| Synthetic compress burn                                                                                        | `tests/synthetic-compress-burn.test.ts`          |
| Protected patterns (tool name globs, file path globs, multiedit/apply_patch)                                   | `tests/protected-patterns.test.ts`               |

`lib/strategies/deduplication.ts` and `lib/strategies/purge-errors.ts` are only covered indirectly. See `docs/TESTING.md` "Coverage gaps".
