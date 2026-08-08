import assert from "node:assert/strict"
import test from "node:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs"
import { loadSessionState } from "../lib/state/persistence"
import { FORK_SCHEMA_VERSION } from "../lib/state/types"
import { Logger } from "../lib/logger"

const testDataHome = join(tmpdir(), `opencode-dcp-schema-tests-${process.pid}`)
const testConfigHome = join(tmpdir(), `opencode-dcp-schema-config-${process.pid}`)

process.env.XDG_DATA_HOME = testDataHome
process.env.XDG_CONFIG_HOME = testConfigHome

mkdirSync(testDataHome, { recursive: true })
mkdirSync(testConfigHome, { recursive: true })

const logger = new Logger(false)

// Mirror the storage location layout used by lib/state/persistence.ts.
const STORAGE_DIR = join(process.env.XDG_DATA_HOME, "opencode", "storage", "plugin", "dcp")

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

test("loadSessionState returns null when forkSchemaVersion is missing (v1 state)", async () => {
    const sessionID = `ses_v1_missing_${Date.now()}`
    writeStateFile(sessionID, buildMinimalState())

    const loaded = await loadSessionState(sessionID, logger)
    assert.equal(loaded, null)

    rmSync(join(STORAGE_DIR, `${sessionID}.json`), { force: true })
})

test("loadSessionState returns null when forkSchemaVersion is 1 (old shape)", async () => {
    const sessionID = `ses_v1_${Date.now()}`
    writeStateFile(
        sessionID,
        buildMinimalState({
            forkSchemaVersion: 1,
            manualMode: true,
        }),
    )

    const loaded = await loadSessionState(sessionID, logger)
    assert.equal(loaded, null)

    rmSync(join(STORAGE_DIR, `${sessionID}.json`), { force: true })
})

test("loadSessionState returns null when forkSchemaVersion is 4 (future shape)", async () => {
    const sessionID = `ses_v4_${Date.now()}`
    writeStateFile(
        sessionID,
        buildMinimalState({
            forkSchemaVersion: 4,
        }),
    )

    const loaded = await loadSessionState(sessionID, logger)
    assert.equal(loaded, null)

    rmSync(join(STORAGE_DIR, `${sessionID}.json`), { force: true })
})

test("loadSessionState returns state when forkSchemaVersion matches FORK_SCHEMA_VERSION", async () => {
    const sessionID = `ses_v2_match_${Date.now()}`
    writeStateFile(
        sessionID,
        buildMinimalState({
            forkSchemaVersion: FORK_SCHEMA_VERSION,
            userForced: true,
            recoveryForced: false,
            nonCompactingRunCount: 2,
            recoveryFadeCounter: 1,
            manualMode: true,
        }),
    )

    const loaded = await loadSessionState(sessionID, logger)
    assert.ok(loaded, "expected load to succeed for current schema version")
    assert.equal(loaded?.forkSchemaVersion, FORK_SCHEMA_VERSION)
    assert.equal(loaded?.userForced, true)
    assert.equal(loaded?.recoveryForced, false)
    assert.equal(loaded?.nonCompactingRunCount, 2)
    assert.equal(loaded?.recoveryFadeCounter, 1)
    assert.equal(loaded?.manualMode, true)

    rmSync(join(STORAGE_DIR, `${sessionID}.json`), { force: true })
})

test("loadSessionState returns state when forkSchemaVersion matches even with default fields", async () => {
    const sessionID = `ses_v2_minimal_${Date.now()}`
    writeStateFile(
        sessionID,
        buildMinimalState({
            forkSchemaVersion: FORK_SCHEMA_VERSION,
        }),
    )

    const loaded = await loadSessionState(sessionID, logger)
    assert.ok(loaded, "expected load to succeed for current schema version with minimal fields")
    assert.equal(loaded?.forkSchemaVersion, FORK_SCHEMA_VERSION)

    rmSync(join(STORAGE_DIR, `${sessionID}.json`), { force: true })
})

test("loadSessionState returns null when file does not exist", async () => {
    const sessionID = `ses_missing_file_${Date.now()}`
    if (existsSync(join(STORAGE_DIR, `${sessionID}.json`))) {
        rmSync(join(STORAGE_DIR, `${sessionID}.json`))
    }

    const loaded = await loadSessionState(sessionID, logger)
    assert.equal(loaded, null)
})

test("loadSessionState returns null when file is malformed JSON", async () => {
    const sessionID = `ses_malformed_${Date.now()}`
    mkdirSync(STORAGE_DIR, { recursive: true })
    writeFileSync(join(STORAGE_DIR, `${sessionID}.json`), "{ not json", "utf-8")

    const loaded = await loadSessionState(sessionID, logger)
    assert.equal(loaded, null)

    rmSync(join(STORAGE_DIR, `${sessionID}.json`), { force: true })
})

test("loadSessionState returns null when required structural fields are missing", async () => {
    const sessionID = `ses_no_prune_${Date.now()}`
    writeStateFile(sessionID, {
        forkSchemaVersion: FORK_SCHEMA_VERSION,
        manualMode: false,
        nudges: { contextLimitAnchors: [] },
        stats: { pruneTokenCounter: 0, totalPruneTokens: 0 },
        lastUpdated: new Date().toISOString(),
    } as any)

    const loaded = await loadSessionState(sessionID, logger)
    assert.equal(loaded, null)

    rmSync(join(STORAGE_DIR, `${sessionID}.json`), { force: true })
})

test("FORK_SCHEMA_VERSION is the current persisted-state shape version", () => {
    assert.equal(FORK_SCHEMA_VERSION, 3)
})
// Logic Verified: loadSessionState returns null for forkSchemaVersion 1/4/missing and returns state when it matches FORK_SCHEMA_VERSION (with default fields).
// Bugs Documented: none.
// Fakes Updated: none
// Review Status: pending independent review.
