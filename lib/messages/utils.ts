import { createHash } from "node:crypto"
import type { PluginConfig } from "../config"
import type { SessionState, WithParts } from "../state"
import { isMessageCompacted } from "../state/utils"
import { isToolNameProtected } from "../protected-patterns"
import type { UserMessage } from "@opencode-ai/sdk/v2"

const SUMMARY_ID_HASH_LENGTH = 16
const DCP_BLOCK_ID_TAG_REGEX = /(<dcp-message-id(?=[\s>])[^>]*>)b\d+(<\/dcp-message-id>)/g
const DCP_PAIRED_TAG_REGEX = /<dcp[^>]*>[\s\S]*?<\/dcp[^>]*>/gi
const DCP_UNPAIRED_TAG_REGEX = /<\/?dcp[^>]*>/gi

const generateStableId = (prefix: string, seed: string): string => {
    const hash = createHash("sha256").update(seed).digest("hex").slice(0, SUMMARY_ID_HASH_LENGTH)
    return `${prefix}_${hash}`
}

export const createSyntheticUserMessage = (
    baseMessage: WithParts,
    content: string,
    stableSeed?: string,
): WithParts => {
    const userInfo = baseMessage.info as UserMessage
    const deterministicSeed = stableSeed?.trim() || userInfo.id
    const messageId = generateStableId("msg_dcp_summary", deterministicSeed)
    const partId = generateStableId("prt_dcp_summary", deterministicSeed)

    return {
        info: {
            id: messageId,
            sessionID: userInfo.sessionID,
            role: "user" as const,
            agent: userInfo.agent,
            model: userInfo.model,
            // M2.5c Fix 5 — synthetic summary byte-stability. The seed already
            // yields stable messageId + partId + content; the only field that
            // varied per turn was time.created (Date.now()), which busted the
            // provider's prompt cache on every transform-hook fire even when
            // the summary text was identical. Ponytail: 0 is a safe sentinel
            // — the synthetic message is positioned by its anchorMessageId,
            // not by time. Caveat from review: after a real compaction
            // (`state.lastCompaction > 0`), `isMessageCompacted` (state/utils.ts)
            // returns true for this synthetic message because
            // `time.created < lastCompaction`. Today this is harmless because
            // the synthetic carries no tool parts (the prune-* loops skip
            // compacted messages at the top) — but a future "skip already-
            // counted" optimizer that reads `time.created` for user messages
            // would silently include this summary. If that lands, switch to
            // `state.lastCompaction + 1` so the synthetic is treated as new.
            time: { created: 0 },
        },
        parts: [
            {
                id: partId,
                sessionID: userInfo.sessionID,
                messageID: messageId,
                type: "text" as const,
                text: content,
            },
        ],
    }
}

export const createSyntheticTextPart = (
    baseMessage: WithParts,
    content: string,
    stableSeed?: string,
) => {
    const userInfo = baseMessage.info as UserMessage
    const deterministicSeed = stableSeed?.trim() || userInfo.id
    const partId = generateStableId("prt_dcp_text", deterministicSeed)

    return {
        id: partId,
        sessionID: userInfo.sessionID,
        messageID: userInfo.id,
        type: "text" as const,
        text: content,
    }
}

type MessagePart = WithParts["parts"][number]
type ToolPart = Extract<MessagePart, { type: "tool" }>
type TextPart = Extract<MessagePart, { type: "text" }>

export const appendToLastTextPart = (message: WithParts, injection: string): boolean => {
    const textPart = findLastTextPart(message)
    if (!textPart) {
        return false
    }

    return appendToTextPart(textPart, injection)
}

const findLastTextPart = (message: WithParts): TextPart | null => {
    for (let i = message.parts.length - 1; i >= 0; i--) {
        const part = message.parts[i]
        if (part.type === "text") {
            return part
        }
    }

    return null
}

