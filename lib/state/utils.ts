import type {
    CompressionBlock,
    PruneMessagesState,
    PrunedMessageEntry,
    SessionState,
    WithParts,
} from "./types"
import { isIgnoredUserMessage, messageHasCompress } from "../messages/query"
import { isMessageWithInfo } from "../messages/shape"
import { countTokens } from "../token-utils"

export const isMessageCompacted = (state: SessionState, msg: WithParts): boolean => {
    if (!isMessageWithInfo(msg)) {
        return false
    }

    if (msg.info.time.created < state.lastCompaction) {
        return true
    }
    const pruneEntry = state.prune.messages.byMessageId.get(msg.info.id)
    if (pruneEntry && pruneEntry.activeBlockIds.length > 0) {
        return true
    }
    return false
}

interface PersistedPruneMessagesState {
    byMessageId: Record<string, PrunedMessageEntry>
    blocksById: Record<string, CompressionBlock>
    activeBlockIds: number[]
    activeByAnchorMessageId: Record<string, number>
    nextBlockId: number
    nextRunId: number
}

export function serializePruneMessagesState(
    messagesState: PruneMessagesState,
): PersistedPruneMessagesState {
    return {
        byMessageId: Object.fromEntries(messagesState.byMessageId),
        blocksById: Object.fromEntries(
            Array.from(messagesState.blocksById.entries()).map(([blockId, block]) => [
                String(blockId),
                block,
            ]),
        ),
        activeBlockIds: Array.from(messagesState.activeBlockIds),
        activeByAnchorMessageId: Object.fromEntries(messagesState.activeByAnchorMessageId),
        nextBlockId: messagesState.nextBlockId,
        nextRunId: messagesState.nextRunId,
    }
}

/** Determines whether a session has a parent subagent session, bounded by the SDK timeout. */
export async function isSubAgentSession(client: any, sessionID: string): Promise<boolean> {
    try {
        const result = await client.session.get({
            path: { id: sessionID },
            signal: AbortSignal.timeout(2000),
        })
        return !!result.data?.parentID
    } catch (error: any) {
        return false
    }
}

/**
 * Detects whether a session title indicates it was forked from another session
 * via the OpenCode UI fork action. Matches the upstream server's
 * `getForkedTitle` regex `/^(.+) \(fork #(\d+)\)$/`.
 *
 * This is the ONLY in-band signal we have today — the OpenCode SDK does not
 * expose a `forkedFrom` field on `Session`. A user-renamed title defeats
 * detection (graceful: returns `isForked: false`). Missing / non-string titles
 * also return `isForked: false` — no throw, no crash.
 *
 * The signature is the REPLACEABLE contract: when OpenCode SDK exposes a real
 * `forkedFrom` field (upstream issue tracked separately), the regex logic
 * behind this signature swaps for a 2-line SDK call without any caller change.
 * See known_issues/BUG-087 and docs/DECISIONS/002-compression-state-is-session-scoped.md.
 *
 * ponytail: title-pattern detection is fragile (user can rename). When swapped
 * for upstream forkedFrom, the regex logic becomes a 2-line SDK call.
 */
export function detectParentSessionFromTitle(title: string | undefined | null): {
    isForked: boolean
    parentTitle?: string
    forkNumber?: number
} {
    if (typeof title !== "string" || title.length === 0) {
        return { isForked: false }
    }
    const match = /^(.+) \(fork #(\d+)\)$/.exec(title)
    if (match === null) {
        return { isForked: false }
    }
    const parentTitle = match[1]
    const forkNumber = Number.parseInt(match[2], 10)
    if (!Number.isFinite(forkNumber)) {
        return { isForked: false }
    }
    return { isForked: true, parentTitle, forkNumber }
}

export function findLastCompactionTimestamp(messages: WithParts[]): number {
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        if (!isMessageWithInfo(msg)) {
            continue
        }
        if (msg.info.role === "assistant" && msg.info.summary === true) {
            return msg.info.time.created
        }
    }
    return 0
}

export function countTurns(state: SessionState, messages: WithParts[]): number {
    let turnCount = 0
    for (const msg of messages) {
        if (!isMessageWithInfo(msg)) {
            continue
        }
        if (isMessageCompacted(state, msg)) {
            continue
        }
        const parts = Array.isArray(msg.parts) ? msg.parts : []
        for (const part of parts) {
            if (part.type === "step-start") {
                turnCount++
            }
        }
    }
    return turnCount
}

