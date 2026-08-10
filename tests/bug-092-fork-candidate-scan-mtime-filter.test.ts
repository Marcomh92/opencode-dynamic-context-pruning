/**
 * BUG-092 — fork candidate scan: mtime pre-filter + log collapse + sweep on
 * save + stateRetentionDays config. See
 * known_issues/BUG-092-fork-candidate-scan-ungoverned-directory-growth.md
 * for the original report; the four changes under test are summarised in
 * the section headers below.
 *
 * PAT references:
 *   - PAT-010: inline builders (no fixtures dir)
 *   - PAT-011: XDG sandbox per-test temp dirs
 *   - PAT-012: audit-trail trailer at EOF
 *   - PAT-013: BUG-092: prefix in test names
 */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test, { afterEach } from "node:test"
import { clampStateRetentionDays, getConfig } from "../lib/config"
import { Logger } from "../lib/logger"
import { findCandidateParents } from "../lib/state/inherit"
import { sweepExpiredStateFiles } from "../lib/state/persistence"
import { FORK_SCHEMA_VERSION } from "../lib/state/types"

// PAT-011: per-test XDG_DATA_HOME. resolveStorageDir() reads the env var at
// call-time so each test can point at a fresh dir. afterEach reaps the dir
// so leftover state files never bleed between cases.
let currentSandbox: string | null = null
let currentConfigSandbox: string | null = null
afterEach(() => {
    if (currentSandbox) {
        rmSync(currentSandbox, { recursive: true, force: true })
        currentSandbox = null
    }
    if (currentConfigSandbox) {
        rmSync(currentConfigSandbox, { recursive: true, force: true })
        currentConfigSandbox = null
    }
    delete process.env.XDG_DATA_HOME
    delete process.env.XDG_CONFIG_HOME
})

/** Allocate a fresh XDG sandbox and return the storage dir under it. */
function newSandbox(): string {
    const dataHome = mkdtempSync(join(tmpdir(), "dcp-bug-092-"))
    process.env.XDG_DATA_HOME = dataHome
    currentSandbox = dataHome
    return join(dataHome, "opencode", "storage", "plugin", "dcp")
}

/** Logger whose debug/info/warn calls are recorded for assertion. The real
 *  Logger(false) has enabled=false so its write() is a no-op; the method
 *  reassignments here are the capture shim. Pattern from
 *  tests/coalesce-save-session.test.ts. */
function makeCapturingLogger(): {
    logger: Logger
    debugCalls: Array<{ msg: string; data?: any }>
    infoCalls: Array<{ msg: string; data?: any }>
    warnCalls: Array<{ msg: string; data?: any }>
} {
    const logger = new Logger(false)
    const debugCalls: Array<{ msg: string; data?: any }> = []
    const infoCalls: Array<{ msg: string; data?: any }> = []
    const warnCalls: Array<{ msg: string; data?: any }> = []
    const origDebug = logger.debug.bind(logger)
    const origInfo = logger.info.bind(logger)
    const origWarn = logger.warn.bind(logger)
    logger.debug = ((msg: string, data?: any) => {
        debugCalls.push({ msg, data })
        void origDebug(msg, data)
    }) as Logger["debug"]
    logger.info = ((msg: string, data?: any) => {
        infoCalls.push({ msg, data })
        void origInfo(msg, data)
    }) as Logger["info"]
    logger.warn = ((msg: string, data?: any) => {
        warnCalls.push({ msg, data })
        void origWarn(msg, data)
    }) as Logger["warn"]
    return { logger, debugCalls, infoCalls, warnCalls }
}

interface StateFileOpts {
    title?: string
    schemaVersion?: number
    mtimeDaysAgo?: number
}

/** Write a minimal but well-formed persisted state file. The title and
 *  schema version can be overridden to drive the BUG-092 gates. */
function writeStateFile(storageDir: string, sessionId: string, opts: StateFileOpts = {}): void {
    const title = opts.title ?? "Bug092"
    const schemaVersion = opts.schemaVersion ?? FORK_SCHEMA_VERSION
    const payload = {
        sessionName: title,
        manualMode: false,
        userForced: false,
        forkSchemaVersion: schemaVersion,
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
        stats: { pruneTokenCounter: 0, totalPruneTokens: 0 },
        lastUpdated: new Date().toISOString(),
    }
    const filePath = join(storageDir, `${sessionId}.json`)
    writeFileSync(filePath, JSON.stringify(payload), "utf-8")
    if (typeof opts.mtimeDaysAgo === "number") {
        const past = new Date(Date.now() - opts.mtimeDaysAgo * 86_400_000)
        utimesSync(filePath, past, past)
    }
}

// ---------------------------------------------------------------------------
// 1. mtime pre-filter behaviour
// ---------------------------------------------------------------------------

