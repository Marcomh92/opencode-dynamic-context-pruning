import assert from "node:assert/strict"
import test, { afterEach } from "node:test"
import { mkdirSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Logger } from "../lib/logger"

const testDataHome = join(tmpdir(), `opencode-dcp-context-cache-data-${process.pid}`)
const testConfigHome = join(tmpdir(), `opencode-dcp-context-cache-config-${process.pid}`)
process.env.XDG_DATA_HOME = testDataHome
process.env.XDG_CONFIG_HOME = testConfigHome
mkdirSync(testDataHome, { recursive: true })
mkdirSync(testConfigHome, { recursive: true })

// Module-level Logger cache must be cleared between tests so a previous case's
// sessionId doesn't pre-seed the hash map for the next case's sessionId.
// Tests that share content across sessions would otherwise see stale hash hits.
afterEach(() => {
    Logger.clearSaveContextCache()
})

function messages(text = "same") {
    return [{ info: { id: "msg-1", role: "user" }, parts: [{ type: "text", text }] }]
}

function files(sessionId: string): string[] {
    const dir = join(testConfigHome, "opencode", "logs", "dcp", "context", sessionId)
    try {
        return readdirSync(dir)
    } catch {
        return []
    }
}

async function nextTick() {
    await new Promise<void>((resolve) => setImmediate(resolve))
}

test("saveContext skips a no-op write for identical minimized messages", async () => {
    const sessionId = `ses_context_same_${Date.now()}`
    const logger = new Logger(true)
    await logger.saveContext(sessionId, messages())
    await logger.saveContext(sessionId, messages())
    assert.equal(files(sessionId).length, 1)
})

test("saveContext writes again when minimized messages change", async () => {
    const sessionId = `ses_context_changed_${Date.now()}`
    const logger = new Logger(true)
    await logger.saveContext(sessionId, messages("first"))
    await nextTick()
    await logger.saveContext(sessionId, messages("second"))
    assert.equal(files(sessionId).length, 2)
})

test("saveContext tracks hashes independently per session", async () => {
    const logger = new Logger(true)
    const content = messages("shared")
    const sessionA = `ses_context_a_${Date.now()}`
    const sessionB = `ses_context_b_${Date.now()}`
    await logger.saveContext(sessionA, content)
    await logger.saveContext(sessionB, content)
    assert.equal(files(sessionA).length, 1)
    assert.equal(files(sessionB).length, 1)
})

test("disabled Logger does not write context dumps", async () => {
    const sessionId = `ses_context_disabled_${Date.now()}`
    await new Logger(false).saveContext(sessionId, messages("ignored"))
    assert.deepEqual(files(sessionId), [])
})
// Logic Verified: saveContext skips no-op writes for identical minimized messages, writes again when content changes, tracks hashes independently per session, and disabled Logger never writes.
// Bugs Documented: none.
// Fakes Updated: none
// Review Status: pending independent review.
