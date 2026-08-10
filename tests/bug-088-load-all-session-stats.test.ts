/**
 * BUG-088 — `loadAllSessionStats` double-counts `totalPruneTokens` across
 * forked sessions. See known_issues/BUG-088-load-all-session-stats-double-count.md
 * for the original report. The fix (Option B in the report):
 *   1. Add `SessionStats.inheritedPruneTokens?: number`
 *      (lib/state/types.ts:30). Optional for backward compat with pre-fix
 *      state files.
 *   2. `inherit.ts` writes parent's `totalPruneTokens` into the CHILD's
 *      `inheritedPruneTokens` slot (NOT `totalPruneTokens`). Multi-gen:
 *      accumulates if the parent itself inherited from a grandparent.
 *   3. `loadAllSessionStats` aggregation is unchanged — still sums
 *      `totalPruneTokens` only. Now correct by construction because no
 *      fork copies into the summed field.
 *   4. `/dcp stats` per-session display reports `total + inherited` with
 *      an "(includes ~N inherited from fork)" annotation only when
 *      `inheritedPruneTokens > 0`.
 *
 * PAT references:
 *   - PAT-010: inline builders (no fixtures dir)
 *   - PAT-011: XDG sandbox per-test temp dir (each test allocates its own)
 *   - PAT-012: audit-trail trailer at EOF
 *   - PAT-013: BUG-088: prefix in test names
 */
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test, { afterEach } from "node:test"
import { Logger } from "../lib/logger"
import { FORK_SCHEMA_VERSION, type CompressionBlock, type WithParts } from "../lib/state/types"
import { createSessionState, loadAllSessionStats, tryInheritFromParent } from "../lib/state"
import { buildStatsReport, formatStatsMessage } from "../lib/commands/stats"

// PAT-011: per-test XDG_DATA_HOME. resolveStorageDir() reads the env var at
// call-time so each test can point at a fresh dir. afterEach reaps the dir
// so leftover state files never bleed between cases (the loadAllSessionStats
// aggregation would otherwise over-sum across cases).
let currentSandbox: string | null = null
afterEach(() => {
    if (currentSandbox) {
        rmSync(currentSandbox, { recursive: true, force: true })
        currentSandbox = null
    }
    delete process.env.XDG_DATA_HOME
})

/** Allocate a fresh XDG sandbox and return the storage dir under it. */
function newSandbox(): string {
    const dataHome = mkdtempSync(join(tmpdir(), "dcp-bug-088-"))
    process.env.XDG_DATA_HOME = dataHome
    currentSandbox = dataHome
    return join(dataHome, "opencode", "storage", "plugin", "dcp")
}

const logger = new Logger(false)

// ---------------------------------------------------------------------------
// Inline builders (PAT-010)
// ---------------------------------------------------------------------------

/** Minimal well-formed persisted state file. `stats` is overridable so each
 *  test can pick the exact (totalPruneTokens, inheritedPruneTokens) shape
 *  it needs. */
function writePersistedFile(
    sessionId: string,
    sessionName: string,
    stats: { totalPruneTokens: number; inheritedPruneTokens?: number },
    dir: string,
): void {
    mkdirSync(dir, { recursive: true })
    const payload = {
        sessionName,
        manualMode: false,
        userForced: false,
        recoveryForced: false,
        nonCompactingRunCount: 0,
        recoveryFadeCounter: 0,
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
            totalPruneTokens: stats.totalPruneTokens,
            ...(stats.inheritedPruneTokens !== undefined
                ? { inheritedPruneTokens: stats.inheritedPruneTokens }
                : {}),
        },
        lastUpdated: new Date().toISOString(),
    }
    writeFileSync(join(dir, `${sessionId}.json`), JSON.stringify(payload, null, 2), "utf-8")
}

/** Build a persisted file for a parent with a single compression block. Used
 *  by the fork-copy tests. Mirrors the helper shape from
 *  tests/session-fork-inherit.test.ts:189 (`persistBlock`). */
