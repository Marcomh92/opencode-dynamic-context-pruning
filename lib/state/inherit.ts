/**
 * Fork-state inheritance — copies compression blocks from a parent session
 * into a freshly-forked child session (BUG-089 / fork-state-inheritance plan).
 *
 * The trigger lives in `ensureSessionInitialized` (`lib/state/state.ts`),
 * which calls `tryInheritFromParent` inside its `persisted === null` branch
 * (B has no prior state, so a fork is the only case where inheritance
 * applies). All writes to `state.prune.messages.*` route through
 * `mergeInheritedBlocks` in `lib/compress/state.ts` per DPP-006 / PAT-002 —
 * this file is a pure orchestrator and never mutates block state directly.
 *
 * ponytail: every helper swallows errors via `logger.debug` and returns a
 * non-throwing sentinel (empty array, original input, or `undefined`).
 * Inheritance must never break the transform pipeline.
 */

import type { Stats } from "node:fs"
import { promises as fs } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { mergeInheritedBlocks } from "../compress/state"
import type { PluginConfig } from "../config"
import type { Logger } from "../logger"
import { parseBoundaryId } from "../message-ids"
import { isMessageWithInfo } from "../messages/shape"
import type { PersistedSessionState } from "./persistence"
import { coalesceSaveSessionState, loadSessionState } from "./persistence"
import type { CompressionBlock, SessionState, WithParts } from "./types"
import { FORK_SCHEMA_VERSION } from "./types"
import {
    detectParentSessionFromTitle,
    effectiveManualMode,
    getSessionMetadata,
    loadPruneMap,
} from "./utils"

/** A persisted state file matching the parent's title scan.
 *  Carries the file's mtime so `pickParentCandidate` can apply the recency
 *  fallback when prefix scores tie (or all-zero). */
export interface CandidateFile {
    sessionId: string
    /** mtime in ms — for recency fallback only. */
    mtime: number
    /** Refreshed title from SDK at scan time, when a client is provided.
     *  Used to defeat stale `sessionName` saved before a parent rename —
     *  the parent's `persisted.sessionName` may still carry the old title
     *  if the user renamed the parent session between compresses. */
    currentTitle?: string
    /** Parsed snapshot. Already passed the version gate inside
     *  `findCandidateParents`; loadSessionState applies the same gate again
     *  for the chosen candidate (belt-and-braces). */
    persisted: PersistedSessionState
}

/** Resolve the DCP storage directory at call-time. Mirrors the implementation
 *  in `lib/state/persistence.ts:61` (which is module-private and owned by the
 *  Stage A-3 implementer).
 *  ponytail: duplicated here rather than reaching into a non-exported symbol.
 *  Add when persistence exposes this as a public helper. */
function resolveStorageDir(): string {
    return join(
        process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
        "opencode",
        "storage",
        "plugin",
        "dcp",
    )
}

/** Schema-version gate predicate (DPP-004 / PAT-008). Centralised so the
 *  candidate-scan and the canonical loader can't drift on future schema bumps.
 *  Export kept module-local for now; the load-side adoption is a follow-up. */
export function isCompatibleForkSchemaVersion(parsed: unknown): boolean {
    return (
        typeof (parsed as { forkSchemaVersion?: unknown } | null)?.forkSchemaVersion === "number" &&
        (parsed as { forkSchemaVersion: number }).forkSchemaVersion === FORK_SCHEMA_VERSION
    )
}

/** Builds a first-wins time index of B's messages.
 *  Used by both the rekey pass (timestamp → B's message ID) and the
 *  inheritable predicate (timestamp present in B at all). First-wins per
 *  plan §4.4 — same-ms user/assistant pairs are rare; the predicate only
 *  requires the timestamp to exist in B, not a specific message ID.
 *  Returns both `timeSet` (membership test for the predicate) and
 *  `timeToId` (rekey lookup). */
export function buildTimeIndex(messages: WithParts[]): {
    timeSet: Set<number>
    timeToId: Map<number, string>
} {
    const timeSet = new Set<number>()
    const timeToId = new Map<number, string>()
    for (const m of messages) {
        if (!isMessageWithInfo(m)) continue
        const t = m.info.time.created
        if (!timeSet.has(t)) {
            timeSet.add(t)
            timeToId.set(t, m.info.id)
        }
    }
    return { timeSet, timeToId }
}

