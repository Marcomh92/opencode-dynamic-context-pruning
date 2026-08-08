import assert from "node:assert/strict"
import test from "node:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdirSync, readFileSync } from "node:fs"
import type { PluginConfig } from "../lib/config"
import { createCompressRangeTool } from "../lib/compress/range"
import { createSystemPromptHandler } from "../lib/hooks"
import { Logger } from "../lib/logger"
import {
    createSessionState,
    detectParentSessionFromTitle,
    ensureSessionInitialized,
    loadSessionState,
    saveSessionState,
    type SessionState,
    type WithParts,
} from "../lib/state"

const testDataHome = join(tmpdir(), `opencode-dcp-bug087-data-${process.pid}`)
const testConfigHome = join(tmpdir(), `opencode-dcp-bug087-config-${process.pid}`)
process.env.XDG_DATA_HOME = testDataHome
process.env.XDG_CONFIG_HOME = testConfigHome
mkdirSync(testDataHome, { recursive: true })
mkdirSync(testConfigHome, { recursive: true })

function buildConfig(): PluginConfig {
    return {
        enabled: true,
        autoUpdate: false,
        debug: false,
        pruneNotification: "off",
        pruneNotificationType: "chat",
        commands: { enabled: true, protectedTools: [] },
        manualMode: { enabled: false, automaticStrategies: true },
        turnProtection: { enabled: false, turns: 4 },
        experimental: { allowSubAgents: true, customPrompts: false },
        protectedFilePatterns: [],
        compress: {
            mode: "range",
            permission: "allow",
            showCompression: false,
            summaryBuffer: true,
            maxContextLimit: 150000,
            minContextLimit: 50000,
            nudgeFrequency: 5,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            protectedTools: [],
            protectTags: false,
            protectUserMessages: false,
            maxCompactionRatio: 0.7,
            maxContextLimitRecovery: 3,
            recoveryFadeWindow: 5,
            forkSchemaVersion: 3,
            stateMaxAgeDays: null,
        },
        strategies: {
            deduplication: { enabled: false, protectedTools: [] },
            purgeErrors: { enabled: false, turns: 4, protectedTools: [] },
        },
    }
}

function textPart(messageID: string, sessionID: string, text: string) {
    return {
        id: `${messageID}-part`,
        messageID,
        sessionID,
        type: "text" as const,
        text,
    }
}

function buildMessages(sessionID: string, count: number): WithParts[] {
    return Array.from({ length: count }, (_, index) => {
        const id = `msg-${index + 1}`
        const role = index % 2 === 0 ? "user" : "assistant"
        return {
            info: {
                id,
                role,
                sessionID,
                agent: "assistant",
                ...(role === "user"
                    ? { model: { providerID: "test", modelID: "test-model" } }
                    : {}),
                time: { created: index + 1 },
            } as WithParts["info"],
            parts: [textPart(id, sessionID, `raw content ${index + 1}`)],
        }
    })
}

function buildClient(messagesBySession: Map<string, WithParts[]>, titles: Map<string, string>) {
    return {
        session: {
            messages: async ({ path: { id } }: { path: { id: string } }) => ({
                data: messagesBySession.get(id) ?? [],
            }),
            get: async ({ path: { id } }: { path: { id: string } }) => ({
                data: { parentID: null, title: titles.get(id) },
            }),
        },
        tui: { showToast: async () => {} },
    }
}

function prompts() {
    return {
        reload() {},
        getRuntimePrompts() {
            return { compressRange: "", compressMessage: "", system: "DCP system prompt" }
        },
    }
}

function buildTool(
    state: SessionState,
    client: any,
    config: PluginConfig = buildConfig(),
    logger = new Logger(false),
) {
    return createCompressRangeTool({ client, state, logger, config, prompts: prompts() } as any)
}

async function executeRange(
    state: SessionState,
    client: any,
    sessionID: string,
    startId: string,
    endId: string,
    summary: string,
    config = buildConfig(),
) {
    return buildTool(state, client, config).execute(
        { topic: "BUG-087 test compression", content: [{ startId, endId, summary }] },
        { ask: async () => {}, metadata: () => {}, sessionID, messageID: `compress-${sessionID}` },
    )
}

