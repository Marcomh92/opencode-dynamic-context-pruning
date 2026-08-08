import { getConfig, type PluginConfig } from "../config"
import { Logger } from "../logger"
import { filterMessages } from "../messages/shape"
import { createSessionState, type SessionState, type WithParts } from "../state"
import { loadSessionState } from "../state/persistence"
import { findLastCompactionTimestamp, loadPruneMap, loadPruneMessagesState } from "../state/utils"
import type { TuiApi } from "./types"

export const logger = new Logger(false)

export function loadConfig(api: TuiApi): PluginConfig {
    return getConfig({
        client: api.client,
        directory: api.state.path.directory,
        worktree: api.state.path.worktree,
        // ponytail: TUI's `api` shape differs from `PluginInput`; the cast bridges the seam for the standalone TUI process. Drop when the TUI plugin type aligns with `PluginInput`.
    } as any)
}

export function activeSessionID(api: TuiApi): string | undefined {
    const current = api.route.current
    if (current.name !== "session") return undefined
    const sessionID = current.params?.sessionID
    return typeof sessionID === "string" ? sessionID : undefined
}

export function sessionMessages(api: TuiApi, sessionID: string): WithParts[] {
    const messages = api.state.session.messages(sessionID)
    return filterMessages(
        messages.map((info) => ({
            info,
            parts: api.state.part(info.id),
        })) as unknown as WithParts[],
    )
}

export async function buildSessionState(
    sessionID: string,
    messages: WithParts[],
    config: PluginConfig,
): Promise<SessionState> {
    const state = createSessionState()
    state.sessionId = sessionID
    state.manualMode = config.manualMode.enabled ? "active" : false
    state.userForced = config.manualMode.enabled
    state.lastCompaction = findLastCompactionTimestamp(messages)

    const persisted = await loadSessionState(sessionID, logger, config.compress.stateMaxAgeDays)
    if (persisted) {
        if (typeof persisted.manualMode === "boolean") {
            state.manualMode = persisted.manualMode ? "active" : false
            state.userForced = persisted.manualMode
        }

        // v2 fields: loadSessionState has already enforced the schema-version
        // gate; any persisted file reaching here is a valid v2 file.
        //
        // BUG-031: recoveryForced + streak counters are intentionally NOT
        // restored here — they are session-local recovery protocol state that
        // resets on every session load. See lib/state/persistence.ts and
        // docs/features/STATE_PERSISTENCE.md.
        if (typeof persisted.userForced === "boolean") {
            state.userForced = persisted.userForced
        }

        // Re-derive the manualMode cache from the user-driven flag only;
        // recoveryForced defaults to false on a fresh session-local load.
        state.manualMode = state.userForced ? "active" : false

        state.prune.tools = loadPruneMap(persisted.prune.tools)
        state.prune.messages = loadPruneMessagesState(persisted.prune.messages)
        state.nudges.contextLimitAnchors = new Set(persisted.nudges.contextLimitAnchors || [])
        state.nudges.turnNudgeAnchors = new Set(persisted.nudges.turnNudgeAnchors || [])
        state.nudges.iterationNudgeAnchors = new Set(persisted.nudges.iterationNudgeAnchors || [])
        state.stats = {
            pruneTokenCounter: persisted.stats?.pruneTokenCounter || 0,
            totalPruneTokens: persisted.stats?.totalPruneTokens || 0,
        }
    }

    return state
}

// ponytail: per-session sidecar cache. `state` is cached for SIDECAR_TTL_MS so
// rapid modal open/close cycles don't hit disk; `messages` is host state and
// changes on every assistant turn, so it stays fresh. Bounded by # active
// sessions; no eviction needed. BUG-080.
const sidecarCache = new Map<string, { state: SessionState; expiresAt: number }>()
const SIDECAR_TTL_MS = 5000

export async function loadSessionData(api: TuiApi, config: PluginConfig) {
    const sessionID = activeSessionID(api)
    if (!sessionID) return undefined

    const messages = sessionMessages(api, sessionID)
    const cached = sidecarCache.get(sessionID)
    if (cached && cached.expiresAt > Date.now()) {
        return { state: cached.state, messages }
    }

    const state = await buildSessionState(sessionID, messages, config)
    sidecarCache.set(sessionID, { state, expiresAt: Date.now() + SIDECAR_TTL_MS })
    return { state, messages }
}
