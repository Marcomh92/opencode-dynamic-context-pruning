import assert from "node:assert/strict"
import test from "node:test"
import {
    dispatchToast,
    getPendingMergedCount,
    isDispatchInFlight,
    resetPendingToast,
    resolveEffectiveNotificationType,
} from "../lib/ui/notification"

test("resolveEffectiveNotificationType: TUI honours user config", () => {
    assert.equal(resolveEffectiveNotificationType("chat", false), "chat")
    assert.equal(resolveEffectiveNotificationType("toast", false), "toast")
})

test("resolveEffectiveNotificationType: desktop forces toast regardless of config", () => {
    assert.equal(resolveEffectiveNotificationType("chat", true), "toast")
    assert.equal(resolveEffectiveNotificationType("toast", true), "toast")
})

test("dispatchToast coalesces synchronous bursts via in-flight flag", () => {
    resetPendingToast()
    const client = { tui: { showToast: async () => undefined } }
    dispatchToast(client, "DCP", "first message")
    // The first call sets inFlightDispatch synchronously, so subsequent same-tick calls coalesce.
    assert.equal(isDispatchInFlight(), true)
    assert.equal(getPendingMergedCount(), 0)

    dispatchToast(client, "DCP", "second message")
    dispatchToast(client, "DCP", "third message")
    assert.equal(getPendingMergedCount(), 2)

    resetPendingToast()
    assert.equal(isDispatchInFlight(), false)
    assert.equal(getPendingMergedCount(), 0)
})

test("dispatchToast does not coalesce after the in-flight dispatch resolves", async () => {
    resetPendingToast()
    const client = { tui: { showToast: async () => undefined } }

    dispatchToast(client, "DCP", "first")
    // Wait for the in-flight dispatch to complete.
    await new Promise((resolve) => setImmediate(resolve))
    // Yield a few extra microtasks to let the finally block clear inFlightDispatch.
    for (let i = 0; i < 5; i++) {
        await new Promise((resolve) => setImmediate(resolve))
    }
    assert.equal(isDispatchInFlight(), false)

    dispatchToast(client, "DCP", "second")
    assert.equal(isDispatchInFlight(), true)
    assert.equal(getPendingMergedCount(), 0)

    resetPendingToast()
})

test("dispatchToast fires showToast immediately on the first call", async () => {
    resetPendingToast()
    const toastCalls: Array<{ title: string; message: string }> = []
    const client = {
        tui: {
            showToast: async (payload: any) => {
                toastCalls.push({ title: payload.body.title, message: payload.body.message })
            },
        },
    }

    dispatchToast(client, "DCP", "immediate message")
    // Let the in-flight dispatch resolve so we can inspect the recorded calls.
    await new Promise((resolve) => setImmediate(resolve))
    for (let i = 0; i < 5; i++) {
        await new Promise((resolve) => setImmediate(resolve))
    }

    assert.equal(toastCalls.length, 1)
    assert.equal(toastCalls[0]?.title, "DCP")
    assert.match(toastCalls[0]?.message ?? "", /immediate message/)

    resetPendingToast()
})

test("dispatchToast fires a merged follow-up for synchronous bursts", async () => {
    resetPendingToast()
    const toastCalls: Array<{ title: string; message: string }> = []
    const client = {
        tui: {
            showToast: async (payload: any) => {
                toastCalls.push({ title: payload.body.title, message: payload.body.message })
            },
        },
    }

    dispatchToast(client, "DCP", "alpha")
    dispatchToast(client, "DCP", "beta")
    dispatchToast(client, "DCP", "gamma")

    await new Promise((resolve) => setImmediate(resolve))
    for (let i = 0; i < 10; i++) {
        await new Promise((resolve) => setImmediate(resolve))
    }

    assert.equal(toastCalls.length, 2)
    // First call fires immediately (alpha is the immediate toast).
    assert.match(toastCalls[0]?.message ?? "", /alpha/)
    // Subsequent same-tick calls coalesce into a merged follow-up.
    assert.match(toastCalls[1]?.message ?? "", /beta/)
    assert.match(toastCalls[1]?.message ?? "", /gamma/)

    resetPendingToast()
})