export function loadPruneMap(obj?: Record<string, number>): Map<string, number> {
    if (!obj || typeof obj !== "object") {
        return new Map()
    }

    const entries = Object.entries(obj).filter(
        (entry): entry is [string, number] =>
            typeof entry[0] === "string" && typeof entry[1] === "number",
    )
    return new Map(entries)
}

export function createPruneMessagesState(): PruneMessagesState {
    return {
        byMessageId: new Map<string, PrunedMessageEntry>(),
        blocksById: new Map<number, CompressionBlock>(),
        activeBlockIds: new Set<number>(),
        activeByAnchorMessageId: new Map<string, number>(),
        nextBlockId: 1,
        nextRunId: 1,
    }
}

export function loadPruneMessagesState(
    persisted?: PersistedPruneMessagesState,
): PruneMessagesState {
    const state = createPruneMessagesState()
    if (!persisted || typeof persisted !== "object") {
        return state
    }

    if (typeof persisted.nextBlockId === "number" && Number.isInteger(persisted.nextBlockId)) {
        state.nextBlockId = Math.max(1, persisted.nextBlockId)
    }
    if (typeof persisted.nextRunId === "number" && Number.isInteger(persisted.nextRunId)) {
        state.nextRunId = Math.max(1, persisted.nextRunId)
    }

    if (persisted.byMessageId && typeof persisted.byMessageId === "object") {
        for (const [messageId, entry] of Object.entries(persisted.byMessageId)) {
            if (!entry || typeof entry !== "object") {
                continue
            }

            const tokenCount = typeof entry.tokenCount === "number" ? entry.tokenCount : 0
            const allBlockIds = Array.isArray(entry.allBlockIds)
                ? [
                      ...new Set(
                          entry.allBlockIds.filter(
                              (id): id is number => Number.isInteger(id) && id > 0,
                          ),
                      ),
                  ]
                : []
            const activeBlockIds = Array.isArray(entry.activeBlockIds)
                ? [
                      ...new Set(
                          entry.activeBlockIds.filter(
                              (id): id is number => Number.isInteger(id) && id > 0,
                          ),
                      ),
                  ]
                : []

            state.byMessageId.set(messageId, {
                tokenCount,
                allBlockIds,
                activeBlockIds,
            })
        }
    }

    if (persisted.blocksById && typeof persisted.blocksById === "object") {
        for (const [blockIdStr, block] of Object.entries(persisted.blocksById)) {
            const blockId = Number.parseInt(blockIdStr, 10)
            if (!Number.isInteger(blockId) || blockId < 1 || !block || typeof block !== "object") {
                continue
            }

            const toNumberArray = (value: unknown): number[] =>
                Array.isArray(value)
                    ? [
                          ...new Set(
                              value.filter(
                                  (item): item is number => Number.isInteger(item) && item > 0,
                              ),
                          ),
                      ]
                    : []
            const toStringArray = (value: unknown): string[] =>
                Array.isArray(value)
                    ? [...new Set(value.filter((item): item is string => typeof item === "string"))]
                    : []

            state.blocksById.set(blockId, {
                blockId,
                runId:
                    typeof block.runId === "number" &&
                    Number.isInteger(block.runId) &&
                    block.runId > 0
                        ? block.runId
                        : blockId,
                active: block.active === true,
                deactivatedByUser: block.deactivatedByUser === true,
                compressedTokens:
                    typeof block.compressedTokens === "number" &&
                    Number.isFinite(block.compressedTokens)
                        ? Math.max(0, block.compressedTokens)
                        : 0,
                summaryTokens:
                    typeof block.summaryTokens === "number" && Number.isFinite(block.summaryTokens)
                        ? Math.max(0, block.summaryTokens)
                        : typeof block.summary === "string"
                          ? countTokens(block.summary)
                          : 0,
                durationMs:
                    typeof block.durationMs === "number" && Number.isFinite(block.durationMs)
                        ? Math.max(0, block.durationMs)
                        : 0,
                mode: block.mode === "range" || block.mode === "message" ? block.mode : undefined,
                topic: typeof block.topic === "string" ? block.topic : "",
                batchTopic:
                    typeof block.batchTopic === "string"
                        ? block.batchTopic
                        : typeof block.topic === "string"
                          ? block.topic
                          : "",
                startId: typeof block.startId === "string" ? block.startId : "",
                endId: typeof block.endId === "string" ? block.endId : "",
                anchorMessageId:
                    typeof block.anchorMessageId === "string" ? block.anchorMessageId : "",
                compressMessageId:
                    typeof block.compressMessageId === "string" ? block.compressMessageId : "",
                compressCallId:
                    typeof block.compressCallId === "string" ? block.compressCallId : undefined,
                includedBlockIds: toNumberArray(block.includedBlockIds),
                consumedBlockIds: toNumberArray(block.consumedBlockIds),
                parentBlockIds: toNumberArray(block.parentBlockIds),
                directMessageIds: toStringArray(block.directMessageIds),
                directToolIds: toStringArray(block.directToolIds),
                effectiveMessageIds: toStringArray(block.effectiveMessageIds),
                effectiveToolIds: toStringArray(block.effectiveToolIds),
                createdAt: typeof block.createdAt === "number" ? block.createdAt : 0,
                deactivatedAt:
                    typeof block.deactivatedAt === "number" ? block.deactivatedAt : undefined,
                deactivatedByBlockId:
                    typeof block.deactivatedByBlockId === "number" &&
                    Number.isInteger(block.deactivatedByBlockId)
                        ? block.deactivatedByBlockId
                        : undefined,
                summary: typeof block.summary === "string" ? block.summary : "",
            })
        }
    }

    if (Array.isArray(persisted.activeBlockIds)) {
        for (const blockId of persisted.activeBlockIds) {
            if (!Number.isInteger(blockId) || blockId < 1) {
                continue
            }
            state.activeBlockIds.add(blockId)
        }
    }

    if (
        persisted.activeByAnchorMessageId &&
        typeof persisted.activeByAnchorMessageId === "object"
    ) {
        for (const [anchorMessageId, blockId] of Object.entries(
            persisted.activeByAnchorMessageId,
        )) {
            if (typeof blockId !== "number" || !Number.isInteger(blockId) || blockId < 1) {
                continue
            }
            state.activeByAnchorMessageId.set(anchorMessageId, blockId)
        }
    }

    for (const [blockId, block] of state.blocksById) {
        if (block.active) {
            state.activeBlockIds.add(blockId)
            if (block.anchorMessageId) {
                state.activeByAnchorMessageId.set(block.anchorMessageId, blockId)
            }
        }
        if (blockId >= state.nextBlockId) {
            state.nextBlockId = blockId + 1
        }
        if (block.runId >= state.nextRunId) {
            state.nextRunId = block.runId + 1
        }
    }

    return state
}

