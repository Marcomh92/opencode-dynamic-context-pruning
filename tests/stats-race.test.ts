import assert from "node:assert/strict"
import test, { afterEach } from "node:test"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSessionState } from "../lib/state"
import { FORK_SCHEMA_VERSION } from "../lib/state/types"
import { flushPruneStats } from "../lib/state/utils"
import { loadSessionState, resetSaveCoalescer, saveSessionState } from "../lib/state/persistence"
import { Logger } from "../lib/logger"

const testDataHome = join(tmpdir(), `opencode-dcp-stats-race-data-${process.pid}`)
const testConfigHome = join(tmpdir(), `opencode-dcp-stats-race-config-${process.pid}`)
process.env.XDG_DATA_HOME = testDataHome
process.env.XDG_CONFIG_HOME = testConfigHome
mkdirSync(testDataHome, { recursive: true })
mkdirSync(testConfigHome, { recursive: true })

const storageDir = join(testDataHome, "opencode", "storage", "plugin", "dcp")
const logger = new Logger(false)

afterEach(() => resetSaveCoalescer())

function persistedState(pruneTokenCounter: number, totalPruneTokens: number) {
    return {
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
        stats: { pruneTokenCounter, totalPruneTokens },
        lastUpdated: new Date().toISOString(),
    }
}

function readDiskTotal(sessionId: string): number {
    const value = JSON.parse(readFileSync(join(storageDir, `${sessionId}.json`), "utf8"))
    return value.stats.totalPruneTokens
}

test("flushPruneStats with zero counter is a no-op", () => {
    const stats = { pruneTokenCounter: 0, totalPruneTokens: 100 }
    assert.equal(flushPruneStats(stats), 0)
    assert.deepEqual(stats, { pruneTokenCounter: 0, totalPruneTokens: 100 })
})

test("flushPruneStats moves the counter into the lifetime total", () => {
    const stats = { pruneTokenCounter: 5_000, totalPruneTokens: 10_000 }
    assert.equal(flushPruneStats(stats), 5_000)
    assert.deepEqual(stats, { pruneTokenCounter: 0, totalPruneTokens: 15_000 })
})

test("flushPruneStats sequential flushes do not double-count", () => {
    const stats = { pruneTokenCounter: 5_000, totalPruneTokens: 10_000 }
    flushPruneStats(stats)
    assert.equal(flushPruneStats(stats), 0)
    assert.deepEqual(stats, { pruneTokenCounter: 0, totalPruneTokens: 15_000 })
})

test("flushPruneStats reload regression counts only the fresh counter", () => {
    const firstWriter = { pruneTokenCounter: 5_000, totalPruneTokens: 10_000 }
    flushPruneStats(firstWriter)

    const reloadedWriter = { pruneTokenCounter: 5_000, totalPruneTokens: 15_000 }
    assert.equal(flushPruneStats(reloadedWriter), 5_000)
    assert.deepEqual(reloadedWriter, { pruneTokenCounter: 0, totalPruneTokens: 20_000 })
})

test("saveSessionState merges totalPruneTokens monotonically", async () => {
    const sessionId = `ses_stats_monotonic_${Date.now()}`
    const state = createSessionState()
    state.sessionId = sessionId
    state.stats.totalPruneTokens = 100
    await saveSessionState(state, logger)

    state.stats.totalPruneTokens = 50
    await saveSessionState(state, logger)
    assert.equal(readDiskTotal(sessionId), 100)

    state.stats.totalPruneTokens = 150
    await saveSessionState(state, logger)
    assert.equal(readDiskTotal(sessionId), 150)
})

test("loadSessionState flushes a persisted prune counter", async () => {
    const sessionId = `ses_stats_load_${Date.now()}`
    mkdirSync(storageDir, { recursive: true })
    writeFileSync(
        join(storageDir, `${sessionId}.json`),
        JSON.stringify(persistedState(5_000, 1_000)),
        "utf8",
    )

    const loaded = await loadSessionState(sessionId, logger)

    assert.ok(loaded)
    assert.equal(loaded.stats.pruneTokenCounter, 0)
    assert.equal(loaded.stats.totalPruneTokens, 6_000)
})

test("saveSessionState falls back to a plain write when the existing file is malformed", async () => {
    const sessionId = `ses_stats_read_failure_${Date.now()}`
    const filePath = join(storageDir, `${sessionId}.json`)
    mkdirSync(storageDir, { recursive: true })
    writeFileSync(filePath, '{ "stats": { "totalPruneTokens": INVALID', "utf8")
    const state = createSessionState()
    state.sessionId = sessionId
    state.stats.totalPruneTokens = 50

    await assert.doesNotReject(saveSessionState(state, logger))

    const persisted = JSON.parse(readFileSync(filePath, "utf8"))
    assert.equal(persisted.stats.totalPruneTokens, 50)
    assert.equal(persisted.forkSchemaVersion, FORK_SCHEMA_VERSION)
    assert.deepEqual(persisted.prune.tools, {})
    assert.deepEqual(persisted.nudges.contextLimitAnchors, [])
})
// Logic Verified: flushPruneStats moves the counter into the lifetime total without double-counting across sequential flushes and reloads, and saveSessionState merges totalPruneTokens monotonically.
// Bugs Documented: none.
// Fakes Updated: none
// Review Status: pending independent review.
