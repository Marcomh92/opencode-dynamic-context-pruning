/**
 * State persistence module for DCP plugin.
 * Persists pruned tool IDs across sessions so they survive OpenCode restarts.
 * Storage location: ~/.local/share/opencode/storage/plugin/dcp/{sessionId}.json
 */

import * as fs from "fs/promises"
import { existsSync } from "fs"
import { homedir } from "os"
import { join } from "path"
import type { CompressionBlock, PrunedMessageEntry, SessionState, SessionStats } from "./types"
import { FORK_SCHEMA_VERSION } from "./types"
import type { Logger } from "../logger"
import { flushPruneStats, serializePruneMessagesState } from "./utils"

/** Prune state as stored on disk */
export interface PersistedPruneMessagesState {
    byMessageId: Record<string, PrunedMessageEntry>
    blocksById: Record<string, CompressionBlock>
    activeBlockIds: number[]
    activeByAnchorMessageId: Record<string, number>
    nextBlockId: number
    nextRunId: number
}

export interface PersistedPrune {
    tools?: Record<string, number>
    messages?: PersistedPruneMessagesState
}

export interface PersistedNudges {
    contextLimitAnchors: string[]
    turnNudgeAnchors?: string[]
    iterationNudgeAnchors?: string[]
}

export interface PersistedSessionState {
    sessionName?: string
    // Legacy v1 field, retained on the write side so older forks can still
    // detect a user-enabled manual mode on load. The load validation is solely
    // on forkSchemaVersion (see below).
    manualMode?: boolean
    // v2 fork-protocol fields (issue #573 + #590).
    userForced?: boolean
    recoveryForced?: boolean
    nonCompactingRunCount?: number
    recoveryFadeCounter?: number
    forkSchemaVersion?: number
    prune: PersistedPrune
    nudges: PersistedNudges
    stats: SessionStats
    lastUpdated: string
}

const STORAGE_DIR = join(
    process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
    "opencode",
    "storage",
    "plugin",
    "dcp",
)

/** Resolve the storage directory at call-time so per-test XDG_DATA_HOME
 *  overrides (set after this module was first imported) take effect.
 *  ponytail: this exists because module-top-level `const STORAGE_DIR`
 *  captures process.env at first import; tests that mutate env mid-run
 *  need a fresh read. Add when no test framework can hijack import order. */
function resolveStorageDir(): string {
    return join(
        process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
        "opencode",
        "storage",
        "plugin",
        "dcp",
    )
}

async function ensureStorageDir(): Promise<void> {
    const dir = resolveStorageDir()
    if (!existsSync(dir)) {
        await fs.mkdir(dir, { recursive: true })
    }
}

function getSessionFilePath(sessionId: string): string {
    return join(resolveStorageDir(), `${sessionId}.json`)
}

async function writePersistedSessionState(
    sessionId: string,
    state: PersistedSessionState,
    logger: Logger,
): Promise<void> {
    await ensureStorageDir()

    const filePath = getSessionFilePath(sessionId)
    const content = JSON.stringify(state, null, 2)
    await fs.writeFile(filePath, content, "utf-8")

    logger.info("Saved session state to disk", {
        sessionId,
        totalTokensSaved: state.stats.totalPruneTokens,
    })
}

