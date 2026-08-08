// BUG-077 — `PromptStore` does not hash bundled prompt values for drift
// detection.
//
// The bug:
//   * `lib/prompts/store.ts` writes default prompt files on construction
//     when `experimental.customPrompts = true` (`ensureDefaultFiles`).
//   * Today, a write is silent — there is no log line identifying which
//     bundled source the write came from, so operators cannot correlate a
//     rewrite to a specific bundled-prompt version.
//   * Per the task description, the expected fix is to log a hash of the
//     bundled prompt values. A stable hex identifier on each load makes
//     drift visible in the daily log without needing a separate drift
//     registry file.
//
// Tested by spying on the `Logger` instance the `PromptStore` is
// constructed with, constructing the store with `customPrompts = true`
// (which forces `ensureDefaultFiles()` to run), and asserting at least
// one captured log call carries a hex hash of the bundled prompts.
//
// Reference: known_issues/BUG-077-override-file-list-hash.md
// Docs:       docs/features/PROMPTS.md (Override paths)

import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { Logger } from "../lib/logger"
import { PromptStore } from "../lib/prompts/store"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type LogLevel = "info" | "debug" | "warn" | "error"

interface LogCall {
    level: LogLevel
    message: string
    data: any
}

/** Wrap `logger.info/debug/warn/error` so test cases can observe calls
 *  without paying the real disk-write cost. Returns the array the spy
 *  pushes into, plus a `restore()` closure to undo the monkey-patches.
 *  Mirrors the pattern in `tests/logger-hygiene.test.ts`. */
function spyLogger(logger: Logger): { calls: LogCall[]; restore(): void } {
    const calls: LogCall[] = []
    const origInfo = logger.info.bind(logger)
    const origDebug = logger.debug.bind(logger)
    const origWarn = logger.warn.bind(logger)
    const origError = logger.error.bind(logger)

    logger.info = ((message: string, data?: any) => {
        calls.push({ level: "info", message, data })
        return origInfo(message, data)
    }) as typeof logger.info
    logger.debug = ((message: string, data?: any) => {
        calls.push({ level: "debug", message, data })
        return origDebug(message, data)
    }) as typeof logger.debug
    logger.warn = ((message: string, data?: any) => {
        calls.push({ level: "warn", message, data })
        return origWarn(message, data)
    }) as typeof logger.warn
    logger.error = ((message: string, data?: any) => {
        calls.push({ level: "error", message, data })
        return origError(message, data)
    }) as typeof logger.error

    return {
        calls,
        restore() {
            logger.info = origInfo
            logger.debug = origDebug
            logger.warn = origWarn
            logger.error = origError
        },
    }
}

/** Build an isolated fixture rooted under `os.tmpdir()`. Returns the
 *  workspace + config dirs, a `PromptStore` wired to a spy-wrapped
 *  Logger, and a `cleanup()` that restores the original env and removes
 *  the temp tree. Pattern mirrors `tests/prompts.test.ts`. */
function createFixture() {
    const rootDir = mkdtempSync(join(tmpdir(), "opencode-dcp-bug077-"))
    const configHome = join(rootDir, "config")
    const workspaceDir = join(rootDir, "workspace")

    mkdirSync(configHome, { recursive: true })
    mkdirSync(workspaceDir, { recursive: true })

    const previousConfigHome = process.env.XDG_CONFIG_HOME
    const previousOpencodeConfigDir = process.env.OPENCODE_CONFIG_DIR

    process.env.XDG_CONFIG_HOME = configHome
    delete process.env.OPENCODE_CONFIG_DIR

    const logger = new Logger(false)
    const spy = spyLogger(logger)
    const store = new PromptStore(logger, workspaceDir, true)

    return {
        store,
        calls: spy.calls,
        restore: spy.restore,
        cleanup() {
            spy.restore()
            if (previousConfigHome === undefined) {
                delete process.env.XDG_CONFIG_HOME
            } else {
                process.env.XDG_CONFIG_HOME = previousConfigHome
            }
            if (previousOpencodeConfigDir === undefined) {
                delete process.env.OPENCODE_CONFIG_DIR
            } else {
                process.env.OPENCODE_CONFIG_DIR = previousOpencodeConfigDir
            }
            rmSync(rootDir, { recursive: true, force: true })
        },
    }
}

/** Find the first hex-shaped token of length ≥ 8 anywhere in a log call.
 *  A bundled-prompt hash would normally be SHA-256 (64 chars) or a
 *  truncated SHA-1/CRC — anything in `[0-9a-f]{8,}` is a safe lower
 *  bound that avoids false positives from short numeric IDs. */
const HEX_HASH_RE = /[0-9a-f]{8,}/i

