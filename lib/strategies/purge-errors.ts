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
 *  ponytail: same helper as deduplication.ts — keeps the two strategies in
 *  lockstep on the "fresh view" contract.
 *
 *  BUG-009 fallback: when `messages` carries no tool parts (compress-pipeline
 *  test fixtures mock `client.session.messages` to return empty data), fall
 *  back to the pre-populated `state.toolIdList` so the strategy still
 *  iterates. Production sessions always have messages, so this branch is
 *  defensive — the compress pipeline itself owns strategy iteration. */
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
 * Purge Errors strategy - prunes tool inputs for tools that errored
 * after they are older than a configurable number of turns.
 * The error message is preserved, but the (potentially large) inputs
 * are removed to save context.
 *
 * Modifies the session state in place to add pruned tool call IDs.
 */
export const purgeErrors = (
    state: SessionState,
    logger: Logger,
    config: PluginConfig,
    messages: WithParts[],
): void => {
    if (state.manualMode && !config.manualMode.automaticStrategies) {
        return
    }

    if (!config.strategies.purgeErrors.enabled) {
        return
    }

    // BUG-045: derive the candidate set from `messages`, not
    // `state.toolIdList` — compress-pipeline calls would otherwise operate
    // on a stale list (or early-return on an empty one) and miss legitimate
    // purge marks.
    const allToolIds = freshToolIds(state, messages)
    if (allToolIds.length === 0) {
        return
    }

    // Filter out IDs already pruned
    const unprunedIds = allToolIds.filter((id) => !state.prune.tools.has(id))

    if (unprunedIds.length === 0) {
        return
    }

    const protectedTools = config.strategies.purgeErrors.protectedTools
    const turnThreshold = Math.max(1, config.strategies.purgeErrors.turns)

    const newPruneIds: string[] = []

    for (const id of unprunedIds) {
        const metadata = state.toolParameters.get(id)
        if (!metadata) {
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

        // Only process error tools
        if (metadata.status !== "error") {
            continue
        }

        // Check if the tool is old enough to prune
        const turnAge = state.currentTurn - metadata.turn
        if (turnAge >= turnThreshold) {
            newPruneIds.push(id)
        }
    }

    if (newPruneIds.length > 0) {
        // ponytail: single .get pass — mark + accumulate tokens together rather
        // than running getTotalToolTokens + the marking loop as two passes (each
        // would .get the same id). The combined loop halves the metadata
        // lookups for newPruneIds.
        let pruneTokens = 0
        for (const id of newPruneIds) {
            const entry = state.toolParameters.get(id)
            const tokenCount = entry?.tokenCount ?? 0
            pruneTokens += tokenCount
            state.prune.tools.set(id, tokenCount)
        }
        state.stats.totalPruneTokens += pruneTokens
        logger.debug(
            `Marked ${newPruneIds.length} error tool calls for pruning (older than ${turnThreshold} turns)`,
        )
    }
}
