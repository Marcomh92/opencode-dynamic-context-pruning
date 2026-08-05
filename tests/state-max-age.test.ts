import assert from "node:assert/strict"
import test from "node:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdirSync, writeFileSync, rmSync } from "node:fs"
import { loadSessionState } from "../lib/state/persistence"
import { FORK_SCHEMA_VERSION } from "../lib/state/types"
import type { Logger } from "../lib/logger"

// Per-test isolation: redirect XDG_DATA_HOME / XDG_CONFIG_HOME so the
// persistence layer never touches the host filesystem.
const testDataHome = join(tmpdir(), `opencode-dcp-maxage-tests-${process.pid}`)
const testConfigHome = join(tmpdir(), `opencode-dcp-maxage-config-tests-${process.pid}`)

process.env.XDG_DATA_HOME = testDataHome
process.env.XDG_CONFIG_HOME = testConfigHome

mkdirSync(testDataHome, { recursive: true })
mkdirSync(testConfigHome, { recursive: true })

// Mirror the storage location layout used by lib/state/persistence.ts.
const STORAGE_DIR = join(
    process.env.XDG_DATA_HOME,
    "opencode",
    "storage",
    "plugin",
    "dcp",
)

/** Build a Logger-shaped stub that captures warn/info calls. The persistence
 *  layer calls `logger.warn(...)` to drop age-expired state (issue #590 +
 *  M2.5 max-age gate); we want to assert the drop is observable, not just
 *  that the return value is null. */
function makeCapturingLogger(): {
    logger: Logger
    warnings: string[]
    infos: string[]
} {
    const warnings: string[] = []
    const infos: string[] = []
    const stub: any = {
        warn(message: string, _data?: unknown) {
            warnings.push(String(message))
            return Promise.resolve()
        },
        info(message: string, _data?: unknown) {
            infos.push(String(message))
            return Promise.resolve()
        },
        debug() {
            return Promise.resolve()
        },
        error(message: string, _data?: unknown) {
            warnings.push(String(message))
            return Promise.resolve()
        },
    }
    return { logger: stub as Logger, warnings, infos }
}

function writeStateFile(sessionID: string, state: any): void {
    mkdirSync(STORAGE_DIR, { recursive: true })
    const filePath = join(STORAGE_DIR, `${sessionID}.json`)
    writeFileSync(filePath, JSON.stringify(state, null, 2), "utf-8")
}

function buildMinimalState(overrides: any = {}): any {
    return {
        manualMode: false,
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
        ...overrides,
    }
}

/** ISO-8601 timestamp for `daysAgo` whole days (plus optional ms offset) in
 *  the past. Used to construct deterministic state files; freshness is
 *  measured against `Date.now()` at the moment of `loadSessionState`. */
function isoDaysAgo(days: number, msOffset = 0): string {
    return new Date(Date.now() - days * 24 * 60 * 60 * 1000 - msOffset).toISOString()
}

// ────────────────────────────────────────────────────────────────────────────
// M2.5: loadSessionState(sessionId, logger, maxAgeDays?) wall-clock gate
// ────────────────────────────────────────────────────────────────────────────

test("loadSessionState: state within age threshold loads", async () => {
    const sessionID = `ses_maxage_fresh_${Date.now()}`
    writeStateFile(
        sessionID,
        buildMinimalState({
            forkSchemaVersion: FORK_SCHEMA_VERSION,
            lastUpdated: isoDaysAgo(0), // now
        }),
    )

    const { logger } = makeCapturingLogger()
    const loaded = await loadSessionState(sessionID, logger, 30)

    assert.ok(loaded, "fresh state must load under maxAgeDays=30")
    assert.equal(loaded?.forkSchemaVersion, FORK_SCHEMA_VERSION)

    rmSync(join(STORAGE_DIR, `${sessionID}.json`), { force: true })
})