function writeParentBlock(
    sessionId: string,
    sessionName: string,
    stats: { totalPruneTokens: number; inheritedPruneTokens?: number },
    dir: string,
): void {
    mkdirSync(dir, { recursive: true })
    const block: CompressionBlock = {
        blockId: 1,
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 1000,
        summaryTokens: 100,
        durationMs: 0,
        mode: "range",
        topic: "Bug088 test block",
        batchTopic: "Bug088 test block",
        startId: "msg-1",
        endId: "msg-10",
        anchorMessageId: "msg-2",
        compressMessageId: "msg-1",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: [],
        directToolIds: [],
        effectiveMessageIds: [],
        effectiveToolIds: [],
        createdAt: Date.now(),
        summary: "Bug088 test summary",
        startTime: 1,
        endTime: 10,
        effectiveTimeMs: Array.from({ length: 10 }, (_, i) => i + 1),
        directTimeMs: Array.from({ length: 10 }, (_, i) => i + 1),
        anchorTime: 2,
        compressTime: 1,
    }
    const payload = {
        sessionName,
        manualMode: false,
        userForced: false,
        recoveryForced: false,
        nonCompactingRunCount: 0,
        recoveryFadeCounter: 0,
        forkSchemaVersion: FORK_SCHEMA_VERSION,
        prune: {
            tools: {},
            messages: {
                byMessageId: {},
                blocksById: { [String(block.blockId)]: block },
                activeBlockIds: [block.blockId],
                activeByAnchorMessageId: { [block.anchorMessageId]: block.blockId },
                nextBlockId: 2,
                nextRunId: 2,
            },
        },
        nudges: {
            contextLimitAnchors: [],
            turnNudgeAnchors: [],
            iterationNudgeAnchors: [],
        },
        stats: {
            pruneTokenCounter: 0,
            totalPruneTokens: stats.totalPruneTokens,
            ...(stats.inheritedPruneTokens !== undefined
                ? { inheritedPruneTokens: stats.inheritedPruneTokens }
                : {}),
        },
        lastUpdated: new Date().toISOString(),
    }
    writeFileSync(join(dir, `${sessionId}.json`), JSON.stringify(payload, null, 2), "utf-8")
}

function buildMessages(sessionID: string, count: number): WithParts[] {
    return Array.from({ length: count }, (_, index) => {
        const id = `msg-${index + 1}`
        const role = index % 2 === 0 ? "user" : "assistant"
        return {
            info: {
                id,
                role,
                sessionID,
                agent: "assistant",
                ...(role === "user"
                    ? { model: { providerID: "test", modelID: "test-model" } }
                    : {}),
                time: { created: index + 1 },
            } as WithParts["info"],
            parts: [
                {
                    id: `${id}-part`,
                    messageID: id,
                    sessionID,
                    type: "text" as const,
                    text: `raw content ${index + 1}`,
                },
            ],
        }
    })
}

/** Fake OpenCode client that returns `messagesB` for B's session and
 *  `titles.get(id)` for `session.get`. Mirrors the rig in
 *  tests/session-fork-inherit.test.ts:125. */
function buildClient(
    messagesBySession: Map<string, WithParts[]>,
    titles: Map<string, string>,
): any {
    return {
        session: {
            messages: async ({ path: { id } }: { path: { id: string } }) => ({
                data: messagesBySession.get(id) ?? [],
            }),
            get: async ({ path: { id } }: { path: { id: string } }) => ({
                data: { parentID: null, title: titles.get(id) },
            }),
        },
        tui: { showToast: async () => {} },
    }
}

/** Minimal config — most keys are ignored by `tryInheritFromParent` and
 *  `findCandidateParents`; we only need the `experimental.inheritOnFork`
 *  gate (default-on when undefined). */
function buildConfig(): any {
    return {
        experimental: { inheritOnFork: true, allowSubAgents: true },
        compress: { recoveryFadeWindow: 5, permission: "allow" },
    }
}

/** Pop the persisted state back off disk. The saveSessionState path runs
 *  after `tryInheritFromParent` (coalesced via microtask); waiting two
 *  setImmediate ticks lets the persisted file flush before the test
 *  asserts on it. */
async function flushSaves(): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
}

// ---------------------------------------------------------------------------
// 1. Aggregation behaviour — loadAllSessionStats sums ONLY totalPruneTokens
// ---------------------------------------------------------------------------

