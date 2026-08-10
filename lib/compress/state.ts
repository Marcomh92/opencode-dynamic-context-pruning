import type { Logger } from "../logger"
import { formatBlockRef, formatMessageIdTag } from "../message-ids"
import type { CompressionBlock, PruneMessagesState, SessionState } from "../state"
import { flushPruneStats } from "../state/utils"
import type { AppliedCompressionResult, CompressionStateInput, SelectionResolution } from "./types"

export const COMPRESSED_BLOCK_HEADER = "[Compressed conversation section]"

export function allocateBlockId(state: SessionState): number {
    const next = state.prune.messages.nextBlockId
    if (!Number.isInteger(next) || next < 1) {
        state.prune.messages.nextBlockId = 2
        return 1
    }

    state.prune.messages.nextBlockId = next + 1
    return next
}

export function allocateRunId(state: SessionState): number {
    const next = state.prune.messages.nextRunId
    if (!Number.isInteger(next) || next < 1) {
        state.prune.messages.nextRunId = 2
        return 1
    }

    state.prune.messages.nextRunId = next + 1
    return next
}

export function attachCompressionDuration(
    messagesState: PruneMessagesState,
    messageId: string,
    callId: string,
    durationMs: number,
): number {
    if (typeof durationMs !== "number" || !Number.isFinite(durationMs)) {
        return 0
    }

    let updates = 0
    for (const block of messagesState.blocksById.values()) {
        if (block.compressMessageId !== messageId || block.compressCallId !== callId) {
            continue
        }

        block.durationMs = durationMs
        updates++
    }

    return updates
}

export function wrapCompressedSummary(blockId: number, summary: string): string {
    const header = COMPRESSED_BLOCK_HEADER
    const footer = formatMessageIdTag(formatBlockRef(blockId))
    const body = summary.trim()
    if (body.length === 0) {
        return `${header}\n${footer}`
    }
    return `${header}\n${body}\n\n${footer}`
}