/** Timestamp-anchored predicate per plan §4.4.
 *  Returns the subset of parent's blocks whose every required field maps
 *  to a timestamp present in B AND whose block-graph references all
 *  resolve in the parent set (so a surviving block never references a
 *  dropped block — `lib/commands/decompress.ts:44-63` and
 *  `lib/messages/sync.ts:66` both walk these fields).
 *
 *  Blocks failing the predicate are silently dropped — the strict filter
 *  is the safety net against wrong-parent picks (plan §3.5). */
export function filterInheritableBlocks(
    rawBlocks: CompressionBlock[],
    bTimeSet: Set<number>,
    parentBlocksById: Map<number, CompressionBlock>,
    logger?: Logger,
): CompressionBlock[] {
    const dropped: { blockId: number; reason: string }[] = []
    const inheritable = rawBlocks.filter((block) => {
        if (block.deactivatedByUser) {
            dropped.push({ blockId: block.blockId, reason: "deactivatedByUser" })
            return false
        }
        if (!bTimeSet.has(block.startTime)) {
            dropped.push({ blockId: block.blockId, reason: "startTime-not-in-B" })
            return false
        }
        if (!bTimeSet.has(block.endTime)) {
            dropped.push({ blockId: block.blockId, reason: "endTime-not-in-B" })
            return false
        }
        if (!bTimeSet.has(block.anchorTime)) {
            dropped.push({ blockId: block.blockId, reason: "anchorTime-not-in-B" })
            return false
        }
        if (!bTimeSet.has(block.compressTime)) {
            dropped.push({ blockId: block.blockId, reason: "compressTime-not-in-B" })
            return false
        }
        if (!block.effectiveTimeMs.every((t) => bTimeSet.has(t))) {
            dropped.push({ blockId: block.blockId, reason: "effectiveTimeMs-not-in-B" })
            return false
        }
        if (!block.directTimeMs.every((t) => bTimeSet.has(t))) {
            dropped.push({ blockId: block.blockId, reason: "directTimeMs-not-in-B" })
            return false
        }
        for (const id of block.includedBlockIds ?? []) {
            if (!parentBlocksById.has(id)) {
                dropped.push({ blockId: block.blockId, reason: "dangling-includedBlockIds" })
                return false
            }
        }
        for (const id of block.consumedBlockIds ?? []) {
            if (!parentBlocksById.has(id)) {
                dropped.push({ blockId: block.blockId, reason: "dangling-consumedBlockIds" })
                return false
            }
        }
        for (const id of block.parentBlockIds ?? []) {
            if (!parentBlocksById.has(id)) {
                dropped.push({ blockId: block.blockId, reason: "dangling-parentBlockIds" })
                return false
            }
        }
        return true
    })
    if (logger && dropped.length > 0) {
        logger.debug(`fork inheritance: dropped ${dropped.length} block(s) from inheritance`, {
            dropped,
        })
    }
    return inheritable
}

/** CRITICAL post-filter pass — rewrites the ID-shaped fields from the
 *  parent's message IDs to B's message IDs via `timeToId` (plan architect
 *  flag #1). Without this, `lib/messages/sync.ts:42-53` deactivates every
 *  inherited block on B's first sync because the parent's
 *  `compressMessageId` is regenerated in B; the same applies to
 *  `anchorMessageId` and the effective/direct ranges.
 *
 *  `startId`/`endId` are NOT message IDs — they are boundary refs
 *  (mNNNN/bN, see range.ts:216-217 / message.ts:166-167) in a
 *  session-relative namespace that forks inherit verbatim: ref assignment
 *  is deterministic over identical message lists, so the same message gets
 *  the same ref in B. They are preserved as-is; only non-ref legacy values
 *  fall back to the timestamp mapping (BUG-091).
 *
 *  `byMessageId` rebuilding is owned by `mergeInheritedBlocks` in
 *  `lib/compress/state.ts` (single-writer funnel — DPP-006 / PAT-002).
 *  This function ONLY rewrites the block's own ID-shaped fields. */