export async function saveSessionState(
    sessionState: SessionState,
    logger: Logger,
    sessionName?: string,
): Promise<void> {
    try {
        if (!sessionState.sessionId) {
            return
        }

        // M2.5c Fix 2 — flush the counter into total before serialising. The
        // counter is in-memory transient state; if we save it non-zero, the
        // next loader sees a partial flush and would double-count on its
        // next write (sweep / compress / nudge). Flushing here guarantees
        // that whatever hits disk is the post-flush state.
        flushPruneStats(sessionState.stats)

        const state: PersistedSessionState = {
            sessionName: sessionName,
            // #590 mirror: only persist `true` when manualMode is genuinely "active".
            // The legacy `manualMode?: boolean` field is preserved for backward compat
            // with older forks; v2 load validation uses forkSchemaVersion instead.
            manualMode: sessionState.manualMode === "active",
            userForced: sessionState.userForced,
            recoveryForced: sessionState.recoveryForced,
            nonCompactingRunCount: sessionState.nonCompactingRunCount,
            recoveryFadeCounter: sessionState.recoveryFadeCounter,
            forkSchemaVersion: sessionState.forkSchemaVersion,
            prune: {
                tools: Object.fromEntries(sessionState.prune.tools),
                messages: serializePruneMessagesState(sessionState.prune.messages),
            },
            nudges: {
                contextLimitAnchors: Array.from(sessionState.nudges.contextLimitAnchors),
                turnNudgeAnchors: Array.from(sessionState.nudges.turnNudgeAnchors),
                iterationNudgeAnchors: Array.from(sessionState.nudges.iterationNudgeAnchors),
            },
            stats: sessionState.stats,
            lastUpdated: new Date().toISOString(),
        }

        // M2.5c Fix 2 — monotonic merge on save. The transform hook reloads
        // state from disk on every fire (intentional multi-instance sync,
        // see `loadOnEveryFire` rationale above), but two writers can race
        // if both load before either saves. last-writer-wins would lose the
        // earlier writer's contribution to totalPruneTokens. Read disk,
        // take max, write. Ponytail: the read is one JSON parse on the same
        // path we already wrote — adds one syscall per save, acceptable
        // because saveSessionState is coalesced per microtask (see
        // coalesceSaveSessionState). The schema-version + age gates are
        // already passed before this read, so we know the file shape is v3.
        //
        // Residual cross-process race (acknowledged in plan §3 Fix 2):
        // process A reads disk (= 100), computes max (= 110); process B
        // saves (writes 200); process A writes 110, overwriting B's 200.
        // The window is one fs roundtrip per save, the value is monotonically
        // increasing, and the worst case is one lost contribution. The fork
        // does not coordinate TUI + Desktop sidecars across processes; if
        // multi-process parity ever matters, add an advisory lock (flock on
        // POSIX, LockFileEx on Windows) before the read+write. Documented in
        // MY_CHANGELOG.md M2.5c entry under "residual race".
        try {
            const filePath = getSessionFilePath(sessionState.sessionId)
            if (existsSync(filePath)) {
                const content = await fs.readFile(filePath, "utf-8")
                const onDisk = JSON.parse(content) as PersistedSessionState
                if (typeof onDisk.stats?.totalPruneTokens === "number") {
                    state.stats.totalPruneTokens = Math.max(
                        state.stats.totalPruneTokens,
                        onDisk.stats.totalPruneTokens,
                    )
                }
            }
        } catch {
            // Merge is best-effort; a failed read falls through to the plain
            // write. The save-error catch below still reports any write error.
        }

        await writePersistedSessionState(sessionState.sessionId, state, logger)
    } catch (error: any) {
        logger.error("Failed to save session state", {
            sessionId: sessionState.sessionId,
            error: error?.message,
        })
    }
}

// M2.5c Fix 5 — coalesce saveSessionState. The transform hook can fire
// many times per second; each `void saveSessionState(state, logger)` in
// inject.ts spawns a full file write. With one coalesced write per
// microtask tick we get O(1) writes per transform fire instead of O(N).
// Ponytail: a microtask coalescer is sufficient because the transform
// hook is synchronous from call to return — all nudge-mutating sites in
// the same hook fire before the next microtask. If a caller needs
// strong save-on-await semantics, await saveSessionState() directly.
const saveScheduledBySession = new Map<string, boolean>()

export function coalesceSaveSessionState(
    sessionState: SessionState,
    logger: Logger,
    sessionName?: string,
): void {
    const sessionId = sessionState.sessionId
    if (!sessionId) {
        return
    }
    if (saveScheduledBySession.get(sessionId) === true) {
        return
    }
    saveScheduledBySession.set(sessionId, true)
    queueMicrotask(() => {
        saveScheduledBySession.set(sessionId, false)
        void saveSessionState(sessionState, logger, sessionName).catch((err: any) =>
            logger.warn("Coalesced save failed", { sessionId, error: err?.message }),
        )
    })
}

/** Test-only — clear the coalescer state between tests. */
export function resetSaveCoalescer(): void {
    saveScheduledBySession.clear()
}