test("BUG-092: mtime filter skips files older than stateRetentionDays", async () => {
    const storageDir = newSandbox()
    mkdirSync(storageDir, { recursive: true })
    // fresh: mtime = now, well inside the 7-day window.
    writeStateFile(storageDir, "fresh", { mtimeDaysAgo: 0 })
    // exact: mtime at the cutoff boundary (now - 7d). Set up for
    // completeness; the strict < comparison means the boundary is
    // filesystem-precision sensitive on some platforms, so we do not
    // assert on it — only on the clear-cut well-over case below.
    writeStateFile(storageDir, "exact", { mtimeDaysAgo: 7 })
    // old: mtime well past the cutoff.
    writeStateFile(storageDir, "old", { mtimeDaysAgo: 30 })

    const candidates = await findCandidateParents("Bug092", new Logger(false), undefined, 7)

    assert.ok(
        candidates.find((c) => c.sessionId === "fresh"),
        "BUG-092: a fresh file (mtime = now) must survive the mtime pre-filter (sanity check)",
    )
    assert.equal(
        candidates.find((c) => c.sessionId === "old"),
        undefined,
        "BUG-092: a file well past the cutoff (mtime = now - 30d) must be filtered out by the mtime pre-filter",
    )
})

test("BUG-092: mtime filter is bypassed when stateRetentionDays is null", async () => {
    const storageDir = newSandbox()
    mkdirSync(storageDir, { recursive: true })
    writeStateFile(storageDir, "fresh", { mtimeDaysAgo: 0 })
    writeStateFile(storageDir, "very-old", { mtimeDaysAgo: 365 })

    const candidates = await findCandidateParents("Bug092", new Logger(false), undefined, null)

    assert.ok(
        candidates.find((c) => c.sessionId === "fresh"),
        "BUG-092: null retention must keep fresh files",
    )
    assert.ok(
        candidates.find((c) => c.sessionId === "very-old"),
        "BUG-092: null retention must keep old files too (mtime filter disabled — legacy behaviour)",
    )
})

test("BUG-092: mtime filter with stateRetentionDays=null collapses to disabled (zero retention case)", async () => {
    // Per the new contract, `stateRetentionDays=0` is collapsed to `null` at
    // the config-merge layer by `clampStateRetentionDays` — so the candidate
    // scan never receives a literal `0`. From the user's perspective, "no
    // retention" and "disabled" both round-trip to `null` and the scan
    // behaves identically (everything is a candidate). This test pins the
    // user-facing contract: passing `null` returns the full set with no
    // mtime filtering.
    const storageDir = newSandbox()
    mkdirSync(storageDir, { recursive: true })
    writeStateFile(storageDir, "fresh", { mtimeDaysAgo: 0 })
    writeStateFile(storageDir, "old", { mtimeDaysAgo: 30 })

    const candidates = await findCandidateParents("Bug092", new Logger(false), undefined, null)

    const sessionIds = candidates.map((c) => c.sessionId).sort()
    assert.deepEqual(
        sessionIds,
        ["fresh", "old"],
        "BUG-092: stateRetentionDays=null must NOT mtime-filter — both fresh and old files are kept (0 collapses to null via clampStateRetentionDays)",
    )
})

// ---------------------------------------------------------------------------
// 2. Log collapse behaviour
// ---------------------------------------------------------------------------

test("BUG-092: scan emits exactly one summary debug line when files are skipped", async () => {
    const storageDir = newSandbox()
    mkdirSync(storageDir, { recursive: true })
    // Wrong schema version → schemaSkipped++.
    writeStateFile(storageDir, "bad-schema", { schemaVersion: 2 })
    // Right schema, but old mtime → ageSkipped++.
    writeStateFile(storageDir, "old-but-current", { mtimeDaysAgo: 30 })
    // Right schema, fresh — kept.
    writeStateFile(storageDir, "kept", { mtimeDaysAgo: 0 })

    const { logger, debugCalls } = makeCapturingLogger()
    await findCandidateParents("Bug092", logger, undefined, 7)

    const summaryCalls = debugCalls.filter((c) => c.msg === "fork candidate scan summary")
    assert.equal(
        summaryCalls.length,
        1,
        "BUG-092: exactly one summary debug line is expected when both age and schema skips occur",
    )
    const data = summaryCalls[0].data
    assert.equal(data.schemaSkipped, 1, "BUG-092: summary.schemaSkipped count is wrong")
    assert.equal(data.ageSkipped, 1, "BUG-092: summary.ageSkipped count is wrong")
    assert.equal(data.kept, 1, "BUG-092: summary.kept count is wrong")
})