test("BUG-088: loadAllSessionStats sums only totalPruneTokens across files (ignores inherited)", async () => {
    const storageDir = newSandbox()
    // Three mock session files: A (own 1000), B forked from A (own 0,
    // inherited 1000), C (own 500). Pre-fix aggregation would have summed
    // both fields and reported 2500. Post-fix aggregation sums only the
    // `totalPruneTokens` field, so it reports 1500 — the actual lifetime
    // savings across A and C, with B's inheritance correctly NOT counted
    // (A's 1000 is already in the sum).
    const ts = Date.now()
    writePersistedFile(`ses_A_${ts}`, "AggA", { totalPruneTokens: 1000 }, storageDir)
    writePersistedFile(
        `ses_B_${ts}`,
        "AggB",
        { totalPruneTokens: 0, inheritedPruneTokens: 1000 },
        storageDir,
    )
    writePersistedFile(`ses_C_${ts}`, "AggC", { totalPruneTokens: 500 }, storageDir)

    const all = await loadAllSessionStats(logger)

    // The aggregate must equal 1000 + 0 + 500 = 1500, NOT 2500.
    // sessionCount counts every file that has totalPruneTokens truthy AND
    // a prune block — see lib/state/persistence.ts:598. The guard
    // `if (state?.stats?.totalPruneTokens && ...)` is truthy-gated, so a
    // file with totalPruneTokens === 0 (file B above) does NOT count
    // toward sessionCount even though it has a valid prune block.
    // sessionCount is therefore 2 (A + C). B's inheritedPruneTokens
    // does not change this — only the summed total is the contract.
    assert.equal(all.totalTokens, 1500, "BUG-088: aggregate must skip inheritedPruneTokens")
    assert.equal(
        all.sessionCount,
        2,
        "BUG-088: sessionCount counts files with truthy totalPruneTokens (B's 0 is excluded)",
    )
})

test("BUG-088: loadAllSessionStats ignores inheritedPruneTokens in the sum", async () => {
    const storageDir = newSandbox()
    // Same scenario but with only inherited values on B. The aggregate
    // sums ONLY totalPruneTokens: B's 0 contributes 0. A future
    // regression that lifts the `totalPruneTokens` truthy guard AND
    // sums the inherited field would pull 5000 in — pin that this
    // does NOT happen.
    const ts = Date.now()
    writePersistedFile(`ses_A_${ts}_solo`, "SoloA", { totalPruneTokens: 200 }, storageDir)
    writePersistedFile(
        `ses_B_${ts}_solo`,
        "SoloB",
        { totalPruneTokens: 0, inheritedPruneTokens: 5000 },
        storageDir,
    )

    const all = await loadAllSessionStats(logger)

    assert.equal(
        all.totalTokens,
        200,
        "BUG-088: an inherited-only file contributes 0 to the aggregate (inherited field is excluded)",
    )
})

test("BUG-088: loadAllSessionStats handles legacy pre-fix files (no inheritedPruneTokens field)", async () => {
    const storageDir = newSandbox()
    // A pre-fix file has stats.totalPruneTokens but NO stats.inheritedPruneTokens
    // (the field was added by the fix). The aggregate must still pick up
    // the legacy file. The plan tolerates legacy overcount here because
    // those sessions self-heal as they age out (per BUG-088 §Resolution
    // rationale, "self-healing as those sessions age out"). Document the
    // current behaviour: legacy file's totalPruneTokens contributes.
    const ts = Date.now()
    writePersistedFile(`ses_legacy_${ts}`, "LegacyA", { totalPruneTokens: 1000 }, storageDir)
    writePersistedFile(
        `ses_fixed_${ts}`,
        "FixedA",
        { totalPruneTokens: 500, inheritedPruneTokens: 500 },
        storageDir,
    )

    const all = await loadAllSessionStats(logger)

    // Legacy file's 1000 contributes; the fixed file's own 500 contributes;
    // the fixed file's inherited 500 does NOT. Total = 1500.
    assert.equal(
        all.totalTokens,
        1500,
        "BUG-088: legacy pre-fix files contribute totalPruneTokens (no inherited field exists)",
    )
})

// ---------------------------------------------------------------------------
// 2. Fork-copy behaviour — inherit.ts writes parent's total to child's
//    inheritedPruneTokens (NOT totalPruneTokens), with multi-gen accumulation.
// ---------------------------------------------------------------------------

