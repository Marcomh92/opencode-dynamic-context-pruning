import type { Logger } from "../../logger"
import type { SessionState, WithParts } from "../../state"
import { mergeSubagentResult } from "../../subagents/subagent-results"
import { buildSubAgentCacheKey } from "../../subagents/cache-key"
import { stripHallucinationsFromString } from "../utils"

/** Inject the original subagent result back into task parts in the live
 *  message stream. Issue #595 fix:
 *
 *  On cache HIT (composite key `${subAgentSessionId}::${callID}`), merge the
 *  cached text into the part's output as before.
 *
 *  On cache MISS, do NOT fetch the subagent session — leave `part.state.output`
 *  untouched. The part was created with that output at the time of the call
 *  and is the round-correct value. The previous fetch-and-merge-with-current-
 *  subagent-state behaviour is exactly the bug: the subagent session's CURRENT
 *  state is the latest round's text, so re-fetching poisons the older round's
 *  cached value. PLAN §5.9/§6.5.
 *
 *  ponytail: fetch removed entirely. If the part has no `state.output` of its
 *  own (call never produced output), the cache miss simply yields no extension,
 *  which is correct — there is nothing to extend. */
export const injectExtendedSubAgentResults = async (
    _client: any,
    state: SessionState,
    _logger: Logger,
    messages: WithParts[],
    allowSubAgents: boolean,
): Promise<void> => {
    if (!allowSubAgents) {
        return
    }

    for (const message of messages) {
        const parts = Array.isArray(message.parts) ? message.parts : []

        for (const part of parts) {
            if (part.type !== "tool" || part.tool !== "task" || !part.callID) {
                continue
            }
            if (state.prune.tools.has(part.callID)) {
                continue
            }
            if (part.state?.status !== "completed" || typeof part.state.output !== "string") {
                continue
            }

            const subAgentSessionId = part.state?.metadata?.sessionId
            const sessionKey =
                typeof subAgentSessionId === "string" && subAgentSessionId.length > 0
                    ? subAgentSessionId
                    : ""
            const cacheKey = buildSubAgentCacheKey(sessionKey, part.callID)
            const cachedResult = state.subAgentResultCache.get(cacheKey)
            if (!cachedResult || !cachedResult.text) {
                continue
            }

            part.state.output = stripHallucinationsFromString(
                mergeSubagentResult(part.state.output, cachedResult.text),
            )
        }
    }
}