test("BUG-092: scan does not emit the per-file dropping pre-bump file debug line", async () => {
    const storageDir = newSandbox()
    mkdirSync(storageDir, { recursive: true })
    // Pre-bump files (wrong schemaVersion) so schemaSkipped > 0.
    writeStateFile(storageDir, "pre-bump-1", { schemaVersion: 2 })
    writeStateFile(storageDir, "pre-bump-2", { schemaVersion: 3 })
    writeStateFile(storageDir, "pre-bump-3", { schemaVersion: 1 })

    const { logger, debugCalls, infoCalls, warnCalls } = makeCapturingLogger()
    await findCandidateParents("Bug092", logger, undefined, 7)

    const all = [...debugCalls, ...infoCalls, ...warnCalls]
    const offenders = all.filter((c) => c.msg.includes("dropping pre-bump file"))
    assert.deepEqual(
        offenders,
        [],
        "BUG-092: per-file 'dropping pre-bump file' debug line must not be emitted (replaced by one summary line)",
    )
})

// ---------------------------------------------------------------------------
// 3. Sweep on save behaviour
//
// NOTE on test order: `sweepDone` is a module-level flag in
// lib/state/persistence.ts. The first sweep test in this file runs while
// the flag is still false; it sets the flag while doing the deletion. The
// throttle test runs after and depends on the flag being set; the null
// test is order-independent (null is checked before the flag).
// ---------------------------------------------------------------------------

test("BUG-092: sweep deletes files older than stateRetentionDays", async () => {
    const storageDir = newSandbox()
    mkdirSync(storageDir, { recursive: true })
    writeStateFile(storageDir, "fresh-sweep", { mtimeDaysAgo: 0 })
    writeStateFile(storageDir, "old-sweep", { mtimeDaysAgo: 30 })

    await sweepExpiredStateFiles(new Logger(false), 7)

    assert.ok(
        existsSync(join(storageDir, "fresh-sweep.json")),
        "BUG-092: a fresh file must survive the sweep",
    )
    assert.equal(
        existsSync(join(storageDir, "old-sweep.json")),
        false,
        "BUG-092: an old file must be deleted by the sweep",
    )
})

test("BUG-092: sweep is throttled — subsequent calls are no-ops", async () => {
    // The deletion test above has already set the module-level `sweepDone`
    // flag. We observe the throttle by creating a new old file AFTER the
    // first sweep and confirming it survives a second sweep call: a
    // non-throttled second call would delete it.
    const storageDir = newSandbox()
    mkdirSync(storageDir, { recursive: true })
    const past = new Date(Date.now() - 30 * 86_400_000)

    const target = join(storageDir, "throttle-target-1.json")
    writeFileSync(target, JSON.stringify({ forkSchemaVersion: FORK_SCHEMA_VERSION }), "utf-8")
    utimesSync(target, past, past)

    // First call — flag is set (from the deletion test) → no-op regardless
    // of the file. The behaviour we care about is the SECOND call below.
    await sweepExpiredStateFiles(new Logger(false), 7)

    // Create a second old file. The second sweep call is what we test.
    const target2 = join(storageDir, "throttle-target-2.json")
    writeFileSync(target2, JSON.stringify({ forkSchemaVersion: FORK_SCHEMA_VERSION }), "utf-8")
    utimesSync(target2, past, past)

    await sweepExpiredStateFiles(new Logger(false), 7)

    assert.ok(
        existsSync(target2),
        "BUG-092: second sweep call is throttled — a file created between the two calls must not be deleted",
    )
})

test("BUG-092: sweep returns early when stateRetentionDays is null", async () => {
    const storageDir = newSandbox()
    mkdirSync(storageDir, { recursive: true })
    writeStateFile(storageDir, "fresh-null", { mtimeDaysAgo: 0 })
    writeStateFile(storageDir, "old-null", { mtimeDaysAgo: 365 })

    await sweepExpiredStateFiles(new Logger(false), null)

    assert.ok(
        existsSync(join(storageDir, "fresh-null.json")),
        "BUG-092: null retention must leave fresh files alone",
    )
    assert.ok(
        existsSync(join(storageDir, "old-null.json")),
        "BUG-092: null retention must leave old files alone (no sweep, legacy behaviour)",
    )
})

// ---------------------------------------------------------------------------
// 4. Config validation
// ---------------------------------------------------------------------------

