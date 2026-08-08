// ponytail: declares Bun as optional so the desktop-runtime check below type-checks
// even when @types/bun isn't installed (mirrors the same line in tui.tsx).
declare const Bun: { version?: string } | undefined

import type { Logger } from "../logger"
import type { SessionState } from "../state"
import {
    formatPrunedItemsList,
    formatProgressBar,
    formatStatsHeader,
    formatTokenCount,
} from "./utils"
import { ToolParameterEntry } from "../state"
import { PluginConfig } from "../config"
import { getActiveSummaryTokenUsage } from "../state/utils"

export type PruneReason = "completion" | "noise" | "extraction"
export const PRUNE_REASON_LABELS: Record<PruneReason, string> = {
    completion: "Task Complete",
    noise: "Noise Removal",
    extraction: "Extraction",
}

interface CompressionNotificationEntry {
    blockId: number
    runId: number
    summary: string
    summaryTokens: number
}

function buildMinimalMessage(state: SessionState, reason: PruneReason | undefined): string {
    const reasonSuffix = reason ? ` — ${PRUNE_REASON_LABELS[reason]}` : ""
    return (
        formatStatsHeader(state.stats.totalPruneTokens, state.stats.pruneTokenCounter) +
        reasonSuffix
    )
}

function buildDetailedMessage(
    state: SessionState,
    reason: PruneReason | undefined,
    pruneToolIds: string[],
    toolMetadata: Map<string, ToolParameterEntry>,
    workingDirectory: string,
): string {
    let message = formatStatsHeader(state.stats.totalPruneTokens, state.stats.pruneTokenCounter)

    if (pruneToolIds.length > 0) {
        const pruneTokenCounterStr = `~${formatTokenCount(state.stats.pruneTokenCounter)}`
        const reasonLabel = reason ? ` — ${PRUNE_REASON_LABELS[reason]}` : ""
        message += `\n\n▣ Pruning (${pruneTokenCounterStr})${reasonLabel}`

        const itemLines = formatPrunedItemsList(pruneToolIds, toolMetadata, workingDirectory)
        message += "\n" + itemLines.join("\n")
    }

    return message.trim()
}

const TOAST_BODY_MAX_LINES = 12
const TOAST_SUMMARY_MAX_CHARS = 600

// ponytail: one module-level in-flight flag is sufficient because plugin notifications share one host client.
// The dispatcher fires the FIRST call immediately (preserving test contracts + user-visible action feedback),
// and any same-tick subsequent calls coalesce into a single follow-up toast. This satisfies both:
//   - single call → one immediate toast
//   - burst of N synchronous calls → one immediate toast + one merged follow-up
//   - sequential awaited calls → one toast per call (inFlight clears between awaits)
// Shared across sessions; coalescing is per-process. Cross-session toast coalescing across two concurrent
// sessions would merge unrelated messages — cosmetic, not corruption.
let inFlightDispatch: Promise<void> | null = null
let pendingMergedMessages: string[] = []
// ponytail: dedup window for identical sequential calls. A session that triggers compress every turn would
// otherwise toast the same body 10 times in 2 seconds. Key includes the message body, not just the title
// (all callers use the constant title "DCP: Compress Notification"). BUG-078.
let lastDispatchKey = ""
let lastDispatchAt = 0
const TOAST_DEDUP_WINDOW_MS = 1000

/** Resolves the configured notification type for the current host runtime.
 *  Forces `"toast"` on the OpenCode Desktop sidecar regardless of user config,
 *  because the desktop runtime has no chat-message channel for ignored text.
 *  The `pruneNotification` content setting (off / minimal / detailed) is
 *  unaffected — only the transport type flips. */
export function resolveEffectiveNotificationType(
    configPruneNotificationType: "chat" | "toast",
    isDesktop: boolean,
): "chat" | "toast" {
    return isDesktop ? "toast" : configPruneNotificationType
}

/**
 * Fires a toast. Coalesces synchronous bursts (the same JS tick) into a single
 * follow-up toast with merged content. Sequential awaited calls each fire
 * their own toast, unless they fall within the dedup window for an identical
 * title+message key.
 */
export function dispatchToast(client: any, title: string, message: string): void {
    const key = `${title}|${message}`
    const now = Date.now()
    if (key === lastDispatchKey && now - lastDispatchAt < TOAST_DEDUP_WINDOW_MS) {
        // ponytail: identical notification within the dedup window — drop.
        // Surfacing a "+N suppressed" counter here would require a second
        // channel; out of scope for BUG-078. Add when the user complains.
        return
    }
    lastDispatchKey = key
    lastDispatchAt = now

    if (inFlightDispatch) {
        pendingMergedMessages.push(message)
        return
    }

    inFlightDispatch = (async () => {
        try {
            await client.tui.showToast({
                body: { title, message, variant: "info", duration: 5000 },
            })
            // Drain loop: re-check after each merged follow-up so messages
            // arriving mid-await are not silently dropped.
            // ponytail: unbounded; each iteration is an IPC roundtrip. Cap only if observed.
            while (pendingMergedMessages.length > 0) {
                const merged = pendingMergedMessages.join("\n")
                pendingMergedMessages = []
                await client.tui.showToast({
                    body: { title, message: merged, variant: "info", duration: 5000 },
                })
            }
        } catch {
            // Swallow rejections silently; the fork can't recover from a host-side toast failure.
            // ponytail: extension to fire-and-forget — no logger in scope here.
        } finally {
            inFlightDispatch = null
            // Defensive: clear the queue unconditionally so the next burst
            // starts from a clean state (mid-await arrivals during a rejected
            // toast are dropped — acceptable trade-off vs. an unbounded leak).
            pendingMergedMessages = []
        }
    })()
}

