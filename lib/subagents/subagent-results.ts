import type { WithParts } from "../state"

const SUB_AGENT_RESULT_BLOCK_REGEX = /(<task_result>\s*)([\s\S]*?)(\s*<\/task_result>)/i

/**
 * Replaces the body of the first `<task_result>...</task_result>` block in
 * `output` with `subAgentResultText`. Used to extend a part's `state.output`
 * with a cached sub-agent result on a cache HIT (see issue #595).
 *
 * ponytail: `getSubAgentId` and `buildSubagentResultText` were removed after
 * M4 deleted the fetch-on-miss path; the cache HIT path is the only remaining
 * consumer of this file. The internal regex is a single non-greedy match.
 */
export function mergeSubagentResult(output: string, subAgentResultText: string): string {
    if (!subAgentResultText || typeof output !== "string") {
        return output
    }

    return output.replace(
        SUB_AGENT_RESULT_BLOCK_REGEX,
        (_match, openTag: string, _body: string, closeTag: string) =>
            `${openTag}${subAgentResultText}${closeTag}`,
    )
}
