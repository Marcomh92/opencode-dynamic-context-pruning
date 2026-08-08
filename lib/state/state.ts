import type { SessionState, ToolParameterEntry, WithParts } from "./types"
import { CachedSubAgentResult, FORK_SCHEMA_VERSION } from "./types"
import type { Logger } from "../logger"
import { applyPendingCompressionDurations } from "../compress/timing"
import { loadManualModeSetting, loadSessionState, saveSessionState } from "./persistence"
import {
    isSubAgentSession,
    findLastCompactionTimestamp,
    countTurns,
    resetOnCompaction,
    createPruneMessagesState,
    loadPruneMessagesState,
    loadPruneMap,
    collectTurnNudgeAnchors,
    effectiveManualMode,
} from "./utils"
import { getLastUserMessage } from "../messages/query"

export const checkSession = async (
    client: any,
    state: SessionState,
    logger: Logger,
    messages: WithParts[],
    manualModeDefault: boolean,
    stateMaxAgeDays: number | null = null,
    allowSubAgents: boolean = false,
): Promise<void> => {
    const lastUserMessage = getLastUserMessage(messages)
    if (!lastUserMessage) {
        return
    }

    const lastSessionId = lastUserMessage.info.sessionID

    if (state.sessionId === null || state.sessionId !== lastSessionId) {
        logger.info(`Session changed: ${state.sessionId} -> ${lastSessionId}`)
        try {
            await ensureSessionInitialized(
                client,
                state,
                lastSessionId,
                logger,
                messages,
                manualModeDefault,
                stateMaxAgeDays,
                allowSubAgents,
            )
        } catch (err: any) {
            logger.error("Failed to initialize session state", { error: err.message })
        }
    }

    const lastCompactionTimestamp = findLastCompactionTimestamp(messages)
    if (lastCompactionTimestamp > state.lastCompaction) {
        state.lastCompaction = lastCompactionTimestamp
        resetOnCompaction(state)
        logger.info("Detected compaction - reset stale state", {
            timestamp: lastCompactionTimestamp,
        })

        saveSessionState(state, logger).catch((error) => {
            logger.warn("Failed to persist state reset after compaction", {
                error: error instanceof Error ? error.message : String(error),
            })
        })
    }

    state.currentTurn = countTurns(state, messages)
    await refreshManualMode(state, lastSessionId, logger, manualModeDefault)
}

export function createSessionState(): SessionState {
    return {
        sessionId: null,
        isSubAgent: false,
        manualMode: false,
        userForced: false,
        recoveryForced: false,
        nonCompactingRunCount: 0,
        recoveryFadeCounter: 0,
        forkSchemaVersion: FORK_SCHEMA_VERSION,
        compressPermission: undefined,
        pendingManualTrigger: null,
        prune: {
            tools: new Map<string, number>(),
            messages: createPruneMessagesState(),
        },
        nudges: {
            contextLimitAnchors: new Set<string>(),
            turnNudgeAnchors: new Set<string>(),
            iterationNudgeAnchors: new Set<string>(),
        },
        stats: {
            pruneTokenCounter: 0,
            totalPruneTokens: 0,
        },
        compressionTiming: {
            startsByCallId: new Map<string, number>(),
            pendingByCallId: new Map(),
        },
        toolParameters: new Map<string, ToolParameterEntry>(),
        subAgentResultCache: new Map<string, CachedSubAgentResult>(),
        toolIdList: [],
        messageIds: {
            byRawId: new Map<string, string>(),
            byRef: new Map<string, string>(),
            nextRef: 1,
        },
        lastCompaction: 0,
        currentTurn: 0,
        modelContextLimit: undefined,
        systemPromptTokens: undefined,
        diagnostic: {
            fireCount: 0,
            lastPrefixHash: null,
            lastFireAt: null,
        },
    }
}

export function resetSessionState(state: SessionState): void {
    state.sessionId = null
    state.isSubAgent = false
    state.manualMode = false
    state.userForced = false
    state.recoveryForced = false
    state.nonCompactingRunCount = 0
    state.recoveryFadeCounter = 0
    state.forkSchemaVersion = FORK_SCHEMA_VERSION
    state.compressPermission = undefined
    state.pendingManualTrigger = null
    state.prune = {
        tools: new Map<string, number>(),
        messages: createPruneMessagesState(),
    }
    state.nudges = {
        contextLimitAnchors: new Set<string>(),
        turnNudgeAnchors: new Set<string>(),
        iterationNudgeAnchors: new Set<string>(),
    }
    state.stats = {
        pruneTokenCounter: 0,
        totalPruneTokens: 0,
    }
    // ponytail: clear compressionTiming so orphans (e.g. compress call started
    // but never completed via crash / kill) do not leak across session
    // boundaries inside a long-lived TUI / desktop sidecar process.
    state.compressionTiming.startsByCallId.clear()
    state.compressionTiming.pendingByCallId.clear()
    state.toolParameters.clear()
    state.subAgentResultCache.clear()
    state.toolIdList = []
    state.messageIds = {
        byRawId: new Map<string, string>(),
        byRef: new Map<string, string>(),
        nextRef: 1,
    }
    state.lastCompaction = 0
    state.currentTurn = 0
    state.modelContextLimit = undefined
    state.systemPromptTokens = undefined
    state.diagnostic = {
        fireCount: 0,
        lastPrefixHash: null,
        lastFireAt: null,
    }
}