test("BUG-088: inherit.ts writes parent's totalPruneTokens to child's inheritedPruneTokens", async () => {
    const storageDir = newSandbox()
    // Parent A has totalPruneTokens: 5000 (own savings). Fork to B.
    // After inheritance, B's stats.totalPruneTokens must stay 0 (own-session
    // semantics) and stats.inheritedPruneTokens must equal 5000 (display-only).
    const sessionA = `ses_A_${Date.now()}_fc`
    const sessionB = `ses_B_${Date.now()}_fc`
    const messagesB = buildMessages(sessionB, 10)
    const titles = new Map<string, string>([
        [sessionA, "ForkCopy"],
        [sessionB, "ForkCopy (fork #1)"],
    ])
    const client = buildClient(new Map([[sessionB, messagesB]]), titles)

    writeParentBlock(sessionA, "ForkCopy", { totalPruneTokens: 5000 }, storageDir)

    const state = createSessionState()
    // The orchestrator reads state.sessionTitle to detect the fork
    // pattern. ensureSessionInitialized normally caches it from the SDK;
    // since we call the orchestrator directly here, we set it ourselves.
    state.sessionTitle = "ForkCopy (fork #1)"
    await tryInheritFromParent(
        state,
        client,
        sessionB,
        logger,
        messagesB,
        buildConfig(),
        null,
        null,
    )
    await flushSaves()

    assert.equal(
        state.stats.totalPruneTokens,
        0,
        "BUG-088: child's own-session total is untouched by fork inheritance",
    )
    assert.equal(
        state.stats.inheritedPruneTokens,
        5000,
        "BUG-088: parent's 5000 lands in child's inheritedPruneTokens",
    )
})

test("BUG-088: multi-gen inheritance accumulates parent's total + parent's inherited", async () => {
    const storageDir = newSandbox()
    // Parent A has totalPruneTokens: 1000 (own) AND inheritedPruneTokens: 2000
    // (from a grandparent). Fork to child B. The fork-copy logic at
    // lib/state/inherit.ts:660-679 sums both: 1000 + 2000 = 3000 must
    // land in B's inheritedPruneTokens. The transitive total is what
    // /dcp stats displays per-session.
    const sessionA = `ses_A_${Date.now()}_multigen`
    const sessionB = `ses_B_${Date.now()}_multigen`
    const messagesB = buildMessages(sessionB, 10)
    const titles = new Map<string, string>([
        [sessionA, "MultiGen"],
        [sessionB, "MultiGen (fork #1)"],
    ])
    const client = buildClient(new Map([[sessionB, messagesB]]), titles)

    writeParentBlock(
        sessionA,
        "MultiGen",
        { totalPruneTokens: 1000, inheritedPruneTokens: 2000 },
        storageDir,
    )

    const state = createSessionState()
    state.sessionTitle = "MultiGen (fork #1)"
    await tryInheritFromParent(
        state,
        client,
        sessionB,
        logger,
        messagesB,
        buildConfig(),
        null,
        null,
    )
    await flushSaves()

    assert.equal(
        state.stats.totalPruneTokens,
        0,
        "BUG-088: child's own-session total stays 0 even when parent had inherited",
    )
    assert.equal(
        state.stats.inheritedPruneTokens,
        3000,
        "BUG-088: child's inheritedPruneTokens = parent's total + parent's inherited (1000 + 2000)",
    )
})

// ---------------------------------------------------------------------------
// 3. Per-session display behaviour — /dcp stats annotation
// ---------------------------------------------------------------------------

