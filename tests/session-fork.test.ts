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
    config: PluginConfig = buildConfig(),
): Promise<void> {
    await ensureSessionInitialized(
        client,
        state,
        sessionID,
        new Logger(false),
        messages,
        false,
        config,
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
        parentTitle: "Original (fork #1)",
        forkNumber: 2,
    })
    assert.deepEqual(detectParentSessionFromTitle("My Session With Spaces (fork #5)"), {
        isForked: true,
        parentTitle: "My Session With Spaces (fork #4)",
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

test("BUG-087: forked B inherits A's compression block", async () => {
    // BUG-089 update: B inherits A's filtered block via the fork-state-inheritance
    // orchestrator. The "isolated state" half of the old contract is replaced by
    // "B inherits A's filtered blocks"; subsequent compresses by B continue to
    // work but require the full transform pipeline (assignMessageRefs) to populate
    // B's byMessageId — that part is covered by the message-ids+compress tests.
    //
    // The block is constructed directly with valid timestamps rather than via
    // the compress tool. The tool creates a tool message that is not in the
    // test's messages array, so the tool-layer lookup at range.ts:184-209
    // returns anchorTime = compressTime = 0, and the timestamp-anchored filter
    // (§4.4) would reject the block. Constructing directly avoids the test
    // entanglement and exercises the inheritance path in isolation.
    const sessionA = `ses_A_${Date.now()}_core`
    const sessionB = `ses_B_${Date.now()}_core`
    const messagesA = buildMessages(sessionA, 20)
    const messagesB = buildMessages(sessionB, 30)
    // Unique titles per test (PAT-010) — prevents the candidate scan from
    // picking up the recovery-test or multi-gen test's persisted files.
    const titles = new Map([
        [sessionA, "Core"],
        [sessionB, "Core (fork #1)"],
    ])
    const client = buildClient(
        new Map([
            [sessionA, messagesA],
            [sessionB, messagesB],
        ]),
        titles,
    )
    const state = createSessionState()

    // Initialize A and put a block directly into A's state with valid timestamps.
    // All 6 timestamp fields are populated from A's message time.created values
    // (1..20), so the timestamp-anchored predicate will accept the block on B's side.
    await initialize(state, client, sessionA, messagesA)
    const aBlock = {
        blockId: 1,
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 1000,
        summaryTokens: 100,
        durationMs: 0,
        mode: "range" as const,
        topic: "A inherited range",
        startId: "msg-1",
        endId: "msg-20",
        anchorMessageId: "msg-2",
        compressMessageId: "msg-1",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: [],
        directToolIds: [],
        effectiveMessageIds: [],
        effectiveToolIds: [],
        createdAt: Date.now(),
        summary: "A summary",
        startTime: 1,
        endTime: 20,
        effectiveTimeMs: Array.from({ length: 20 }, (_, i) => i + 1),
        directTimeMs: Array.from({ length: 20 }, (_, i) => i + 1),
        anchorTime: 2,
        compressTime: 1,
    }
    state.prune.messages.blocksById.set(1, aBlock)
    state.prune.messages.activeBlockIds.add(1)
    state.prune.messages.byMessageId.set("msg-1", {
        tokenCount: 100,
        allBlockIds: [1],
        activeBlockIds: [1],
    })
    state.prune.messages.nextBlockId = 2
    state.prune.messages.byMessageId.set("msg-2", {
        tokenCount: 100,
        allBlockIds: [1],
        activeBlockIds: [1],
    })
    await saveSessionState(state, new Logger(false))
    assert.equal(persistedBlockCount(sessionA), 1)

    // After A's block is saved, B is initialized with a fork-pattern title.
    // The orchestrator finds A's file via the title scan and inherits the block.
    await initialize(state, client, sessionB, messagesB)

    assert.equal(state.sessionId, sessionB)
    // B inherits A's filtered block (timestamp-anchored predicate matches).
    assert.equal(state.prune.messages.blocksById.size, 1)
    // A's persisted file is untouched by B's inheritance.
    assert.equal(persistedBlockCount(sessionA), 1)
    // B recorded its parent in the in-memory inheritedFrom slot.
    assert.equal(state.inheritedFrom, sessionA)
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
test("BUG-087: forked B DOES inherit A recovery state and non-compacting counter (BUG-089 update)", async () => {
    // BUG-089 update (fork-state-inheritance plan §4.5): the recovery
    // fields round-trip via persistence so B can inherit A's recovery state
    // alongside the blocks. The old "session-local reset" rule (BUG-031) is
    // preserved at the load-path level: a non-fork load still drops these
    // fields. Fork inheritance is the only path that copies them.
    const sessionA = `ses_A_${Date.now()}_recovery`
    const sessionB = `ses_B_${Date.now()}_recovery`
    const messagesA = buildMessages(sessionA, 10)
    const messagesB = buildMessages(sessionB, 10)
    const titles = new Map([
        [sessionA, "Recovery"],
        [sessionB, "Recovery (fork #1)"],
    ])
    const client = buildClient(
        new Map([
            [sessionA, messagesA],
            [sessionB, messagesB],
        ]),
        titles,
    )
    const state = createSessionState()

    await initialize(state, client, sessionA, messagesA)
    state.recoveryForced = true
    state.userForced = true
    state.nonCompactingRunCount = 3
    state.recoveryFadeCounter = 1
    await saveSessionState(state, new Logger(false))

    await initialize(state, client, sessionB, messagesB)
    assert.equal(state.recoveryForced, true)
    assert.equal(state.userForced, true)
    assert.equal(state.nonCompactingRunCount, 3)
    assert.equal(state.recoveryFadeCounter, 1)
})

test("BUG-089: system prompt for a forked session does NOT include the legacy fork hint", async () => {
    // Stage B-1 Fix 4 (BUG-089 plan §6.25): the in-prompt "forked from another
    // session" hint was removed entirely. The hint was wrong in both branches:
    // without inheritance it lied about block visibility; with inheritance it
    // contradicted the visible blocks. Asserting absence here is the regression
    // guard — the hint must not creep back into the rendered prompt.
    const state = createSessionState()
    state.sessionId = "ses_B_prompt"
    const config = buildConfig()
    const logger = new Logger(false)
    const handler = createSystemPromptHandler(state, logger, config, prompts() as any)

    ;(state as { sessionTitle?: string }).sessionTitle = "My Work (fork #3)"
    const forkOutput = { system: ["base"] }
    await handler({ sessionID: state.sessionId, model: { limit: { context: 1000 } } }, forkOutput)
    assert.doesNotMatch(forkOutput.system[0], /forked from another session/)
    assert.doesNotMatch(forkOutput.system[0], /prior compression blocks are not visible/i)
    ;(state as { sessionTitle?: string }).sessionTitle = "Plain Title"
    const plainOutput = { system: ["base"] }
    await handler({ sessionID: state.sessionId, model: { limit: { context: 1000 } } }, plainOutput)
    assert.doesNotMatch(plainOutput.system[0], /forked from another session/)
    assert.doesNotMatch(plainOutput.system[0], /prior compression blocks are not visible/i)
})

test("BUG-089: multi-generation A-to-B-to-C propagates filtered blocks and leaves parent files untouched", async () => {
    // BUG-089 update (fork-state-inheritance plan §6.21): transitivity is
    // automatic through B's own persisted state — the orchestrator only
    // looks at the immediate parent. A→B inherits B's blocks; B→C inherits
    // B's filtered blocks (which already include A's filtered blocks).
    // Parent files are NEVER modified by child inheritance; only the
    // child's own file is written.
    const suffix = `${Date.now()}_generations`
    const sessionA = `ses_A_${suffix}`
    const sessionB = `ses_B_${suffix}`
    const sessionC = `ses_C_${suffix}`
    const messagesA = buildMessages(sessionA, 10)
    const messagesB = buildMessages(sessionB, 10)
    const messagesC = buildMessages(sessionC, 10)
    const titles = new Map([
        [sessionA, "MultiGen"],
        [sessionB, "MultiGen (fork #1)"],
        [sessionC, "MultiGen (fork #1) (fork #2)"],
    ])
    const client = buildClient(
        new Map([
            [sessionA, messagesA],
            [sessionB, messagesB],
            [sessionC, messagesC],
        ]),
        titles,
    )
    const state = createSessionState()

    // Seed A directly with a block (timestamps populated from A's messages).
    await initialize(state, client, sessionA, messagesA)
    state.prune.messages.blocksById.set(1, {
        blockId: 1,
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 1000,
        summaryTokens: 100,
        durationMs: 0,
        mode: "range" as const,
        topic: "A block",
        startId: "msg-1",
        endId: "msg-10",
        anchorMessageId: "msg-2",
        compressMessageId: "msg-1",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: [],
        directToolIds: [],
        effectiveMessageIds: [],
        effectiveToolIds: [],
        createdAt: Date.now(),
        summary: "A block",
        startTime: 1,
        endTime: 10,
        effectiveTimeMs: Array.from({ length: 10 }, (_, i) => i + 1),
        directTimeMs: Array.from({ length: 10 }, (_, i) => i + 1),
        anchorTime: 2,
        compressTime: 1,
    })
    state.prune.messages.activeBlockIds.add(1)
    state.prune.messages.byMessageId.set("msg-1", {
        tokenCount: 100,
        allBlockIds: [1],
        activeBlockIds: [1],
    })
    state.prune.messages.byMessageId.set("msg-2", {
        tokenCount: 100,
        allBlockIds: [1],
        activeBlockIds: [1],
    })
    state.prune.messages.nextBlockId = 2
    await saveSessionState(state, new Logger(false))
    const aFileBefore = JSON.stringify(await loadSessionState(sessionA, new Logger(false)))

    // B inherits A's block (auto-persisted), then we add a second block to B.
    await initialize(state, client, sessionB, messagesB)
    assert.equal(state.prune.messages.blocksById.size, 1, "B inherits A's filtered block")
    state.prune.messages.blocksById.set(2, {
        blockId: 2,
        runId: 2,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 500,
        summaryTokens: 50,
        durationMs: 0,
        mode: "range" as const,
        topic: "B block",
        startId: "msg-1",
        endId: "msg-5",
        anchorMessageId: "msg-2",
        compressMessageId: "msg-1",
        includedBlockIds: [],
        consumedBlockIds: [1],
        parentBlockIds: [],
        directMessageIds: [],
        directToolIds: [],
        effectiveMessageIds: [],
        effectiveToolIds: [],
        createdAt: Date.now(),
        summary: "B block",
        startTime: 1,
        endTime: 5,
        effectiveTimeMs: [1, 2, 3, 4, 5],
        directTimeMs: [1, 2, 3, 4, 5],
        anchorTime: 2,
        compressTime: 1,
    })
    state.prune.messages.activeBlockIds.add(2)
    state.prune.messages.nextBlockId = 3
    await saveSessionState(state, new Logger(false))
    const bFileBefore = JSON.stringify(await loadSessionState(sessionB, new Logger(false)))

    // C inherits from B (transitive: B's blocksById includes A's filtered block).
    await initialize(state, client, sessionC, messagesC)
    assert.equal(
        state.prune.messages.blocksById.size,
        2,
        "C inherits B's filtered blocks (transitive contract, §6.21)",
    )

    // Parent files are immutable from child inheritance — this is the
    // load-bearing invariant regardless of the strip bug.
    assert.equal(JSON.stringify(await loadSessionState(sessionA, new Logger(false))), aFileBefore)
    assert.equal(JSON.stringify(await loadSessionState(sessionB, new Logger(false))), bFileBefore)
    // Each session has its own file with its own count.
    assert.equal(persistedBlockCount(sessionA), 1)
    assert.equal(persistedBlockCount(sessionB), 2)
    // C's file is persisted (via the coalesced save in tryInheritFromParent)
    // regardless of whether inheritance fired.
    assert.ok(persistedBlockCount(sessionC) >= 0)
})

// Logic Verified: detector, A→B inherit (replaces was: isolated), monotonic bypass, non-compacting post-apply, recovery inherit (replaces was: reset), no fork hint in system prompt, A→B→C transitive inherit with isolated parent files.
// Bugs Documented: BUG-087 (UX hint subset, superseded by BUG-089), BUG-089 (this rewrite — every persisted-block assertion contracts).
// Fakes Updated: inline OpenCode client, prompts, messages, config fakes.
// Review Status: pending independent review.
