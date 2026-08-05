import type { CompressionBlock, SessionState } from "../state"
import { formatBlockRef, parseBoundaryId } from "../message-ids"
import { resolveAnchorMessageId, resolveBoundaryIds, resolveSelection } from "./search"
import type {
    BoundaryReference,
    CompressRangeToolArgs,
    InjectedSummaryResult,
    ParsedBlockPlaceholder,
    ResolvedRangeCompression,
    SearchContext,
} from "./types"

const BLOCK_PLACEHOLDER_REGEX = /\(b(\d+)\)|\{block_(\d+)\}/gi

/** Enumerate every boundary ID the agent can currently use as a start or end
 *  anchor in this session: every injected message ref + every active block ref.
 *  Used to construct error messages that carry a valid-ID list so the agent
 *  can self-correct (PLAN §6.1 acceptance criterion). */
export function listValidBoundaryIds(state: SessionState): string[] {
    const ids = new Set<string>()
    for (const ref of state.messageIds.byRef.keys()) {
        ids.add(ref)
    }
    for (const blockId of state.prune.messages.blocksById.keys()) {
        const block = state.prune.messages.blocksById.get(blockId)
        if (block && block.active) {
            ids.add(formatBlockRef(blockId))
        }
    }
    // Numeric-aware sort: `m0001` < `m0010` < `m0100`, `b1` < `b2` < `b10`.
    // ponytail: default sort is lexicographic and would yield `b1, b10, b2`.
    return [...ids].sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
}

/** Check whether a single boundary ID resolves against the visible message set.
 *  Pure: no IO. */
export function isBoundaryIdValid(id: string, state: SessionState): boolean {
    const parsed = parseBoundaryId(id)
    if (parsed === null) {
        return false
    }
    if (parsed.kind === "message") {
        return state.messageIds.byRef.has(parsed.ref)
    }
    const block = state.prune.messages.blocksById.get(parsed.blockId)
    return !!block && block.active
}

/** Validate that startId and endId both resolve against the currently-visible
 *  message set. Throws with a valid-ID list (issue #573 acceptance criterion). */
export function validateBoundaryIds(
    startId: string,
    endId: string,
    state: SessionState,
): void {
    const issues: string[] = []
    if (!isBoundaryIdValid(startId, state)) {
        issues.push(
            `startId ${startId} is not available in the current conversation context. Choose an injected ID visible in context.`,
        )
    }
    if (!isBoundaryIdValid(endId, state)) {
        issues.push(
            `endId ${endId} is not available in the current conversation context. Choose an injected ID visible in context.`,
        )
    }
    if (issues.length > 0) {
        throw new Error(
            issues.length === 1
                ? issues[0]
                : issues.map((issue) => `- ${issue}`).join("\n"),
        )
    }
}

/** Validate `startId <= endId` (lexical). Throws otherwise. Equality is allowed
 *  here — the monotonicity guard in validateMonotonicEnd rejects it downstream
 *  when relevant. */
export function validateRangeSanity(startId: string, endId: string): void {
    if (startId.localeCompare(endId) > 0) {
        throw new Error(
            `__DCP_RANGE_SANITY__: startId ${startId} must come before or equal to endId ${endId}.`,
        )
    }
}

/** Enforce the v2 strictly-greater anchor rule from PLAN §6.1:
 *  newStart > prevAnchorEnd AND newEnd > prevAnchorEnd. Equality also throws
 *  — it means zero new coverage. The error message carries a valid-ID list
 *  so the agent can self-correct. */
export function validateMonotonicEnd(
    prevAnchorEnd: string,
    newStart: string,
    newEnd: string,
    state: SessionState,
): void {
    const validNextIds = listValidBoundaryIds(state)
    const validNextHint =
        validNextIds.length > 0
            ? `Valid next anchors: ${validNextIds.join(", ")}`
            : "Valid next anchors: (none — message refs not yet injected)"

    // prevAnchorEnd must itself be a valid boundary for the comparison to be meaningful.
    if (!isBoundaryIdValid(prevAnchorEnd, state)) {
        throw new Error(
            `__DCP_MONOTONIC_VIOLATION__: previous anchor ${prevAnchorEnd} is not available in the current conversation context. ${validNextHint}`,
        )
    }

    if (newStart.localeCompare(prevAnchorEnd) <= 0) {
        throw new Error(
            `__DCP_MONOTONIC_VIOLATION__: new start ${newStart} must be strictly greater than previous end ${prevAnchorEnd}. ${validNextHint}`,
        )
    }

    if (newEnd.localeCompare(prevAnchorEnd) <= 0) {
        throw new Error(
            `__DCP_MONOTONIC_VIOLATION__: new end ${newEnd} must be strictly greater than previous end ${prevAnchorEnd}. ${validNextHint}`,
        )
    }
}

