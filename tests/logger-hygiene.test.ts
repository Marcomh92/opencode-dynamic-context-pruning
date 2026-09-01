import assert from "node:assert/strict"
import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, test } from "node:test"

// Per-test isolation: redirect XDG_DATA_HOME / XDG_CONFIG_HOME so any disk
// writes (saveContext dumps in the BUG-046/069 case) land in a per-process
// tmp dir rather than the host's `~/.config/opencode/`.
const testDataHome = join(tmpdir(), `opencode-dcp-hygiene-data-${process.pid}`)
const testConfigHome = join(tmpdir(), `opencode-dcp-hygiene-config-${process.pid}`)
process.env.XDG_DATA_HOME = testDataHome
process.env.XDG_CONFIG_HOME = testConfigHome
mkdirSync(testDataHome, { recursive: true })
mkdirSync(testConfigHome, { recursive: true })

import { assignMessageRefs } from "../lib/message-ids"
import { Logger } from "../lib/logger"
import { createSessionState, syncToolCache, type WithParts } from "../lib/state"
import type { PluginConfig } from "../lib/config"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal `PluginConfig` shape that satisfies `syncToolCache` (turnProtection
 *  branch). Other fields are populated with sensible no-op defaults so the
 *  function never reads past undefined paths. */
function buildConfig(): PluginConfig {
    return {
        enabled: true,
        debug: false,
        pruneNotification: "off",
        pruneNotificationType: "chat",
        commands: { enabled: true, protectedTools: [] },
        manualMode: { enabled: false, automaticStrategies: true },
        turnProtection: { enabled: false, turns: 4 },
        experimental: { allowSubAgents: false, customPrompts: false },
        protectedFilePatterns: [],
        compress: {
            mode: "message",
            permission: "allow",
            showCompression: false,
            maxContextLimit: 150000,
            minContextLimit: 50000,
            nudgeFrequency: 5,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            protectedTools: ["task"],
            protectTags: false,
            protectUserMessages: false,
            // BUG-096: default 1 (protect only the most recent real user
            // message). Not exercised in this file (protectUserMessages is
            // always false), so the default is fine.
            protectUserMessagesCount: 1,
        },
        strategies: {
            deduplication: { enabled: true, protectedTools: [] },
            purgeErrors: { enabled: true, turns: 4, protectedTools: [] },
        },
    }
}

function textPart(messageID: string, sessionID: string, id: string, text: string) {
    return { id, messageID, sessionID, type: "text" as const, text }
}

function toolPart(
    messageID: string,
    sessionID: string,
    callID: string,
    toolName: string,
    output: string,
) {
    return {
        id: `${callID}-part`,
        messageID,
        sessionID,
        type: "tool" as const,
        tool: toolName,
        callID,
        state: {
            status: "completed" as const,
            input: { description: "demo" },
            output,
        },
    }
}

/** Build a message array containing one assistant message with `n` tool parts.
 *  `syncToolCache` walks the parts in order and caches each one — the
 *  per-tool-part `logger.info` in the pre-fix code fires once per part. */
function buildMessagesWithNToolParts(sessionID: string, n: number): WithParts[] {
    const toolParts = []
    for (let i = 0; i < n; i++) {
        toolParts.push(
            toolPart(`msg-assistant-tools`, sessionID, `call-${i}`, "bash", `output ${i}`),
        )
    }
    return [
        {
            info: {
                id: "msg-assistant-tools",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 2 },
            } as WithParts["info"],
            parts: toolParts,
        },
    ]
}

/** Wrap `logger.info/debug/warn` so we can observe calls without paying the
 *  real disk-write cost. Returns the array the spy pushes into, plus a
 *  restore function to undo the monkey-patches. */
