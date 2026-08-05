import assert from "node:assert/strict"
import test, { afterEach } from "node:test"
import { mkdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSessionState } from "../lib/state"
import { coalesceSaveSessionState, resetSaveCoalescer } from "../lib/state/persistence"
import { Logger } from "../lib/logger"

// Per-test isolation: redirect XDG_DATA_HOME / XDG_CONFIG_HOME so the
// persistence layer and the logger never touch the host filesystem.
const testDataHome = join(tmpdir(), `opencode-dcp-coalesce-save-data-${process.pid}`)
const testConfigHome = join(tmpdir(), `opencode-dcp-coalesce-save-config-${process.pid}`)
process.env.XDG_DATA_HOME = testDataHome
process.env.XDG_CONFIG_HOME = testConfigHome
mkdirSync(testDataHome, { recursive: true })
mkdirSync(testConfigHome, { recursive: true })

const storageDir = join(testDataHome, "opencode", "storage", "plugin", "dcp")

afterEach(() => resetSaveCoalescer())

function countingLogger() {
    const logger = new Logger(false)
    let writes = 0
    logger.info = ((message: string) => {
        if (message === "Saved session state to disk") writes++
    }) as Logger["info"]
    return { logger, writeCount: () => writes }
}

async function waitForWrite(writeCount: () => number, expected: number): Promise<void> {
    for (let i = 0; i < 100 && writeCount() < expected; i++) {
        await new Promise((resolve) => setTimeout(resolve, 5))
    }
}

function diskTotal(sessionId: string): number {
    const persisted = JSON.parse(readFileSync(join(storageDir, `${sessionId}.json`), "utf8"))
    return persisted.stats.totalPruneTokens
}

test("coalesceSaveSessionState performs one write for one synchronous burst", async () => {
    const state = createSessionState()
    state.sessionId = `ses_coalesce_burst_${Date.now()}`
    state.stats.totalPruneTokens = 50
    const { logger, writeCount } = countingLogger()

    for (let i = 0; i < 5; i++) coalesceSaveSessionState(state, logger)
    await waitForWrite(writeCount, 1)

    assert.equal(writeCount(), 1)
    assert.equal(diskTotal(state.sessionId), 50)
})

test("coalesceSaveSessionState saves again across a microtask boundary", async () => {
    const state = createSessionState()
    state.sessionId = `ses_coalesce_boundary_${Date.now()}`
    const { logger, writeCount } = countingLogger()

    state.stats.totalPruneTokens = 50
    coalesceSaveSessionState(state, logger)
    await waitForWrite(writeCount, 1)
    assert.equal(writeCount(), 1)

    state.stats.totalPruneTokens = 75
    coalesceSaveSessionState(state, logger)
    await waitForWrite(writeCount, 2)

    assert.equal(writeCount(), 2)
    assert.equal(diskTotal(state.sessionId), 75)
})

// Logic Verified: one persisted write per synchronous burst and separate writes across ticks.
// Bugs Documented: none.
// Fakes Updated: counting logger observes completed persistence writes.
// Review Status: independent review completed; completed writes observed through Logger.
