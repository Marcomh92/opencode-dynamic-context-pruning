import type { CompressionTimingState } from "../compress/timing"
import { Message, Part } from "@opencode-ai/sdk/v2"

export interface WithParts {
    info: Message
    parts: Part[]
}

export type ToolStatus = "pending" | "running" | "completed" | "error"

export interface ToolParameterEntry {
    tool: string
    parameters: any
    status?: ToolStatus
    error?: string
    turn: number
    tokenCount?: number
}

export interface SessionStats {
    pruneTokenCounter: number
    totalPruneTokens: number
}

export interface PrunedMessageEntry {
    tokenCount: number
    allBlockIds: number[]
    activeBlockIds: number[]
}

export type CompressionMode = "range" | "message"

export interface CompressionBlock {
    blockId: number
    runId: number
    active: boolean
    deactivatedByUser: boolean
    compressedTokens: number
    summaryTokens: number
    durationMs: number
    mode?: CompressionMode
    topic: string
    batchTopic?: string
    startId: string
    endId: string
    anchorMessageId: string
    compressMessageId: string
    compressCallId?: string
    includedBlockIds: number[]
    consumedBlockIds: number[]
    parentBlockIds: number[]
    directMessageIds: string[]
    directToolIds: string[]
    effectiveMessageIds: string[]
    effectiveToolIds: string[]
    createdAt: number
    deactivatedAt?: number
    deactivatedByBlockId?: number
    summary: string
}

export interface PruneMessagesState {
    byMessageId: Map<string, PrunedMessageEntry>
    blocksById: Map<number, CompressionBlock>
    activeBlockIds: Set<number>
    activeByAnchorMessageId: Map<string, number>
    nextBlockId: number
    nextRunId: number
}

export interface Prune {
    tools: Map<string, number>
    messages: PruneMessagesState
}

export interface PendingManualTrigger {
    sessionId: string
    prompt: string
}

export interface MessageIdState {
    byRawId: Map<string, string>
    byRef: Map<string, string>
    nextRef: number
}

export interface Nudges {
    contextLimitAnchors: Set<string>
    turnNudgeAnchors: Set<string>
    iterationNudgeAnchors: Set<string>
}

export interface SessionState {
    sessionId: string | null
    isSubAgent: boolean
    // manualMode is a derived cache: === "active" iff userForced || recoveryForced.
    // "compress-pending" is the transient state right after `/dcp-compress` was invoked
    // and the model still owes a compress call. Kept for backward compat with code
    // paths M2 doesn't touch; the v2 protocol reads/writes userForced and recoveryForced.
    manualMode: false | "active" | "compress-pending"
    // v2 fork protocol flags (issue #573 + #590).
    // userForced:    set when the user explicitly turned manual mode on (`/dcp manual on`)
    //                or after a successful manual compress (clears userForced; user
    //                intent satisfied). Cleared only by `/dcp manual off` or a successful
    //                manual compress — never by autonomous-compress success.
    // recoveryForced: set after `compress.maxContextLimitRecovery` consecutive
    //                non-compacting compress calls. Cleared only on session end,
    //                OpenCode restart, or `compress.recoveryFadeWindow` consecutive
    //                good compresses while set. NEVER cleared by `/dcp manual off`.
    userForced: boolean
    recoveryForced: boolean
    // Counter of consecutive compress calls that did not shrink context (net-compaction
    // check: summaryTokens >= removedTokens * maxCompactionRatio). Reset on any
    // compacting compress. Drives the auto-disable into recoveryForced.
    nonCompactingRunCount: number
    // Streak of consecutive good MANUAL compresses while recoveryForced is set.
    // Reset on session end, restart, or any non-compacting run. Clears
    // recoveryForced when it reaches `compress.recoveryFadeWindow` (§6.2).
    recoveryFadeCounter: number
    // Persisted-state shape version. Bumped on any change to the persisted-state shape.
    // On load, mismatched versions are dropped and a startup log line names the dropped
    // version. Matches the `compress.forkSchemaVersion` config key on load.
    forkSchemaVersion: number
    compressPermission: "ask" | "allow" | "deny" | undefined
    pendingManualTrigger: PendingManualTrigger | null
    prune: Prune
    nudges: Nudges
    stats: SessionStats
    compressionTiming: CompressionTimingState
    toolParameters: Map<string, ToolParameterEntry>
    // #595 — composite key `${subAgentSessionId}::${callID}` (defensive against
    // future callID reuse). older-wins write semantic narrows blast radius
    // within one parent session; the load-bearing correctness across resume is
    // the fallback to `part.state.output` when the cache is cold (PLAN §6.5).
    // ponytail: this cache is INTENTIONALLY cold in the M4 implementation — no
    // production write site exists, because the legacy fetch-on-miss path was
    // the source of the round-overwrite bug and has been removed. The cache
    // scaffolding is preserved (key, value type, helper module) so a future
    // safe write-on-completion path can be added without further schema churn.
    subAgentResultCache: Map<string, CachedSubAgentResult>
    toolIdList: string[]
    messageIds: MessageIdState
    lastCompaction: number
    currentTurn: number
    modelContextLimit: number | undefined
    systemPromptTokens: number | undefined
}

/** Persisted-state schema version for the local-only fork.
 *  v2: userForced / recoveryForced / nonCompactingRunCount / forkSchemaVersion.
 *  v3 (M4 — #595): in-memory `subAgentResultCache` value type changed from
 *      `string` to `CachedSubAgentResult`. The cache is NOT persisted (per
 *      PersistedSessionState — it is rebuildable from the subagent session),
 *      so the bump is purely defensive: any v2 file on disk could carry state
 *      whose runtime invariants are now slightly different. Older state files
 *      are dropped on load (logged, not migrated). */
export const FORK_SCHEMA_VERSION = 3

/** Cached result for a single subagent tool call (issue #595).
 *  Keyed by `${subAgentSessionId}::${callID}`. Written with the older-wins
 *  semantic so a re-fetched "newer" subagent state cannot overwrite an entry
 *  that already represents the round-correct value. The cache is an
 *  optimisation within one parent session; the load-bearing correctness across
 *  resume is the fallback to `part.state.output` (PLAN §6.5). */
export interface CachedSubAgentResult {
    subAgentSessionId: string
    toolCallId: string
    capturedAt: number
    text: string
}