export function rekeyBlocksToFork(
    blocks: CompressionBlock[],
    timeToId: Map<number, string>,
): CompressionBlock[] {
    return blocks.map((b) => {
        const startId = parseBoundaryId(b.startId) ? b.startId : (timeToId.get(b.startTime) ?? "")
        const endId = parseBoundaryId(b.endId) ? b.endId : (timeToId.get(b.endTime) ?? "")
        const anchorMessageId = timeToId.get(b.anchorTime) ?? ""
        const compressMessageId = timeToId.get(b.compressTime) ?? ""
        const effectiveMessageIds = b.effectiveTimeMs
            .map((t) => timeToId.get(t) ?? "")
            .filter((s): s is string => s !== "")
        const directMessageIds = b.directTimeMs
            .map((t) => timeToId.get(t) ?? "")
            .filter((s): s is string => s !== "")
        return {
            ...b,
            startId,
            endId,
            anchorMessageId,
            compressMessageId,
            effectiveMessageIds,
            directMessageIds,
        }
    })
}

// ponytail: `directToolIds` / `effectiveToolIds` are NOT rekeyed — they
// store `part.callID`s, which OpenCode preserves verbatim across fork
// (verified via SQLite probe 2026-08-08). Guard test fails if this changes.

/** Always-pick fallback chain per plan §4.3.
 *  - 1 candidate → direct pick.
 *  - N candidates → longest shared prefix of B's message timestamps against
 *    the candidate's block-level timestamps; tie-break by recency.
 *  - All-zero scores → most recent mtime (the user was working in that
 *    session most recently — wrong-parent picks are filtered by the
 *    timestamp predicate in `filterInheritableBlocks`).
 *
 *  ponytail: prefix-match uses block-level `effectiveTimeMs`/`directTimeMs`
 *  only (Path B). Messages outside any block contribute no signal here.
 *  Add per-candidate SDK fetch (`client.session.messages`) when full
 *  prefix-match coverage becomes important. */
export function pickParentCandidate(
    candidates: CandidateFile[],
    sessionId: string,
    bMessages: WithParts[],
    logger?: Logger,
): CandidateFile {
    if (candidates.length === 0) {
        // Contract violation — caller should gate on length > 0. Throw so
        // the caller sees the violation rather than returning a silent
        // fallback. tryInheritFromParent catches all errors.
        throw new Error("pickParentCandidate: candidates must be non-empty")
    }
    const pickLabel = (c: CandidateFile) =>
        `${c.currentTitle ?? c.persisted.sessionName} (${c.sessionId})`
    if (candidates.length === 1) {
        logger?.debug("fork inheritance: parent picked (single candidate)", {
            parent: pickLabel(candidates[0]),
            reason: "single",
        })
        return candidates[0]
    }

    let best: CandidateFile | null = null
    let bestScore = -1
    for (const c of candidates) {
        const score = computePrefixScore(c, bMessages)
        // ponytail: same mtime-DESC + sessionId-DESC pattern as
        // `pickMostRecent` — strict `>` plus tiebreak keeps the choice
        // deterministic regardless of iteration order.
        if (
            score > bestScore ||
            (score === bestScore &&
                score > 0 &&
                best !== null &&
                (c.mtime > best.mtime || (c.mtime === best.mtime && c.sessionId > best.sessionId)))
        ) {
            best = c
            bestScore = score
        }
    }
    if (best === null || bestScore === 0) {
        const pick = pickMostRecent(candidates)
        logger?.debug("fork inheritance: parent picked (recency fallback)", {
            parent: pickLabel(pick),
            reason: "recency-fallback",
            score: bestScore,
        })
        return pick
    }
    logger?.debug("fork inheritance: parent picked (longest timestamp prefix)", {
        parent: pickLabel(best),
        reason: "longest-prefix",
        score: bestScore,
    })
    return best
}

function computePrefixScore(candidate: CandidateFile, bMessages: WithParts[]): number {
    // ponytail: candidates with no prune.messages carry no prefix signal —
    // returning 0 lets pickParentCandidate's recency fallback pick the most
    // recent one (per plan §3.5 wrong-parent safety).
    const candidateMessages = candidate.persisted.prune.messages
    if (!candidateMessages) return 0
    const candidateTimeSet = new Set<number>()
    for (const block of Object.values(candidateMessages.blocksById)) {
        for (const t of block.effectiveTimeMs) candidateTimeSet.add(t)
        for (const t of block.directTimeMs) candidateTimeSet.add(t)
        if (block.anchorTime !== 0) candidateTimeSet.add(block.anchorTime)
        if (block.compressTime !== 0) candidateTimeSet.add(block.compressTime)
    }
    let score = 0
    for (const m of bMessages) {
        if (!isMessageWithInfo(m)) continue
        if (!candidateTimeSet.has(m.info.time.created)) break
        score++
    }
    return score
}

