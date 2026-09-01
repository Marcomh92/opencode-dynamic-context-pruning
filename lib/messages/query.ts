import type { PluginConfig } from "../config"
import type { WithParts } from "../state"
import { isMessageWithInfo } from "./shape"

export const getLastUserMessage = (
    messages: WithParts[],
    startIndex?: number,
): WithParts | null => {
    const start = startIndex ?? messages.length - 1
    for (let i = start; i >= 0; i--) {
        const msg = messages[i]
        if (!isMessageWithInfo(msg)) {
            continue
        }
        if (msg.info.role === "user" && !isIgnoredUserMessage(msg)) {
            return msg
        }
    }
    return null
}

export const messageHasCompress = (message: WithParts): boolean => {
    if (!isMessageWithInfo(message)) {
        return false
    }

    if (message.info.role !== "assistant") {
        return false
    }

    const parts = Array.isArray(message.parts) ? message.parts : []
    return parts.some(
        (part) =>
            part.type === "tool" && part.tool === "compress" && part.state?.status === "completed",
    )
}

export const isIgnoredUserMessage = (message: WithParts): boolean => {
    if (!isMessageWithInfo(message)) {
        return false
    }

    if (message.info.role !== "user") {
        return false
    }

    const parts = Array.isArray(message.parts) ? message.parts : []
    if (parts.length === 0) {
        return true
    }

    for (const part of parts) {
        if (part.type === "text") {
            if (!part.ignored && !part.synthetic) {
                return false
            }
            continue
        }
        return false
    }

    return true
}

export function isProtectedUserMessage(
    config: PluginConfig,
    message: WithParts,
    protectedMessageIds: ReadonlySet<string>,
): boolean {
    if (!isMessageWithInfo(message)) {
        return false
    }

    // ponytail: mode check kept for backward compat. In range mode the
    // BLOCKED tag is not set for user messages — protection in range mode
    // is the verbatim-text append in `appendProtectedUserMessages` only. In
    // message mode the BLOCKED tag is set for the last N real user messages
    // (see `computeProtectedUserMessageIds`). Remove this gate if a future
    // feature wants range-mode BLOCKED tags.
    if (config.compress.mode !== "message") {
        return false
    }

    if (!config.compress.protectUserMessages) {
        return false
    }

    if (message.info.role !== "user") {
        return false
    }

    if (isIgnoredUserMessage(message)) {
        return false
    }

    const id = message.info.id
    if (typeof id !== "string") {
        return false
    }

    return protectedMessageIds.has(id)
}

// BUG-096: returns the Set of message IDs that should be treated as
// "protected user messages" under the last-N semantics. The caller supplies
// the message list to scope the result — the range-mode summary builder
// passes `selection.messageIds` (compression range only), the message-mode
// priority map and BLOCKED tag pass the full session. Synthetic / ignored
// user messages do not count toward N. Empty set when `protectUserMessages`
// is false or no real user messages exist.
export function computeProtectedUserMessageIds(
    config: PluginConfig,
    messages: ReadonlyArray<WithParts>,
): Set<string> {
    const result = new Set<string>()
    if (!config.compress.protectUserMessages) {
        return result
    }

    const raw = config.compress.protectUserMessagesCount ?? 1
    // clampMin1 inlined: 0 / negative / non-number → 1. Math.floor truncates
    // fractional inputs. `Number.POSITIVE_INFINITY` collapses to 1 here, even
    // though `appendProtectedUserMessages` (range-mode) treats Infinity as
    // "all" — the config-driven path never produces Infinity because
    // `mergeCompress`'s `clampMin1` rejects it, so the asymmetry is
    // unreachable through normal config. Direct API callers that pass
    // Infinity will get 1 here; for range-mode "all" use a large finite
    // value (e.g. 9999) instead.
    const count = typeof raw === "number" && Number.isFinite(raw) ? Math.max(1, Math.floor(raw)) : 1

    for (let i = messages.length - 1; i >= 0 && result.size < count; i--) {
        const msg = messages[i]
        if (!isMessageWithInfo(msg)) continue
        if (msg.info.role !== "user") continue
        if (isIgnoredUserMessage(msg)) continue
        const id = msg.info.id
        if (typeof id !== "string") continue
        result.add(id)
    }

    return result
}