async function initialize(
    state: SessionState,
    client: any,
    sessionID: string,
    messages: WithParts[],
): Promise<void> {
    await ensureSessionInitialized(
        client,
        state,
        sessionID,
        new Logger(false),
        messages,
        false,
        null,
        true,
    )
}

function persistedBlockCount(sessionID: string): number {
    const path = join(testDataHome, "opencode", "storage", "plugin", "dcp", `${sessionID}.json`)
    try {
        const persisted = JSON.parse(readFileSync(path, "utf8"))
        return Object.keys(persisted.prune.messages.blocksById).length
    } catch {
        return 0
    }
}

test("BUG-087: detectParentSessionFromTitle recognizes numbered fork titles", () => {
    assert.deepEqual(detectParentSessionFromTitle("Original (fork #1)"), {
        isForked: true,
        parentTitle: "Original",
        forkNumber: 1,
    })
    assert.deepEqual(detectParentSessionFromTitle("Original (fork #2)"), {
        isForked: true,
        parentTitle: "Original",
        forkNumber: 2,
    })
    assert.deepEqual(detectParentSessionFromTitle("My Session With Spaces (fork #5)"), {
        isForked: true,
        parentTitle: "My Session With Spaces",
        forkNumber: 5,
    })
})

test("BUG-087: detectParentSessionFromTitle rejects non-fork and missing titles", () => {
    for (const title of [
        "Some Session",
        "Some Session (split #1)",
        "Some Session (fork)",
        "Some Session (fork #abc)",
        "",
        undefined,
        null,
    ]) {
        assert.deepEqual(detectParentSessionFromTitle(title), { isForked: false })
    }
})

test("BUG-087: forked B starts with isolated state and can compress overlapping raw history", async () => {
    const sessionA = `ses_A_${Date.now()}_core`
    const sessionB = `ses_B_${Date.now()}_core`
    const messagesA = buildMessages(sessionA, 20)
    const messagesB = buildMessages(sessionB, 30)
    const client = buildClient(
        new Map([
            [sessionA, messagesA],
            [sessionB, messagesB],
        ]),
        new Map(),
    )
    const state = createSessionState()

    await initialize(state, client, sessionA, messagesA)
    await executeRange(state, client, sessionA, "m0001", "m0020", "A summary")
    await initialize(state, client, sessionB, messagesB)

    assert.equal(state.sessionId, sessionB)
    assert.equal(state.prune.messages.blocksById.size, 0)
    assert.equal(await loadSessionState(sessionB, new Logger(false)), null)
    assert.equal(persistedBlockCount(sessionA), 1)

    await executeRange(state, client, sessionB, "m0001", "m0025", "B overlapping summary")
    assert.equal(state.sessionId, sessionB)
    assert.equal(state.prune.messages.blocksById.size, 1)
    assert.equal(persistedBlockCount(sessionB), 1)
})

test("BUG-087: intended first-compress prevAnchorEnd empty bypass accepts the initial range", async () => {
    const sessionID = `ses_B_${Date.now()}_monotonic`
    const messages = buildMessages(sessionID, 10)
    const client = buildClient(new Map([[sessionID, messages]]), new Map())
    const state = createSessionState()
    await initialize(state, client, sessionID, messages)

    // INTENDED: there is no previous anchor on a fresh session, so monotonic
    // validation is skipped and the first block is allowed to be applied.
    await assert.doesNotReject(() =>
        executeRange(state, client, sessionID, "m0001", "m0010", "first compression"),
    )
    assert.equal(state.prune.messages.blocksById.size, 1)
})

test("BUG-087: first non-compacting compress applies its block before the guard increments recovery state", async () => {
    const sessionID = `ses_B_${Date.now()}_noncompacting`
    const messages = buildMessages(sessionID, 10)
    const client = buildClient(new Map([[sessionID, messages]]), new Map())
    const state = createSessionState()
    await initialize(state, client, sessionID, messages)

    // INTENDED LIMITATION: maxCompactionRatio is a post-apply feedback guard;
    // it does not reject the first non-compacting block at write time.
    await executeRange(
        state,
        client,
        sessionID,
        "m0001",
        "m0010",
        "A very large summary ".repeat(200),
    )
    assert.equal(state.prune.messages.blocksById.size, 1)
    assert.equal(state.nonCompactingRunCount, 1)
})

