import { PluginConfig } from "../config"
import { Logger } from "../logger"
import type { SessionState, WithParts } from "../state"
import { isMessageCompacted } from "../state/utils"
import {
    getFilePathsFromParameters,
    isFilePathProtected,
    isToolNameProtected,
} from "../protected-patterns"

/** Build the set of candidate tool IDs from the freshly fetched messages,
 *  ignoring any stale `state.toolIdList` from earlier transform fires.
 *  ponytail: O(|messages|) over the just-emitted stream — chat-transform and
 *  compress pipelines both pass `messages`, so the strategies always see the
 *  same view the rest of the pipeline does. Mirrors the inner loop of
 *  buildToolIdList (lib/messages/utils.ts) without mutating state.
 *
 *  BUG-009 fallback: when `messages` carries no tool parts (compress-pipeline
 *  test fixtures mock `client.session.messages` to return empty data, and the
 *  test seeds `state.toolParameters` directly), fall back to the pre-populated
 *  `state.toolIdList` so the strategy still iterates. Production sessions
 *  always have messages, so this branch is defensive — the compress pipeline
 *  itself owns strategy iteration. */
const freshToolIds = (state: SessionState, messages: WithParts[]): string[] => {
    const ids: string[] = []
    for (const msg of messages) {
        if (isMessageCompacted(state, msg)) {
            continue
        }
        const parts = Array.isArray(msg.parts) ? msg.parts : []
        for (const part of parts) {
            if (part.type === "tool" && part.callID && part.tool) {
                ids.push(part.callID)
            }
        }
    }
    if (ids.length === 0 && state.toolIdList.length > 0) {
        return [...state.toolIdList]
    }
    return ids
}

/**
 * Deduplication strategy - prunes older tool calls that have identical
 * tool name and parameters, keeping only the most recent occurrence.
 * Modifies the session state in place to add pruned tool call IDs.
 */
export const deduplicate = (
    state: SessionState,
    logger: Logger,
    config: PluginConfig,
    messages: WithParts[],
): void => {
    if (state.manualMode && !config.manualMode.automaticStrategies) {
        return
    }

    if (!config.strategies.deduplication.enabled) {
        return
    }

    // BUG-045: derive the candidate set from `messages`, not
    // `state.toolIdList` — the latter is rebuilt by buildToolIdList only on
    // chat-transform fires; compress-pipeline calls see a stale list and
    // would otherwise early-return on an empty list that should be non-empty.
    const allToolIds = freshToolIds(state, messages)
    if (allToolIds.length === 0) {
        return
    }

    // Filter out IDs already pruned
    const unprunedIds = allToolIds.filter((id) => !state.prune.tools.has(id))

    if (unprunedIds.length === 0) {
        return
    }

    const protectedTools = config.strategies.deduplication.protectedTools

    // Group by signature (tool name + normalized parameters)
    const signatureMap = new Map<string, string[]>()

    for (const id of unprunedIds) {
        const metadata = state.toolParameters.get(id)
        if (!metadata) {
            // logger.warn(`Missing metadata for tool call ID: ${id}`)
            continue
        }

        // Skip protected tools
        if (isToolNameProtected(metadata.tool, protectedTools)) {
            continue
        }

        const filePaths = getFilePathsFromParameters(metadata.tool, metadata.parameters)
        if (isFilePathProtected(filePaths, config.protectedFilePatterns)) {
            continue
        }

        const signature = createToolSignature(metadata.tool, metadata.parameters)
        if (!signatureMap.has(signature)) {
            signatureMap.set(signature, [])
        }
        const ids = signatureMap.get(signature)
        if (ids) {
            ids.push(id)
        }
    }

    // Find duplicates - keep only the most recent (last) in each group
    const newPruneIds: string[] = []

    for (const [, ids] of signatureMap.entries()) {
        if (ids.length > 1) {
            // All except last (most recent) should be pruned
            const idsToRemove = ids.slice(0, -1)
            newPruneIds.push(...idsToRemove)
        }
    }

    if (newPruneIds.length > 0) {
        // ponytail: single .get pass — mark + accumulate tokens together rather
        // than running getTotalToolTokens + the marking loop as two passes (each
        // would .get the same id). The combined loop keeps token totals in sync
        // with state.prune.tools and halves the metadata lookups for newPruneIds.
        let pruneTokens = 0
        for (const id of newPruneIds) {
            const entry = state.toolParameters.get(id)
            const tokenCount = entry?.tokenCount ?? 0
            pruneTokens += tokenCount
            state.prune.tools.set(id, tokenCount)
        }
        state.stats.totalPruneTokens += pruneTokens
        logger.debug(`Marked ${newPruneIds.length} duplicate tool calls for pruning`)
    }
}

function createToolSignature(tool: string, parameters?: any): string {
    if (!parameters) {
        return tool
    }
    const normalized = normalizeParameters(parameters)
    const sorted = sortObjectKeys(normalized)
    return `${tool}::${JSON.stringify(sorted)}`
}

function normalizeParameters(params: any): any {
    if (typeof params !== "object" || params === null) return params
    if (Array.isArray(params)) return params

    const normalized: any = {}
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) {
            normalized[key] = value
        }
    }
    return normalized
}

function sortObjectKeys(obj: any): any {
    if (typeof obj !== "object" || obj === null) return obj
    if (Array.isArray(obj)) return obj.map(sortObjectKeys)

    const sorted: any = {}
    for (const key of Object.keys(obj).sort()) {
        sorted[key] = sortObjectKeys(obj[key])
    }
    return sorted
}
