/**
 * Tests for state persistence hygiene (BUG-053, BUG-059).
 *
 * BUG-053: loadManualModeSetting / saveManualModeSetting pay the schema-gate
 *          cost (parse JSON + validate forkSchemaVersion) on user-driven
 *          paths. The fix is to skip the schema gate for those callers (the
 *          user-driven path knows the file shape; the schema gate is only
 *          needed on the hot transform path).
 *
 * BUG-059: resetOnCompaction does not clear pendingManualTrigger. The fix is
 *          to add `state.pendingManualTrigger = null` to the reset block.
 *
 * Both tests assert the FIXED behavior; the implementer round makes them
 * pass.
 */

import assert from "node:assert/strict"
import test from "node:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs"
import {
    loadManualModeSetting,
    saveManualModeSetting,
    loadSessionState,
} from "../lib/state/persistence"
import { createSessionState } from "../lib/state/state"
import { resetOnCompaction } from "../lib/state/utils"
import { FORK_SCHEMA_VERSION } from "../lib/state/types"
import type { Logger } from "../lib/logger"

// ────────────────────────────────────────────────────────────────────────────
// Per-test isolation: redirect XDG_DATA_HOME / XDG_CONFIG_HOME so the
// persistence layer never touches the host filesystem. Mirrors the pattern
// in tests/state-schema-version.test.ts and tests/state-max-age.test.ts.
// ────────────────────────────────────────────────────────────────────────────

const testDataHome = join(tmpdir(), `opencode-dcp-hygiene-data-${process.pid}`)
const testConfigHome = join(tmpdir(), `opencode-dcp-hygiene-config-${process.pid}`)
process.env.XDG_DATA_HOME = testDataHome
process.env.XDG_CONFIG_HOME = testConfigHome
mkdirSync(testDataHome, { recursive: true })
mkdirSync(testConfigHome, { recursive: true })

// Mirror the storage location layout used by lib/state/persistence.ts.
const STORAGE_DIR = join(testDataHome, "opencode", "storage", "plugin", "dcp")

/** Build a Logger-shaped stub that captures warn/info calls. The persistence
 *  layer emits a `forkSchemaVersion mismatch` warning when the schema gate
 *  drops a file. The BUG-053 fix asserts that this warning is NOT emitted
 *  when `loadManualModeSetting` / `saveManualModeSetting` is the caller
 *  (because those helpers skip the schema gate). */
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

function readPersisted(sessionID: string): any {
    return JSON.parse(readFileSync(join(STORAGE_DIR, `${sessionID}.json`), "utf-8"))
}

function buildMinimalState(overrides: any = {}): any {
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
        stats: {
            pruneTokenCounter: 0,
            totalPruneTokens: 0,
        },
        lastUpdated: new Date().toISOString(),
        ...overrides,
    }
}

// ────────────────────────────────────────────────────────────────────────────
// BUG-053: loadManualModeSetting / saveManualModeSetting skip the schema gate.
// The schema gate (forkSchemaVersion check inside loadSessionState) is only
// required on the hot transform path. User-driven manual-mode toggles know
// the file shape (the save path produced it) so the gate is redundant cost.
// The fix: skip the gate for those callers.
// ────────────────────────────────────────────────────────────────────────────

test("BUG-053: loadManualModeSetting skips the schema gate for an invalid forkSchemaVersion", async () => {
    // Reproduces the BUG-053 condition: a file with a mismatched
    // forkSchemaVersion (simulating an older-fork-written sidecar) is
    // currently dropped by the schema gate inside loadSessionState. After
    // the fix, the manual-mode helper bypasses the gate and reads the
    // manualMode flag directly.
    const sessionID = `ses_bug053_load_${Date.now()}_${Math.random()}`
    writeStateFile(
        sessionID,
        buildMinimalState({
            forkSchemaVersion: 99, // mismatched — schema gate would drop
            manualMode: true,
            userForced: true,
        }),
    )

    const { logger, warnings } = makeCapturingLogger()
    const loaded = await loadManualModeSetting(sessionID, logger)

    // After the fix: no `forkSchemaVersion mismatch` warning is emitted,
    // because the gate was skipped on this user-driven path.
    const schemaWarnings = warnings.filter((m) => /forkSchemaVersion mismatch/i.test(m))
    assert.equal(
        schemaWarnings.length,
        0,
        "BUG-053: loadManualModeSetting must skip the schema gate " +
            "(no forkSchemaVersion-mismatch warning expected)",
    )

    // And the manualMode value is returned, proving the file was read.
    assert.equal(
        loaded,
        true,
        "BUG-053: loadManualModeSetting must return the persisted manualMode " +
            "even when the schema gate would have dropped the file",
    )

    rmSync(join(STORAGE_DIR, `${sessionID}.json`), { force: true })
})