export async function ensureSessionInitialized(
    client: any,
    state: SessionState,
    sessionId: string,
    logger: Logger,
    messages: WithParts[],
    manualModeEnabled: boolean,
    stateMaxAgeDays: number | null = null,
    allowSubAgents: boolean = false,
): Promise<void> {
    if (state.sessionId === sessionId) {
        return
    }

    // logger.info("session ID = " + sessionId)
    // logger.info("Initializing session state", { sessionId: sessionId })

    // ponytail: snapshot queued duration updates before resetSessionState
    // wipes pendingByCallId. Without this, BUG-086's queueing contract is
    // violated for events that fire before the session is loaded.
    // See known_issues/fixed/BUG-086 for context.
    const pendingSnapshot = new Map(state.compressionTiming.pendingByCallId)

    resetSessionState(state)
    /** Restores queued duration updates after the session state reset. */
    const restorePendingCompressionDurations = (): void => {
        // pendingByCallId keys are messageId:callId, not session-scoped, so
        // conservatively retain every unconsumed entry. The FIFO cap in
        // applyPendingCompressionDurations bounds the growth.
        for (const [key, entry] of pendingSnapshot) {
            if (!state.compressionTiming.pendingByCallId.has(key)) {
                state.compressionTiming.pendingByCallId.set(key, entry)
            }
        }
    }
    state.userForced = manualModeEnabled
    state.manualMode = manualModeEnabled ? "active" : false
    state.sessionId = sessionId

    const isSubAgent = await isSubAgentSession(client, sessionId)
    state.isSubAgent = isSubAgent
    // logger.info("isSubAgent = " + isSubAgent)

    // BUG-054: only skip the persisted-state load when the session is a
    // subagent AND the user has not opted in via experimental.allowSubAgents.
    // The previous unconditional early-return wasted a disk read on every
    // subagent session even when the user explicitly enabled DCP for them.
    if (isSubAgent && !allowSubAgents) {
        restorePendingCompressionDurations()
        return
    }

    state.lastCompaction = findLastCompactionTimestamp(messages)
    state.currentTurn = countTurns(state, messages)
    state.nudges.turnNudgeAnchors = collectTurnNudgeAnchors(messages)

    const persisted = await loadSessionState(sessionId, logger, stateMaxAgeDays)
    if (persisted === null) {
        restorePendingCompressionDurations()
        return
    }

    // The persisted state's legacy `manualMode: boolean` is the only signal we
    // have for a user-enabled manual mode on load (v1 storage didn't carry
    // userForced). recoveryForced and the counters are intentionally NOT
    // restored — they reset on every session load (architect decision: drop,
    // don't migrate, on the v1→v2 boundary).
    if (typeof persisted.manualMode === "boolean") {
        state.userForced = persisted.manualMode
        state.manualMode = persisted.manualMode ? "active" : false
    }

    // v2 fields: apply loaded values when present. The schema-version gate in
    // loadSessionState has already filtered out mismatched files, so anything
    // that reaches here is a valid v2 file.
    //
    // BUG-031: recoveryForced, nonCompactingRunCount, recoveryFadeCounter are
    // intentionally NOT restored — they are session-local recovery protocol
    // state that resets on every session load (see also docs/features/
    // STATE_PERSISTENCE.md and the persistence-side fix in persistence.ts).
    if (typeof persisted.userForced === "boolean") {
        state.userForced = persisted.userForced
    }

    // Re-derive the manualMode cache from the now-merged flags via the
    // canonical helper (DPP-017 / PAT-007).
    state.manualMode = effectiveManualMode(state)

    state.prune.tools = loadPruneMap(persisted.prune.tools)
    state.prune.messages = loadPruneMessagesState(persisted.prune.messages)
    state.nudges.contextLimitAnchors = new Set<string>(persisted.nudges.contextLimitAnchors || [])
    state.nudges.turnNudgeAnchors = new Set<string>([
        ...state.nudges.turnNudgeAnchors,
        ...(persisted.nudges.turnNudgeAnchors || []),
    ])
    state.nudges.iterationNudgeAnchors = new Set<string>(
        persisted.nudges.iterationNudgeAnchors || [],
    )
    state.stats = {
        pruneTokenCounter: persisted.stats?.pruneTokenCounter || 0,
        totalPruneTokens: persisted.stats?.totalPruneTokens || 0,
    }

    restorePendingCompressionDurations()
    const applied = applyPendingCompressionDurations(state)
    if (applied > 0) {
        await saveSessionState(state, logger)
    }
}

export async function refreshManualMode(
    state: SessionState,
    sessionId: string,
    logger: Logger,
    manualModeDefault: boolean,
): Promise<void> {
    if (state.manualMode === "compress-pending") {
        return
    }

    const persisted = await loadManualModeSetting(sessionId, logger)
    const enabled = persisted ?? manualModeDefault
    state.userForced = enabled
    // recoveryForced is preserved across refresh — only session end, restart, or
    // a streak of good compresses clears it. manualMode is the derived cache;
    // re-derive via the canonical helper (DPP-017 / PAT-007).
    state.manualMode = effectiveManualMode(state)
}