export async function loadSessionState(
    sessionId: string,
    logger: Logger,
    maxAgeDays: number | null = null,
): Promise<PersistedSessionState | null> {
    try {
        const filePath = getSessionFilePath(sessionId)

        if (!existsSync(filePath)) {
            return null
        }

        const content = await fs.readFile(filePath, "utf-8")
        const state = JSON.parse(content) as PersistedSessionState

        const hasPruneTools = state?.prune?.tools && typeof state.prune.tools === "object"
        const hasPruneMessages = state?.prune?.messages && typeof state.prune.messages === "object"
        const hasNudgeFormat = state?.nudges && typeof state.nudges === "object"
        if (
            !state ||
            !state.prune ||
            !hasPruneTools ||
            !hasPruneMessages ||
            !state.stats ||
            !hasNudgeFormat
        ) {
            logger.warn("Invalid session state file, ignoring", {
                sessionId: sessionId,
            })
            return null
        }

        const rawContextLimitAnchors = Array.isArray(state.nudges.contextLimitAnchors)
            ? state.nudges.contextLimitAnchors
            : []
        const validAnchors = rawContextLimitAnchors.filter(
            (entry): entry is string => typeof entry === "string",
        )
        const dedupedAnchors = [...new Set(validAnchors)]
        if (validAnchors.length !== rawContextLimitAnchors.length) {
            logger.warn("Filtered out malformed contextLimitAnchors entries", {
                sessionId: sessionId,
                original: rawContextLimitAnchors.length,
                valid: validAnchors.length,
            })
        }
        state.nudges.contextLimitAnchors = dedupedAnchors

        const rawTurnNudgeAnchors = Array.isArray(state.nudges.turnNudgeAnchors)
            ? state.nudges.turnNudgeAnchors
            : []
        const validSoftAnchors = rawTurnNudgeAnchors.filter(
            (entry): entry is string => typeof entry === "string",
        )
        const dedupedSoftAnchors = [...new Set(validSoftAnchors)]
        if (validSoftAnchors.length !== rawTurnNudgeAnchors.length) {
            logger.warn("Filtered out malformed turnNudgeAnchors entries", {
                sessionId: sessionId,
                original: rawTurnNudgeAnchors.length,
                valid: validSoftAnchors.length,
            })
        }
        state.nudges.turnNudgeAnchors = dedupedSoftAnchors

        const rawIterationNudgeAnchors = Array.isArray(state.nudges.iterationNudgeAnchors)
            ? state.nudges.iterationNudgeAnchors
            : []
        const validIterationAnchors = rawIterationNudgeAnchors.filter(
            (entry): entry is string => typeof entry === "string",
        )
        const dedupedIterationAnchors = [...new Set(validIterationAnchors)]
        if (validIterationAnchors.length !== rawIterationNudgeAnchors.length) {
            logger.warn("Filtered out malformed iterationNudgeAnchors entries", {
                sessionId: sessionId,
                original: rawIterationNudgeAnchors.length,
                valid: validIterationAnchors.length,
            })
        }
        state.nudges.iterationNudgeAnchors = dedupedIterationAnchors

        // v2 schema-version gate (issue #590 + PLAN §6.3). Older state (no
        // forkSchemaVersion field, or v1) and newer state (a future fork we
        // can't read) are both dropped. The startup log line names the dropped
        // version so the user can correlate with a plugin upgrade.
        if (
            typeof state.forkSchemaVersion !== "number" ||
            state.forkSchemaVersion !== FORK_SCHEMA_VERSION
        ) {
            logger.warn(
                `Dropping persisted session state: forkSchemaVersion mismatch (got ${state.forkSchemaVersion ?? "missing"}, expected ${FORK_SCHEMA_VERSION})`,
                { sessionId: sessionId, droppedVersion: state.forkSchemaVersion ?? null },
            )
            return null
        }

        // Optional wall-clock expiry gate (PLAN §6.3). null disables; the
        // age comparison is skipped on a missing or unparsable lastUpdated so
        // a malformed timestamp never silently invalidates a fresh session.
        if (
            maxAgeDays !== null &&
            maxAgeDays >= 0 &&
            typeof state.lastUpdated === "string"
        ) {
            const parsed = Date.parse(state.lastUpdated)
            if (Number.isFinite(parsed)) {
                const ageDays = (Date.now() - parsed) / (1000 * 60 * 60 * 24)
                if (ageDays > maxAgeDays) {
                    logger.warn(
                        `Dropping persisted session state: age ${ageDays.toFixed(1)}d exceeds stateMaxAgeDays ${maxAgeDays}`,
                        { sessionId: sessionId, ageDays, maxAgeDays },
                    )
                    return null
                }
            }
        }

        logger.info("Loaded session state from disk", {
            sessionId: sessionId,
        })

        // M2.5c Fix 2 — flush the persisted counter into the lifetime total
        // on load. A counter >0 on disk means a prior writer crashed between
        // `counter += x` and the save; without the flush, the next writer
        // would add its own counter on top and double-count. ponytail: the
        // flush is in-place on the returned snapshot — callers that assign
        // into SessionState get the post-flush numbers automatically.
        flushPruneStats(state.stats)

        return state
    } catch (error: any) {
        logger.warn("Failed to load session state", {
            sessionId: sessionId,
            error: error?.message,
        })
        return null
    }
}