test("BUG-053: loadManualModeSetting skips the schema gate when forkSchemaVersion is missing", async () => {
    // A v1 file (no forkSchemaVersion) is also dropped by the schema gate.
    // The manual-mode helper must still read the legacy manualMode flag.
    const sessionID = `ses_bug053_v1_${Date.now()}_${Math.random()}`
    const v1Like = buildMinimalState({ manualMode: true })
    delete v1Like.forkSchemaVersion // simulate v1 shape
    writeStateFile(sessionID, v1Like)

    const { logger, warnings } = makeCapturingLogger()
    const loaded = await loadManualModeSetting(sessionID, logger)

    const schemaWarnings = warnings.filter((m) => /forkSchemaVersion mismatch/i.test(m))
    assert.equal(
        schemaWarnings.length,
        0,
        "BUG-053: loadManualModeSetting must skip the schema gate for v1-shaped files",
    )
    assert.equal(loaded, true)

    rmSync(join(STORAGE_DIR, `${sessionID}.json`), { force: true })
})

test("BUG-053 (control): loadSessionState still runs the schema gate (default path unchanged)", async () => {
    // Control test: the default path (loadSessionState) MUST still drop
    // files with a mismatched forkSchemaVersion. The gate skip in BUG-053
    // is scoped to the user-driven manual-mode helpers only — the hot
    // transform path keeps the gate.
    const sessionID = `ses_bug053_control_${Date.now()}_${Math.random()}`
    writeStateFile(
        sessionID,
        buildMinimalState({
            forkSchemaVersion: 99, // mismatched
            manualMode: true,
        }),
    )

    const { logger, warnings } = makeCapturingLogger()
    const loaded = await loadSessionState(sessionID, logger)

    const schemaWarnings = warnings.filter((m) => /forkSchemaVersion mismatch/i.test(m))
    assert.ok(
        schemaWarnings.length >= 1,
        "control: loadSessionState must still emit the forkSchemaVersion-mismatch warning",
    )
    assert.equal(loaded, null, "control: loadSessionState must still drop the file")

    rmSync(join(STORAGE_DIR, `${sessionID}.json`), { force: true })
})

test("BUG-053: saveManualModeSetting skips the schema gate when reading existing state", async () => {
    // The save path calls loadSessionState (or its raw equivalent) to merge
    // with the existing file. With the gate skipped, the save no longer
    // emits a `forkSchemaVersion mismatch` warning for a file written by an
    // older fork. The on-disk file after the save carries the new manualMode
    // and the current forkSchemaVersion (from emptyPersistedState).
    const sessionID = `ses_bug053_save_${Date.now()}_${Math.random()}`
    writeStateFile(
        sessionID,
        buildMinimalState({
            forkSchemaVersion: 99, // mismatched — gate would drop
            manualMode: false,
            userForced: false,
        }),
    )

    const { logger, warnings } = makeCapturingLogger()
    await saveManualModeSetting(sessionID, true, logger)

    // After the fix: no schema-gate warning during the save path.
    const schemaWarnings = warnings.filter((m) => /forkSchemaVersion mismatch/i.test(m))
    assert.equal(
        schemaWarnings.length,
        0,
        "BUG-053: saveManualModeSetting must skip the schema gate " +
            "when reading the existing state",
    )

    // The new manualMode must be saved, and the schema version promoted
    // to the current FORK_SCHEMA_VERSION (from emptyPersistedState).
    const onDisk = readPersisted(sessionID)
    assert.equal(onDisk.manualMode, true, "new manualMode must be persisted")
    assert.equal(
        onDisk.forkSchemaVersion,
        FORK_SCHEMA_VERSION,
        "saved file must carry the current forkSchemaVersion",
    )

    rmSync(join(STORAGE_DIR, `${sessionID}.json`), { force: true })
})

