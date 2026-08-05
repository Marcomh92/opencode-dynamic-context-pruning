import type { CachedSubAgentResult } from "../state/types"

/** Composite cache key for subagent results (issue #595).
 *  Defensive against future callID reuse across different subagent sessions.
 *  ponytail: trivial pure helper; no IO. */
export function buildSubAgentCacheKey(subAgentSessionId: string, callID: string): string {
    return `${subAgentSessionId}::${callID}`
}
