import type { SessionState } from "../state"
import { isIgnoredUserMessage } from "../messages/query"
import { stripText } from "../messages/strip-patterns"
import {
    getFilePathsFromParameters,
    isFilePathProtected,
    isToolNameProtected,
} from "../protected-patterns"
import { mergeSubagentResult } from "../subagents/subagent-results"
import { buildSubAgentCacheKey } from "../subagents/cache-key"
import type { SearchContext, SelectionResolution } from "./types"

export function appendProtectedUserMessages(
    summary: string,
    selection: SelectionResolution,
    searchContext: SearchContext,
    state: SessionState,
    enabled: boolean,
    stripPatterns: readonly string[] = [],
    count: number = Number.POSITIVE_INFINITY,
): string {
    if (!enabled) return summary

    const userTexts: string[] = []

    for (const messageId of selection.messageIds) {
        const existingCompressionEntry = state.prune.messages.byMessageId.get(messageId)
        if (existingCompressionEntry && existingCompressionEntry.activeBlockIds.length > 0) {
            continue
        }

        const message = searchContext.rawMessagesById.get(messageId)
        if (!message) continue
        if (message.info.role !== "user") continue
        if (isIgnoredUserMessage(message)) continue

        const parts = Array.isArray(message.parts) ? message.parts : []
        for (const part of parts) {
            if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
                // BUG-096: messages whose text is fully consumed by
                // stripPatterns are filtered out AND do not count toward
                // the "last N" cap. Push only when the stripped result
                // still has visible content.
                const stripped = stripText(part.text, stripPatterns)
                if (stripped.trim()) {
                    userTexts.push(stripped)
                }
                break
            }
        }
    }

    // BUG-096: take only the last N real user messages from the
    // compression range. `userTexts` is already in selection order, so
    // a tail slice gives the most recent N. `Number.POSITIVE_INFINITY`
    // (the default) keeps the legacy "all" behaviour for callers that
    // do not pass a cap.
    const lastN =
        count >= userTexts.length || !Number.isFinite(count) ? userTexts : userTexts.slice(-count)

    if (lastN.length === 0) {
        return summary
    }

    const heading = "\n\nThe following user messages were sent in this conversation verbatim:"
    // ponytail: per-message heading mirrors the heading style used in
    // `appendProtectedTools` below (a `### ...` heading per protected
    // item). We use a `\n\n` separator here so multiple entries get a
    // blank line between them — the protected-tools section is one item
    // per tool call so it does not need the same. Ordinal labels are
    // local to this protected section — they are NOT `mNNNN` refs and
    // have no stable meaning across re-materializations. Switch to
    // OpenCode session IDs if the agent ever needs cross-transform
    // anchoring.
    const body = lastN
        .map((text, i) => `\n\n### User message ${i + 1} of ${lastN.length}\n${text}`)
        .join("")
    return summary + heading + body
}

export function appendProtectedPromptInfo(
    summary: string,
    selection: SelectionResolution,
    searchContext: SearchContext,
    state: SessionState,
    enabled: boolean,
    stripPatterns: readonly string[] = [],
): string {
    if (!enabled) return summary

    const protectedTexts: string[] = []

    for (const messageId of selection.messageIds) {
        const existingCompressionEntry = state.prune.messages.byMessageId.get(messageId)
        if (existingCompressionEntry && existingCompressionEntry.activeBlockIds.length > 0) {
            continue
        }

        const message = searchContext.rawMessagesById.get(messageId)
        if (!message) continue
        if (message.info.role !== "user") continue
        if (isIgnoredUserMessage(message)) continue

        const parts = Array.isArray(message.parts) ? message.parts : []
        for (const part of parts) {
            if (part.type !== "text" || typeof part.text !== "string") continue

            for (const protectedText of extractProtectedPromptInfo(part.text)) {
                protectedTexts.push(stripText(protectedText, stripPatterns))
            }
        }
    }

    if (protectedTexts.length === 0) {
        return summary
    }

    const heading =
        "\n\nThe following protected prompt information was included in this conversation verbatim:"
    const body = protectedTexts.map((text) => `\n${text}`).join("")
    return summary + heading + body
}

export function extractProtectedPromptInfo(text: string): string[] {
    const protectedTexts: string[] = []
    const protectTagRegex = /<protect>([\s\S]*?)<\/protect>/gi

    for (const match of text.matchAll(protectTagRegex)) {
        const protectedText = match[1]?.trim()
        if (protectedText) {
            protectedTexts.push(protectedText)
        }
    }

    return protectedTexts
}

export async function appendProtectedTools(
    _client: any,
    state: SessionState,
    allowSubAgents: boolean,
    summary: string,
    selection: SelectionResolution,
    searchContext: SearchContext,
    protectedTools: string[],
    protectedFilePatterns: string[] = [],
): Promise<string> {
    const protectedOutputs: string[] = []

    for (const messageId of selection.messageIds) {
        const existingCompressionEntry = state.prune.messages.byMessageId.get(messageId)
        if (existingCompressionEntry && existingCompressionEntry.activeBlockIds.length > 0) {
            continue
        }

        const message = searchContext.rawMessagesById.get(messageId)
        if (!message) continue

        const parts = Array.isArray(message.parts) ? message.parts : []
        for (const part of parts) {
            if (part.type === "tool" && part.callID) {
                let isToolProtected = isToolNameProtected(part.tool, protectedTools)

                if (!isToolProtected && protectedFilePatterns.length > 0) {
                    const filePaths = getFilePathsFromParameters(part.tool, part.state?.input)
                    if (isFilePathProtected(filePaths, protectedFilePatterns)) {
                        isToolProtected = true
                    }
                }

                if (isToolProtected) {
                    const title = `Tool: ${part.tool}`
                    let output = ""

                    if (part.state?.status === "completed" && part.state?.output) {
                        output =
                            typeof part.state.output === "string"
                                ? part.state.output
                                : JSON.stringify(part.state.output)
                    }

                    // #595: cache HIT merges the cached subagent text into the
                    // part's output. Cache MISS leaves `part.state.output`
                    // untouched — the part's own output is the round-correct
                    // value. The previous fetch-and-merge-with-current-subagent-
                    // state behaviour was the bug. PLAN §6.5.
                    //
                    // Cache lookup happens unconditionally for completed task
                    // parts so the HIT path is exercised; MISS simply skips the
                    // merge (no fetch). When the part lacks a subagent session
                    // ID in metadata, the composite key degenerates to a bare
                    // callID — same observable behavior as the legacy key.
                    if (
                        allowSubAgents &&
                        part.tool === "task" &&
                        part.state?.status === "completed" &&
                        typeof part.state?.output === "string"
                    ) {
                        const subAgentSessionId = part.state?.metadata?.sessionId
                        const sessionKey =
                            typeof subAgentSessionId === "string" && subAgentSessionId.length > 0
                                ? subAgentSessionId
                                : ""
                        const cacheKey = buildSubAgentCacheKey(sessionKey, part.callID)
                        const cachedSubAgentResult = state.subAgentResultCache.get(cacheKey)
                        if (cachedSubAgentResult && cachedSubAgentResult.text) {
                            output = mergeSubagentResult(
                                part.state.output,
                                cachedSubAgentResult.text,
                            )
                        }
                    }

                    if (output) {
                        protectedOutputs.push(`\n### ${title}\n${output}`)
                    }
                }
            }
        }
    }

    if (protectedOutputs.length === 0) {
        return summary
    }

    const heading = "\n\nThe following protected tools were used in this conversation as well:"
    return summary + heading + protectedOutputs.join("")
}