// ────────────────────────────────────────────────────────────────────────────
// BUG-059: resetOnCompaction clears pendingManualTrigger.
// On compaction, the in-memory prune state is reset. The pendingManualTrigger
// (the user-invoked `/dcp-compress` instruction) must also be cleared,
// otherwise the next transform fires the manual-trigger prompt against
// content that has just been compacted away.
// ────────────────────────────────────────────────────────────────────────────

test("BUG-059: resetOnCompaction clears pendingManualTrigger when it was set", () => {
    // Pre-condition: pendingManualTrigger is populated (user issued
    // `/dcp-compress` and the next transform is expected to inject it).
    const state = createSessionState()
    state.pendingManualTrigger = {
        sessionId: "ses_test",
        prompt: "compress now",
    }

    resetOnCompaction(state)

    // After the fix: pendingManualTrigger is cleared.
    assert.equal(
        state.pendingManualTrigger,
        null,
        "BUG-059: resetOnCompaction must clear pendingManualTrigger",
    )
})

test("BUG-059: resetOnCompaction on a state with null pendingManualTrigger leaves it null", () => {
    // Defensive parity test: the reset is a no-op on an already-null
    // pendingManualTrigger. Verifies the fix does not over-eagerly write.
    const state = createSessionState()
    state.pendingManualTrigger = null

    resetOnCompaction(state)

    assert.equal(state.pendingManualTrigger, null)
})

test("BUG-059: resetOnCompaction also clears the other documented fields (parity with pre-fix behaviour)", () => {
    // The fix adds ONE line to resetOnCompaction. This test guards the
    // other fields that the reset already cleared — to ensure the fix did
    // not accidentally drop one of them while adding the new line.
    const state = createSessionState()
    state.pendingManualTrigger = { sessionId: "ses_test", prompt: "compress now" }
    state.toolParameters.set("call_1", {
        tool: "bash",
        parameters: { cmd: "ls" },
        turn: 1,
    })
    state.prune.tools.set("call_2", 42)
    state.nudges.contextLimitAnchors.add("anchor_1")
    state.messageIds.byRawId.set("raw_1", "ref_1")

    resetOnCompaction(state)

    assert.equal(state.toolParameters.size, 0, "toolParameters must be cleared")
    assert.equal(state.prune.tools.size, 0, "prune.tools must be cleared")
    assert.equal(state.prune.messages.activeBlockIds.size, 0, "prune.messages must be reset")
    assert.equal(state.messageIds.byRawId.size, 0, "messageIds must be reset")
    assert.equal(state.nudges.contextLimitAnchors.size, 0, "nudges must be reset")
    assert.equal(state.messageIds.nextRef, 1, "messageIds.nextRef must be reset")
    assert.equal(
        state.pendingManualTrigger,
        null,
        "BUG-059: pendingManualTrigger must also be cleared",
    )
})

// Logic Verified: BUG-053 (manual-mode helpers skip the schema gate);
//                  BUG-059 (resetOnCompaction clears pendingManualTrigger).
// Bugs Documented: see per-test KNOWN BUG references — tests fail in
//                  current code, pass after the implementer round.
// Fakes Updated: capturing logger observes schema-gate warnings.
// Review Status: tests assert the FIXED contract; subagent review not
//                requested in this delegation.
// Logic Verified: loadManualModeSetting / saveManualModeSetting skip the schema gate for the special manual-mode path, and resetOnCompaction clears pendingManualTrigger when set.
// Bugs Documented: BUG-053, BUG-059.
// Fakes Updated: capturing logger observes schema-gate warnings.
// Review Status: pending independent review.