test("BUG-092: clampStateRetentionDays returns null for null/undefined/NaN/Infinity/non-numbers", () => {
    assert.equal(clampStateRetentionDays(null), null, "BUG-092: null is the disabled sentinel")
    assert.equal(clampStateRetentionDays(undefined), null, "BUG-092: undefined collapses to null")
    assert.equal(clampStateRetentionDays(Number.NaN), null, "BUG-092: NaN is a user error → null")
    assert.equal(
        clampStateRetentionDays(Number.POSITIVE_INFINITY),
        null,
        "BUG-092: +Infinity is a user error → null",
    )
    assert.equal(
        clampStateRetentionDays(Number.NEGATIVE_INFINITY),
        null,
        "BUG-092: -Infinity is a user error → null",
    )
    // @ts-expect-error verify runtime guard rejects non-numbers
    assert.equal(clampStateRetentionDays("30"), null, "BUG-092: string is not a number → null")
    // @ts-expect-error verify runtime guard rejects objects
    assert.equal(clampStateRetentionDays({}), null, "BUG-092: object is not a number → null")
})

test("BUG-092: clampStateRetentionDays returns null for 0 and negatives (disabled)", () => {
    // KEY semantic for BUG-092 — `stateRetentionDays=0` is destructive
    // (sweep deletes every file, scan filters every mtime) so the clamp
    // collapses it to null instead of preserving it as a "no grace period"
    // window. Same for negative values — a user typo of -1 must not
    // silently change behaviour to "delete everything".
    assert.equal(
        clampStateRetentionDays(0),
        null,
        "BUG-092: 0 is the disabled sentinel (was: 'valid no-grace-period window')",
    )
    assert.equal(clampStateRetentionDays(-5), null, "BUG-092: -5 collapses to null (disabled)")
    assert.equal(clampStateRetentionDays(-0.5), null, "BUG-092: -0.5 collapses to null (disabled)")
})

test("BUG-092: clampStateRetentionDays returns null for fractional values below 1", () => {
    // Fractional inputs floor to the integer day; 0.999 floors to 0, which
    // is then collapsed to null. So the floor contract is "Math.floor(x)
    // < 1 → null", not "0 < x < 1 → null".
    assert.equal(clampStateRetentionDays(0.5), null, "BUG-092: 0.5 floors to 0 → null")
    assert.equal(clampStateRetentionDays(0.999), null, "BUG-092: 0.999 floors to 0 → null")
})

test("BUG-092: clampStateRetentionDays returns Math.floor for values >= 1", () => {
    assert.equal(clampStateRetentionDays(1), 1, "BUG-092: 1 stays 1")
    assert.equal(clampStateRetentionDays(7), 7, "BUG-092: 7 (default) passes through")
    assert.equal(clampStateRetentionDays(30), 30, "BUG-092: 30 passes through")
    assert.equal(clampStateRetentionDays(1.5), 1, "BUG-092: 1.5 floors to 1")
    assert.equal(clampStateRetentionDays(1.9), 1, "BUG-092: 1.9 floors to 1")
    assert.equal(clampStateRetentionDays(100.5), 100, "BUG-092: 100.5 floors to 100")
})

test("BUG-092: mergeCompress collapses stateRetentionDays=0 to null at the config layer", () => {
    // Pins the user-facing contract: a user typo of 0 in dcp.jsonc never
    // reaches the candidate scan or the sweep — it round-trips through the
    // clamp into null (disabled). Mirrors the BUG-012 load-time clamp tests
    // in tests/clampers.test.ts. Per-test XDG_CONFIG_HOME so getConfig never
    // reads the host filesystem.
    const tag = `bug092_cfg_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const xdgConfigHome = join(tmpdir(), `dcp-bug-092-cfg-${tag}`)
    const opencodeConfigDir = join(xdgConfigHome, "opencode")
    mkdirSync(opencodeConfigDir, { recursive: true })
    currentConfigSandbox = xdgConfigHome
    process.env.XDG_CONFIG_HOME = xdgConfigHome

    writeFileSync(
        join(opencodeConfigDir, "dcp.jsonc"),
        JSON.stringify({ compress: { stateRetentionDays: 0 } }),
    )

    const config = getConfig({
        directory: tmpdir(),
        client: {},
    } as any)

    assert.equal(
        config.compress.stateRetentionDays,
        null,
        "BUG-092: stateRetentionDays=0 in dcp.jsonc must collapse to null via clampStateRetentionDays in mergeCompress",
    )
})

// Logic Verified: BUG-092 mtime pre-filter (positive/null cases); BUG-092 log collapse (summary line emitted, per-file dropping log not emitted); BUG-092 sweep on save (deletion, throttle via module-level sweepDone, null early-return); clampStateRetentionDays edge cases (null/undefined/NaN/Infinity, 0, negatives, fractional below 1, Math.floor for >= 1); mergeCompress load-time collapse of stateRetentionDays=0 to null.
// Bugs Documented: BUG-092 — see known_issues/BUG-092-fork-candidate-scan-ungoverned-directory-growth.md.
// Fakes Updated: none (real temp dirs + a method-reassignment capture shim around the real Logger; no module doubles).
// Review Status: pending independent review.