export function validateArgs(args: CompressRangeToolArgs): void {
    if (typeof args.topic !== "string" || args.topic.trim().length === 0) {
        throw new Error("topic is required and must be a non-empty string")
    }

    if (!Array.isArray(args.content) || args.content.length === 0) {
        throw new Error("content is required and must be a non-empty array")
    }

    for (let index = 0; index < args.content.length; index++) {
        const entry = args.content[index]
        const prefix = `content[${index}]`

        if (typeof entry?.startId !== "string" || entry.startId.trim().length === 0) {
            throw new Error(`${prefix}.startId is required and must be a non-empty string`)
        }

        if (typeof entry?.endId !== "string" || entry.endId.trim().length === 0) {
            throw new Error(`${prefix}.endId is required and must be a non-empty string`)
        }

        if (typeof entry?.summary !== "string" || entry.summary.trim().length === 0) {
            throw new Error(`${prefix}.summary is required and must be a non-empty string`)
        }
    }
}

export function resolveRanges(
    args: CompressRangeToolArgs,
    searchContext: SearchContext,
    state: SessionState,
): ResolvedRangeCompression[] {
    return args.content.map((entry, index) => {
        const normalizedEntry = {
            startId: entry.startId.trim(),
            endId: entry.endId.trim(),
            summary: entry.summary,
        }

        const { startReference, endReference } = resolveBoundaryIds(
            searchContext,
            state,
            normalizedEntry.startId,
            normalizedEntry.endId,
        )
        const selection = resolveSelection(searchContext, startReference, endReference)

        return {
            index,
            entry: normalizedEntry,
            selection,
            anchorMessageId: resolveAnchorMessageId(startReference),
        }
    })
}

export function validateNonOverlapping(
    plans: ResolvedRangeCompression[],
    state?: SessionState,
): void {
    const sortedPlans = [...plans].sort(
        (left, right) =>
            left.selection.startReference.rawIndex - right.selection.startReference.rawIndex ||
            left.selection.endReference.rawIndex - right.selection.endReference.rawIndex ||
            left.index - right.index,
    )

    const issues: string[] = []

    for (let index = 1; index < sortedPlans.length; index++) {
        const previous = sortedPlans[index - 1]
        const current = sortedPlans[index]
        if (!previous || !current) {
            continue
        }

        if (current.selection.startReference.rawIndex > previous.selection.endReference.rawIndex) {
            continue
        }

        issues.push(
            `content[${previous.index}] (${previous.entry.startId}..${previous.entry.endId}) overlaps content[${current.index}] (${current.entry.startId}..${current.entry.endId}). Overlapping ranges cannot be compressed in the same batch.`,
        )
    }

    if (issues.length > 0) {
        const validHint =
            state !== undefined
                ? `\nValid boundary IDs: ${listValidBoundaryIds(state).join(", ")}`
                : ""
        throw new Error(
            (issues.length === 1 ? issues[0] : issues.map((issue) => `- ${issue}`).join("\n")) +
                validHint,
        )
    }
}

export function parseBlockPlaceholders(summary: string): ParsedBlockPlaceholder[] {
    const placeholders: ParsedBlockPlaceholder[] = []
    const regex = new RegExp(BLOCK_PLACEHOLDER_REGEX)

    let match: RegExpExecArray | null
    while ((match = regex.exec(summary)) !== null) {
        const full = match[0]
        const blockIdPart = match[1] || match[2]
        const parsed = Number.parseInt(blockIdPart, 10)
        if (!Number.isInteger(parsed)) {
            continue
        }

        placeholders.push({
            raw: full,
            blockId: parsed,
            startIndex: match.index,
            endIndex: match.index + full.length,
        })
    }

    return placeholders
}

export function validateSummaryPlaceholders(
    placeholders: ParsedBlockPlaceholder[],
    requiredBlockIds: number[],
    startReference: BoundaryReference,
    endReference: BoundaryReference,
    summaryByBlockId: Map<number, CompressionBlock>,
): number[] {
    const boundaryOptionalIds = new Set<number>()
    if (startReference.kind === "compressed-block") {
        if (startReference.blockId === undefined) {
            throw new Error("Failed to map boundary matches back to raw messages")
        }
        boundaryOptionalIds.add(startReference.blockId)
    }
    if (endReference.kind === "compressed-block") {
        if (endReference.blockId === undefined) {
            throw new Error("Failed to map boundary matches back to raw messages")
        }
        boundaryOptionalIds.add(endReference.blockId)
    }

    const strictRequiredIds = requiredBlockIds.filter((id) => !boundaryOptionalIds.has(id))
    const requiredSet = new Set(requiredBlockIds)
    const keptPlaceholderIds = new Set<number>()
    const validPlaceholders: ParsedBlockPlaceholder[] = []

    for (const placeholder of placeholders) {
        const isKnown = summaryByBlockId.has(placeholder.blockId)
        const isRequired = requiredSet.has(placeholder.blockId)
        const isDuplicate = keptPlaceholderIds.has(placeholder.blockId)

        if (isKnown && isRequired && !isDuplicate) {
            validPlaceholders.push(placeholder)
            keptPlaceholderIds.add(placeholder.blockId)
        }
    }

    placeholders.length = 0
    placeholders.push(...validPlaceholders)

    return strictRequiredIds.filter((id) => !keptPlaceholderIds.has(id))
}