function pickMostRecent(candidates: CandidateFile[]): CandidateFile {
    let best = candidates[0]
    for (let i = 1; i < candidates.length; i++) {
        // ponytail: strict `>` + sessionId-DESC tiebreak. Result is
        // deterministic regardless of iteration order — the alphabetical
        // sort in `findCandidateParents` is a stable input but the choice
        // is locked here. Add a third-level tiebreak (e.g. block count
        // DESC) if sessionId ties become a UX-sensitive default.
        if (
            candidates[i].mtime > best.mtime ||
            (candidates[i].mtime === best.mtime && candidates[i].sessionId > best.sessionId)
        ) {
            best = candidates[i]
        }
    }
    return best
}

/** Scans the DCP storage dir for files whose persisted `sessionName`
 *  matches the parent title. Each candidate carries the file's mtime for
 *  the recency fallback. The schema-version gate is applied here so the
 *  caller receives only version-compatible candidates — pre-bump files
 *  carry `startTime = 0` etc. and would fail the predicate anyway, but
 *  the version check skips them faster.
 *
 *  When `client` is provided, each candidate's title is refreshed from
 *  the SDK before the title-match filter runs. This defeats the case
 *  where the parent session was renamed between compresses: the on-disk
 *  `sessionName` is stale, but the SDK knows the current title. */
