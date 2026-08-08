# PERFORMANCE

Performance budgets and trade-offs. The plugin is on the hot path of every LLM call. Most of the budget is the transform hook; the compress tool is one-shot.

## Hot path

The hot path is `experimental.chat.messages.transform`. It runs once per LLM call. The work is O(n) over the visible message stream where n is the number of messages after OpenCode's own filtering.

| Phase                           | Order | Complexity               |
| ------------------------------- | ----- | ------------------------ |
| `stripHallucinations`           | 1     | O(total text bytes)      |
| `cacheSystemPromptTokens`       | 2     | O(1)                     |
| `assignMessageRefs`             | 3     | O(n)                     |
| `syncCompressionBlocks`         | 4     | O(active blocks)         |
| `syncToolCache`                 | 5     | O(n)                     |
| `buildToolIdList`               | 6     | O(n)                     |
| `prune`                         | 7     | O(n × parts per message) |
| `injectExtendedSubAgentResults` | 8     | O(subagent cache hits)   |
| `buildPriorityMap`              | 9     | O(n) (message mode only) |
| `injectCompressNudges`          | 10    | O(n)                     |
| `injectMessageIds`              | 11    | O(n)                     |
| `applyPendingManualTrigger`     | 12    | O(1)                     |
| `stripStaleMetadata`            | 13    | O(n)                     |

## Cache-aware trade-off (PER-001)

Pruning invalidates the prompt-cache prefix from the prune point forward. The README records ~85% cache hit rate with DCP versus ~90% without.

**Implication.** Pruning is not "free" token savings. Documentation and benchmarks must not claim a zero-cache cost. The number above is the published measurement; do not extrapolate.

## Token counting (PER-002)

Token counting uses `@anthropic-ai/tokenizer` with a character-count fallback in `lib/token-utils.ts`. `tiktoken` is installed in `package.json` but no source import uses it.

**Implication.** Counts are model-agnostic. The fallback is intentionally naive; the real estimate is the tokenizer's output.

## Coalesced save (PER-003)

`coalesceSaveSessionState` ensures at most one write per microtask per session ID. The transform hook fires `void coalesceSaveSessionState(...)` and continues. Direct `await saveSessionState(...)` is the strong save-on-await path.

**Implication.** A long transform does not block on disk. The cross-process race is acknowledged and is not closed in this fork.

## Compress tool (PER-004)

`compress` is O(n) over the canonical message stream for refetch and boundary resolution, then O(k) for k blocks in the batch. The tool runs once per LLM call at most.

**Implication.** The tool is not a hot path. The transform hook's overhead is the budget; the tool's overhead is amortized.

## Subagent cache (PER-005)

`subAgentResultCache` is intentionally cold. The HIT path is O(hits). A MISS is a no-op that falls back to `part.state.output`.

**Implication.** A cache miss does not stall the transform. The cost is correctness: cache misses never re-fetch.

## Manual-mode recovery (PER-006)

`recoveryForced` is set after `compress.maxContextLimitRecovery` consecutive non-compacting runs. The fade window is `compress.recoveryFadeWindow` consecutive successful manual compresses. Autonomous compresses do not count toward the fade.

**Implication.** During recovery, the model cannot autonomously compress. The user must run `/dcp-compress` enough times to clear the flag, or restart the session.

## Test-suite runtime (PER-007)

The full suite (32 files / 198 tests) completes in ~4.3 s on the test machine. `npm test` is the only test entrypoint.

**Implication.** The suite is fast enough for pre-commit. No parallel runner is required.

## Budgets (PER-008)

| Surface                         | Budget                                               |
| ------------------------------- | ---------------------------------------------------- |
| `messages.transform` wall-clock | No published budget; fast enough to not be observed. |
| `compress` tool wall-clock      | No published budget; one-shot per call.              |
| Persistence write               | One per microtask per session.                       |
| Persistence coalescer key       | One coalescer per session ID.                        |
| Schema-version gate             | One integer compare per load.                        |
| Age gate                        | One wall-clock compare per load when enabled.        |

## What is not budgeted

- LLM summarization. The plugin does not call a second LLM.
- Cache hit rate. The README's ~85% is a measurement, not a budget.
- Compress-tool success rate. The recovery protocol absorbs repeated failure; there is no SLO.