export function applyCompressionState(
    state: SessionState,
    input: CompressionStateInput,
    selection: SelectionResolution,
    anchorMessageId: string,
    blockId: number,
    summary: string,
    consumedBlockIds: number[],
): AppliedCompressionResult {
    const messagesState = state.prune.messages
    const consumed = [...new Set(consumedBlockIds.filter((id) => Number.isInteger(id) && id > 0))]
    const included = [...consumed]

    const effectiveMessageIds = new Set<string>(selection.messageIds)
    const effectiveToolIds = new Set<string>(selection.toolIds)

    for (const consumedBlockId of consumed) {
        const consumedBlock = messagesState.blocksById.get(consumedBlockId)
        if (!consumedBlock) {
            continue
        }
        for (const messageId of consumedBlock.effectiveMessageIds) {
            effectiveMessageIds.add(messageId)
        }
        for (const toolId of consumedBlock.effectiveToolIds) {
            effectiveToolIds.add(toolId)
        }
    }

    const initiallyActiveMessages = new Set<string>()
    for (const messageId of effectiveMessageIds) {
        const entry = messagesState.byMessageId.get(messageId)
        if (entry && entry.activeBlockIds.length > 0) {
            initiallyActiveMessages.add(messageId)
        }
    }

    const initiallyActiveToolIds = new Set<string>()
    for (const activeBlockId of messagesState.activeBlockIds) {
        const activeBlock = messagesState.blocksById.get(activeBlockId)
        if (!activeBlock || !activeBlock.active) {
            continue
        }

        for (const toolId of activeBlock.effectiveToolIds) {
            initiallyActiveToolIds.add(toolId)
        }
    }

    const createdAt = Date.now()
    const block: CompressionBlock = {
        blockId,
        runId: input.runId,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 0,
        summaryTokens: input.summaryTokens,
        durationMs: 0,
        mode: input.mode,
        topic: input.topic,
        batchTopic: input.batchTopic,
        startId: input.startId,
        endId: input.endId,
        anchorMessageId,
        compressMessageId: input.compressMessageId,
        compressCallId: input.compressCallId,
        includedBlockIds: included,
        consumedBlockIds: consumed,
        parentBlockIds: [],
        directMessageIds: [],
        directToolIds: [],
        effectiveMessageIds: [...effectiveMessageIds],
        effectiveToolIds: [...effectiveToolIds],
        startTime: input.startTime ?? 0,
        endTime: input.endTime ?? 0,
        effectiveTimeMs: input.effectiveTimeMs ?? [],
        directTimeMs: input.directTimeMs ?? [],
        anchorTime: input.anchorTime ?? 0,
        compressTime: input.compressTime ?? 0,
        createdAt,
        summary,
    }

    messagesState.blocksById.set(blockId, block)
    messagesState.activeBlockIds.add(blockId)
    messagesState.activeByAnchorMessageId.set(anchorMessageId, blockId)

    const deactivatedAt = Date.now()
    for (const consumedBlockId of consumed) {
        const consumedBlock = messagesState.blocksById.get(consumedBlockId)
        if (!consumedBlock || !consumedBlock.active) {
            continue
        }

        consumedBlock.active = false
        consumedBlock.deactivatedAt = deactivatedAt
        consumedBlock.deactivatedByBlockId = blockId
        if (!consumedBlock.parentBlockIds.includes(blockId)) {
            consumedBlock.parentBlockIds.push(blockId)
        }

        messagesState.activeBlockIds.delete(consumedBlockId)
        const mappedBlockId = messagesState.activeByAnchorMessageId.get(
            consumedBlock.anchorMessageId,
        )
        if (mappedBlockId === consumedBlockId) {
            messagesState.activeByAnchorMessageId.delete(consumedBlock.anchorMessageId)
        }
    }

    const removeActiveBlockId = (
        entry: { activeBlockIds: number[] },
        blockIdToRemove: number,
    ): void => {
        if (entry.activeBlockIds.length === 0) {
            return
        }
        entry.activeBlockIds = entry.activeBlockIds.filter((id) => id !== blockIdToRemove)
    }

    for (const consumedBlockId of consumed) {
        const consumedBlock = messagesState.blocksById.get(consumedBlockId)
        if (!consumedBlock) {
            continue
        }
        for (const messageId of consumedBlock.effectiveMessageIds) {
            const entry = messagesState.byMessageId.get(messageId)
            if (!entry) {
                continue
            }
            removeActiveBlockId(entry, consumedBlockId)
        }
    }

    for (const messageId of selection.messageIds) {
        const tokenCount = selection.messageTokenById.get(messageId) || 0
        const existing = messagesState.byMessageId.get(messageId)

        if (!existing) {
            messagesState.byMessageId.set(messageId, {
                tokenCount,
                allBlockIds: [blockId],
                activeBlockIds: [blockId],
            })
            continue
        }

        existing.tokenCount = Math.max(existing.tokenCount, tokenCount)
        if (!existing.allBlockIds.includes(blockId)) {
            existing.allBlockIds.push(blockId)
        }
        if (!existing.activeBlockIds.includes(blockId)) {
            existing.activeBlockIds.push(blockId)
        }
    }

    for (const messageId of block.effectiveMessageIds) {
        if (selection.messageTokenById.has(messageId)) {
            continue
        }

        const existing = messagesState.byMessageId.get(messageId)
        if (!existing) {
            continue
        }
        if (!existing.allBlockIds.includes(blockId)) {
            existing.allBlockIds.push(blockId)
        }
        if (!existing.activeBlockIds.includes(blockId)) {
            existing.activeBlockIds.push(blockId)
        }
    }

    let compressedTokens = 0
    const newlyCompressedMessageIds: string[] = []
    for (const messageId of effectiveMessageIds) {
        const entry = messagesState.byMessageId.get(messageId)
        if (!entry) {
            continue
        }

        const isNowActive = entry.activeBlockIds.length > 0
        const wasActive = initiallyActiveMessages.has(messageId)

        if (isNowActive && !wasActive) {
            compressedTokens += entry.tokenCount
            newlyCompressedMessageIds.push(messageId)
        }
    }

    const newlyCompressedToolIds: string[] = []
    for (const toolId of effectiveToolIds) {
        if (!initiallyActiveToolIds.has(toolId)) {
            newlyCompressedToolIds.push(toolId)
        }
    }

    block.directMessageIds = [...newlyCompressedMessageIds]
    block.directToolIds = [...newlyCompressedToolIds]

    block.compressedTokens = compressedTokens

    // M2.5c Fix 3 — prune.tools propagation. Block records which tool parts
    // it newly covered via directToolIds; without propagating those into
    // state.prune.tools, the next transform's pruneToolOutputs early-returns
    // for these IDs (see lib/messages/prune.ts:84). Whole compressed messages
    // are already filtered by filterCompressedRanges so this is purely
    // defensive — it matters only for tools referenced from non-compressed
    // messages (e.g. a single tool part surviving outside the compressed
    // range whose callID also appears in the block's direct set).
    for (const toolId of newlyCompressedToolIds) {
        if (state.prune.tools.has(toolId)) {
            continue
        }
        const tokenCount = state.toolParameters.get(toolId)?.tokenCount ?? 0
        state.prune.tools.set(toolId, tokenCount)
    }

    state.stats.pruneTokenCounter += compressedTokens
    // M2.5c Fix 2 — centralised flush. The previous inline
    // `totalPruneTokens += pruneTokenCounter; counter = 0` could
    // double-count when counter had been pre-flushed by a sibling writer.
    flushPruneStats(state.stats)

    return {
        compressedTokens,
        messageIds: selection.messageIds,
        newlyCompressedMessageIds,
        newlyCompressedToolIds,
    }
}