function emptyPersistedState(manualMode: boolean): PersistedSessionState {
    return {
        manualMode,
        userForced: manualMode,
        recoveryForced: false,
        nonCompactingRunCount: 0,
        forkSchemaVersion: FORK_SCHEMA_VERSION,
        prune: {
            tools: {},
            messages: {
                byMessageId: {},
                blocksById: {},
                activeBlockIds: [],
                activeByAnchorMessageId: {},
                nextBlockId: 1,
                nextRunId: 1,
            },
        },
        nudges: {
            contextLimitAnchors: [],
            turnNudgeAnchors: [],
            iterationNudgeAnchors: [],
        },
        stats: {
            pruneTokenCounter: 0,
            totalPruneTokens: 0,
        },
        lastUpdated: new Date().toISOString(),
    }
}

export async function loadManualModeSetting(
    sessionId: string,
    logger: Logger,
): Promise<boolean | undefined> {
    // manualMode is a derived flag — age doesn't apply. Skip the wall-clock gate.
    const state = await loadSessionState(sessionId, logger, null)
    return typeof state?.manualMode === "boolean" ? state.manualMode : undefined
}

export async function saveManualModeSetting(
    sessionId: string,
    manualMode: boolean,
    logger: Logger,
): Promise<void> {
    // Same: age doesn't apply to a write-only path; null disables the gate.
    const existing = await loadSessionState(sessionId, logger, null)
    const state = existing ?? emptyPersistedState(manualMode)
    state.manualMode = manualMode
    state.lastUpdated = new Date().toISOString()
    await writePersistedSessionState(sessionId, state, logger)
}

export interface AggregatedStats {
    totalTokens: number
    totalTools: number
    totalMessages: number
    sessionCount: number
}

export async function loadAllSessionStats(logger: Logger): Promise<AggregatedStats> {
    const result: AggregatedStats = {
        totalTokens: 0,
        totalTools: 0,
        totalMessages: 0,
        sessionCount: 0,
    }

    try {
        const dir = resolveStorageDir()
        if (!existsSync(dir)) {
            return result
        }

        const files = await fs.readdir(dir)
        const jsonFiles = files.filter((f) => f.endsWith(".json"))

        for (const file of jsonFiles) {
            try {
                const filePath = join(dir, file)
                const content = await fs.readFile(filePath, "utf-8")
                const state = JSON.parse(content) as PersistedSessionState

                if (state?.stats?.totalPruneTokens && state?.prune) {
                    result.totalTokens += state.stats.totalPruneTokens
                    result.totalTools += state.prune.tools
                        ? Object.keys(state.prune.tools).length
                        : 0
                    result.totalMessages += state.prune.messages?.byMessageId
                        ? Object.keys(state.prune.messages.byMessageId).length
                        : 0
                    result.sessionCount++
                }
            } catch {
                // Skip invalid files
            }
        }

        logger.debug("Loaded all-time stats", result)
    } catch (error: any) {
        logger.warn("Failed to load all-time stats", { error: error?.message })
    }

    return result
}