// Regression for M2.5b drain-loop fix. The stub here does NOT resolve synchronously: each
// showToast awaits a manually-controlled promise so the test can interleave new dispatchToast
// calls while the previous await is still pending. This exercises the multi-iteration drain
// loop in lib/ui/notification.ts, which a synchronous `async () => undefined` stub cannot.
test("dispatchToast: async-burst during merged-follow-up is drained across loops", async () => {
    resetPendingToast()
    const toastCalls: Array<{ title: string; message: string }> = []
    const pendingToastResolvers: Array<() => void> = []
    const client = {
        tui: {
            showToast: async (payload: any) => {
                toastCalls.push({ title: payload.body.title, message: payload.body.message })
                // Defer resolution so the test owns the await lifecycle.
                await new Promise<void>((resolve) => pendingToastResolvers.push(resolve))
            },
        },
    }

    // Call 1: fires the immediate toast (now awaiting on the deferred promise).
    dispatchToast(client, "DCP", "first")
    // Yield enough for the IIFE to reach the await on showToast.
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))

    // Call 2: synchronous — lands in pendingMergedMessages while the immediate toast's
    // await is still pending. This is the burst-during-await scenario the drain loop covers.
    dispatchToast(client, "DCP", "second")

    // Resolve the immediate toast. The drain loop should now drain "second" and fire a merged
    // follow-up that itself awaits on the next deferred promise.
    pendingToastResolvers.shift()!()
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))

    // Call 3: synchronous — lands in pendingMergedMessages while the first merged follow-up's
    // await is still pending. This is the second drain-loop iteration.
    dispatchToast(client, "DCP", "third")

    // Resolve the first merged follow-up. The drain loop should now drain "third" and fire
    // a second merged follow-up that itself awaits on the next deferred promise.
    pendingToastResolvers.shift()!()
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))

    // Resolve the second merged follow-up. The IIFE should exit the drain loop and clear
    // state via the finally block.
    pendingToastResolvers.shift()!()
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))

    assert.equal(
        toastCalls.length,
        3,
        "expected 3 toasts: immediate (first) + merged follow-up (second) + merged follow-up (third)",
    )
    assert.match(toastCalls[0]?.message ?? "", /first/)
    assert.match(toastCalls[1]?.message ?? "", /second/)
    assert.match(toastCalls[2]?.message ?? "", /third/)
    assert.equal(isDispatchInFlight(), false, "in-flight flag must clear after drain completes")
    assert.equal(getPendingMergedCount(), 0, "pending queue must clear after drain completes")

    resetPendingToast()
})

// Regression for M2.5b silent-swallow fix. The IIFE's `try { ... } catch { /* swallow */ }`
// must catch rejections from showToast so a host-side toast failure does not leak an
// unhandled promise rejection or wedge inFlightDispatch non-null.
test("dispatchToast: rejected showToast is silently swallowed, subsequent calls work", async () => {
    resetPendingToast()
    const unhandledRejections: unknown[] = []
    const rejectionHandler = (reason: unknown) => {
        unhandledRejections.push(reason)
    }
    process.on("unhandledRejection", rejectionHandler)

    try {
        const client = {
            tui: {
                showToast: async () => {
                    throw new Error("host-side toast failure")
                },
            },
        }

        // Call 1: rejected — must be swallowed by the IIFE's catch.
        dispatchToast(client, "DCP", "first")
        await new Promise((resolve) => setImmediate(resolve))
        for (let i = 0; i < 5; i++) {
            await new Promise((resolve) => setImmediate(resolve))
        }
        assert.equal(isDispatchInFlight(), false, "in-flight flag must clear after rejection")

        // Call 2: must still start a fresh IIFE. If the previous rejection had left
        // inFlightDispatch stuck non-null, this would coalesce into pendingMergedMessages
        // instead of firing its own dispatch.
        dispatchToast(client, "DCP", "second")
        await new Promise((resolve) => setImmediate(resolve))
        for (let i = 0; i < 5; i++) {
            await new Promise((resolve) => setImmediate(resolve))
        }
        assert.equal(isDispatchInFlight(), false, "second call's in-flight flag must also clear")
        assert.equal(
            unhandledRejections.length,
            0,
            "no unhandled rejections should escape the .catch swallow",
        )

        resetPendingToast()
    } finally {
        process.off("unhandledRejection", rejectionHandler)
    }
})