/**
 * Merges compression blocks inherited from a forked parent session into
 * `state`. Per DPP-006 / PAT-002 this is the third sanctioned writer of
 * `state.prune.messages.*` (next to `applyCompressionState` and
 * `syncCompressionBlocks`); ADR-003 records the amendment. Upholds the
 * invariants `applyCompressionState` does:
 *
 * - Monotonic block / run IDs (no `+1`; the allocator returns and increments).
 * - Anchor index consistency (`activeByAnchorMessageId` populated only when
 *   `anchorMessageId !== ""`).
 * - Block-graph closure assumed — `filterInheritableBlocks` (Stage A-2) drops
 *   any block referencing a non-inheritable sibling before this is called.
 * - `byMessageId` rebuild from each block's `effectiveMessageIds`.
 *
 * `parentSessionId` is accepted for the agreed-upon signature; the
 * in-memory `state.inheritedFrom` is set separately by `lib/state/inherit.ts`.
 */
export function mergeInheritedBlocks(
    state: SessionState,
    blocks: CompressionBlock[],
    parentSessionId: string,
    logger?: Logger,
): void {
    const pm = state.prune.messages

    let parentMaxBlockId = 0
    let parentMaxRunId = 0
    for (const b of blocks) {
        if (b.blockId > parentMaxBlockId) parentMaxBlockId = b.blockId
        if (b.runId > parentMaxRunId) parentMaxRunId = b.runId
    }
    // ponytail: nextBlockId is NEXT-FREE (allocateBlockId returns then increments).
    // mirror loadPruneMessagesState:382-387 which uses `blockId + 1`.
    if (parentMaxBlockId >= pm.nextBlockId) pm.nextBlockId = parentMaxBlockId + 1
    if (parentMaxRunId >= pm.nextRunId) pm.nextRunId = parentMaxRunId + 1

    let duplicateSkips = 0
    for (const block of blocks) {
        if (pm.blocksById.has(block.blockId)) {
            // Defensive: a duplicate blockId should not happen because
            // rekeyBlocksToFork produces unique IDs. Skip rather than overwrite.
            duplicateSkips++
            continue
        }

        pm.blocksById.set(block.blockId, block)
        if (block.active) {
            pm.activeBlockIds.add(block.blockId)
            if (block.anchorMessageId !== "") {
                pm.activeByAnchorMessageId.set(block.anchorMessageId, block.blockId)
            }
        }

        if (!block.active) {
            continue
        }

        // Rebuild byMessageId entries from effectiveMessageIds. The pattern
        // mirrors applyCompressionState :191-228. Per-message tokenCount is
        // not available from the persisted parent file; we approximate by
        // distributing the block's compressedTokens evenly across its
        // effective messages.
        //
        // ponytail: tokenCount per message is approximated. Subsequent prunes
        // on B will re-derive correct token counts via state.toolParameters
        // (see lib/messages/prune.ts). Add per-message tokenCount persistence
        // when BUG-XXX lands.
        const perMessageTokens =
            block.effectiveMessageIds.length > 0
                ? Math.floor(block.compressedTokens / block.effectiveMessageIds.length)
                : 0

        for (const messageId of block.effectiveMessageIds) {
            const existing = pm.byMessageId.get(messageId)
            if (existing) {
                if (!existing.allBlockIds.includes(block.blockId)) {
                    existing.allBlockIds.push(block.blockId)
                }
                if (!existing.activeBlockIds.includes(block.blockId)) {
                    existing.activeBlockIds.push(block.blockId)
                }
                if (perMessageTokens > existing.tokenCount) {
                    existing.tokenCount = perMessageTokens
                }
                continue
            }
            pm.byMessageId.set(messageId, {
                tokenCount: perMessageTokens,
                allBlockIds: [block.blockId],
                activeBlockIds: [block.blockId],
            })
        }
    }

    // ponytail: prune.tools is NOT updated here. The rebuild path at
    // syncPruneToolsFromActiveBlocks (lib/state/utils.ts) still runs on
    // subsequent prunes (defensive). Inherited blocks' directToolIds are the
    // source of truth — copying prune.tools verbatim is the responsibility of
    // lib/state/inherit.ts, not this funnel.
    if (logger && duplicateSkips > 0) {
        logger.debug(
            `fork inheritance: skipped ${duplicateSkips} duplicate block(s) during merge (parent ${parentSessionId})`,
        )
    }
}
