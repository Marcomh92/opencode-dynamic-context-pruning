import type { CachedSubAgentResult } from "../state/types"

/** Composite cache key for subagent results (issue #595).
 *  Defensive against future callID reuse across different subagent sessions.
 *  ponytail: trivial pure helper; no IO. */
export function buildSubAgentCacheKey(subAgentSessionId: string, callID: string): string {
    return `${subAgentSessionId.length}\x00${subAgentSessionId}\x00${callID.length}\x00${callID}`
}

/** Older-wins write semantic for the subagent result cache (issue #595).
 *  Returns the incoming value iff its capturedAt is strictly older than the
 *  existing one; otherwise returns the existing entry. Prevents a re-fetched
 *  "newer" subagent state from overwriting the round-correct value.
 *  No production caller exists yet — this is a reference implementation for
 *  the future write-on-completion path; existing tests in
 *  `tests/subagent-cache.test.ts` already cover the rule. */
export function olderWinsWrite(
    existing: CachedSubAgentResult | undefined,
    incoming: CachedSubAgentResult,
): CachedSubAgentResult {
    if (existing === undefined) {
        return incoming
    }
    return incoming.capturedAt < existing.capturedAt ? incoming : existing
}
