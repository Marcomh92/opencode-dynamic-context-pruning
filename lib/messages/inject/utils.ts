import type { SessionState, WithParts } from "../../state"
import type { PluginConfig } from "../../config"
import {
    appendGuidanceToDcpTag,
    buildCompressedBlockGuidance,
    renderMessagePriorityGuidance,
} from "../../prompts/extensions/nudge"
import type { RuntimePrompts } from "../../prompts/store"
import type { UserMessage } from "@opencode-ai/sdk/v2"
import {
    type CompressionPriorityMap,
    type MessagePriority,
    listPriorityRefsBeforeIndex,
} from "../priority"
import {
    appendToLastTextPart,
    createSyntheticTextPart,
    createSyntheticUserMessage,
    hasContent,
} from "../utils"
import { getLastUserMessage, isIgnoredUserMessage } from "../query"
import { getCurrentTokenUsage } from "../../token-utils"
import { getActiveSummaryTokenUsage } from "../../state/utils"

const MESSAGE_MODE_NUDGE_PRIORITY: MessagePriority = "high"

export interface LastUserModelContext {
    providerId: string | undefined
    modelId: string | undefined
}

export interface LastNonIgnoredMessage {
    message: WithParts
    index: number
}

export function getNudgeFrequency(config: PluginConfig): number {
    return Math.max(1, Math.floor(config.compress.nudgeFrequency || 1))
}

export function getIterationNudgeThreshold(config: PluginConfig): number {
    return Math.max(1, Math.floor(config.compress.iterationNudgeThreshold || 1))
}

export function findLastNonIgnoredMessage(messages: WithParts[]): LastNonIgnoredMessage | null {
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i]
        if (isIgnoredUserMessage(message)) {
            continue
        }
        return { message, index: i }
    }

    return null
}

export function countMessagesAfterIndex(messages: WithParts[], index: number): number {
    let count = 0

    for (let i = index + 1; i < messages.length; i++) {
        const message = messages[i]
        if (isIgnoredUserMessage(message)) {
            continue
        }
        count++
    }

    return count
}

export function getModelInfo(messages: WithParts[]): LastUserModelContext {
    const lastUserMessage = getLastUserMessage(messages)
    if (!lastUserMessage) {
        return {
            providerId: undefined,
            modelId: undefined,
        }
    }

    const userInfo = lastUserMessage.info as UserMessage
    return {
        providerId: userInfo.model.providerID,
        modelId: userInfo.model.modelID,
    }
}

function resolveContextTokenLimit(
    config: PluginConfig,
    state: SessionState,
    providerId: string | undefined,
    modelId: string | undefined,
    threshold: "max" | "min",
): number | undefined {
    const parseLimitValue = (limit: number | `${number}%` | undefined): number | undefined => {
        if (limit === undefined) {
            return undefined
        }

        if (typeof limit === "number") {
            return limit
        }

        if (!limit.endsWith("%") || state.modelContextLimit === undefined) {
            return undefined
        }

        const parsedPercent = parseFloat(limit.slice(0, -1))
        if (isNaN(parsedPercent)) {
            return undefined
        }

        const roundedPercent = Math.round(parsedPercent)
        const clampedPercent = Math.max(0, Math.min(100, roundedPercent))
        return Math.round((clampedPercent / 100) * state.modelContextLimit)
    }

    const modelLimits =
        threshold === "max" ? config.compress.modelMaxLimits : config.compress.modelMinLimits
    if (modelLimits && providerId !== undefined && modelId !== undefined) {
        const providerModelId = `${providerId}/${modelId}`
        const modelLimit = modelLimits[providerModelId]
        if (modelLimit !== undefined) {
            return parseLimitValue(modelLimit)
        }
    }

    const globalLimit =
        threshold === "max" ? config.compress.maxContextLimit : config.compress.minContextLimit
    return parseLimitValue(globalLimit)
}