export function collectTurnNudgeAnchors(messages: WithParts[]): Set<string> {
    const anchors = new Set<string>()
    let pendingUserMessageId: string | null = null

    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i]

        if (messageHasCompress(message)) {
            break
        }

        if (message.info.role === "user") {
            if (!isIgnoredUserMessage(message)) {
                pendingUserMessageId = message.info.id
            }
            continue
        }

        if (message.info.role === "assistant" && pendingUserMessageId) {
            anchors.add(message.info.id)
            anchors.add(pendingUserMessageId)
            pendingUserMessageId = null
        }
    }

    return anchors
}

export function getActiveSummaryTokenUsage(state: SessionState): number {
    let total = 0
    for (const blockId of state.prune.messages.activeBlockIds) {
        const block = state.prune.messages.blocksById.get(blockId)
        if (!block || !block.active) {
            continue
        }
        total += block.summaryTokens
    }
    return total
}

/** Effective manual-mode helper for the v2 protocol.
 *  Returns "active" iff `userForced || recoveryForced`; otherwise `false`.
 *
 *  The legacy `state.manualMode` tri-state cache field is derived from
 *  `userForced` (explicit user intent) and `recoveryForced` (auto-disable
 *  after too many non-compacting runs) via this helper. The "compress-pending"
 *  transient — set by `/dcp-compress` while the model still owes a compress
 *  call — is owned by the slash-command handler and NEVER surfaces through
 *  this helper; readers that need to detect the transient must check
 *  `state.manualMode` directly.
 *
 *  ponytail: canonical implementation lives in `lib/compress/pipeline.ts`; this
 *  is a re-export to keep the `../state/utils` import path working for
 *  consumers that don't import from the pipeline directly (e.g.
 *  `lib/commands/manual.ts`). Delete the re-export once those consumers
 *  migrate to the canonical path.
 */
