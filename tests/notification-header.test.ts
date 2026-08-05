import assert from "node:assert/strict"
import test from "node:test"
import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSessionState, type CompressionBlock } from "../lib/state"
import { Logger } from "../lib/logger"
import { sendCompressNotification } from "../lib/ui/notification"

const testDataHome = join(tmpdir(), `opencode-dcp-notification-header-data-${process.pid}`)
const testConfigHome = join(tmpdir(), `opencode-dcp-notification-header-config-${process.pid}`)
process.env.XDG_DATA_HOME = testDataHome
process.env.XDG_CONFIG_HOME = testConfigHome
mkdirSync(testDataHome, { recursive: true })
mkdirSync(testConfigHome, { recursive: true })

function block(blockId: number, runId: number, compressedTokens: number): CompressionBlock {
    return {
        blockId,
        runId,
        active: true,
        deactivatedByUser: false,
        compressedTokens,
        summaryTokens: 3,
        durationMs: 0,
        topic: `topic ${blockId}`,
        startId: `m000${blockId}`,
        endId: `m000${blockId}`,
        anchorMessageId: `m000${blockId}`,
        compressMessageId: `msg-compress-${blockId}`,
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: [`msg-${blockId}`],
        directToolIds: [],
        effectiveMessageIds: [`msg-${blockId}`],
        effectiveToolIds: [],
        createdAt: blockId,
        summary: "short summary",
    }
}

function config() {
    return {
        pruneNotification: "detailed",
        pruneNotificationType: "chat",
        compress: { showCompression: false },
    } as any
}

async function notify(state: ReturnType<typeof createSessionState>, blockId: number, runId: number) {
    let text = ""
    const client = {
        session: {
            prompt: async (request: any) => {
                text = request.body.parts[0].text
            },
        },
    }
    const compressionBlock = state.prune.messages.blocksById.get(blockId)!
    const previousDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Bun")
    // Force the TUI branch off (typeof Bun !== "undefined") so the chat path
    // is taken regardless of the host runtime. Uses defineProperty because
    // Bun defines `globalThis.Bun` as a read-only property; plain assignment
    // throws TypeError under Bun's test runner.
    Object.defineProperty(globalThis, "Bun", {
        value: {},
        configurable: true,
        writable: true,
        enumerable: false,
    })
    try {
        await sendCompressNotification(
            client,
            new Logger(false),
            config(),
            state,
            "ses_notification_header",
            [{ blockId, runId, summary: compressionBlock.summary, summaryTokens: 3 }],
            undefined,
            compressionBlock.directMessageIds,
            {},
        )
    } finally {
        if (previousDescriptor) {
            Object.defineProperty(globalThis, "Bun", previousDescriptor)
        } else {
            delete (globalThis as any).Bun
        }
    }
    return text
}

test("sendCompressNotification uses the notified block delta in headline and detail", async () => {
    const state = createSessionState()
    state.stats.totalPruneTokens = 12_000
    state.stats.pruneTokenCounter = 345
    state.prune.messages.blocksById.set(1, block(1, 7, 2_500))
    state.prune.messages.activeBlockIds.add(1)

    const text = await notify(state, 1, 7)

    assert.match(text, /^▣ DCP \| -2\.5K removed, \+3 summary/m)
    assert.match(text, /▣ Compression #7 -2\.5K removed, \+3 summary/)
    assert.match(text, /→ Session total: 12\.3K removed/)
    assert.doesNotMatch(text.split("\n")[0] ?? "", /12\.3K/)
})

test("sendCompressNotification sums compressedTokens across multiple entries", async () => {
    const state = createSessionState()
    state.prune.messages.blocksById.set(1, block(1, 5, 1_500))
    state.prune.messages.blocksById.set(2, block(2, 5, 2_500))
    state.prune.messages.activeBlockIds.add(1)
    state.prune.messages.activeBlockIds.add(2)

    let text = ""
    const client = {
        session: { prompt: async (req: any) => { text = req.body.parts[0].text } },
    }
    const previousDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Bun")
    Object.defineProperty(globalThis, "Bun", {
        value: {},
        configurable: true,
        writable: true,
        enumerable: false,
    })
    try {
        await sendCompressNotification(
            client, new Logger(false), config(), state, "ses_multi",
            [
                { blockId: 1, runId: 5, summary: "a", summaryTokens: 3 },
                { blockId: 2, runId: 5, summary: "b", summaryTokens: 3 },
            ],
            undefined,
            ["msg-1", "msg-2"],
            {},
        )
    } finally {
        if (previousDescriptor) {
            Object.defineProperty(globalThis, "Bun", previousDescriptor)
        } else {
            delete (globalThis as any).Bun
        }
    }

    assert.match(text.split("\n")[0] ?? "", /-4K removed/)
    assert.match(text, /▣ Compression #5 -4K removed, \+6 summary/)
})

test("sendCompressNotification returns false without dispatching when notification is off", async () => {
    const state = createSessionState()
    state.prune.messages.blocksById.set(1, block(1, 1, 1_000))
    state.prune.messages.activeBlockIds.add(1)
    let called = false
    const client = { session: { prompt: async () => { called = true } } }
    const previousDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Bun")
    Object.defineProperty(globalThis, "Bun", {
        value: {},
        configurable: true,
        writable: true,
        enumerable: false,
    })
    try {
        const result = await sendCompressNotification(
            client, new Logger(false), { pruneNotification: "off" } as any,
            state, "ses_off",
            [{ blockId: 1, runId: 1, summary: "x", summaryTokens: 3 }],
            undefined, ["msg-1"], {},
        )
        assert.equal(result, false)
        assert.equal(called, false)
    } finally {
        if (previousDescriptor) {
            Object.defineProperty(globalThis, "Bun", previousDescriptor)
        } else {
            delete (globalThis as any).Bun
        }
    }
})

test("sendCompressNotification reports different deltas for consecutive compresses", async () => {
    const state = createSessionState()
    state.stats.totalPruneTokens = 20_000
    state.prune.messages.blocksById.set(1, block(1, 1, 1_200))
    state.prune.messages.activeBlockIds.add(1)
    const first = await notify(state, 1, 1)

    state.stats.totalPruneTokens = 27_800
    state.prune.messages.blocksById.set(2, block(2, 2, 7_800))
    state.prune.messages.activeBlockIds.add(2)
    const second = await notify(state, 2, 2)

    const firstHeadline = first.split("\n")[0]
    const secondHeadline = second.split("\n")[0]
    assert.equal(firstHeadline, "▣ DCP | -1.2K removed, +3 summary")
    assert.equal(secondHeadline, "▣ DCP | -7.8K removed, +6 summary")
    assert.notEqual(firstHeadline, secondHeadline)
    assert.match(second, /▣ Compression #2 -7\.8K removed, \+3 summary/)
    assert.match(second, /→ Session total: 27\.8K removed/)
})