test("BUG-087: forked B does not inherit A recovery state or non-compacting counter", async () => {
    const sessionA = `ses_A_${Date.now()}_recovery`
    const sessionB = `ses_B_${Date.now()}_recovery`
    const messagesA = buildMessages(sessionA, 10)
    const messagesB = buildMessages(sessionB, 10)
    const client = buildClient(
        new Map([
            [sessionA, messagesA],
            [sessionB, messagesB],
        ]),
        new Map(),
    )
    const state = createSessionState()
    await initialize(state, client, sessionA, messagesA)
    state.recoveryForced = true
    state.nonCompactingRunCount = 3
    await saveSessionState(state, new Logger(false))

    await initialize(state, client, sessionB, messagesB)
    assert.equal(state.recoveryForced, false)
    assert.equal(state.nonCompactingRunCount, 0)
})

test("BUG-087: system prompt adds the fork inheritance hint only for detected fork titles", async () => {
    const state = createSessionState()
    state.sessionId = "ses_B_prompt"
    const config = buildConfig()
    const logger = new Logger(false)
    const handler = createSystemPromptHandler(state, logger, config, prompts() as any)

    ;(state as { sessionTitle?: string }).sessionTitle = "My Work (fork #3)"
    const forkOutput = { system: ["base"] }
    await handler({ sessionID: state.sessionId, model: { limit: { context: 1000 } } }, forkOutput)
    assert.match(forkOutput.system[0], /forked from another session/)
    ;(state as { sessionTitle?: string }).sessionTitle = "Plain Title"
    const plainOutput = { system: ["base"] }
    await handler({ sessionID: state.sessionId, model: { limit: { context: 1000 } } }, plainOutput)
    assert.doesNotMatch(plainOutput.system[0], /forked from another session/)

    delete (state as { sessionTitle?: string }).sessionTitle
    const missingOutput = { system: ["base"] }
    await handler(
        { sessionID: state.sessionId, model: { limit: { context: 1000 } } },
        missingOutput,
    )
    assert.doesNotMatch(missingOutput.system[0], /forked from another session/)
})

test("BUG-087: multi-generation A-to-B-to-C keeps every session's blocks and files isolated", async () => {
    const suffix = `${Date.now()}_generations`
    const sessionA = `ses_A_${suffix}`
    const sessionB = `ses_B_${suffix}`
    const sessionC = `ses_C_${suffix}`
    const messagesA = buildMessages(sessionA, 10)
    const messagesB = buildMessages(sessionB, 10)
    const messagesC = buildMessages(sessionC, 10)
    const client = buildClient(
        new Map([
            [sessionA, messagesA],
            [sessionB, messagesB],
            [sessionC, messagesC],
        ]),
        new Map(),
    )
    const state = createSessionState()

    await initialize(state, client, sessionA, messagesA)
    await executeRange(state, client, sessionA, "m0001", "m0010", "A block")
    const aFileBefore = JSON.stringify(await loadSessionState(sessionA, new Logger(false)))

    await initialize(state, client, sessionB, messagesB)
    await executeRange(state, client, sessionB, "m0001", "m0005", "B block")
    const bFileBefore = JSON.stringify(await loadSessionState(sessionB, new Logger(false)))

    await initialize(state, client, sessionC, messagesC)
    assert.equal(state.prune.messages.blocksById.size, 0)
    await executeRange(state, client, sessionC, "m0001", "m0003", "C block")

    assert.equal(JSON.stringify(await loadSessionState(sessionA, new Logger(false))), aFileBefore)
    assert.equal(JSON.stringify(await loadSessionState(sessionB, new Logger(false))), bFileBefore)
    assert.equal(persistedBlockCount(sessionA), 1)
    assert.equal(persistedBlockCount(sessionB), 1)
    assert.equal(persistedBlockCount(sessionC), 1)
    assert.equal(state.prune.messages.blocksById.size, 1)
})

// Logic Verified: detector, A→B core, monotonic bypass, non-compacting post-apply, recovery isolation, system-prompt hint, A→B→C.
// Bugs Documented: BUG-087.
// Fakes Updated: inline OpenCode client, prompts, messages, config fakes.
// Review Status: pending independent review.
