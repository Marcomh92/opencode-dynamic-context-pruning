import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdirSync } from "node:fs"
import { saveSessionState } from "../lib/state/persistence"
import { createSessionState } from "../lib/state"
import { Logger } from "../lib/logger"

const testDataHome = join(tmpdir(), `opencode-dcp-recovery-not-persisted-data-${process.pid}`)
const testConfigHome = join(tmpdir(), `opencode-dcp-recovery-not-persisted-config-${process.pid}`)
process.env.XDG_DATA_HOME = testDataHome
process.env.XDG_CONFIG_HOME = testConfigHome
mkdirSync(testDataHome, { recursive: true })
mkdirSync(testConfigHome, { recursive: true })

const storageDir = join(testDataHome, "opencode", "storage", "plugin", "dcp")

test("BUG-031: recoveryForced and streak counters are session-local, not persisted", async () => {
    const sessionId = `ses_recovery_not_persisted_${Date.now()}_${Math.random()}`
    const state = createSessionState()
    state.sessionId = sessionId
    state.manualMode = "active"
    state.recoveryForced = true
    state.nonCompactingRunCount = 4
    state.recoveryFadeCounter = 2

    await saveSessionState(state, new Logger(false))

    const persisted = JSON.parse(
        readFileSync(join(storageDir, `${sessionId}.json`), "utf8"),
    ) as Record<string, unknown>

    for (const field of ["recoveryForced", "nonCompactingRunCount", "recoveryFadeCounter"]) {
        assert.ok(
            !(field in persisted) || persisted[field] == null,
            `${field} must not cross the v1→v2 persistence boundary`,
        )
    }
})

// Logic Verified: recovery protocol state and streak counters do not cross the persistence boundary.
// Bugs Documented: BUG-031-recoveryforced-persists-cross-run.md.
// Fakes Updated: isolated XDG data/config directories only.
// Review Status: pending implementer round.
