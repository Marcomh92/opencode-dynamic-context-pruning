import type { SessionState, WithParts } from "./state"
import { isIgnoredUserMessage } from "./messages/query"

const MESSAGE_REF_REGEX = /^m(\d{4})$/
const BLOCK_REF_REGEX = /^b([1-9]\d*)$/
const MESSAGE_ID_TAG_NAME = "dcp-message-id"

const MESSAGE_REF_WIDTH = 4
const MESSAGE_REF_MIN_INDEX = 1
export const MESSAGE_REF_MAX_INDEX = 9999

export type ParsedBoundaryId =
    | {
          kind: "message"
          ref: string
          index: number
      }
    | {
          kind: "compressed-block"
          ref: string
          blockId: number
      }

export function formatMessageRef(index: number): string {
    if (
        !Number.isInteger(index) ||
        index < MESSAGE_REF_MIN_INDEX ||
        index > MESSAGE_REF_MAX_INDEX
    ) {
        throw new Error(
            `Message ID index out of bounds: ${index}. Supported range is 0-${MESSAGE_REF_MAX_INDEX}.`,
        )
    }
    return `m${index.toString().padStart(MESSAGE_REF_WIDTH, "0")}`
}

export function formatBlockRef(blockId: number): string {
    if (!Number.isInteger(blockId) || blockId < 1) {
        throw new Error(`Invalid block ID: ${blockId}`)
    }
    return `b${blockId}`
}

export function parseMessageRef(ref: string): number | null {
    const normalized = ref.trim().toLowerCase()
    const match = normalized.match(MESSAGE_REF_REGEX)
    if (!match) {
        return null
    }
    const index = Number.parseInt(match[1], 10)
    if (!Number.isInteger(index)) {
        return null
    }
    if (index < MESSAGE_REF_MIN_INDEX || index > MESSAGE_REF_MAX_INDEX) {
        return null
    }
    return index
}

export function parseBlockRef(ref: string): number | null {
    const normalized = ref.trim().toLowerCase()
    const match = normalized.match(BLOCK_REF_REGEX)
    if (!match) {
        return null
    }
    const id = Number.parseInt(match[1], 10)
    return Number.isInteger(id) ? id : null
}

export function parseBoundaryId(id: string): ParsedBoundaryId | null {
    const normalized = id.trim().toLowerCase()
    const messageIndex = parseMessageRef(normalized)
    if (messageIndex !== null) {
        return {
            kind: "message",
            ref: formatMessageRef(messageIndex),
            index: messageIndex,
        }
    }

    const blockId = parseBlockRef(normalized)
    if (blockId !== null) {
        return {
            kind: "compressed-block",
            ref: formatBlockRef(blockId),
            blockId,
        }
    }

    return null
}

function escapeXmlAttribute(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
}

export function formatMessageIdTag(
    ref: string,
    attributes?: Record<string, string | undefined>,
): string {
    const serializedAttributes = Object.entries(attributes || {})
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, value]) => {
            if (name.trim().length === 0 || typeof value !== "string" || value.length === 0) {
                return ""
            }

            return ` ${name}="${escapeXmlAttribute(value)}"`
        })
        .join("")

    return `\n<${MESSAGE_ID_TAG_NAME}${serializedAttributes}>${ref}</${MESSAGE_ID_TAG_NAME}>`
}

export function assignMessageRefs(state: SessionState, messages: WithParts[]): number {
    let assigned = 0
    let skippedSubAgentPrompt = false

    for (const message of messages) {
        if (isIgnoredUserMessage(message)) {
            continue
        }

        if (state.isSubAgent && !skippedSubAgentPrompt && message.info.role === "user") {
            skippedSubAgentPrompt = true
            continue
        }

        const rawMessageId = message.info.id
        if (typeof rawMessageId !== "string" || rawMessageId.length === 0) {
            continue
        }

        const existingRef = state.messageIds.byRawId.get(rawMessageId)
        if (existingRef) {
            if (state.messageIds.byRef.get(existingRef) !== rawMessageId) {
                state.messageIds.byRef.set(existingRef, rawMessageId)
            }
            continue
        }

        const ref = allocateNextMessageRef(state)
        // ponytail: capacity-exhausted sentinel. Returning "" lets the caller
        // skip silently instead of throwing through the transform pipeline
        // (BUG-074). The caller treats "" as "no ref available for this message".
        if (ref === "") {
            continue
        }
        state.messageIds.byRawId.set(rawMessageId, ref)
        state.messageIds.byRef.set(ref, rawMessageId)
        assigned++
    }

    return assigned
}

