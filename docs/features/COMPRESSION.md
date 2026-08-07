# COMPRESSION

The `compress` tool and the v2 fork-protocol layer. The tool's contract is the agent's interface; the fork protocol is the v2 manual/recovery state machine on top of it.

## Boundaries

| Boundary | Behavior |
|---|---|
| `compressPermission === "deny"` | Tool is not registered. |
| `state.manualMode` true | Tool is blocked by the manual-mode gate. `/dcp-compress` is the bypass. |
| Subagent session | Skipped upstream; tool is not invoked. |
| `experimental.allowSubAgents = false` | `compress` is in `experimental.primary_tools`. |

## Two tool variants

The plugin registers exactly one of:

| Variant | Argument shape | Source |
|---|---|---|
| Range mode | `{topic, content: [{startId, endId, summary}, ...]}` | `lib/compress/range.ts` |
| Message mode | `{topic, content: [{messageId, topic, summary}, ...]}` | `lib/compress/message.ts` |

Both feed `applyCompressionState` with the same `CompressionStateInput` shape; `mode` distinguishes them on the persisted block.

## Boundary reference kinds

| Kind | Format | Valid in |
|---|---|---|
| Message ref | `mNNNN` | Both modes. |
| Block ref | `bN` | Range mode only. Message mode rejects `bN` with a `block-id` soft issue. |

A `bN` ref points to a still-active compression block. A `mNNNN` ref points to a visible message. The tool resolves both to canonical message IDs.

## Block lifecycle

| State | Source |
|---|---|
| Active | Present in `state.prune.messages.activeBlockIds` and `activeByAnchorMessageId`. |
| Deactivated by user | `deactivatedByUser=true` (set by `/dcp decompress`). |
| Deactivated by another block | `deactivatedByBlockId=parentBlockId` (set when this block is consumed). |
| Deactivated by missing origin | `syncCompressionBlocks` deactivates blocks whose `compressMessageId` is no longer in the session. |

A block can be reactivated by `/dcp recompress` or by re-syncing after the origin message reappears.

## v2 protocol states

`manualMode` is a derived cache. The source of truth is `userForced` and `recoveryForced`. The reader is `effectiveManualMode(state)` in `lib/compress/pipeline.ts:46-48`.

| `userForced` | `recoveryForced` | Derived `manualMode` | Compress call |
|---|---|---|---|
| false | false | false | allowed |
| true | false | `"active"` | blocked except when `manualMode === "compress-pending"` |
| false | true | `"active"` | blocked (recovery); only manual `/dcp-compress` allowed |
| true | true | `"active"` | blocked unless pending |
| (during `/dcp-compress` execution) | — | `"compress-pending"` | allowed (transient bypass) |

`"compress-pending"` is local to the slash-command handler. See `PAT-007`.

## Block invariants

| ID | Rule | Source |
|---|---|---|
| INV-1 | New `startId` and `endId` must be strictly greater than the most recent active block's `endId`. First compress exempt. | `validateMonotonicEnd` in `lib/compress/range-utils.ts:80-110` |
| INV-2 | Batches cannot overlap. | `validateNonOverlapping` in `lib/compress/range-utils.ts:168-207` |
| INV-3 | Block ID and run ID are monotonic; reload recomputes `max(stored, max(blockId)+1)`. | `lib/compress/state.ts:8-17`, `lib/state/utils.ts:280-285` |
| INV-4 | A consumed block is deactivated, anchored, and removed from the active anchor map. | `lib/compress/state.ts:144-165` |
| INV-5 | `manualMode === "compress-pending"` is the transient bypass only. | `lib/compress/pipeline.ts:58-69, 127, 197` |
| INV-6 | Net compaction: `removedTokens > 0 && summaryTokens < removedTokens * maxCompactionRatio` increments `nonCompactingRunCount`; reaching `maxContextLimitRecovery` sets `recoveryForced`. | `lib/compress/pipeline.ts:142-172` |
| INV-7 | Recovery fade: only successful manual compresses increment `recoveryFadeCounter`; reaching `recoveryFadeWindow` clears `recoveryForced`. | `lib/compress/pipeline.ts:178-189` |
| INV-8 | `userForced` clearing: `/dcp manual off` clears; `/dcp manual on` sets and preserves `recoveryForced`; successful manual compress clears; autonomous success does not. | `lib/commands/manual.ts:64-75`, `lib/compress/pipeline.ts:132-134` |
| INV-9 | Protected-content skip: messages with an active compression entry cannot be re-appended as protected. | `lib/compress/protected-content.ts:24-27, 64-67, 119-122` |
| INV-10 | `wrapCompressedSummary(blockId, summary)` writes `[Compressed conversation section]\n<summary>\n\n`. `restoreSummary` strips the header/footer. | `lib/compress/state.ts:53-61`, `lib/compress/range-utils.ts:373-384` |
| INV-11 | Block-placeholder regex: `/\(b(\d+)\)|\{block_(\d+)\}/gi`. Validation keeps only placeholders whose block is active and in the selection's `requiredBlockIds`. | `lib/compress/range-utils.ts:13, 233-274` |
| INV-12 | `resolveSelection` requires a non-empty resolved ID set. Empty throws. | `lib/compress/search.ts:124-181` |
| INV-13 | Persisted state schema gate drops mismatched `forkSchemaVersion` files. | `lib/state/persistence.ts:312-322` |
| INV-14 | `flushPruneStats` is centralised; both `compress/state.ts` and `commands/sweep.ts` use it. | `lib/state/utils.ts:338-348` |
| INV-15 | `saveSessionState` takes `max(totalPruneTokens)` against the existing file. | `lib/state/persistence.ts:167-182` |
| INV-16 | `coalesceSaveSessionState` ensures one write per microtask per session. | `lib/state/persistence.ts:193-227` |
| INV-17 | `subAgentResultCache` is intentionally cold. | `lib/state/types.ts:135-139` |
| INV-18 | Range-mode blocks are individual `CompressionTarget`s; message-mode blocks are grouped by `runId` with the batch's `batchTopic`. | `lib/commands/compression-targets.ts` |
| INV-19 | `syncCompressionBlocks` is idempotent across re-syncs. | `lib/messages/sync.ts:32-91` |
| INV-20 | `parseBlockRef("b0")` returns null; IDs must be ≥1. | `lib/compress/state.ts` and `parseBlockRef` callers |

## Public surface

`lib/compress/index.ts` exports exactly three symbols: `ToolContext`, `createCompressMessageTool`, `createCompressRangeTool`. `index.ts` is the only production importer; tests import internals directly.

## Where to look

- Tool entry: `lib/compress/range.ts` and `lib/compress/message.ts`.
- Pipeline: `lib/compress/pipeline.ts`.
- State mutator: `lib/compress/state.ts`.
- Slash commands: `lib/commands/`.
- Block sync: `lib/messages/sync.ts`.
- ADR: `docs/DECISIONS/001-v2-fork-protocol.md`.