export { effectiveManualMode } from "../compress/pipeline"

// M2.5c Fix 2 — centralised counter flush. The `pruneTokenCounter += x;
// totalPruneTokens += pruneTokenCounter; pruneTokenCounter = 0` idiom was
// duplicated at lib/compress/state.ts:258-260 and lib/commands/sweep.ts:229-231
// and could double-count any pre-flushed counter value when two writers raced.
// Ponytail: a single helper that adds the in-memory counter to the lifetime
// total and zeroes the counter. Callers add to counter first, then call this.
// Returns the value that was flushed (for tests / logs).
export function flushPruneStats(stats: {
    pruneTokenCounter: number
    totalPruneTokens: number
}): number {
    const flushed = stats.pruneTokenCounter
    if (flushed > 0) {
        stats.totalPruneTokens += flushed
        stats.pruneTokenCounter = 0
    }
    return flushed
}

// M2.5c follow-up — keep state.prune.tools in sync with active blocks (BUG
// found post-M2.5c via code review). Fix 3 added the *write* side of
// state.prune.tools (compress populates via directToolIds), but the *delete*
// side never existed. After /dcp decompress N deactivated a block, the tool
// IDs stayed in state.prune.tools. The next prune() checked
// state.prune.tools.has(callID) and replaced the just-restored tool outputs
// with the placeholder, silently undoing the user's restoration. This helper
// rebuilds state.prune.tools from active blocks so decompress removes and
// recompress re-adds the right IDs.
//
// Ponytail: this rebuild also wipes sweep/strategy entries that aren't in any
// active block's directToolIds. That's intentional — /dcp decompress is an
// explicit user intent to restore ALL tool outputs that were compacted, which
// subsumes both block-compressed and sweep-marked tools. Sweep-marked entries
// re-accumulate on the next /dcp sweep run. O(|active blocks| + |prune.tools|).
export function syncPruneToolsFromActiveBlocks(state: SessionState): void {
    const activeToolIds = new Set<string>()
    for (const blockId of state.prune.messages.activeBlockIds) {
        const block = state.prune.messages.blocksById.get(blockId)
        if (!block) continue
        for (const toolId of block.directToolIds) {
            activeToolIds.add(toolId)
        }
    }
    for (const toolId of [...state.prune.tools.keys()]) {
        if (!activeToolIds.has(toolId)) state.prune.tools.delete(toolId)
    }
    for (const toolId of activeToolIds) {
        // BUG-051: always re-read the tokenCount from toolParameters. The
        // toolParameters entry can be evicted by trimToolParametersCache and
        // re-populated later with a fresh tokenCount; a `has` short-circuit
        // would leave the stale snapshot in place. Callers that need only the
        // Set semantics should treat this Map as a Set (read .has / .keys
        // only) — the value is best-effort, recomputed each sync.
        const entry = state.toolParameters.get(toolId)
        state.prune.tools.set(toolId, entry?.tokenCount ?? 0)
    }
}

export function resetOnCompaction(state: SessionState): void {
    state.toolParameters.clear()
    state.prune.tools = new Map<string, number>()
    state.prune.messages = createPruneMessagesState()
    state.messageIds = {
        byRawId: new Map<string, string>(),
        byRef: new Map<string, string>(),
        nextRef: 1,
    }
    state.nudges = {
        contextLimitAnchors: new Set<string>(),
        turnNudgeAnchors: new Set<string>(),
        iterationNudgeAnchors: new Set<string>(),
    }
    // BUG-059 — clear the pending manual trigger so a `/dcp-compress`
    // invocation that interleaves with a compaction doesn't apply the
    // manual-trigger prompt against content that has just been compacted
    // away. Mirrors resetSessionState (lib/state/state.ts).
    state.pendingManualTrigger = null
}