test("BUG-088: stats per-session shows total + inherited with annotation when inherited > 0", async () => {
    // Hermetic: fresh sandbox so buildStatsReport's internal call to
    // loadAllSessionStats reads an empty storage dir.
    newSandbox()
    // The per-session figure is totalPruneTokens + inheritedPruneTokens.
    // When inherited > 0, the formatter appends
    // "(includes ~N inherited from fork)" so the user sees where the
    // forked share comes from. Pin the exact substring so the UI text
    // doesn't drift.
    //
    // We use buildStatsReport + formatStatsMessage directly to avoid
    // wiring a full handleStatsCommand call (which needs a mocked
    // OpenCode client + notifications). The two functions are the
    // load-bearing formatters — see lib/commands/stats.ts:24 and :149.
    const state = createSessionState()
    state.stats.totalPruneTokens = 100
    state.stats.inheritedPruneTokens = 900

    const report = await buildStatsReport(state, logger)

    assert.equal(
        report.sessionTokens,
        1000,
        "BUG-088: per-session figure is totalPruneTokens + inheritedPruneTokens (100 + 900 = 1000)",
    )
    assert.equal(
        report.inheritedTokens,
        900,
        "BUG-088: report.inheritedTokens carries inheritedPruneTokens through for the formatter",
    )

    // Render the formatted text via formatStatsMessage with a zero all-time
    // so we can assert the per-session line in isolation.
    const text = formatStatsMessage(
        report.sessionTokens,
        report.sessionSummaryTokens,
        report.sessionTools,
        report.sessionMessages,
        report.sessionDurationMs,
        report.allTime,
        false, // recoveryForced
        0, // nonCompactingRunCount
        0, // recoveryFadeCounter
        5, // recoveryFadeWindow
        report.inheritedTokens,
    )

    // formatTokenCount(1000) = "1K tokens"; formatTokenCount(900) = "900 tokens".
    // Annotation substring: "(includes ~900 tokens inherited from fork)".
    assert.match(
        text,
        /Tokens saved:\s*~1K tokens \(includes ~900 tokens inherited from fork\)/,
        "BUG-088: per-session line shows total + inherited with the fork annotation",
    )
})

test("BUG-088: stats per-session omits annotation when inheritedPruneTokens === 0", async () => {
    // Hermetic: fresh sandbox so buildStatsReport's internal call to
    // loadAllSessionStats reads an empty storage dir.
    newSandbox()
    // When the child has no inherited savings (parent had zero, or this
    // is not a fork), the per-session line must NOT carry the "(includes
    // ~N inherited from fork)" annotation. The `inheritedTokens > 0`
    // guard at lib/commands/stats.ts:55-58 is what enforces this.
    const state = createSessionState()
    state.stats.totalPruneTokens = 100
    // inheritedPruneTokens is left undefined (= 0 by the ?? 0 default at
    // lib/commands/stats.ts:155). The annotation must be absent.

    const report = await buildStatsReport(state, logger)

    assert.equal(
        report.sessionTokens,
        100,
        "BUG-088: per-session figure is just totalPruneTokens when inherited is 0",
    )
    assert.equal(
        report.inheritedTokens,
        0,
        "BUG-088: report.inheritedTokens falls back to 0 when inheritedPruneTokens is unset",
    )

    const text = formatStatsMessage(
        report.sessionTokens,
        report.sessionSummaryTokens,
        report.sessionTools,
        report.sessionMessages,
        report.sessionDurationMs,
        report.allTime,
        false, // recoveryForced
        0, // nonCompactingRunCount
        0, // recoveryFadeCounter
        5, // recoveryFadeWindow
        report.inheritedTokens,
    )

    // The "Tokens saved:" line must NOT contain the "(includes ... inherited
    // from fork)" annotation. Use a negative match that anchors on the
    // per-session line — broader "inherited" words appear elsewhere in the
    // output but never adjacent to "Tokens saved:" in the no-inherit case.
    const perSessionLine = text
        .split("\n")
        .find((l) => l.includes("Tokens saved:") && !l.includes("All-time"))
    assert.ok(perSessionLine, "BUG-088: per-session 'Tokens saved:' line must be present")
    assert.ok(
        !perSessionLine.includes("inherited from fork"),
        `BUG-088: per-session 'Tokens saved:' line must omit the inherited annotation when inheritedPruneTokens === 0 (got: ${perSessionLine})`,
    )
})

// Logic Verified: BUG-088 aggregation (loadAllSessionStats sums only totalPruneTokens, ignores inheritedPruneTokens, handles legacy pre-fix files); BUG-088 fork-copy (tryInheritFromParent writes parent's total into child's inheritedPruneTokens, multi-gen accumulates parent + parent's inherited); BUG-088 display (formatStatsMessage adds inherited annotation when >0, omits when ===0, buildStatsReport sums own+inherited for per-session figure).
// Bugs Documented: BUG-088 — see known_issues/BUG-088-load-all-session-stats-double-count.md.
// Fakes Updated: inline OpenCode client + file-system persistence with per-test XDG sandbox; buildStatsReport/formatStatsMessage are called directly with a constructed SessionState instead of driving handleStatsCommand end-to-end (no notification/SDK stub needed for the formatter contract).
// Review Status: pending independent review.