export const appendToTextPart = (part: TextPart, injection: string): boolean => {
    if (typeof part.text !== "string") {
        return false
    }

    const normalizedInjection = injection.replace(/^\n+/, "")
    if (!normalizedInjection.trim()) {
        return false
    }
    // M2.5c Fix 5 — exact-tail idempotency. The previous substring match
    // (`part.text.includes(...)`) could give false positives if the same
    // tag appeared elsewhere in the message; on a transform-hook fire that
    // sees the message for the second time it would early-return without
    // mutating, but the call still bust the provider's prompt cache by
    // triggering a parent-object identity change. endsWith is both cheaper
    // and exact: only the most-recent appended tag suppresses a re-append.
    if (part.text.endsWith(normalizedInjection)) {
        return true
    }

    const baseText = part.text.replace(/\n*$/, "")
    part.text = baseText.length > 0 ? `${baseText}\n\n${normalizedInjection}` : normalizedInjection
    return true
}

export const appendToAllToolParts = (message: WithParts, tag: string): boolean => {
    let injected = false
    for (const part of message.parts) {
        if (part.type === "tool") {
            injected = appendToToolPart(part, tag) || injected
        }
    }
    return injected
}

export const appendToToolPart = (part: ToolPart, tag: string): boolean => {
    if (part.state?.status !== "completed" || typeof part.state.output !== "string") {
        return false
    }
    // M2.5c Fix 5 — exact-tail idempotency. See appendToTextPart above.
    if (part.state.output.endsWith(tag)) {
        return true
    }

    part.state.output = `${part.state.output}${tag}`
    return true
}

export const hasContent = (message: WithParts): boolean => {
    return message.parts.some(
        (part) =>
            (part.type === "text" &&
                typeof part.text === "string" &&
                part.text.trim().length > 0) ||
            (part.type === "tool" &&
                part.state?.status === "completed" &&
                typeof part.state.output === "string"),
    )
}

// ponytail: returns tool IDs filtered by `config.compress.protectedTools`
// when `config` is provided — callers that pass config see only prunable IDs.
// When `config` is omitted the function preserves the legacy raw-view
// contract (no protected-tools filter at the source); the existing
// pre-`config` callers continue to behave as before. Consumers that need
// protected-tool filtering at read time already do their own re-filter
// via `isToolNameProtected` — duplicating that here keeps each call site
// honest about which view of "prunable tools" it wants.
export function buildToolIdList(
    state: SessionState,
    messages: WithParts[],
    config?: PluginConfig,
): string[] {
    const protectedTools = config?.compress.protectedTools ?? []
    const toolIds: string[] = []
    for (const msg of messages) {
        if (isMessageCompacted(state, msg)) {
            continue
        }
        const parts = Array.isArray(msg.parts) ? msg.parts : []
        for (const part of parts) {
            if (part.type !== "tool" || !part.callID || !part.tool) continue
            if (isToolNameProtected(part.tool, protectedTools)) continue
            toolIds.push(part.callID)
        }
    }
    state.toolIdList = toolIds
    return toolIds
}

export const replaceBlockIdsWithBlocked = (text: string): string => {
    return text.replace(DCP_BLOCK_ID_TAG_REGEX, "$1BLOCKED$2")
}

export const stripHallucinationsFromString = (text: string): string => {
    return text.replace(DCP_PAIRED_TAG_REGEX, "").replace(DCP_UNPAIRED_TAG_REGEX, "")
}

export const stripHallucinations = (messages: WithParts[]): void => {
    for (const message of messages) {
        for (const part of message.parts) {
            if (part.type === "text" && typeof part.text === "string") {
                part.text = stripHallucinationsFromString(part.text)
            }

            if (
                part.type === "tool" &&
                part.state?.status === "completed" &&
                typeof part.state.output === "string"
            ) {
                part.state.output = stripHallucinationsFromString(part.state.output)
            }
        }
    }
}
