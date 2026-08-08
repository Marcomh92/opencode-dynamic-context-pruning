import type { WithParts } from "../state"
import { getLastUserMessage } from "./query"

/** Key prefixes on `part.metadata` that identify model/provider-internal
 *  fields (e.g. `modelVersion`, `requestId`, `providerMetadata`). On a
 *  cross-model switch these are dropped because they refer to the model
 *  that just left the conversation. All other keys are treated as caller-
 *  attached data and preserved — third-party tools (e.g. `task`) record
 *  caller identity on this surface and losing it across a model switch is
 *  a silent regression for downstream readers. */
const MODEL_INTERNAL_KEY_PREFIXES: readonly string[] = ["model", "request", "provider"]

const isModelInternalKey = (key: string): boolean => {
    const lower = key.toLowerCase()
    return MODEL_INTERNAL_KEY_PREFIXES.some((prefix) => lower.startsWith(prefix))
}

/**
 * Mirrors opencode's differentModel handling by preserving part content while
 * dropping provider metadata on assistant parts that came from a different
 * model/provider than the current turn's user message.
 *
 * ponytail: only model/provider/request-prefixed fields are stripped. Caller-
 * attached keys (`sessionId`, `caller`, `traceId`, …) survive because they
 * describe the round, not the model that produced it. `part.state.metadata`
 * is the load-bearing surface and is not touched here.
 */
export function stripStaleMetadata(messages: WithParts[]): void {
    const lastUserMessage = getLastUserMessage(messages)
    if (lastUserMessage?.info.role !== "user") {
        return
    }

    const modelID = lastUserMessage.info.model.modelID
    const providerID = lastUserMessage.info.model.providerID

    messages.forEach((message) => {
        if (message.info.role !== "assistant") {
            return
        }

        if (message.info.modelID === modelID && message.info.providerID === providerID) {
            return
        }

        message.parts = message.parts.map((part) => {
            if (part.type !== "text" && part.type !== "tool" && part.type !== "reasoning") {
                return part
            }

            const metadata = (part as { metadata?: unknown }).metadata
            if (!metadata || typeof metadata !== "object") {
                return part
            }

            const filtered: Record<string, unknown> = {}
            for (const [key, value] of Object.entries(metadata as Record<string, unknown>)) {
                if (isModelInternalKey(key)) {
                    continue
                }
                filtered[key] = value
            }

            return { ...part, metadata: filtered }
        })
    })
}
