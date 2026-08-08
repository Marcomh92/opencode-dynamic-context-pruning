import type { SessionState } from "../state/types"
import { attachCompressionDuration } from "./state"

export interface PendingCompressionDuration {
    messageId: string
    callId: string
    durationMs: number
}

export interface CompressionTimingState {
    startsByCallId: Map<string, number>
    pendingByCallId: Map<string, PendingCompressionDuration>
}

export function buildCompressionTimingKey(messageId: string, callId: string): string {
    return `${messageId}:${callId}`
}

export function consumeCompressionStart(
    state: SessionState,
    messageId: string,
    callId: string,
): number | undefined {
    const key = buildCompressionTimingKey(messageId, callId)
    const start = state.compressionTiming.startsByCallId.get(key)
    state.compressionTiming.startsByCallId.delete(key)
    return start
}

export function resolveCompressionDuration(
    startedAt: number | undefined,
    eventTime: number | undefined,
    partTime: { start?: unknown; end?: unknown } | undefined,
): number | undefined {
    const runningAt =
        typeof partTime?.start === "number" && Number.isFinite(partTime.start)
            ? partTime.start
            : eventTime
    const pendingToRunningMs =
        typeof startedAt === "number" && typeof runningAt === "number"
            ? Math.max(0, runningAt - startedAt)
            : undefined

    const toolStart = partTime?.start
    const toolEnd = partTime?.end
    const runtimeMs =
        typeof toolStart === "number" &&
        Number.isFinite(toolStart) &&
        typeof toolEnd === "number" &&
        Number.isFinite(toolEnd)
            ? Math.max(0, toolEnd - toolStart)
            : undefined

    return typeof pendingToRunningMs === "number" ? pendingToRunningMs : runtimeMs
}

export function applyPendingCompressionDurations(state: SessionState): number {
    if (state.compressionTiming.pendingByCallId.size === 0) {
        return 0
    }

    // ponytail: BUG-086 — restore conditional delete so queued entries survive
    // until a matching block exists (sessions reloaded from disk land their
    // pending entries on the next `ensureSessionInitialized` call). The FIFO
    // cap below bounds the leak surface the BUG-010 fix originally closed.
    const CAP = 128
    let updates = 0
    const consumed: string[] = []
    for (const [key, entry] of state.compressionTiming.pendingByCallId) {
        const applied = attachCompressionDuration(
            state.prune.messages,
            entry.messageId,
            entry.callId,
            entry.durationMs,
        )
        updates += applied
        if (applied > 0) consumed.push(key)
    }
    for (const k of consumed) state.compressionTiming.pendingByCallId.delete(k)

    // ponytail: FIFO eviction ceiling 128 — protects against the BUG-010 leak
    // (sessions that never load, or blocks deactivated before completion). Map
    // preserves insertion order, so `keys().next()` is the oldest entry.
    // Upgrade to per-session caps if multi-session memory matters.
    while (state.compressionTiming.pendingByCallId.size > CAP) {
        const oldest = state.compressionTiming.pendingByCallId.keys().next().value
        if (oldest === undefined) break
        state.compressionTiming.pendingByCallId.delete(oldest)
    }

    return updates
}