/** Returns whether a dispatch is currently in flight (for deterministic dispatcher tests). */
export function isDispatchInFlight(): boolean {
    return inFlightDispatch !== null
}

/** Returns the pending merged messages queue length (for deterministic dispatcher tests). */
export function getPendingMergedCount(): number {
    return pendingMergedMessages.length
}

/** Clears the queued state between dispatcher tests. */
export function resetPendingToast(): void {
    pendingMergedMessages = []
    inFlightDispatch = null
}

function truncateToastBody(body: string, maxLines: number = TOAST_BODY_MAX_LINES): string {
    const lines = body.split("\n")
    if (lines.length <= maxLines) {
        return body
    }
    const kept = lines.slice(0, maxLines - 1)
    const remaining = lines.length - maxLines + 1
    return kept.join("\n") + `\n... and ${remaining} more`
}

function truncateToastSummary(summary: string, maxChars: number = TOAST_SUMMARY_MAX_CHARS): string {
    if (summary.length <= maxChars) {
        return summary
    }
    return summary.slice(0, maxChars - 3) + "..."
}

function truncateExtractedSection(
    message: string,
    maxChars: number = TOAST_SUMMARY_MAX_CHARS,
): string {
    const marker = "\n\n▣ Extracted"
    const index = message.indexOf(marker)
    if (index === -1) {
        return message
    }
    const extracted = message.slice(index)
    if (extracted.length <= maxChars) {
        return message
    }
    return message.slice(0, index) + truncateToastSummary(extracted, maxChars)
}

export async function sendUnifiedNotification(
    client: any,
    logger: Logger,
    config: PluginConfig,
    state: SessionState,
    sessionId: string,
    pruneToolIds: string[],
    toolMetadata: Map<string, ToolParameterEntry>,
    reason: PruneReason | undefined,
    params: any,
    workingDirectory: string,
): Promise<boolean> {
    const hasPruned = pruneToolIds.length > 0
    if (!hasPruned) {
        return false
    }

    if (config.pruneNotification === "off") {
        return false
    }

    const message =
        config.pruneNotification === "minimal"
            ? buildMinimalMessage(state, reason)
            : buildDetailedMessage(state, reason, pruneToolIds, toolMetadata, workingDirectory)

    const isDesktop = typeof Bun === "undefined"
    const effectiveNotificationType = resolveEffectiveNotificationType(
        config.pruneNotificationType,
        isDesktop,
    )
    if (effectiveNotificationType === "toast") {
        let toastMessage = truncateExtractedSection(message)
        toastMessage =
            config.pruneNotification === "minimal" ? toastMessage : truncateToastBody(toastMessage)

        dispatchToast(client, "DCP: Compress Notification", toastMessage)
        return true
    }

    await sendIgnoredMessage(client, sessionId, message, params, logger)
    return true
}

function buildCompressionSummary(
    entries: CompressionNotificationEntry[],
    state: SessionState,
): string {
    if (entries.length === 1) {
        return entries[0]?.summary ?? ""
    }

    return entries
        .map((entry) => {
            const topic =
                state.prune.messages.blocksById.get(entry.blockId)?.topic ?? "(unknown topic)"
            return `### ${topic}\n${entry.summary}`
        })
        .join("\n\n")
}

function getCompressionLabel(entries: CompressionNotificationEntry[]): string {
    const runId = entries[0]?.runId
    if (runId === undefined) {
        return "Compression"
    }

    return `Compression #${runId}`
}

function formatCompressionMetrics(removedTokens: number, summaryTokens: number): string {
    const metrics = [`-${formatTokenCount(removedTokens, true)} removed`]
    if (summaryTokens > 0) {
        metrics.push(`+${formatTokenCount(summaryTokens, true)} summary`)
    }
    return metrics.join(", ")
}

