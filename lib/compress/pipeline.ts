import type { SessionState, WithParts } from "../state"
import { ensureSessionInitialized, refreshManualMode } from "../state"
import { saveSessionState } from "../state/persistence"
import { assignMessageRefs } from "../message-ids"
import { isIgnoredUserMessage } from "../messages/query"
import { deduplicate, purgeErrors } from "../strategies"
import { getCurrentParams } from "../token-utils"
import { sendCompressNotification } from "../ui/notification"
import type { ToolContext } from "./types"
import { buildSearchContext, fetchSessionMessages } from "./search"
import type { SearchContext } from "./types"
import { applyPendingCompressionDurations } from "./timing"

interface RunContext {
    ask(input: {
        permission: string
        patterns: string[]
        always: string[]
        metadata: Record<string, unknown>
    }): Promise<void>
    metadata(input: { title: string }): void
    sessionID: string
}

export interface NotificationEntry {
    blockId: number
    runId: number
    summary: string
    summaryTokens: number
    // Tokens removed from the raw context by this block's compression. Used by
    // finalizeSession for the v2 net-compaction guard (issue #573): a block
    // whose summaryTokens >= removedTokens * maxCompactionRatio is treated as
    // non-compacting and counts toward nonCompactingRunCount.
    compressedTokens: number
}

export interface PreparedSession {
    rawMessages: WithParts[]
    searchContext: SearchContext
}

/** Canonical effective manual-mode helper for the v2 protocol.
 *  Returns "active" iff userForced || recoveryForced. The legacy `manualMode`
 *  tri-state field on SessionState is kept in sync by refreshManualMode and
 *  the compress pipeline. */
export function effectiveManualMode(state: SessionState): "active" | false {
    return state.userForced || state.recoveryForced ? "active" : false
}

export async function prepareSession(
    ctx: ToolContext,
    toolCtx: RunContext,
    title: string,
): Promise<PreparedSession> {
    await refreshManualMode(ctx.state, toolCtx.sessionID, ctx.logger, ctx.config.manualMode.enabled)

    // "compress-pending" is the transient state right after `/dcp-compress`
    // was invoked and the model still owes a compress call; allow through.
    // The compress is blocked whenever the v2 effective manual flag is set
    // and the session is not in "compress-pending".
    // Two conditions: `manual === "active"` is the v2 net block;
    // `manualMode !== "compress-pending"` is the per-compress bypass for
    // `/dcp-compress`.
    const manual = effectiveManualMode(ctx.state)
    if (manual === "active" && ctx.state.manualMode !== "compress-pending") {
        throw new Error(
            "Manual mode: compress blocked. Do not retry until `<compress triggered manually>` appears in user context.",
        )
    }

    await toolCtx.ask({
        permission: "compress",
        patterns: ["*"],
        always: ["*"],
        metadata: {},
    })

    toolCtx.metadata({ title })

    const rawMessages = await fetchSessionMessages(ctx.client, toolCtx.sessionID)

    await ensureSessionInitialized(
        ctx.client,
        ctx.state,
        toolCtx.sessionID,
        ctx.logger,
        rawMessages,
        ctx.config.manualMode.enabled,
        ctx.config.compress.stateMaxAgeDays,
        ctx.config.experimental.allowSubAgents,
    )

    assignMessageRefs(ctx.state, rawMessages)

    // ponytail: per-strategy try/catch so one buggy strategy does not abort the
    // whole compress. Strategies are still load-bearing for prune marks; if a
    // strategy throws we log and continue rather than killing the compress.
    try {
        deduplicate(ctx.state, ctx.logger, ctx.config, rawMessages)
    } catch (err: any) {
        ctx.logger.warn("deduplicate strategy threw; continuing without dedupe marks", {
            sessionId: toolCtx.sessionID,
            error: err?.message ?? String(err),
        })
    }
    try {
        purgeErrors(ctx.state, ctx.logger, ctx.config, rawMessages)
    } catch (err: any) {
        ctx.logger.warn("purgeErrors strategy threw; continuing without purge marks", {
            sessionId: toolCtx.sessionID,
            error: err?.message ?? String(err),
        })
    }

    return {
        rawMessages,
        searchContext: buildSearchContext(ctx.state, rawMessages),
    }
}