export function isContextOverLimits(
    config: PluginConfig,
    state: SessionState,
    providerId: string | undefined,
    modelId: string | undefined,
    messages: WithParts[],
) {
    const summaryTokenExtension = config.compress.summaryBuffer
        ? getActiveSummaryTokenUsage(state)
        : 0
    const resolvedMaxContextLimit = resolveContextTokenLimit(
        config,
        state,
        providerId,
        modelId,
        "max",
    )
    const maxContextLimit =
        resolvedMaxContextLimit === undefined
            ? undefined
            : resolvedMaxContextLimit + summaryTokenExtension
    const resolvedMinContextLimit = resolveContextTokenLimit(
        config,
        state,
        providerId,
        modelId,
        "min",
    )
    // ponytail: scales the same summary extension onto `minContextLimit` so the
    // min threshold rises with active summary size (default 0.2 = 20%). 0 cleanly
    // disables without needing a separate boolean. Undefined → undefined so the
    // "always nudge when min is unset" semantics below remain intact.
    const minContextLimit =
        resolvedMinContextLimit === undefined
            ? undefined
            : resolvedMinContextLimit +
              summaryTokenExtension * (config.compress.summaryBufferMinRatio ?? 0)
    const currentTokens = getCurrentTokenUsage(state, messages)

    const overMaxLimit = maxContextLimit === undefined ? false : currentTokens > maxContextLimit
    const overMinLimit = minContextLimit === undefined ? true : currentTokens >= minContextLimit

    return {
        overMaxLimit,
        overMinLimit,
    }
}

export function addAnchor(
    anchorMessageIds: Set<string>,
    anchorMessageId: string,
    anchorMessageIndex: number,
    messages: WithParts[],
    interval: number,
): boolean {
    if (anchorMessageIndex < 0) {
        return false
    }

    let latestAnchorMessageIndex = -1
    for (let i = messages.length - 1; i >= 0; i--) {
        if (anchorMessageIds.has(messages[i].info.id)) {
            latestAnchorMessageIndex = i
            break
        }
    }

    const shouldAdd =
        latestAnchorMessageIndex < 0 || anchorMessageIndex - latestAnchorMessageIndex >= interval
    if (!shouldAdd) {
        return false
    }

    const previousSize = anchorMessageIds.size
    anchorMessageIds.add(anchorMessageId)
    return anchorMessageIds.size !== previousSize
}

function buildMessagePriorityGuidance(
    messages: WithParts[],
    compressionPriorities: CompressionPriorityMap | undefined,
    anchorIndex: number,
    priority: MessagePriority,
): string {
    if (!compressionPriorities || compressionPriorities.size === 0) {
        return ""
    }

    const refs = listPriorityRefsBeforeIndex(messages, compressionPriorities, anchorIndex, priority)
    const priorityLabel = `${priority[0].toUpperCase()}${priority.slice(1)}`

    return renderMessagePriorityGuidance(priorityLabel, refs)
}

type NudgeType = "iteration" | "turn" | "context_limit"

function injectAnchoredNudge(
    message: WithParts,
    index: number,
    messages: WithParts[],
    nudgeText: string,
    nudgeType: NudgeType,
): void {
    if (!nudgeText.trim()) {
        return
    }

    if (message.info.role === "user") {
        if (appendToLastTextPart(message, nudgeText)) {
            return
        }

        message.parts.push(createSyntheticTextPart(message, nudgeText))
        return
    }

    if (message.info.role !== "assistant") {
        return
    }

    if (!hasContent(message)) {
        return
    }

    // BUG-098: insert a synthetic user message at messages[index + 1]. The role
    // boundary lets the model read the directive as inbound rather than as its
    // own prior speech (the old append-to-assistant-text behaviour was ignored
    // because the tail read as past self-quoted text). Three invariants the
    // call site MUST preserve:
    //   (1) the synthetic text part carries `synthetic: true` so
    //       `isIgnoredUserMessage` (query.ts:54) skips it — otherwise each
    //       nudge would reset the iteration counter via countMessagesAfterIndex
    //       AND become the "last user message" for protectUserMessages;
    //   (2) the seed is deterministic (`dcp_nudge:<nudgeType>:<anchorId>`) so
    //       the messageId is stable across transform-hook re-fires;
    //   (3) idempotency is enforced by checking messages[index+1].info.id
    //       against the deterministic messageId — replaces the old endsWith
    //       check on the assistant's last text part.
    // Callers iterate in reverse-index order so an insert here does not shift
    // the indices of anchors still to be visited.
    const seed = `dcp_nudge:${nudgeType}:${message.info.id}`
    const syntheticMessage = createSyntheticUserMessage(message, nudgeText, seed, true)
    const adjacent = messages[index + 1]
    if (adjacent && adjacent.info.id === syntheticMessage.info.id) {
        return
    }
    messages.splice(index + 1, 0, syntheticMessage)
}

