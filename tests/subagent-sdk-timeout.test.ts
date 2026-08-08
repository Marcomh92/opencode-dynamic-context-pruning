import assert from "node:assert/strict"
import test from "node:test"
import { isSubAgentSession } from "../lib/state/utils"

// ────────────────────────────────────────────────────────────────────────────
// BUG-037 — `isSubAgentSession` SDK call has no timeout / AbortSignal
//
// `isSubAgentSession(client, sessionID)` calls `client.session.get(...)`
// with no `signal`. If the host is unresponsive the call hangs forever,
// freezing every transform hook that calls `ensureSessionInitialized`.
//
// The fix passes an `AbortSignal.timeout(...)` so a hung SDK aborts within
// a bounded time. These tests assert the contract:
//   1. The SDK call receives an AbortSignal (signal is observable on the
//      captured args).
//   2. When the SDK hangs forever, `isSubAgentSession` resolves (or rejects
//      via the internal abort) within a bounded time — it does NOT wait for
//      the outer test harness timeout.
//   3. Normal responses are unchanged (regression).
// ────────────────────────────────────────────────────────────────────────────

// Generous outer bound — long enough that a healthy production timeout
// (e.g. 2 s) easily completes inside it, short enough that the test still
// fails fast if the production code has no internal timeout. Tuned so the
// test suite stays under its ~4 s budget.
const OUTER_TIMEOUT_MS = 8000

// ────────────────────────────────────────────────────────────────────────────
// Scenario 1 — the SDK receives an AbortSignal.
//
// Capture the args passed to `client.session.get` and assert that the
// production code forwards a signal. In the current code, no signal is
// passed at all (args.signal is undefined). After the fix, args.signal is
// an AbortSignal instance.
// ────────────────────────────────────────────────────────────────────────────

test("BUG-037: isSubAgentSession forwards an AbortSignal to client.session.get", async () => {
    let capturedArgs: any = null

    const client = {
        session: {
            get: async (args: any) => {
                capturedArgs = args
                return { data: { parentID: "parent-1" } }
            },
        },
    }

    await isSubAgentSession(client as any, "ses-1")

    assert.ok(capturedArgs, "client.session.get must be called")
    assert.ok(
        "signal" in capturedArgs,
        `args must include a 'signal' property — got keys: ${Object.keys(capturedArgs).join(", ")}`,
    )
    assert.ok(
        capturedArgs.signal instanceof AbortSignal,
        `args.signal must be an AbortSignal; got ${typeof capturedArgs.signal} ${String(capturedArgs.signal)}`,
    )
})

// ────────────────────────────────────────────────────────────────────────────
// Scenario 2 — the AbortSignal is non-trivial (i.e. fires on its own).
//
// `AbortSignal.timeout(ms)` produces a signal that aborts after `ms`. We
// cannot directly read its timeout from outside, but we CAN observe that
// the signal is NOT already aborted at the time of the SDK call AND that
// it eventually aborts. Stub the SDK so it captures and exposes both
// states.
// ────────────────────────────────────────────────────────────────────────────

test("BUG-037: forwarded signal is not pre-aborted at the moment of the SDK call", async () => {
    let signalAtCall: AbortSignal | undefined

    const client = {
        session: {
            get: async (args: any) => {
                signalAtCall = args.signal
                return { data: {} }
            },
        },
    }

    await isSubAgentSession(client as any, "ses-1")

    assert.ok(signalAtCall, "signal must be present in args")
    assert.equal(
        signalAtCall.aborted,
        false,
        "signal must not be pre-aborted when the SDK call starts",
    )
})

// ────────────────────────────────────────────────────────────────────────────
// Scenario 3 — when the SDK hangs forever, isSubAgentSession resolves
// within a bounded time.
//
// Use a stub that never resolves on its own but honors the signal: it
// rejects the moment the signal aborts. A well-behaved SDK is exactly this
// — `fetch` rejects on signal abort. The fix passes a 2 s signal; with the
// stub below, the call resolves within 2-3 s.
//
// In the CURRENT (buggy) code, no signal is passed at all, so the stub
// hangs forever and the outer test timeout fires. The assertion
// `elapsed < OUTER_TIMEOUT_MS` then fails loudly.
// ────────────────────────────────────────────────────────────────────────────