export async function findCandidateParents(
    parentTitle: string,
    logger: Logger,
    client?: any,
    stateRetentionDays: number | null = null,
): Promise<CandidateFile[]> {
    const dir = resolveStorageDir()
    let entries: string[]
    try {
        entries = await fs.readdir(dir)
    } catch {
        // Storage dir doesn't exist yet (fresh install) — graceful empty.
        return []
    }
    // ponytail: readdir order is filesystem-dependent. Sort by sessionId
    // (numeric so `b2 < b10`) so the mtime tie-break in `pickMostRecent`
    // is deterministic across OSes. Add if filesystem/SDK guarantees
    // ordered listings.
    entries.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))

    // BUG-092 — wall-clock cutoff for the mtime pre-filter. null disables
    // the filter (legacy behaviour); integer filters files older than the
    // configured retention window before the readFile + JSON.parse + schema
    // gate. With stateRetentionDays set, files older than the window are
    // skipped without the per-file debug log that was inflating the log.
    const ageCutoff =
        stateRetentionDays !== null ? Date.now() - stateRetentionDays * 86_400_000 : null

    // Pass 1: parse + schema-gate + push. The title filter is deferred
    // until after the SDK title refresh (pass 1.5) so a stale
    // `sessionName` saved before a parent rename can still match.
    const candidates: CandidateFile[] = []
    let schemaSkipped = 0
    let ageSkipped = 0
    for (const entry of entries) {
        if (!entry.endsWith(".json")) continue
        const sessionId = entry.slice(0, -".json".length)
        const filePath = join(dir, entry)

        let stat: Stats
        try {
            stat = await fs.stat(filePath)
        } catch {
            continue
        }

        // BUG-092 — mtime pre-filter. Skips the readFile + parse + schema
        // gate for files older than the retention window. Semantically
        // identical to the load gate (stateMaxAgeDays), but cheaper: one
        // syscall instead of readFile + JSON.parse + lastUpdated check.
        if (ageCutoff !== null && stat.mtimeMs < ageCutoff) {
            ageSkipped++
            continue
        }

        let raw: string
        try {
            raw = await fs.readFile(filePath, "utf-8")
        } catch {
            continue
        }

        let parsed: any
        try {
            parsed = JSON.parse(raw)
        } catch {
            continue
        }

        if (!isCompatibleForkSchemaVersion(parsed)) {
            schemaSkipped++
            continue
        }

        candidates.push({
            sessionId,
            mtime: stat.mtimeMs,
            persisted: parsed as PersistedSessionState,
        })
    }

    // BUG-092 — log collapse. The per-file `dropping pre-bump file` debug
    // line was generating ~900 lines on machines with accumulated test
    // fixtures. One summary line covers both skip counts. No-op when both
    // counts are zero (the common case at startup on a clean dir).
    if (schemaSkipped > 0 || ageSkipped > 0) {
        logger.debug("fork candidate scan summary", {
            total: entries.filter((e) => e.endsWith(".json")).length,
            schemaSkipped,
            ageSkipped,
            kept: candidates.length,
        })
    }

    // Pass 1.5: refresh each candidate's title from the SDK so the
    // filter below can match against the live title, not the possibly
    // stale `persisted.sessionName`. Refresh runs in parallel — bounded
    // by the candidate count (typically 1-2 at fork time).
    // ponytail: N SDK roundtrips per fork (N = candidates). Acceptable at
    // fork frequency. When OpenCode exposes session.updated events, switch
    // to event-driven title invalidation and drop the SDK calls.
    if (client) {
        await Promise.all(
            candidates.map(async (c) => {
                try {
                    const meta = await getSessionMetadata(client, c.sessionId)
                    if (meta.title) {
                        c.currentTitle = meta.title
                    }
                } catch (err: any) {
                    logger.debug("fork candidate scan: title refresh failed", {
                        sessionId: c.sessionId,
                        error: err?.message ?? String(err),
                    })
                }
            }),
        )
    }

    // Pass 2: suffix-aware title match (BUG-090). parentTitle may be
    // "Original" while the persisted sessionName is "Original (fork #1)"
    // (because we save verbatim). Try exact match first, then bare match
    // (strip parent's fork suffix too). The regex is the inverse of
    // `detectParentSessionFromTitle`'s regex. `currentTitle` wins over
    // `sessionName` when present.
    return candidates.filter((c) => {
        const savedName = c.persisted.sessionName
        const matchName = c.currentTitle ?? savedName
        return matchName === parentTitle || matchName === parentTitle.replace(/ \(fork #\d+\)$/, "")
    })
}

/** Top-level orchestrator. Called inside `ensureSessionInitialized`'s
 *  `persisted === null` branch. Gated on `experimental.inheritOnFork`.
 *  Graceful on all errors — never throws to caller.
 *
 *  Flow (plan §4.2 step 7):
 *    1. Config gate (default true per plan).
 *    2. Detect fork pattern from cached title.
 *    3. Scan storage dir for parent candidates.
 *    4. Disambiguate (always-pick fallback chain).
 *    5. Load + schema/age gate via canonical loader.
 *    6. Build B's time index + parent block-graph closure.
 *    7. Filter + rekey.
 *    8. Merge via canonical third writer.
 *    9. Persist + record parent in memory. */
export async function tryInheritFromParent(
    state: SessionState,
    client: any,
    sessionId: string,
    logger: Logger,
    bMessages: WithParts[],
    config: PluginConfig,
    stateMaxAgeDays: number | null,
    stateRetentionDays: number | null = null,
): Promise<void> {
    try {
        // 1. Config gate. `inheritOnFork` lives on `ExperimentalConfig`
        // (Stage B-2 owns the key). Read defensively so a missing field
        // behaves as `true` (default-on per user direction 2026-08-08).
        const expConfig = config.experimental as { inheritOnFork?: boolean }
        const inheritOnFork = expConfig.inheritOnFork ?? true
        if (inheritOnFork === false) {
            return
        }

        // 2. Fork-pattern detection. `state.sessionTitle` is cached by
        // `ensureSessionInitialized` (Stage A-1's `getSessionMetadata`
        // returns it on the same SDK roundtrip as `isSubAgent`).
        const forkInfo = detectParentSessionFromTitle(state.sessionTitle)
        if (!forkInfo.isForked || !forkInfo.parentTitle) {
            // Common case — most sessions are not forks.
            return
        }

        // 3. Candidate scan. Pass `client` so each candidate's title can
        // be refreshed from the SDK before the title-match filter runs —
        // defeats stale `sessionName` saved before a parent rename.
        // BUG-092 — plumb stateRetentionDays into the scan for the mtime
        // pre-filter.
        const candidates = await findCandidateParents(
            forkInfo.parentTitle,
            logger,
            client,
            stateRetentionDays,
        )
        if (candidates.length === 0) {
            logger.debug(
                `fork detected (#${forkInfo.forkNumber}); no parent state files found for "${forkInfo.parentTitle}"`,
            )
            return
        }

        // 4. Always-pick disambiguator.
        const parentCandidate = pickParentCandidate(candidates, sessionId, bMessages, logger)
        logger.info(
            `fork inheritance: parent session "${parentCandidate.currentTitle ?? parentCandidate.persisted.sessionName}" (${parentCandidate.sessionId}) selected from ${candidates.length} candidate(s)`,
        )

        // 5. Load + schema/age gate. Returns null for subagent / malformed /
        // expired files — all graceful give-ups.
        const parentState = await loadSessionState(
            parentCandidate.sessionId,
            logger,
            stateMaxAgeDays,
        )
        if (parentState === null) {
            logger.debug(
                `fork detected (#${forkInfo.forkNumber}); parent ${parentCandidate.sessionId} state unreadable`,
            )
            return
        }

        // 6. Indexes.
        const { timeSet, timeToId } = buildTimeIndex(bMessages)
        // ponytail: prune.messages is optional on disk (pre-bump files).
        // Graceful give-up matches the rest of this orchestrator.
        const parentMessages = parentState.prune.messages
        if (!parentMessages) {
            logger.debug(`fork inheritance: parent state has no prune.messages`, {
                parentId: parentCandidate.sessionId,
            })
            return
        }
        const rawBlocks = Object.values(parentMessages.blocksById)

        // Parent block-graph closure set. Persisted `blocksById` keys are
        // stringified block IDs (`PersistedPruneMessagesState`); convert
        // to a number→block Map so the predicate's `.has(id)` works
        // against the number fields on `CompressionBlock`.
        const parentBlocksById = new Map<number, CompressionBlock>()
        for (const [blockIdStr, block] of Object.entries(parentMessages.blocksById)) {
            const blockId = Number.parseInt(blockIdStr, 10)
            if (Number.isInteger(blockId) && block) {
                parentBlocksById.set(blockId, block as CompressionBlock)
            }
        }

        // 7. Filter (predicate) + rekey (ID rewrite).
        const inheritable = filterInheritableBlocks(rawBlocks, timeSet, parentBlocksById, logger)
        const rekeyed = rekeyBlocksToFork(inheritable, timeToId)

        // Rekey failures: a block whose anchor/compress origin could not be
        // mapped to B's ID space will be deactivated by syncCompressionBlocks.
        const orphanedAnchor = rekeyed.filter((b) => b.anchorMessageId === "").length
        const orphanedCompress = rekeyed.filter((b) => b.compressMessageId === "").length
        if (orphanedAnchor + orphanedCompress > 0) {
            logger.debug(
                `fork inheritance: ${orphanedAnchor} block(s) lost anchor ID, ${orphanedCompress} block(s) lost compress origin ID after rekey`,
            )
        }

        // 8. Merge via canonical third writer (DPP-006 / PAT-002 funnel).
        // `mergeInheritedBlocks` rebuilds `byMessageId`, integrates the
        // blocks into `state.prune.messages.*`, and applies monotonic-id
        // invariants — none of which we duplicate here.
        mergeInheritedBlocks(state, rekeyed, parentCandidate.sessionId, logger)

        // 8b. Copy non-block fields per plan §4.5 (one-to-one copy intent).
        // `mergeInheritedBlocks` is the third sanctioned writer for BLOCK
        // SHAPE only; the other fields listed in §4.5 are not its
        // responsibility (Stage A-3 deliberately kept `prune.tools` and the
        // recovery flags out — see `lib/compress/state.ts:384-388`). The
        // fields copied here mirror what `ensureSessionInitialized`
        // applies in the `persisted !== null` branch plus the recovery
        // flags which the normal load path intentionally drops.
        //
        // ponytail: BUG-031 "session-local reset" still applies for the
        // non-fork path (architect flag #7). On the FORK path we override
        // that reset because the user's intent (per feedback 2026-08-08) is
        // "always attempt to copy the original session's state". Add a
        // separate config gate if some users want recovery reset on fork.
        // ponytail: `prune.tools` maps `part.callID → tokenCount`.
        // `callID`s survive fork verbatim (OpenCode preserves them), so a
        // direct copy is safe — no rekey needed.
        const copied: string[] = []
        const skipped: string[] = []
        if (parentState.prune?.tools) {
            state.prune.tools = loadPruneMap(parentState.prune.tools)
            copied.push("prune.tools")
        } else {
            skipped.push("prune.tools")
        }
        if (typeof parentState.userForced === "boolean") {
            state.userForced = parentState.userForced
            copied.push("userForced")
        } else {
            skipped.push("userForced")
        }
        if (typeof parentState.recoveryForced === "boolean") {
            state.recoveryForced = parentState.recoveryForced
            copied.push("recoveryForced")
        } else {
            skipped.push("recoveryForced")
        }
        if (typeof parentState.nonCompactingRunCount === "number") {
            state.nonCompactingRunCount = parentState.nonCompactingRunCount
            copied.push("nonCompactingRunCount")
        } else {
            skipped.push("nonCompactingRunCount")
        }
        if (typeof parentState.recoveryFadeCounter === "number") {
            state.recoveryFadeCounter = parentState.recoveryFadeCounter
            copied.push("recoveryFadeCounter")
        } else {
            skipped.push("recoveryFadeCounter")
        }
        // BUG-088 — parent savings go to inheritedPruneTokens, NOT totalPruneTokens.
        // The cross-session aggregation in loadAllSessionStats
        // (lib/state/persistence.ts:598) sums totalPruneTokens only, so writing
        // parent's total here would double-count on the next all-time stats view.
        // Own-session flushes (prune / sweep / compress / decompress) still
        // operate on totalPruneTokens — semantics: totalPruneTokens is "this
        // session's own savings"; inheritedPruneTokens is "savings I display
        // from a parent fork", display-only.
        //
        // ponytail: BUG-088 v2 — single accumulator, single log entry based on
        // whether anything actually changed. Pre-fix the "copied" log fired as
        // soon as parentState.stats?.totalPruneTokens was a number, even when
        // the value was 0 (and inheritedPruneTokens was also 0), so the log
        // reported a copy that wrote nothing. Now both sources contribute to
        // one accumulator; "copied" only fires when the final value is > 0.
        let inheritedAccumulator = 0
        if (typeof parentState.stats?.totalPruneTokens === "number") {
            // ponytail: parent-only copy, not parent + counter — counter is
            // in-memory transient and gets flushed by flushPruneStats on the
            // next save, not duplicated here.
            inheritedAccumulator += parentState.stats.totalPruneTokens
        }
        // Multi-gen: if parent itself inherited from a grandparent, accumulate
        // so the per-session display shows total transitive inheritance from
        // the original owner. Still never contributes to totalPruneTokens.
        if (typeof parentState.stats?.inheritedPruneTokens === "number") {
            inheritedAccumulator += parentState.stats.inheritedPruneTokens
        }
        if (inheritedAccumulator > 0) {
            state.stats.inheritedPruneTokens = inheritedAccumulator
            copied.push("stats.inheritedPruneTokens")
        } else {
            skipped.push("stats.inheritedPruneTokens")
        }
        // NOTE: state.stats.totalPruneTokens is NOT touched by fork inheritance.

        // 8c. Re-derive the manualMode cache from the now-merged flags
        // via the canonical helper (DPP-017 / PAT-007). Mirrors the
        // `persisted !== null` branch in `ensureSessionInitialized`.
        state.manualMode = effectiveManualMode(state)

        logger.debug("fork inheritance: field copy summary", {
            parentId: parentCandidate.sessionId,
            copied,
            skipped,
            manualMode: state.manualMode,
        })

        // 9. Persist + record parent. The explicit save also writes
        // `sessionName` from `state.sessionTitle` (architect flag #10:
        // avoids editing 9 call sites — the save path defaults from the
        // in-memory cache when not passed explicitly; we pass it
        // explicitly to make the round-trip obvious at this site).
        // BUG-092 — plumb stateRetentionDays so the save-path sweep fires
        // on the first persist after the plugin boots.
        coalesceSaveSessionState(state, logger, state.sessionTitle, stateRetentionDays)
        state.inheritedFrom = parentCandidate.sessionId

        logger.info(
            `fork inheritance: ${rekeyed.length}/${rawBlocks.length} blocks preserved from "${forkInfo.parentTitle}" (#${forkInfo.forkNumber}, ${parentCandidate.sessionId})`,
        )
    } catch (err: any) {
        logger.debug("fork inheritance: unexpected error, continuing", {
            error: err?.message ?? String(err),
        })
    }
}