function collectAnchoredMessages(
    anchorMessageIds: Set<string>,
    messages: WithParts[],
): Array<{ message: WithParts; index: number }> {
    const anchoredMessages: Array<{ message: WithParts; index: number }> = []

    for (const anchorMessageId of anchorMessageIds) {
        const index = messages.findIndex((message) => message.info.id === anchorMessageId)
        if (index === -1) {
            continue
        }

        anchoredMessages.push({
            message: messages[index],
            index,
        })
    }

    return anchoredMessages
}

function collectTurnNudgeAnchors(
    state: SessionState,
    config: PluginConfig,
    messages: WithParts[],
): Set<string> {
    const turnNudgeAnchors = new Set<string>()
    const targetRole = config.compress.nudgeForce === "strong" ? "user" : "assistant"

    for (const message of messages) {
        if (!state.nudges.turnNudgeAnchors.has(message.info.id)) continue

        if (message.info.role === targetRole) {
            turnNudgeAnchors.add(message.info.id)
        }
    }

    return turnNudgeAnchors
}

function applyRangeModeAnchoredNudge(
    anchorMessageIds: Set<string>,
    messages: WithParts[],
    baseNudgeText: string,
    compressedBlockGuidance: string,
    nudgeType: NudgeType,
): void {
    const nudgeText = appendGuidanceToDcpTag(baseNudgeText, compressedBlockGuidance)
    if (!nudgeText.trim()) {
        return
    }

    // BUG-098: iterate highest-index first so an insert at index+1 does not
    // shift the indices of anchors still to be visited.
    const anchoredMessages = collectAnchoredMessages(anchorMessageIds, messages)
    anchoredMessages.sort((a, b) => b.index - a.index)
    for (const { message, index } of anchoredMessages) {
        injectAnchoredNudge(message, index, messages, nudgeText, nudgeType)
    }
}

function applyMessageModeAnchoredNudge(
    anchorMessageIds: Set<string>,
    messages: WithParts[],
    baseNudgeText: string,
    nudgeType: NudgeType,
    compressionPriorities?: CompressionPriorityMap,
): void {
    // BUG-098: iterate highest-index first so an insert at index+1 does not
    // shift the indices of anchors still to be visited. The priorityGuidance
    // is keyed off the anchor's position; with reverse iteration the index
    // we pass to buildMessagePriorityGuidance is the original anchor index
    // (not affected by inserts we have not done yet).
    const anchoredMessages = collectAnchoredMessages(anchorMessageIds, messages)
    anchoredMessages.sort((a, b) => b.index - a.index)
    for (const { message, index } of anchoredMessages) {
        const priorityGuidance = buildMessagePriorityGuidance(
            messages,
            compressionPriorities,
            index,
            MESSAGE_MODE_NUDGE_PRIORITY,
        )
        const nudgeText = appendGuidanceToDcpTag(baseNudgeText, priorityGuidance)
        injectAnchoredNudge(message, index, messages, nudgeText, nudgeType)
    }
}

export function applyAnchoredNudges(
    state: SessionState,
    config: PluginConfig,
    messages: WithParts[],
    prompts: RuntimePrompts,
    compressionPriorities?: CompressionPriorityMap,
): void {
    const turnNudgeAnchors = collectTurnNudgeAnchors(state, config, messages)

    if (config.compress.mode === "message") {
        applyMessageModeAnchoredNudge(
            state.nudges.contextLimitAnchors,
            messages,
            prompts.contextLimitNudge,
            "context_limit",
            compressionPriorities,
        )
        applyMessageModeAnchoredNudge(
            turnNudgeAnchors,
            messages,
            prompts.turnNudge,
            "turn",
            compressionPriorities,
        )
        applyMessageModeAnchoredNudge(
            state.nudges.iterationNudgeAnchors,
            messages,
            prompts.iterationNudge,
            "iteration",
            compressionPriorities,
        )
        return
    }

    const compressedBlockGuidance = buildCompressedBlockGuidance(state)
    applyRangeModeAnchoredNudge(
        state.nudges.contextLimitAnchors,
        messages,
        prompts.contextLimitNudge,
        compressedBlockGuidance,
        "context_limit",
    )
    applyRangeModeAnchoredNudge(
        turnNudgeAnchors,
        messages,
        prompts.turnNudge,
        compressedBlockGuidance,
        "turn",
    )
    applyRangeModeAnchoredNudge(
        state.nudges.iterationNudgeAnchors,
        messages,
        prompts.iterationNudge,
        compressedBlockGuidance,
        "iteration",
    )
}