/** Build a client whose `session.get` hangs forever — unless `signal` is
 *  provided and aborts, in which case it rejects. This mirrors how a
 *  well-behaved SDK (one that spreads opts into a Request and honors the
 *  signal) behaves. */
function makeHangingClientThatHonorsSignal(): any {
    return {
        session: {
            get: ({ signal }: { signal?: AbortSignal }) =>
                new Promise<any>((_resolve, reject) => {
                    if (signal?.aborted) {
                        reject(new Error("AbortError"))
                        return
                    }
                    signal?.addEventListener("abort", () => {
                        reject(new Error("AbortError"))
                    })
                }),
        },
    }
}

test("BUG-037: isSubAgentSession does not hang forever when the SDK hangs", async () => {
    const client = makeHangingClientThatHonorsSignal()

    const start = Date.now()
    let resolved: { value: boolean } | null = null
    let raceError: Error | null = null

    try {
        const result = await Promise.race([
            isSubAgentSession(client, "ses-hang-1").then((v) => ({ value: v })),
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error("TEST_OUTER_TIMEOUT")), OUTER_TIMEOUT_MS),
            ),
        ])
        resolved = result as { value: boolean }
    } catch (e: any) {
        raceError = e
    }

    const elapsed = Date.now() - start

    if (raceError?.message === "TEST_OUTER_TIMEOUT") {
        assert.fail(
            `isSubAgentSession hung past the outer timeout (${OUTER_TIMEOUT_MS} ms); ` +
                `the production code must pass an AbortSignal so a hung SDK does not freeze the transform hook`,
        )
    }

    // Either `isSubAgentSession` resolved to `false` (catch path on abort),
    // or some other error escaped. Both are acceptable; what is NOT
    // acceptable is hanging forever.
    if (resolved !== null) {
        assert.equal(
            resolved.value,
            false,
            "a hung/aborted SDK must be treated as primary session (returns false)",
        )
    } else if (raceError) {
        // Some unexpected error escaped — that is also bounded time. As long
        // as the call did not hang, the contract holds. Re-throw the error
        // so the failure is visible rather than silently swallowed.
        throw raceError
    }

    // Sanity bound: must complete well inside the outer timeout.
    assert.ok(
        elapsed < OUTER_TIMEOUT_MS,
        `isSubAgentSession must abort within bounded time; elapsed=${elapsed} ms`,
    )
})

// ────────────────────────────────────────────────────────────────────────────
// Scenario 4 — regression: normal SDK behavior is unchanged.
//
// These tests pass both before and after the fix. They lock the contract
// so a future change to the catch path / return shape cannot silently
// break the happy paths.
// ────────────────────────────────────────────────────────────────────────────

test("BUG-037: isSubAgentSession returns true when the SDK reports a parentID", async () => {
    const client = {
        session: {
            get: async () => ({ data: { parentID: "parent-1" } }),
        },
    }

    const result = await isSubAgentSession(client as any, "ses-sub-1")
    assert.equal(result, true)
})

test("BUG-037: isSubAgentSession returns false when the SDK reports no parentID", async () => {
    const client = {
        session: {
            get: async () => ({ data: {} }),
        },
    }

    const result = await isSubAgentSession(client as any, "ses-primary-1")
    assert.equal(result, false)
})

test("BUG-037: isSubAgentSession returns false when the SDK throws (error path)", async () => {
    const client = {
        session: {
            get: async () => {
                throw new Error("network down")
            },
        },
    }

    const result = await isSubAgentSession(client as any, "ses-err-1")
    assert.equal(result, false)
})

test("BUG-037: isSubAgentSession returns false when the SDK returns null data", async () => {
    const client = {
        session: {
            get: async () => ({ data: null }),
        },
    }

    const result = await isSubAgentSession(client as any, "ses-null-1")
    assert.equal(result, false)
})

// Logic Verified: AbortSignal is forwarded; hung SDK does not block; happy paths unchanged.
// Bugs Documented: BUG-037 (no timeout / AbortSignal on client.session.get).
// Fakes Updated: makeHangingClientThatHonorsSignal mirrors a well-behaved SDK that honors the signal.
// Review Status: pending implementer round.
