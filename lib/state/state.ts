import { applyPendingCompressionDurations } from "../compress/timing"
import type { PluginConfig } from "../config"
import type { Logger } from "../logger"
import { getLastUserMessage } from "../messages/query"
import { tryInheritFromParent } from "./inherit"
import { loadManualModeSetting, loadSessionState, saveSessionState } from "./persistence"
import type { SessionState, ToolParameterEntry, WithParts } from "./types"
import { CachedSubAgentResult, FORK_SCHEMA_VERSION } from "./types"
import {
    collectTurnNudgeAnchors,
    countTurns,
    createPruneMessagesState,
    effectiveManualMode,
    findLastCompactionTimestamp,
    getSessionMetadata,
    loadPruneMap,
    loadPruneMessagesState,
    resetOnCompaction,
} from "./utils"

export const checkSession = async (
    client: any,
    state: SessionState,
    logger: Logger,
    messages: WithParts[],
    manualModeDefault: boolean,
    config: PluginConfig,
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
                config,
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
    // sessionTitle is in-memory only (never persisted); the fork-inheritance
    // orchestrator reads it via `detectParentSessionFromTitle`. Reset so a
    // fork-from-clean-state session doesn't inherit the previous title.
    state.sessionTitle = undefined
    // inheritedFrom is in-memory only (never persisted); set by
    // `tryInheritFromParent` on a successful fork inheritance. Reset so
    // the next session's status reflects its own lineage, not the prior
    // session's.
    state.inheritedFrom = null
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
    config: PluginConfig,
    stateMaxAgeDays: number | null = null,
    allowSubAgents: boolean = false,
): Promise<void> {
    if (state.sessionId === sessionId) {
        return
    }

    logger.info("session ID = " + sessionId)
    logger.info("Initializing session state", { sessionId: sessionId })

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

    // Stage A-1's `getSessionMetadata` replaces `isSubAgentSession` and adds
    // `title` on the same SDK roundtrip (architect flag #14 — the title
    // fetch was previously a duplicate roundtrip in lib/hooks.ts:240-252).
    // `sessionTitle` is cached on `state` for the fork-inheritance orchestrator
    // (`tryInheritFromParent` reads it via `detectParentSessionFromTitle`).
    const meta = await getSessionMetadata(client, sessionId)
    const isSubAgent = meta.isSubAgent
    state.isSubAgent = isSubAgent
    state.sessionTitle = meta.title
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
        // BUG-089 (fork-state-inheritance plan §4.2 step 7):
        // Wire inheritance call. Inside `persisted === null` branch (B has
        // no prior state) — B's own state wins if any exists. Gated on
        // `experimental.inheritOnFork` (default true per user direction
        // 2026-08-08). Try/catch wraps everything; inheritance is
        // best-effort and never blocks the transform.
        await tryInheritFromParent(
            state,
            client,
            sessionId,
            logger,
            messages,
            config,
            stateMaxAgeDays,
        )
        restorePendingCompressionDurations()
        return
    }

    // The persisted state's legacy `manualMode: boolean` is the only signal we
    // have for a user-enabled manual mode on load (v1 storage didn't carry
    // userForced).
    if (typeof persisted.manualMode === "boolean") {
        state.userForced = persisted.manualMode
        state.manualMode = persisted.manualMode ? "active" : false
    }

    // v2 fields: apply loaded values when present. The schema-version gate in
    // loadSessionState has already filtered out mismatched files, so anything
    // that reaches here is a valid v2 file.
    //
    // v4 (BUG-089): the recovery fields are now round-tripped through
    // persistence so a forked session (B) can inherit A's recovery state
    // along with its blocks (fork-state-inheritance plan §4.5). Fork
    // inheritance reads them via the same defensive `typeof ===` guards in
    // lib/state/inherit.ts:tryInheritFromParent. See
    // docs/features/STATE_PERSISTENCE.md for the persisted-vs-in-memory
    // table. BUG-031 fully superseded at v4: these fields round-trip on
    // every load, not just on fork.
    if (typeof persisted.userForced === "boolean") {
        state.userForced = persisted.userForced
    }
    if (typeof persisted.recoveryForced === "boolean")
        state.recoveryForced = persisted.recoveryForced
    if (
        typeof persisted.nonCompactingRunCount === "number" &&
        persisted.nonCompactingRunCount >= 0
    ) {
        state.nonCompactingRunCount = persisted.nonCompactingRunCount
    }
    if (typeof persisted.recoveryFadeCounter === "number" && persisted.recoveryFadeCounter >= 0) {
        state.recoveryFadeCounter = persisted.recoveryFadeCounter
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