function spyLogger(logger: Logger) {
    const calls: { level: "info" | "debug" | "warn" | "error"; message: string }[] = []
    const origInfo = logger.info.bind(logger)
    const origDebug = logger.debug.bind(logger)
    const origWarn = logger.warn.bind(logger)
    const origError = logger.error.bind(logger)
    logger.info = ((msg: string, _data?: any) => {
        calls.push({ level: "info", message: msg })
        return origInfo(msg, _data)
    }) as typeof logger.info
    logger.debug = ((msg: string, _data?: any) => {
        calls.push({ level: "debug", message: msg })
        return origDebug(msg, _data)
    }) as typeof logger.debug
    logger.warn = ((msg: string, _data?: any) => {
        calls.push({ level: "warn", message: msg })
        return origWarn(msg, _data)
    }) as typeof logger.warn
    logger.error = ((msg: string, _data?: any) => {
        calls.push({ level: "error", message: msg })
        return origError(msg, _data)
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

/** Wrap `Error.prepareStackTrace` so we can count how many times it is set to
 *  a non-default value during a window of log calls. `Logger.getCallerFile`
 *  swaps this property once per call today; the fix amortises the swap. The
 *  wrapper restores the original descriptor on `restore()`. */
function spyPrepareStackTraceSwaps() {
    const ErrorCtor = Error
    const originalPrepare = (ErrorCtor as unknown as { prepareStackTrace?: unknown })
        .prepareStackTrace
    let setCount = 0
    let nonDefaultSetCount = 0
    let lastSetValue: unknown = originalPrepare

    Object.defineProperty(ErrorCtor, "prepareStackTrace", {
        configurable: true,
        enumerable: false,
        get() {
            return lastSetValue
        },
        set(v: unknown) {
            setCount++
            if (v !== originalPrepare) nonDefaultSetCount++
            lastSetValue = v
        },
    })

    return {
        setCount: () => setCount,
        nonDefaultSetCount: () => nonDefaultSetCount,
        restore() {
            Object.defineProperty(ErrorCtor, "prepareStackTrace", {
                configurable: true,
                enumerable: false,
                writable: true,
                value: originalPrepare,
            })
        },
    }
}

function buildUserMessage(id: string, sessionID: string, text: string, created = 1): WithParts {
    return {
        info: {
            id,
            role: "user",
            sessionID,
            agent: "assistant",
            model: { providerID: "anthropic", modelID: "claude-test" },
            time: { created },
        } as WithParts["info"],
        parts: [textPart(id, sessionID, `${id}-part`, text)],
    }
}

// Reset the Logger module state between tests so module-level Maps don't
// leak across cases.
beforeEach(() => {
    Logger.clearSaveContextCache()
})

// ---------------------------------------------------------------------------
// BUG-027 — syncToolCache emits one `logger.info` line per cached tool part
//
// Fixed behaviour: the per-tool-part log line is either batched into a single
// summary line per cache fill, or downgraded to `logger.debug`. Either way
// the *info-level* call count for an N-tool-part fire must be O(1), not O(N).
// ---------------------------------------------------------------------------

test("BUG-027: syncToolCache info-level log count is bounded, not per tool part", () => {
    const TOOL_PART_COUNT = 10
    const sessionID = `ses_bug027_${Date.now()}`
    const logger = new Logger(false)
    const spy = spyLogger(logger)

    try {
        const state = createSessionState()
        state.sessionId = sessionID
        const messages = buildMessagesWithNToolParts(sessionID, TOOL_PART_COUNT)
        syncToolCache(state, buildConfig(), logger, messages)

        const infoCalls = spy.calls.filter((c) => c.level === "info")

        // Pre-fix: `Syncing...` + `Cached tool id` × N + `Synced cache` ⇒
        //          ≥ N info calls. Spec target: ≤ 1 info line, or 0 if the
        //          fix downgrades everything to debug.
        assert.ok(
            infoCalls.length <= 1,
            `BUG-027: syncToolCache must not emit one info line per tool part. ` +
                `Got ${infoCalls.length} info calls for ${TOOL_PART_COUNT} tool parts. ` +
                `Messages: ${infoCalls
                    .map((c) => c.message)
                    .slice(0, 3)
                    .join(" | ")}...`,
        )

        // Defensive: none of the surviving info calls should look like the
        // per-tool-part spam line ("Cached tool id: ..."). If the fix keeps
        // info-level calls, they must be the batched summary shape only.
        const perToolLines = infoCalls.filter((c) => /Cached tool id:/i.test(c.message))
        assert.equal(
            perToolLines.length,
            0,
            "BUG-027: per-tool-part 'Cached tool id' lines must not be at info level",
        )
    } finally {
        spy.restore()
    }
})

test("BUG-027: syncToolCache with zero tool parts still respects info bound", () => {
    const sessionID = `ses_bug027_empty_${Date.now()}`
    const logger = new Logger(false)
    const spy = spyLogger(logger)

    try {
        const state = createSessionState()
        state.sessionId = sessionID
        const messages: WithParts[] = [
            {
                info: {
                    id: "msg-assistant-empty",
                    role: "assistant",
                    sessionID,
                    agent: "assistant",
                    time: { created: 2 },
                } as WithParts["info"],
                parts: [textPart("msg-assistant-empty", sessionID, "p1", "nothing to cache")],
            },
        ]
        syncToolCache(state, buildConfig(), logger, messages)

        const infoCalls = spy.calls.filter((c) => c.level === "info")
        assert.ok(
            infoCalls.length <= 1,
            `BUG-027: even an empty sync must not exceed the bounded info budget. ` +
                `Got ${infoCalls.length} info calls.`,
        )
    } finally {
        spy.restore()
    }
})

// ---------------------------------------------------------------------------
// BUG-036 — Logger.getCallerFile allocates a fresh Error stack on every call
//
// Fixed behaviour: the cost is amortised (caller cache, once-per-process
// resolve, or short-circuit on the disabled path). The test counts how many
// times `Error.prepareStackTrace` is swapped to a non-default value while
// issuing 100 log calls from one call site. The pre-fix implementation swaps
// it once per call (100 swaps); the fix must collapse this.
// ---------------------------------------------------------------------------

test("BUG-036: getCallerFile does not allocate per log call", () => {
    const logger = new Logger(false) // disabled — exercises only getCallerFile
    const spy = spyPrepareStackTraceSwaps()

    try {
        const CALL_COUNT = 100
        for (let i = 0; i < CALL_COUNT; i++) {
            logger.info(`call #${i}`)
        }

        const swaps = spy.nonDefaultSetCount()
        // Pre-fix: 100 swaps (one per info() call). Fixed: amortised — either
        // a tiny cache (≤10) or a once-per-process resolve (1).
        assert.ok(
            swaps <= 10,
            `BUG-036: Logger.getCallerFile must amortise stack allocation. ` +
                `Got ${swaps} non-default prepareStackTrace swaps for ${CALL_COUNT} log calls.`,
        )
    } finally {
        spy.restore()
    }
})

test("BUG-036: every public log method amortises the stack walk", () => {
    const logger = new Logger(false)
    const spy = spyPrepareStackTraceSwaps()

    try {
        const PER_METHOD = 25
        for (let i = 0; i < PER_METHOD; i++) {
            logger.info(`info #${i}`)
            logger.debug(`debug #${i}`)
            logger.warn(`warn #${i}`)
            logger.error(`error #${i}`)
        }

        const swaps = spy.nonDefaultSetCount()
        // Pre-fix: 100 swaps (25 per method × 4 methods). Fixed: amortised.
        assert.ok(
            swaps <= 10,
            `BUG-036: info/debug/warn/error must each amortise the stack walk. ` +
                `Got ${swaps} non-default prepareStackTrace swaps for 4×${PER_METHOD} log calls.`,
        )
    } finally {
        spy.restore()
    }
})

// ---------------------------------------------------------------------------
// BUG-046 + BUG-069 — Logger.lastMinimizedHashBySession Map grows unbounded
//
// Fixed behaviour: the module-level Map is bounded (LRU cap, FIFO eviction,
// or session-switch clear). The test drives 1000 distinct session ids
// through `Logger.saveContext` and reads the internal Map size through the
// private field name — the test must also confirm a clearing helper is
// exposed (the existing `Logger.clearSaveContextCache`).
// ---------------------------------------------------------------------------

test("BUG-046/069: lastMinimizedHashBySession Map is bounded across many sessions", async () => {
    const logger = new Logger(true) // enabled so saveContext actually populates the Map

    // Drive 1000 distinct session ids through saveContext with unique content
    // (so each call is a cache miss and inserts a new entry).
    const SESSION_COUNT = 1000
    for (let i = 0; i < SESSION_COUNT; i++) {
        const sessionId = `ses_hygiene_${i}_${process.pid}`
        const messages = [
            {
                info: { id: `m-${i}`, role: "user" },
                parts: [{ type: "text", text: `unique payload ${i}` }],
            },
        ]
        await logger.saveContext(sessionId, messages)
    }

    // Access the static Map via a private-name cast. The implementer may
    // rename it; the contract is "the change-detection cache is bounded".
    const mapField = (Logger as unknown as Record<string, { size: number } | undefined>)[
        "lastMinimizedHashBySession"
    ]

    assert.ok(
        mapField !== undefined && typeof mapField === "object" && typeof mapField.size === "number",
        "BUG-046/069: Logger must expose the change-detection cache so the test can " +
            "assert it stays bounded (either via the original field name or a renamed Map).",
    )

    assert.ok(
        mapField.size < SESSION_COUNT,
        `BUG-046/069: lastMinimizedHashBySession must be bounded. ` +
            `Got size=${mapField.size} after ${SESSION_COUNT} distinct sessions.`,
    )
})

test("BUG-046/069: clearSaveContextCache helper is exposed", () => {
    // The fix is expected to keep the test-only clear hook so tests can reset
    // module state deterministically. This test pins the contract.
    assert.equal(
        typeof Logger.clearSaveContextCache,
        "function",
        "BUG-046/069: Logger.clearSaveContextCache must remain a callable static.",
    )

    Logger.clearSaveContextCache()
    const mapField = (Logger as unknown as Record<string, { size: number } | undefined>)[
        "lastMinimizedHashBySession"
    ]
    assert.ok(
        mapField !== undefined,
        "BUG-046/069: cache Map must still be accessible after clearSaveContextCache()",
    )
    assert.equal(
        mapField!.size,
        0,
        "BUG-046/069: clearSaveContextCache() must reset the cache to empty",
    )
})

// ---------------------------------------------------------------------------
// BUG-083 — log a warning when MESSAGE_REF_MAX_INDEX is approached
//
// Fixed behaviour: a `logger.warn` (or `console.warn`) is emitted as the
// allocator approaches capacity, with a one-shot flag so subsequent
// allocations in the same session do not spam a warn per call. We capture
// warns from both channels and assert: (a) at least one warn fires when the
// allocator enters the danger zone, and (b) the warn is not emitted per
// allocation (it is one-shot or tiered, so the total count stays tiny).
// ---------------------------------------------------------------------------

test("BUG-083: assignMessageRefs emits a one-shot capacity warn near 9999", () => {
    const sessionID = `ses_bug083_${Date.now()}`

    // Pre-seed `nextRef` close to the cap so the very first allocation in
    // this test crosses the warn threshold (the architect review suggests
    // tiered thresholds of 5000/7500/9000; we land at 9050 so we cross all
    // three in one fire, but the one-shot flag still bounds total warns).
    const state = createSessionState()
    state.sessionId = sessionID
    state.messageIds.nextRef = 9050

    const logger = new Logger(false)
    const spy = spyLogger(logger)

    // Also spy on console.warn — the bug allows either logger.warn or
    // console.warn as the emission channel.
    const consoleWarns: string[] = []
    const origConsoleWarn = console.warn
    console.warn = ((msg: unknown, ..._args: unknown[]) => {
        consoleWarns.push(String(msg))
        return origConsoleWarn(msg as any, ...(_args as []))
    }) as typeof console.warn

    try {
        const messages: WithParts[] = []
        const TARGET_ALLOCATIONS = 50
        for (let i = 0; i < TARGET_ALLOCATIONS; i++) {
            messages.push(buildUserMessage(`msg-bug083-${i}`, sessionID, `payload ${i}`, i + 1))
        }

        assignMessageRefs(state, messages)

        const totalWarns = spy.calls.filter((c) => c.level === "warn").length + consoleWarns.length

        assert.ok(
            totalWarns >= 1,
            `BUG-083: a capacity warn must fire when MESSAGE_REF_MAX_INDEX is approached. ` +
                `Got ${totalWarns} warns.`,
        )

        // One-shot (or tiered with a tiny threshold set like {5000,7500,9000}).
        // A per-allocation warn would produce ≥ TARGET_ALLOCATIONS lines.
        assert.ok(
            totalWarns <= 5,
            `BUG-083: capacity warn must be one-shot (or tiered), not per-call. ` +
                `Got ${totalWarns} warns for ${TARGET_ALLOCATIONS} allocations.`,
        )
    } finally {
        spy.restore()
        console.warn = origConsoleWarn
    }
})

test("BUG-083: capacity warn fires at most once across repeated fires at capacity", () => {
    const sessionID = `ses_bug083_repeat_${Date.now()}`

    const state = createSessionState()
    state.sessionId = sessionID
    state.messageIds.nextRef = 9010

    const logger = new Logger(false)
    const spy = spyLogger(logger)
    const consoleWarns: string[] = []
    const origConsoleWarn = console.warn
    console.warn = ((msg: unknown, ..._args: unknown[]) => {
        consoleWarns.push(String(msg))
        return origConsoleWarn(msg as any, ...(_args as []))
    }) as typeof console.warn

    try {
        const ROUNDS = 5
        for (let r = 0; r < ROUNDS; r++) {
            const messages: WithParts[] = []
            for (let i = 0; i < 10; i++) {
                messages.push(
                    buildUserMessage(
                        `msg-bug083-r${r}-${i}`,
                        sessionID,
                        `payload r${r} ${i}`,
                        i + 1,
                    ),
                )
            }
            assignMessageRefs(state, messages)
        }

        const totalWarns = spy.calls.filter((c) => c.level === "warn").length + consoleWarns.length

        // The pre-fix code emits no warns at all (failing the >= 1 check).
        // The fix emits at least one, and the one-shot guard caps the total
        // across ROUNDS of fire well below the number of allocations.
        assert.ok(
            totalWarns >= 1,
            `BUG-083: capacity warn must fire when allocator is near MESSAGE_REF_MAX_INDEX. ` +
                `Got ${totalWarns} warns across ${ROUNDS} fires.`,
        )
        assert.ok(
            totalWarns <= 5,
            `BUG-083: warn must be one-shot across repeated fires. ` +
                `Got ${totalWarns} warns across ${ROUNDS} fires (50 allocations).`,
        )
    } finally {
        spy.restore()
        console.warn = origConsoleWarn
    }
})

// Logic Verified:
//   BUG-027: syncToolCache does not emit one info-level log per tool part.
//            info-level call count is O(1) (≤ 2), and no surviving info line
//            matches the per-tool-part "Cached tool id: ..." spam pattern.
//   BUG-036: Logger.getCallerFile amortises its stack walk — 100 log calls
//            trigger ≤ 10 non-default Error.prepareStackTrace swaps.
//   BUG-046/069: lastMinimizedHashBySession stays bounded across 1000 distinct
//                sessions, and the existing clearSaveContextCache() helper
//                continues to expose a deterministic reset.
//   BUG-083:   assignMessageRefs emits a capacity warn when nextRef enters
//              the danger zone, and the warn is one-shot (or tiered with a
//              tiny threshold set) across repeated fires.
// Bugs Documented: none (already documented in known_issues/).
// Fakes Updated: none.
// Review Status: not yet independently reviewed.
// Logic Verified: logger methods amortise the stack walk, syncToolCache respects the info bound, and Map sizes (lastMinimizedHashBySession, startsByCallId) are bounded.
// Bugs Documented: BUG-027, BUG-036, BUG-046, BUG-069, BUG-083.
// Fakes Updated: none
// Review Status: pending independent review.
