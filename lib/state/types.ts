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
    // Fork-state-inheritance keys (BUG-089 plan §4.4). All additive with
    // safe defaults. Schema bump to v4 (FORK_SCHEMA_VERSION) drops pre-bump
    // state files via the gate at lib/state/persistence.ts:303-316.
    // ponytail: depends on OpenCode preserving `time.created` on UI forks
    // (verified via SQLite probe 2026-08-08). If OpenCode ever regenerates
    // timestamps, the predicate at lib/state/inherit.ts filterInheritableBlocks
    // degrades gracefully to "no inheritance" (timestamp set miss).
    startTime: number
    endTime: number
    effectiveTimeMs: number[]
    directTimeMs: number[]
    anchorTime: number
    compressTime: number
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
    /** Raw message id of the user message where the slash command was issued.
     *  Set by the slash-command handler and used by `applyPendingManualTrigger`
     *  to identify which user message the rewrite must target. Optional for
     *  backward compat with the slash-command path that does not yet provide
     *  it; when present, the trigger attaches to that exact message instead of
     *  "the latest non-ignored user message" (BUG-029 race window). */
    commandMessageId?: string
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
    // Diagnostic state — in-memory only, not persisted. Tracks per-fire
    // prefix hash, fire count, and last-fire timestamp so we can attribute
    // cache-miss events to specific transform fires. See lib/diagnostic.ts.
    diagnostic: {
        fireCount: number
        lastPrefixHash: string | null
        lastFireAt: number | null
    }
    // Cached at session transition (lib/state/state.ts ensureSessionInitialized
    // or lib/hooks.ts createChatMessageTransformHandler). NOT persisted — it is
    // rebuilt on every process start via SDK call. Used by the fork hint and
    // the inheritance logic (BUG-089 plan §4.1).
    sessionTitle?: string
    // Set when fork inheritance copies blocks from a parent session.
    // NOT persisted. Cleared on session reset (lib/state/state.ts resetSessionState).
    inheritedFrom?: string | null
}

/** Persisted-state schema version for the local-only fork.
 *  v2: userForced / recoveryForced / nonCompactingRunCount / forkSchemaVersion.
 *  v3 (M4 — #595): in-memory `subAgentResultCache` value type changed from
 *      `string` to `CachedSubAgentResult`. The cache is NOT persisted (per
 *      PersistedSessionState — it is rebuildable from the subagent session),
 *      so the bump is purely defensive: any v2 file on disk could carry state
 *      whose runtime invariants are now slightly different. Older state files
 *      are dropped on load (logged, not migrated).
 *  v4 (BUG-089): CompressionBlock gains 6 timestamp fields (startTime,
 *      endTime, effectiveTimeMs, directTimeMs, anchorTime, compressTime).
 *      SessionState gains sessionTitle (in-memory) and inheritedFrom (in-memory).
 *      PersistedSessionState gains recoveryForced, nonCompactingRunCount,
 *      recoveryFadeCounter (so fork inheritance can copy them per §4.5).
 *      Pre-v4 files are DROPPED by the schema gate at lib/state/persistence.ts:303-316
 *      (per DPP-004 / PAT-008 "drop, don't migrate"). Honest data loss on upgrade. */
export const FORK_SCHEMA_VERSION = 4

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