export function injectBlockPlaceholders(
    summary: string,
    placeholders: ParsedBlockPlaceholder[],
    summaryByBlockId: Map<number, CompressionBlock>,
    startReference: BoundaryReference,
    endReference: BoundaryReference,
): InjectedSummaryResult {
    let cursor = 0
    let expanded = summary
    const consumed: number[] = []
    const consumedSeen = new Set<number>()

    if (placeholders.length > 0) {
        expanded = ""
        for (const placeholder of placeholders) {
            const target = summaryByBlockId.get(placeholder.blockId)
            if (!target) {
                throw new Error(`Compressed block not found: (b${placeholder.blockId})`)
            }

            expanded += summary.slice(cursor, placeholder.startIndex)
            expanded += restoreSummary(target.summary)
            cursor = placeholder.endIndex

            if (!consumedSeen.has(placeholder.blockId)) {
                consumedSeen.add(placeholder.blockId)
                consumed.push(placeholder.blockId)
            }
        }

        expanded += summary.slice(cursor)
    }

    expanded = injectBoundarySummary(
        expanded,
        startReference,
        "start",
        summaryByBlockId,
        consumed,
        consumedSeen,
    )
    expanded = injectBoundarySummary(
        expanded,
        endReference,
        "end",
        summaryByBlockId,
        consumed,
        consumedSeen,
    )

    return {
        expandedSummary: expanded,
        consumedBlockIds: consumed,
    }
}

export function appendMissingBlockSummaries(
    summary: string,
    missingBlockIds: number[],
    summaryByBlockId: Map<number, CompressionBlock>,
    consumedBlockIds: number[],
): InjectedSummaryResult {
    const consumedSeen = new Set<number>(consumedBlockIds)
    const consumed = [...consumedBlockIds]

    const missingSummaries: string[] = []
    for (const blockId of missingBlockIds) {
        if (consumedSeen.has(blockId)) {
            continue
        }

        const target = summaryByBlockId.get(blockId)
        if (!target) {
            throw new Error(`Compressed block not found: (b${blockId})`)
        }

        missingSummaries.push(`\n### (b${blockId})\n${restoreSummary(target.summary)}`)
        consumedSeen.add(blockId)
        consumed.push(blockId)
    }

    if (missingSummaries.length === 0) {
        return {
            expandedSummary: summary,
            consumedBlockIds: consumed,
        }
    }

    const heading =
        "\n\nThe following previously compressed summaries were also part of this conversation section:"

    return {
        expandedSummary: summary + heading + missingSummaries.join(""),
        consumedBlockIds: consumed,
    }
}

function restoreSummary(summary: string): string {
    const headerMatch = summary.match(/^\s*\[Compressed conversation(?: section)?(?: b\d+)?\]/i)
    if (!headerMatch) {
        return summary
    }

    const afterHeader = summary.slice(headerMatch[0].length)
    const withoutLeadingBreaks = afterHeader.replace(/^(?:\r?\n)+/, "")
    return withoutLeadingBreaks
        .replace(/(?:\r?\n)*<dcp-message-id>b\d+<\/dcp-message-id>\s*$/i, "")
        .replace(/(?:\r?\n)+$/, "")
}

function injectBoundarySummary(
    summary: string,
    reference: BoundaryReference,
    position: "start" | "end",
    summaryByBlockId: Map<number, CompressionBlock>,
    consumed: number[],
    consumedSeen: Set<number>,
): string {
    if (reference.kind !== "compressed-block" || reference.blockId === undefined) {
        return summary
    }
    if (consumedSeen.has(reference.blockId)) {
        return summary
    }

    const target = summaryByBlockId.get(reference.blockId)
    if (!target) {
        throw new Error(`Compressed block not found: (b${reference.blockId})`)
    }

    const injectedBody = restoreSummary(target.summary)
    const left = position === "start" ? injectedBody.trim() : summary.trim()
    const right = position === "start" ? summary.trim() : injectedBody.trim()
    const next = !left ? right : !right ? left : `${left}\n\n${right}`

    consumedSeen.add(reference.blockId)
    consumed.push(reference.blockId)
    return next
}
