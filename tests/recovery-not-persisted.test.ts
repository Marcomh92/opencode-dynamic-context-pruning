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

test("BUG-031 superseded by BUG-089: recoveryForced and streak counters ARE persisted (v4)", async () => {
    // BUG-031 originally established that recoveryForced + nonCompactingRunCount
    // were session-local and never persisted. BUG-089 (fork-state-inheritance
    // plan §4.5) inverts that rule at v4: the recovery fields are now
    // persisted so a forked session (B) can inherit A's recovery state along
    // with its blocks. Fork inheritance overrides the load-path reset
    // (see lib/state/inherit.ts:tryInheritFromParent).
    const sessionId = `ses_recovery_persisted_v4_${Date.now()}_${Math.random()}`
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

    // v4: these fields ARE persisted. The original BUG-031 "must not cross
    // the persistence boundary" claim no longer holds; the new contract is
    // "load-path resets them by default, but fork inheritance can copy them
    // from the parent state via typeof === guards in tryInheritFromParent".
    assert.equal(persisted.recoveryForced, true, "recoveryForced must persist at v4")
    assert.equal(persisted.nonCompactingRunCount, 4, "nonCompactingRunCount must persist at v4")
    assert.equal(persisted.recoveryFadeCounter, 2, "recoveryFadeCounter must persist at v4")
})

// Logic Verified: recoveryForced / nonCompactingRunCount / recoveryFadeCounter persist at v4 (BUG-031 superseded by BUG-089).
// Bugs Documented: BUG-031-recoveryforced-persists-cross-run.md (superseded by BUG-089), BUG-089 (fork-state-inheritance protocol layer).
// Fakes Updated: isolated XDG data/config directories only.
// Review Status: pending independent review.
