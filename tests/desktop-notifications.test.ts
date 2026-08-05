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