export async function sendCompressNotification(
    client: any,
    logger: Logger,
    config: PluginConfig,
    state: SessionState,
    sessionId: string,
    entries: CompressionNotificationEntry[],
    batchTopic: string | undefined,
    sessionMessageIds: string[],
    params: any,
): Promise<boolean> {
    if (config.pruneNotification === "off") {
        return false
    }

    if (entries.length === 0) {
        return false
    }

    let message: string
    const compressionLabel = getCompressionLabel(entries)
    const summary = buildCompressionSummary(entries, state)
    const summaryTokens = entries.reduce((total, entry) => total + entry.summaryTokens, 0)
    const summaryTokensStr = formatTokenCount(summaryTokens)
    const compressedTokens = entries.reduce((total, entry) => {
        const compressionBlock = state.prune.messages.blocksById.get(entry.blockId)
        if (!compressionBlock) {
            logger.error("Compression block missing for notification", {
                compressionId: entry.blockId,
                sessionId,
            })
            return total
        }

        return total + compressionBlock.compressedTokens
    }, 0)

    const newlyCompressedMessageIds: string[] = []
    const newlyCompressedToolIds: string[] = []
    const seenMessageIds = new Set<string>()
    const seenToolIds = new Set<string>()

    for (const entry of entries) {
        const compressionBlock = state.prune.messages.blocksById.get(entry.blockId)
        if (!compressionBlock) {
            continue
        }

        for (const messageId of compressionBlock.directMessageIds) {
            if (seenMessageIds.has(messageId)) {
                continue
            }
            seenMessageIds.add(messageId)
            newlyCompressedMessageIds.push(messageId)
        }

        for (const toolId of compressionBlock.directToolIds) {
            if (seenToolIds.has(toolId)) {
                continue
            }
            seenToolIds.add(toolId)
            newlyCompressedToolIds.push(toolId)
        }
    }

    const topic =
        batchTopic ??
        (entries.length === 1
            ? (state.prune.messages.blocksById.get(entries[0]?.blockId ?? -1)?.topic ??
              "(unknown topic)")
            : "(unknown topic)")

    // Headline shows the per-compress delta (sum of compressedTokens across
    // entries being notified). The previously-reported "totalGross" was the
    // session-lifetime cumulative counter, which made a single compress that
    // shaved 25K look like a -400K removal. Session total is shown on its
    // own line, explicitly labeled. (M2.5c Fix 1)
    const totalActiveSummaryTkns = getActiveSummaryTokenUsage(state)
    const sessionTotalGross = state.stats.totalPruneTokens + state.stats.pruneTokenCounter
    const notificationHeader = `▣ DCP | ${formatCompressionMetrics(compressedTokens, totalActiveSummaryTkns)}`

    if (config.pruneNotification === "minimal") {
        message = `${notificationHeader} — ${compressionLabel}`
    } else {
        message = notificationHeader

        const activePrunedMessages = new Map<string, number>()
        for (const [messageId, entry] of state.prune.messages.byMessageId) {
            if (entry.activeBlockIds.length > 0) {
                activePrunedMessages.set(messageId, entry.tokenCount)
            }
        }
        const progressBar = formatProgressBar(
            sessionMessageIds,
            activePrunedMessages,
            newlyCompressedMessageIds,
            50,
        )
        message += `\n\n${progressBar}`
        message += `\n▣ ${compressionLabel} ${formatCompressionMetrics(compressedTokens, summaryTokens)}`
        message += `\n→ Topic: ${topic}`
        message += `\n→ Items: ${newlyCompressedMessageIds.length} messages`
        if (newlyCompressedToolIds.length > 0) {
            message += ` and ${newlyCompressedToolIds.length} tools compressed`
        } else {
            message += ` compressed`
        }
        message += `\n→ Session total: ${formatTokenCount(sessionTotalGross, true)} removed`
        if (config.compress.showCompression) {
            message += `\n→ Compression (~${summaryTokensStr}): ${summary}`
        }
    }

    const isDesktop = typeof Bun === "undefined"
    const effectiveNotificationType = resolveEffectiveNotificationType(
        config.pruneNotificationType,
        isDesktop,
    )

    if (effectiveNotificationType === "toast") {
        let toastMessage = message
        if (config.compress.showCompression) {
            const truncatedSummary = truncateToastSummary(summary)
            if (truncatedSummary !== summary) {
                toastMessage = toastMessage.replace(
                    `\n→ Compression (~${summaryTokensStr}): ${summary}`,
                    `\n→ Compression (~${summaryTokensStr}): ${truncatedSummary}`,
                )
            }
        }
        toastMessage =
            config.pruneNotification === "minimal" ? toastMessage : truncateToastBody(toastMessage)

        dispatchToast(client, "DCP: Compress Notification", toastMessage)
        return true
    }

    await sendIgnoredMessage(client, sessionId, message, params, logger)
    return true
}

export async function sendIgnoredMessage(
    client: any,
    sessionID: string,
    text: string,
    params: any,
    logger: Logger,
): Promise<void> {
    const agent = params.agent || undefined
    const variant = params.variant || undefined
    const model =
        params.providerId && params.modelId
            ? {
                  providerID: params.providerId,
                  modelID: params.modelId,
              }
            : undefined

    try {
        await client.session.prompt({
            path: {
                id: sessionID,
            },
            body: {
                noReply: true,
                agent: agent,
                model: model,
                variant: variant,
                parts: [
                    {
                        type: "text",
                        text: text,
                        ignored: true,
                    },
                ],
            },
        })
    } catch (error: any) {
        logger.error("Failed to send notification", { error: error.message })
    }
}