export async function finalizeSession(
    ctx: ToolContext,
    toolCtx: RunContext,
    rawMessages: WithParts[],
    entries: NotificationEntry[],
    batchTopic: string | undefined,
): Promise<void> {
    // Capture the manual-mode intent BEFORE the #590 reset below mutates
    // state.manualMode. `compress-pending` is only set by `/dcp-compress`
    // right before the agent's compress call, so seeing it here means this
    // is a manual compress — and on success, userForced clears (user intent
    // satisfied; recoveryForced is preserved).
    const wasManualCompress = ctx.state.manualMode === "compress-pending"

    // Sum per-block tokens for the net-compaction guard (§6.1 + §6.2).
    let removedTokens = 0
    let summaryTokens = 0
    for (const entry of entries) {
        removedTokens += entry.compressedTokens
        summaryTokens += entry.summaryTokens
    }

    // #590 fix: only set "active" when the value is genuinely "active".
    // The tri-state `"compress-pending"` no longer collapses to "active".
    ctx.state.manualMode = ctx.state.manualMode === "active" ? "active" : false

    // After a successful manual compress, the user's intent is satisfied —
    // clear userForced. recoveryForced is preserved (per architect decision;
    // §6.2 only clears it on session end, restart, or recoveryFadeWindow).
    if (wasManualCompress) {
        ctx.state.userForced = false
    }

    // Net-compaction guard (§6.1 + §6.2).
    // Compacting:  summaryTokens < removedTokens * maxCompactionRatio
    // Non-compacting: anything else. Counts toward nonCompactingRunCount.
    const maxCompactionRatio = ctx.config.compress.maxCompactionRatio ?? 0.7
    const maxContextLimitRecovery = ctx.config.compress.maxContextLimitRecovery ?? 3
    const recoveryFadeWindow = ctx.config.compress.recoveryFadeWindow ?? 5
    const isCompacting = removedTokens > 0 && summaryTokens < removedTokens * maxCompactionRatio

    if (!isCompacting) {
        ctx.state.nonCompactingRunCount++
        ctx.state.recoveryFadeCounter = 0
        if (
            !ctx.state.recoveryForced &&
            ctx.state.nonCompactingRunCount >= maxContextLimitRecovery
        ) {
            ctx.state.recoveryForced = true
            ctx.logger.warn("Compress recovery-forced: too many non-compacting runs in a row", {
                sessionId: toolCtx.sessionID,
                nonCompactingRunCount: ctx.state.nonCompactingRunCount,
                threshold: maxContextLimitRecovery,
            })
            try {
                ctx.client?.tui?.showToast?.({
                    body: {
                        title: "DCP: compress recovery-forced",
                        message: `Compress has not shrunk context for ${ctx.state.nonCompactingRunCount} consecutive runs. Autonomous compress disabled for this session; use /dcp-compress manually until ${recoveryFadeWindow} successful manual compresses recover it.`,
                        variant: "warning",
                        duration: 8000,
                    },
                })
            } catch {
                // Toast dispatch is best-effort; the warn log is the authoritative signal.
            }
        }
    } else {
        // Compacting run. Reset the non-compacting counter.
        ctx.state.nonCompactingRunCount = 0
        // Recovery fade: only counts manual compresses (autonomous compress is
        // unavailable while recoveryForced is set). Per §6.2, a good manual
        // compress increments the fade counter; a bad manual compress resets
        // it (covered above).
        if (ctx.state.recoveryForced && wasManualCompress) {
            ctx.state.recoveryFadeCounter++
            if (ctx.state.recoveryFadeCounter >= recoveryFadeWindow) {
                ctx.state.recoveryForced = false
                ctx.state.recoveryFadeCounter = 0
                ctx.logger.info("Compress recovery cleared after good-compress streak", {
                    sessionId: toolCtx.sessionID,
                    streak: recoveryFadeWindow,
                })
            }
        } else if (!ctx.state.recoveryForced) {
            ctx.state.recoveryFadeCounter = 0
        }
    }

    // Keep the legacy `manualMode` cache in sync with the new flags for code
    // paths M2 doesn't touch (TUI, /dcp help, strategy gates).
    ctx.state.manualMode = effectiveManualMode(ctx.state)

    applyPendingCompressionDurations(ctx.state)
    await saveSessionState(ctx.state, ctx.logger)

    const params = getCurrentParams(ctx.state, rawMessages, ctx.logger)
    const sessionMessageIds = rawMessages
        .filter((msg) => !isIgnoredUserMessage(msg))
        .map((msg) => msg.info.id)

    await sendCompressNotification(
        ctx.client,
        ctx.logger,
        ctx.config,
        ctx.state,
        toolCtx.sessionID,
        entries,
        batchTopic,
        sessionMessageIds,
        params,
    )
}