test("loadSessionState: state older than threshold drops and emits a warning", async () => {
    const sessionID = `ses_maxage_stale_${Date.now()}`
    writeStateFile(
        sessionID,
        buildMinimalState({
            forkSchemaVersion: FORK_SCHEMA_VERSION,
            lastUpdated: isoDaysAgo(60),
        }),
    )

    const { logger, warnings } = makeCapturingLogger()
    const loaded = await loadSessionState(sessionID, logger, 30)

    assert.equal(loaded, null)
    assert.ok(
        warnings.length > 0,
        "expected a logger.warn call when the persisted state is age-expired",
    )
    const ageWarn = warnings.find((message) =>
        /stateMaxAgeDays/.test(message),
    )
    assert.ok(ageWarn, `expected a max-age warning, got: ${JSON.stringify(warnings)}`)
    assert.match(ageWarn as string, /Dropping persisted session state/)
    assert.match(ageWarn as string, /exceeds/)
    // The age value should appear in the message. Avoid \bd\b — the
    // production log formats `60.0d` (digit followed by `d`), and "d" is
    // adjacent to a digit so there is no word boundary on the inside.
    assert.match(ageWarn as string, /age \d/)

    rmSync(join(STORAGE_DIR, `${sessionID}.json`), { force: true })
})

test("loadSessionState: state just past threshold drops (strict greater-than comparison)", async () => {
    const sessionID = `ses_maxage_justpast_${Date.now()}`
    writeStateFile(
        sessionID,
        buildMinimalState({
            forkSchemaVersion: FORK_SCHEMA_VERSION,
            // 30 days + 1 ms in the past — age strictly greater than 30 must
            // trip the drop. The spec uses strict `>`, not `>=`, so 30 days
            // exactly would load but a hair past must drop.
            lastUpdated: isoDaysAgo(30, 1),
        }),
    )

    const { logger, warnings } = makeCapturingLogger()
    const loaded = await loadSessionState(sessionID, logger, 30)

    assert.equal(loaded, null)
    assert.ok(
        warnings.some((message) => /stateMaxAgeDays/.test(message)),
        "expected a max-age warning just past the threshold",
    )

    rmSync(join(STORAGE_DIR, `${sessionID}.json`), { force: true })
})

test("loadSessionState: maxAgeDays=null disables the age gate (60d-old loads)", async () => {
    const sessionID = `ses_maxage_null_${Date.now()}`
    writeStateFile(
        sessionID,
        buildMinimalState({
            forkSchemaVersion: FORK_SCHEMA_VERSION,
            lastUpdated: isoDaysAgo(60),
        }),
    )

    const { logger, warnings } = makeCapturingLogger()
    const loaded = await loadSessionState(sessionID, logger, null)

    assert.ok(
        loaded,
        "with maxAgeDays=null the age gate is skipped and stale state still loads",
    )
    assert.ok(
        !warnings.some((message) => /stateMaxAgeDays/.test(message)),
        "no age-related warning expected when the gate is disabled",
    )

    rmSync(join(STORAGE_DIR, `${sessionID}.json`), { force: true })
})

test("loadSessionState: missing lastUpdated loads (paranoia — unparsable timestamps never invalidate a fresh session)", async () => {
    const sessionID = `ses_maxage_missing_${Date.now()}`
    const stateWithoutLastUpdated = buildMinimalState({
        forkSchemaVersion: FORK_SCHEMA_VERSION,
    })
    delete stateWithoutLastUpdated.lastUpdated
    writeStateFile(sessionID, stateWithoutLastUpdated)

    const { logger, warnings } = makeCapturingLogger()
    const loaded = await loadSessionState(sessionID, logger, 30)

    assert.ok(
        loaded,
        "missing lastUpdated must not trigger the age gate; the check is opt-in",
    )
    assert.ok(
        !warnings.some((message) => /stateMaxAgeDays/.test(message)),
        "no age-related warning expected for a missing lastUpdated field",
    )

    rmSync(join(STORAGE_DIR, `${sessionID}.json`), { force: true })
})