// BUG-083: tiered one-shot capacity warning thresholds. Each threshold is
// emitted at most once per sessionId (Map-based guard) so a session near
// the cap does not spam the log on every allocation, but a fresh session
// that crosses the same threshold does get its own warn. Tiered surfaces
// give the user progressively more urgent notice before the
// MESSAGE_REF_MAX_INDEX = 9999 hard cap is reached. ponytail: console.warn
// (not logger.warn) so this module stays logger-agnostic; the call site
// in hooks.ts owns the logger and could mirror to its own channel if
// desired. In-memory Map (not persisted via state.messageIds) so we do
// not need a forkSchemaVersion bump.
const CAPACITY_WARN_THRESHOLDS = [5000, 7500, 9000] as const
const firedCapacityWarningsBySession = new Map<string, Set<number>>()

function warnCapacityApproaching(sessionId: string | null, nextRef: number): void {
    if (!sessionId) return
    let fired = firedCapacityWarningsBySession.get(sessionId)
    if (!fired) {
        fired = new Set()
        firedCapacityWarningsBySession.set(sessionId, fired)
    }
    for (const threshold of CAPACITY_WARN_THRESHOLDS) {
        if (nextRef >= threshold && !fired.has(threshold)) {
            fired.add(threshold)
            // eslint-disable-next-line no-console
            console.warn(
                `[dcp] Message ID capacity approaching: nextRef=${nextRef} (>= ${threshold} of ${MESSAGE_REF_MAX_INDEX}). Consider compressing older history.`,
            )
        }
    }
}

function allocateNextMessageRef(state: SessionState): string {
    let candidate = Number.isInteger(state.messageIds.nextRef)
        ? Math.max(MESSAGE_REF_MIN_INDEX, state.messageIds.nextRef)
        : MESSAGE_REF_MIN_INDEX

    // BUG-083: warn before the hard cap. Done before the loop so a single
    // crossed threshold surfaces once per allocation pass.
    warnCapacityApproaching(state.sessionId, candidate)

    while (candidate <= MESSAGE_REF_MAX_INDEX) {
        const ref = formatMessageRef(candidate)
        if (!state.messageIds.byRef.has(ref)) {
            state.messageIds.nextRef = candidate + 1
            return ref
        }
        candidate++
    }

    // ponytail: degrade gracefully rather than throwing through the transform
    // pipeline (BUG-074). Returning "" lets `assignMessageRefs` skip this
    // message silently — defence-in-depth alongside the outer try/catch in
    // createChatMessageTransformHandler (BUG-028).
    return ""
}

/** Reclaim m-NNNN refs for messages whose sole active block is being
 *  deactivated. Reads the PRE-sync `byMessageId[msg].activeBlockIds` so a
 *  message covered by another block (whether currently in `activeBlockIds`
 *  or not) is preserved. Tightens `nextRef` so the freed slot is reusable
 *  on the next allocation.
 *
 *  BUG-025: without eviction, m-NNNN entries leak until the 9999 cap is hit,
 *  at which point `Message ID alias capacity exceeded` breaks the LLM call.
 *
 *  ponytail: O(block.effectiveMessageIds.length) per deactivation; the same
 *  pass the block-deactivation path already does for `byMessageId`. */
export function evictMessageRefsForBlock(
    state: SessionState,
    blockId: number,
    logger?: { debug: (message: string, context?: Record<string, unknown>) => void },
): void {
    const block = state.prune.messages.blocksById.get(blockId)
    if (!block) {
        return
    }

    let evicted = 0
    let lowestEvictedIndex = Number.POSITIVE_INFINITY

    for (const messageId of block.effectiveMessageIds) {
        const entry = state.prune.messages.byMessageId.get(messageId)
        if (!entry) {
            continue
        }

        // Preserve if the message is covered by any other active block per
        // its pre-sync `activeBlockIds` (this is the canonical cross-reference
        // for "what blocks did the user think covered this message?").
        const stillCovered = entry.activeBlockIds.some((id) => id !== blockId)
        if (stillCovered) {
            continue
        }

        const ref = state.messageIds.byRawId.get(messageId)
        if (!ref) {
            continue
        }

        state.messageIds.byRawId.delete(messageId)
        state.messageIds.byRef.delete(ref)

        const index = parseMessageRef(ref)
        if (index !== null && index < lowestEvictedIndex) {
            lowestEvictedIndex = index
        }
        evicted++
    }

    if (evicted > 0) {
        if (Number.isFinite(lowestEvictedIndex) && lowestEvictedIndex < state.messageIds.nextRef) {
            state.messageIds.nextRef = Math.max(MESSAGE_REF_MIN_INDEX, lowestEvictedIndex)
        }
        if (logger) {
            logger.debug("Evicted m-NNNN refs on block deactivation", { blockId, evicted })
        }
    }
}