function firstHexHashInCall(call: LogCall): string | null {
    // Ponytail: stringify the data once and grep the whole payload. A hash
    // might land in `data.hash`, `data.promptHash`, a nested object, or an
    // array — searching the JSON form catches all of those without having
    // to know the implementer's field name.
    const haystack =
        call.message +
        " " +
        (typeof call.data === "string"
            ? call.data
            : call.data === undefined
              ? ""
              : JSON.stringify(call.data))

    const match = haystack.match(HEX_HASH_RE)
    return match ? match[0] : null
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("BUG-077: PromptStore construction with customPrompts logs a hash of bundled prompts", () => {
    // KNOWN BUG (BUG-077): `ensureDefaultFiles()` writes default files
    // silently today — no log line carries a hash identifying the bundled
    // source version, so operators cannot correlate a rewrite to a
    // specific bundled-prompt version.
    // See: known_issues/BUG-077-override-file-list-hash.md
    //
    // After the fix, at least one captured log call (message or data)
    // must carry a hex-shaped hash of the bundled prompts.
    const fixture = createFixture()

    try {
        const hashCall = fixture.calls.find((c) => firstHexHashInCall(c) !== null)

        assert.ok(
            hashCall !== undefined,
            `BUG-077: expected at least one log call carrying a hex hash of bundled prompts. ` +
                `Captured ${fixture.calls.length} call(s): ` +
                fixture.calls
                    .map((c) => `[${c.level}] ${c.message} ${JSON.stringify(c.data)}`)
                    .join(" | "),
        )

        // Sanity: the hash found is reasonably long. 8 chars catches
        // CRC32 and 64-bit hashes; a bundled-prompt hash should be at
        // least that long.
        const hash = firstHexHashInCall(hashCall)
        assert.ok(
            hash !== null && hash.length >= 8,
            `hash must be at least 8 hex chars: got ${hash}`,
        )
    } finally {
        fixture.cleanup()
    }
})

test("BUG-077 stability: hash is reproducible across two independent constructions", () => {
    // KNOWN BUG (BUG-077): no hash is logged today, so this test fails
    // before the fix. After the fix the hash must be deterministic —
    // the same bundled-prompt source must hash to the same value across
    // independent constructions in independent workspaces.
    // See: known_issues/BUG-077-override-file-list-hash.md
    const fixtureA = createFixture()
    let hashA: string | null = null

    try {
        for (const call of fixtureA.calls) {
            const hash = firstHexHashInCall(call)
            if (hash !== null) {
                hashA = hash
                break
            }
        }
        assert.ok(hashA !== null, "BUG-077: first construction must log a hash")
    } finally {
        fixtureA.cleanup()
    }

    // Second construction in a fresh workspace so `ensureDefaultFiles`
    // sees a fresh dir and re-emits the bundled-prompt log.
    const fixtureB = createFixture()
    let hashB: string | null = null

    try {
        for (const call of fixtureB.calls) {
            const hash = firstHexHashInCall(call)
            if (hash !== null) {
                hashB = hash
                break
            }
        }
        assert.ok(hashB !== null, "BUG-077: second construction must log a hash")

        assert.equal(
            hashB,
            hashA,
            `BUG-077: bundled-prompt hash must be stable across constructions. ` +
                `first=${hashA}, second=${hashB}`,
        )
    } finally {
        fixtureB.cleanup()
    }
})

// Optional stability guard: a second construction in the SAME workspace
// must not log a fresh hash on every reload when nothing changed. The
// bundled prompt sources are stable; if the implementer recomputes and
// logs the hash on every reload, this test still passes (the hash is
// the same). If the implementer only logs on drift, this test confirms
// that no spurious log appears in the no-drift case.
test("BUG-077 no-drift: second reload in the same workspace does not re-emit a stale hash silently", () => {
    // KNOWN BUG (BUG-077): no hash is logged today, so this test fails
    // before the fix on the "first construction must log a hash" branch.
    // After the fix, the second reload in the same workspace should not
    // produce a DIFFERENT hash than the first (hash is over stable source).
    // See: known_issues/BUG-077-override-file-list-hash.md
    const fixture = createFixture()
    const initialCalls = fixture.calls.length
    let initialHash: string | null = null
    try {
        for (const call of fixture.calls) {
            const hash = firstHexHashInCall(call)
            if (hash !== null) {
                initialHash = hash
                break
            }
        }
        assert.ok(initialHash !== null, "BUG-077: initial construction must log a hash")

        // Reload in the same workspace. Defaults dir already matches
        // `managedContent`, so drift is absent — the fix should either
        // not log or log the same hash.
        fixture.store.reload()

        const postReloadHashes: string[] = []
        for (let index = initialCalls; index < fixture.calls.length; index++) {
            const call = fixture.calls[index]
            if (call === undefined) continue
            const hash = firstHexHashInCall(call)
            if (hash !== null) postReloadHashes.push(hash)
        }

        for (const hash of postReloadHashes) {
            assert.equal(
                hash,
                initialHash,
                `BUG-077: hash must remain stable across reloads in a no-drift workspace. ` +
                    `initial=${initialHash}, post-reload=${hash}`,
            )
        }
    } finally {
        fixture.cleanup()
    }
})
// Logic Verified: PromptStore logs a stable hash of bundled prompts on construction and does not silently re-emit a stale hash on reload.
// Bugs Documented: BUG-077.
// Fakes Updated: none
// Review Status: pending independent review.
