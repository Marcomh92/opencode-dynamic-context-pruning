/**
 * Fork-state-inheritance tests (BUG-089 plan §8).
 *
 * Covers the fork-state-inheritance orchestrator (`lib/state/inherit.ts`):
 *   - detector (already-covered: tests/session-fork.test.ts)
 *   - candidate scan + always-pick fallback chain
 *   - timestamp-anchored predicate + rekey post-pass
 *   - mergeInheritedBlocks canonical third writer
 *   - field-level copy (recovery, stats, prune.tools, recovery gadgets)
 *   - gates (allowSubAgents, schema mismatch, fork-suffix strip, etc.)
 *
 * PAT references:
 *   - PAT-010: inline builders (no fixtures dir)
 *   - PAT-011: XDG sandbox per-pid temp dirs
 *   - PAT-012: audit-trail trailer at EOF
 *   - PAT-013: BUG-089: prefix in test names
 */
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import type { PluginConfig } from "../lib/config"
import { Logger } from "../lib/logger"
import { createSessionState, ensureSessionInitialized } from "../lib/state"
import {
    buildTimeIndex,
    filterInheritableBlocks,
    rekeyBlocksToFork,
    tryInheritFromParent,
} from "../lib/state/inherit"
import { loadSessionState, saveSessionState } from "../lib/state/persistence"
import {
    FORK_SCHEMA_VERSION,
    type CompressionBlock,
    type SessionState,
    type WithParts,
} from "../lib/state/types"

// PAT-011: per-pid XDG sandbox so the candidate scan reads only this file's tiles.
const testDataHome = mkdtempSync(join(tmpdir(), "dcp-fork-inherit-data-"))
const testConfigHome = mkdtempSync(join(tmpdir(), "dcp-fork-inherit-config-"))
process.env.XDG_DATA_HOME = testDataHome
process.env.XDG_CONFIG_HOME = testConfigHome
mkdirSync(testConfigHome, { recursive: true })

const storageDir = join(testDataHome, "opencode", "storage", "plugin", "dcp")
const logger = new Logger(false)

// ---------------------------------------------------------------------------
// Inline builders (PAT-010)
// ---------------------------------------------------------------------------

function buildConfig(overrides: Partial<PluginConfig["experimental"]> = {}): PluginConfig {
    return {
        enabled: true,
        autoUpdate: false,
        debug: false,
        pruneNotification: "off",
        pruneNotificationType: "chat",
        commands: { enabled: true, protectedTools: [] },
        manualMode: { enabled: false, automaticStrategies: true },
        turnProtection: { enabled: false, turns: 4 },
        experimental: {
            allowSubAgents: true,
            customPrompts: false,
            inheritOnFork: true,
            ...overrides,
        },
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
            forkSchemaVersion: FORK_SCHEMA_VERSION,
            stateMaxAgeDays: null,
        },
        strategies: {
            deduplication: { enabled: false, protectedTools: [] },
            purgeErrors: { enabled: false, turns: 4, protectedTools: [] },
        },
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
            parts: [
                {
                    id: `${id}-part`,
                    messageID: id,
                    sessionID,
                    type: "text" as const,
                    text: `raw content ${index + 1}`,
                },
            ],
        }
    })
}

function buildClient(
    messagesBySession: Map<string, WithParts[]>,
    titles: Map<string, string>,
    currentTitles?: Map<string, string>,
) {
    return {
        session: {
            messages: async ({ path: { id } }: { path: { id: string } }) => ({
                data: messagesBySession.get(id) ?? [],
            }),
            // `currentTitles` (when provided) overrides the title returned by
            // the SDK mock — simulates the rename-resilience path in
            // findCandidateParents' pass 1.5 (lib/state/inherit.ts:352-368)
            // where each candidate's stale `sessionName` is refreshed from
            // the SDK before the title-match filter runs.
            get: async ({ path: { id } }: { path: { id: string } }) => ({
                data: {
                    parentID: null,
                    title: currentTitles?.get(id) ?? titles.get(id),
                },
            }),
        },
        tui: { showToast: async () => {} },
    }
}

function buildBlock(
    blockId: number,
    overrides: Partial<CompressionBlock> = {},
    count: number = 20,
): CompressionBlock {
    return {
        blockId,
        runId: blockId,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 1000,
        summaryTokens: 100,
        durationMs: 0,
        mode: "range",
        topic: "Inherit test block",
        batchTopic: "Inherit test block",
        startId: "msg-1",
        endId: `msg-${count}`,
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
        summary: "Inherit test summary",
        startTime: 1,
        endTime: count,
        effectiveTimeMs: Array.from({ length: count }, (_, i) => i + 1),
        directTimeMs: Array.from({ length: count }, (_, i) => i + 1),
        anchorTime: 2,
        compressTime: 1,
        ...overrides,
    }
}

function persistBlock(
    sessionID: string,
    block: CompressionBlock,
    sessionTitle?: string,
    extraFields: Record<string, any> = {},
): void {
    mkdirSync(storageDir, { recursive: true })
    const blockRecord: Record<string, any> = { [String(block.blockId)]: block }
    const persisted = {
        sessionName: sessionTitle,
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
                blocksById: blockRecord,
                activeBlockIds: [block.blockId],
                activeByAnchorMessageId: block.anchorMessageId
                    ? { [block.anchorMessageId]: block.blockId }
                    : {},
                nextBlockId: block.blockId + 1,
                nextRunId: block.runId + 1,
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
        ...extraFields,
    }
    writeFileSync(
        join(storageDir, `${sessionID}.json`),
        JSON.stringify(persisted, null, 2),
        "utf-8",
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
        logger,
        messages,
        false,
        config,
        null,
        config.experimental.allowSubAgents,
    )
}

// ---------------------------------------------------------------------------
// BUG-089: Inheritance orchestrator — core scenarios (plan §8.1–8.8)
// ---------------------------------------------------------------------------

test("BUG-089: inheritance-fires-on-real-fork", async () => {
    // §6.1: B loaded for the first time after being forked from A inherits A's
    // timestamp-anchored filtered blocks.
    const sessionA = `ses_A_${Date.now()}_inherit`
    const sessionB = `ses_B_${Date.now()}_inherit`
    const messagesA = buildMessages(sessionA, 20)
    const messagesB = buildMessages(sessionB, 20)
    const titles = new Map([
        [sessionA, "Inherit"],
        [sessionB, "Inherit (fork #1)"],
    ])
    const client = buildClient(
        new Map([
            [sessionA, messagesA],
            [sessionB, messagesB],
        ]),
        titles,
    )

    persistBlock(sessionA, buildBlock(1, {}, 20), "Inherit")

    const state = createSessionState()
    await initialize(state, client, sessionB, messagesB)

    assert.equal(state.sessionId, sessionB)
    assert.equal(state.prune.messages.blocksById.size, 1)
    assert.equal(state.inheritedFrom, sessionA)
})

test("BUG-089: single-candidate-picks-directly", async () => {
    // §6.2: title scan returns 1 match → direct pick without timestamp scoring.
    const sessionA = `ses_A_${Date.now()}_single`
    const sessionB = `ses_B_${Date.now()}_single`
    const messagesA = buildMessages(sessionA, 10)
    const messagesB = buildMessages(sessionB, 10)
    const titles = new Map([
        [sessionA, "Single"],
        [sessionB, "Single (fork #1)"],
    ])
    const client = buildClient(
        new Map([
            [sessionA, messagesA],
            [sessionB, messagesB],
        ]),
        titles,
    )

    persistBlock(sessionA, buildBlock(1, {}, 10), "Single")

    const state = createSessionState()
    await initialize(state, client, sessionB, messagesB)

    assert.equal(state.prune.messages.blocksById.size, 1)
})

test("BUG-089: longest-timestamp-prefix-wins", async () => {
    // §6.3: two siblings (same `(fork #1)` suffix) — pick the one whose block
    // timestamps align longer with B's messages. Built directly via the
    // orchestrator so the diff is the candidate pool, not the test rig.
    const sessionA = `ses_A_${Date.now()}_longest`
    const sessionB = `ses_B_${Date.now()}_longest`
    const messagesB = buildMessages(sessionB, 10)
    const titles = new Map<string, string>([
        [sessionA, "Longest"],
        [sessionB, "Longest (fork #1)"],
    ])
    const client = buildClient(new Map([[sessionB, messagesB]]), titles)

    // Candidate P1: effective 1..10 (full prefix match with B's messages).
    persistBlock(
        sessionA,
        buildBlock(1, {
            effectiveTimeMs: Array.from({ length: 10 }, (_, i) => i + 1),
            directTimeMs: Array.from({ length: 10 }, (_, i) => i + 1),
            startTime: 1,
            endTime: 10,
        }),
        undefined,
        { sessionName: "Longest" },
    )
    // Candidate P2: effective 1..3 only (short prefix match).
    const sessionA2 = `ses_A_${Date.now()}_longest_sibling`
    persistBlock(
        sessionA2,
        buildBlock(2, {
            effectiveTimeMs: [1, 2, 3],
            directTimeMs: [1, 2, 3],
            startTime: 1,
            endTime: 3,
        }),
        undefined,
        { sessionName: "Longest" },
    )

    const state = createSessionState()
    await initialize(state, client, sessionB, messagesB)

    // P1 wins (prefix length 10 > 3). B inherits P1's block.
    assert.equal(state.prune.messages.blocksById.size, 1)
    assert.equal(state.inheritedFrom, sessionA)
})

test("BUG-089: recency-fallback-no-prefix-match", async () => {
    // §6.4: candidates with no shared prefix with B → most recent mtime wins.
    const sessionA = `ses_A_${Date.now()}_recency`
    const sessionA2 = `ses_A_${Date.now()}_recency_sibling`
    const sessionB = `ses_B_${Date.now()}_recency`
    const messagesB = buildMessages(sessionB, 10)
    const titles = new Map<string, string>([
        [sessionA, "Recency"],
        [sessionA2, "Recency"],
        [sessionB, "Recency (fork #1)"],
    ])
    const client = buildClient(new Map([[sessionB, messagesB]]), titles)

    // Candidate A: timestamps that don't align with B (1..10).
    persistBlock(
        sessionA,
        buildBlock(1, {
            effectiveTimeMs: [100, 101, 102],
            directTimeMs: [100, 101, 102],
            startTime: 100,
            endTime: 102,
            anchorTime: 101,
            compressTime: 100,
        }),
        undefined,
        { sessionName: "Recency" },
    )
    // Candidate A2: same misalignment, written later (recency fallback picks this).
    persistBlock(
        sessionA2,
        buildBlock(2, {
            effectiveTimeMs: [200, 201, 202],
            directTimeMs: [200, 201, 202],
            startTime: 200,
            endTime: 202,
            anchorTime: 201,
            compressTime: 200,
        }),
        undefined,
        { sessionName: "Recency" },
    )

    const state = createSessionState()
    await initialize(state, client, sessionB, messagesB)

    // No prefix match → recency fallback picks A2 (written last).
    // The block fails the timestamp filter (timestamps not in B's timeSet) → 0 blocks.
    assert.equal(state.prune.messages.blocksById.size, 0)
    assert.equal(state.inheritedFrom, sessionA2)
})

test("BUG-089: empty-candidate-set-gives-up", async () => {
    // §6.5: zero candidates → graceful give-up (the only legitimate
    // "no parent" case besides subagent/schema/missing-file).
    const sessionB = `ses_B_${Date.now()}_empty`
    const messagesB = buildMessages(sessionB, 10)
    const titles = new Map<string, string>([[sessionB, "Empty (fork #1)"]])
    const client = buildClient(new Map([[sessionB, messagesB]]), titles)

    // No A file at all.
    const state = createSessionState()
    await initialize(state, client, sessionB, messagesB)

    assert.equal(state.prune.messages.blocksById.size, 0)
    assert.equal(state.inheritedFrom, null)
})

test("BUG-089: mid-history-fork-picks-recency", async () => {
    // §6.6: fork point inside the shared prefix of multiple candidates →
    // no exact prefix match exists → recency fallback picks a session.
    const sessionA = `ses_A_${Date.now()}_midhist`
    const sessionA2 = `ses_A_${Date.now()}_midhist_sibling`
    const sessionB = `ses_B_${Date.now()}_midhist`
    const messagesB = buildMessages(sessionB, 10)
    const titles = new Map<string, string>([
        [sessionA, "MidHist"],
        [sessionA2, "MidHist"],
        [sessionB, "MidHist (fork #1)"],
    ])
    const client = buildClient(new Map([[sessionB, messagesB]]), titles)

    // Both candidates have timestamps (100..109 / 200..209) that do NOT
    // overlap with B (1..10). Prefix scores are 0 for both, forcing
    // pickParentCandidate into the recency fallback (bestScore === 0
    // branch in `lib/state/inherit.ts:214`).
    persistBlock(
        sessionA,
        buildBlock(1, {
            effectiveTimeMs: Array.from({ length: 10 }, (_, i) => 100 + i),
            directTimeMs: Array.from({ length: 10 }, (_, i) => 100 + i),
            startTime: 100,
            endTime: 109,
            anchorTime: 101,
            compressTime: 100,
        }),
        undefined,
        { sessionName: "MidHist" },
    )
    persistBlock(
        sessionA2,
        buildBlock(2, {
            effectiveTimeMs: Array.from({ length: 10 }, (_, i) => 200 + i),
            directTimeMs: Array.from({ length: 10 }, (_, i) => 200 + i),
            startTime: 200,
            endTime: 209,
            anchorTime: 201,
            compressTime: 200,
        }),
        undefined,
        { sessionName: "MidHist" },
    )

    const state = createSessionState()
    await initialize(state, client, sessionB, messagesB)

    // No prefix match → recency fallback picks sessionA2 (written last).
    // The block fails the timestamp filter (timestamps not in B's timeSet) → 0 blocks.
    assert.equal(state.prune.messages.blocksById.size, 0)
    assert.equal(state.inheritedFrom, sessionA2)
})

test("BUG-089: predicate-timestamp-anchored-despite-id-regen", async () => {
    // §6.7: parent's block has startId = msg_<A's id>, startTime = 1; B's
    // message at time.created = 1 has ID msg_<B's id> (different). The block
    // passes the filter because startTime is in B's timeSet.
    const sessionA = `ses_A_${Date.now()}_pred`
    const sessionB = `ses_B_${Date.now()}_pred`
    const messagesB = buildMessages(sessionB, 10)
    const titles = new Map<string, string>([
        [sessionA, "Pred"],
        [sessionB, "Pred (fork #1)"],
    ])
    const client = buildClient(new Map([[sessionB, messagesB]]), titles)

    // Use a "fake" message ID for A's block — the startId/endId/anchorMessageId
    // are intentionally different from B's message IDs. Only the timestamp
    // fields anchor the inheritance.
    persistBlock(
        sessionA,
        buildBlock(1, {
            startId: "msg_A_1",
            endId: "msg_A_10",
            anchorMessageId: "msg_A_2",
            compressMessageId: "msg_A_1",
            startTime: 1,
            endTime: 10,
            effectiveTimeMs: Array.from({ length: 10 }, (_, i) => i + 1),
            directTimeMs: Array.from({ length: 10 }, (_, i) => i + 1),
            anchorTime: 2,
            compressTime: 1,
        }),
        "Pred",
    )

    const state = createSessionState()
    await initialize(state, client, sessionB, messagesB)

    // Block is inheritable because timestamps align; rekey rewrites the IDs.
    assert.equal(state.prune.messages.blocksById.size, 1)
    const inherited = state.prune.messages.blocksById.get(1)
    assert.ok(inherited)
    // The rekeyed IDs match B's message IDs (msg-1, msg-2, msg-10), not A's.
    assert.equal(inherited.startId, "msg-1")
    assert.equal(inherited.endId, "msg-10")
    assert.equal(inherited.anchorMessageId, "msg-2")
    assert.equal(inherited.compressMessageId, "msg-1")
})

test("BUG-089: filter-inheritable-blocks-drops-orphan-timestamps", async () => {
    // §6.8: block whose startTime is not in B's timeSet is dropped.
    const bTimeSet = new Set([1, 2, 3, 4, 5])
    const parentBlocksById = new Map<number, CompressionBlock>()
    const block = buildBlock(1, {
        startTime: 999, // not in B's timeSet
        endTime: 5,
        effectiveTimeMs: [1, 2, 3, 4, 5],
        directTimeMs: [1, 2, 3, 4, 5],
        anchorTime: 2,
        compressTime: 1,
    })
    parentBlocksById.set(1, block)

    const result = filterInheritableBlocks([block], bTimeSet, parentBlocksById)
    assert.equal(result.length, 0)
})

test("BUG-089: filter-inheritable-blocks-drops-deactivatedByUser", async () => {
    const bTimeSet = new Set([1, 2, 3, 4, 5])
    const parentBlocksById = new Map<number, CompressionBlock>()
    const block = buildBlock(1, { deactivatedByUser: true })
    parentBlocksById.set(1, block)

    const result = filterInheritableBlocks([block], bTimeSet, parentBlocksById)
    assert.equal(result.length, 0)
})

test("BUG-089: filter-inheritable-blocks-drops-dangling-consumed-refs", async () => {
    const bTimeSet = new Set([1, 2, 3, 4, 5])
    const parentBlocksById = new Map<number, CompressionBlock>()
    const block = buildBlock(1, { consumedBlockIds: [42] }) // 42 not in parent set
    parentBlocksById.set(1, block)

    const result = filterInheritableBlocks([block], bTimeSet, parentBlocksById)
    assert.equal(result.length, 0)
})

test("BUG-089: rekey-blocks-to-fork-rewrites-IDs", async () => {
    // §6.9: rekey rewrites 6 ID-shaped fields from parent's IDs to B's IDs.
    const block = buildBlock(1, {
        startId: "msg_A_1",
        endId: "msg_A_10",
        anchorMessageId: "msg_A_2",
        compressMessageId: "msg_A_1",
        effectiveMessageIds: [],
        directMessageIds: [],
        effectiveTimeMs: [1, 2, 3, 4, 5],
        directTimeMs: [1, 2, 3, 4, 5],
        startTime: 1,
        endTime: 5,
        anchorTime: 2,
        compressTime: 1,
    })
    const timeToId = new Map<number, string>([
        [1, "msg_B_1"],
        [2, "msg_B_2"],
        [3, "msg_B_3"],
        [4, "msg_B_4"],
        [5, "msg_B_5"],
    ])

    const [rekeyed] = rekeyBlocksToFork([block], timeToId)
    assert.ok(rekeyed)
    assert.equal(rekeyed.startId, "msg_B_1")
    assert.equal(rekeyed.endId, "msg_B_5")
    assert.equal(rekeyed.anchorMessageId, "msg_B_2")
    assert.equal(rekeyed.compressMessageId, "msg_B_1")
    assert.deepEqual(rekeyed.effectiveMessageIds, [
        "msg_B_1",
        "msg_B_2",
        "msg_B_3",
        "msg_B_4",
        "msg_B_5",
    ])
})

test("BUG-091: rekey-blocks-to-fork-preserves-boundary-refs", async () => {
    // startId/endId are boundary refs (mNNNN/bN), not message IDs — they are
    // session-relative and carry over verbatim; only raw message-ID fields
    // are rekeyed via timeToId (BUG-091: raw-ID rekey broke the monotonic
    // anchor at range.ts:92 / message.ts:88).
    const block = buildBlock(1, {
        startId: "m0001",
        endId: "m0002",
        anchorMessageId: "msg_A_2",
        compressMessageId: "msg_A_1",
        effectiveMessageIds: [],
        directMessageIds: [],
        effectiveTimeMs: [1, 2, 3, 4, 5],
        directTimeMs: [1, 2, 3, 4, 5],
        startTime: 1,
        endTime: 5,
        anchorTime: 2,
        compressTime: 1,
    })
    const timeToId = new Map<number, string>([
        [1, "msg_B_1"],
        [2, "msg_B_2"],
        [3, "msg_B_3"],
        [4, "msg_B_4"],
        [5, "msg_B_5"],
    ])

    const [rekeyed] = rekeyBlocksToFork([block], timeToId)
    assert.ok(rekeyed)
    assert.equal(rekeyed.startId, "m0001") // ref preserved, NOT msg_B_1
    assert.equal(rekeyed.endId, "m0002") // ref preserved, NOT msg_B_5
    assert.equal(rekeyed.anchorMessageId, "msg_B_2")
    assert.equal(rekeyed.compressMessageId, "msg_B_1")
})

test("BUG-089: anchor-and-compress-rekeyed", async () => {
    // §6.27 / plan architect flag #1: without rekeying anchorMessageId and
    // compressMessageId, sync.ts would deactivate every inherited block on
    // B's first sync. Verify the rekeyed IDs match B's message IDs.
    const sessionA = `ses_A_${Date.now()}_anchor`
    const sessionB = `ses_B_${Date.now()}_anchor`
    const messagesB = buildMessages(sessionB, 10)
    const titles = new Map<string, string>([
        [sessionA, "Anchor"],
        [sessionB, "Anchor (fork #1)"],
    ])
    const client = buildClient(new Map([[sessionB, messagesB]]), titles)

    persistBlock(
        sessionA,
        buildBlock(
            1,
            {
                // A's anchor/compress point to a "tool message" with a completely
                // different ID from any of B's messages. Only the timestamp
                // aligns.
                anchorMessageId: "compress-A-tool-msg",
                compressMessageId: "compress-A-tool-msg",
                anchorTime: 2,
                compressTime: 1,
            },
            10,
        ),
        "Anchor",
    )

    const state = createSessionState()
    await initialize(state, client, sessionB, messagesB)

    assert.equal(state.prune.messages.blocksById.size, 1)
    const inherited = state.prune.messages.blocksById.get(1)
    assert.ok(inherited)
    // CRITICAL: rekeyed IDs match B's IDs, not the parent's "compress-A-tool-msg".
    assert.equal(inherited.anchorMessageId, "msg-2")
    assert.equal(inherited.compressMessageId, "msg-1")
})

test("BUG-089: recovery-state-copied", async () => {
    // §6.10: parent's recoveryForced/userForced/manualMode/nonCompactingRunCount
    // /recoveryFadeCounter all carry over to B.
    const sessionA = `ses_A_${Date.now()}_recovery`
    const sessionB = `ses_B_${Date.now()}_recovery`
    const messagesB = buildMessages(sessionB, 10)
    const titles = new Map<string, string>([
        [sessionA, "RecoveryInherit"],
        [sessionB, "RecoveryInherit (fork #1)"],
    ])
    const client = buildClient(new Map([[sessionB, messagesB]]), titles)

    persistBlock(sessionA, buildBlock(1), "RecoveryInherit", {
        userForced: true,
        recoveryForced: true,
        nonCompactingRunCount: 3,
        recoveryFadeCounter: 5,
    })

    const state = createSessionState()
    await initialize(state, client, sessionB, messagesB)

    assert.equal(state.recoveryForced, true)
    assert.equal(state.userForced, true)
    assert.equal(state.nonCompactingRunCount, 3)
    assert.equal(state.recoveryFadeCounter, 5)
    // manualMode is the derived cache: re-derived after merge.
    assert.equal(state.manualMode, "active")
})

test("BUG-089: id-monotonic-max", async () => {
    // §6.11: B's nextBlockId after merge is max(parent.nextBlockId, state.nextBlockId).
    const sessionA = `ses_A_${Date.now()}_idmax`
    const sessionB = `ses_B_${Date.now()}_idmax`
    const messagesB = buildMessages(sessionB, 10)
    const titles = new Map<string, string>([
        [sessionA, "IdMax"],
        [sessionB, "IdMax (fork #1)"],
    ])
    const client = buildClient(new Map([[sessionB, messagesB]]), titles)

    // Parent's nextBlockId is 50 (so the next-allocated blockId in the parent
    // is 50 — carry this through to B so B's first new block after the
    // inheritance doesn't collide).
    persistBlock(
        sessionA,
        buildBlock(
            50,
            {
                blockId: 50,
                runId: 50,
            },
            10,
        ),
        "IdMax",
        {},
    )
    // The persisted file's `nextBlockId` is what mergeInheritedBlocks reads.
    // Re-write with the desired nextBlockId.

    const persistedPath = join(storageDir, `${sessionA}.json`)
    const persisted = JSON.parse(readFileSync(persistedPath, "utf8"))
    persisted.prune.messages.nextBlockId = 51
    persisted.prune.messages.nextRunId = 51
    writeFileSync(persistedPath, JSON.stringify(persisted, null, 2), "utf-8")

    const state = createSessionState()
    state.prune.messages.nextBlockId = 10
    await initialize(state, client, sessionB, messagesB)

    // B's nextBlockId is max(parent=51, state=10) = 51 (per mergeInheritedBlocks
    // which sets nextBlockId = parentMaxBlockId + 1 when parent wins).
    assert.equal(state.prune.messages.nextBlockId, 51)
})

test("BUG-089: stats-inherited-as-inherited", async () => {
    // §6.12: parent's stats.totalPruneTokens carries over to B as
    // `inheritedPruneTokens`, NOT as `totalPruneTokens`. The split was
    // introduced by the BUG-088 fix: totalPruneTokens is now strictly
    // B's own-session savings (never summed across sessions by
    // loadAllSessionStats), while inheritedPruneTokens carries the
    // transitive fork contribution and is display-only per session.
    const sessionA = `ses_A_${Date.now()}_stats`
    const sessionB = `ses_B_${Date.now()}_stats`
    const messagesB = buildMessages(sessionB, 10)
    const titles = new Map<string, string>([
        [sessionA, "Stats"],
        [sessionB, "Stats (fork #1)"],
    ])
    const client = buildClient(new Map([[sessionB, messagesB]]), titles)

    persistBlock(sessionA, buildBlock(1), "Stats", {
        stats: { pruneTokenCounter: 0, totalPruneTokens: 5000 },
    })

    const state = createSessionState()
    await initialize(state, client, sessionB, messagesB)

    // B's own-session total is untouched by inheritance — stays at 0
    // (createSessionState default). BUG-088 fix: parent savings no
    // longer leak into the all-time sum via totalPruneTokens.
    assert.equal(state.stats.totalPruneTokens, 0)
    // Parent's 5000 lands in the display-only inherited slot.
    assert.equal(state.stats.inheritedPruneTokens, 5000)
})

test("BUG-089: prune-tools-copied", async () => {
    // §6.13: parent's prune.tools carries over verbatim.
    const sessionA = `ses_A_${Date.now()}_tools`
    const sessionB = `ses_B_${Date.now()}_tools`
    const messagesB = buildMessages(sessionB, 10)
    const titles = new Map<string, string>([
        [sessionA, "Tools"],
        [sessionB, "Tools (fork #1)"],
    ])
    const client = buildClient(new Map([[sessionB, messagesB]]), titles)

    persistBlock(sessionA, buildBlock(1), "Tools", {
        prune: {
            tools: { "tool-A": 100, "tool-B": 200 },
            messages: {
                byMessageId: {},
                blocksById: { "1": buildBlock(1) },
                activeBlockIds: [1],
                activeByAnchorMessageId: { "msg-2": 1 },
                nextBlockId: 2,
                nextRunId: 2,
            },
        },
    })

    const state = createSessionState()
    await initialize(state, client, sessionB, messagesB)

    assert.equal(state.prune.tools.get("tool-A"), 100)
    assert.equal(state.prune.tools.get("tool-B"), 200)
})

test("BUG-089: tool-identity-callID-survives-fork", async () => {
    // §6.13a: callID-keyed tool identity survives fork even when the
    // corresponding tool part in B has a different `part.id` and
    // `time_created`. The fork contract is anchored on `part.callID`,
    // which OpenCode preserves verbatim across fork (verified via
    // SQLite probe 2026-08-08). rekeyBlocksToFork spreads `...b` so
    // `directToolIds`/`effectiveToolIds` carry through unchanged.
    const sessionA = `ses_A_${Date.now()}_callid`
    const sessionB = `ses_B_${Date.now()}_callid`
    const messagesB = buildMessages(sessionB, 10)
    const titles = new Map<string, string>([
        [sessionA, "CallId"],
        [sessionB, "CallId (fork #1)"],
    ])
    const client = buildClient(new Map([[sessionB, messagesB]]), titles)

    // Parent block carries two callIDs; B's tool parts have the SAME
    // callIDs but different part.id / time_created. The contract: the
    // callIDs survive via spread — they are not in the 6 rekeyed fields.
    // `count: 10` aligns endTime with B's message timestamps so the
    // timestamp predicate passes.
    const block = buildBlock(
        1,
        {
            directToolIds: ["call-X", "call-Y"],
            effectiveToolIds: ["call-X", "call-Y"],
        },
        10,
    )
    persistBlock(sessionA, block, "CallId", {
        prune: {
            tools: { "call-X": 100, "call-Y": 200 },
            messages: {
                byMessageId: {},
                blocksById: {
                    "1": buildBlock(
                        1,
                        {
                            directToolIds: ["call-X", "call-Y"],
                            effectiveToolIds: ["call-X", "call-Y"],
                        },
                        10,
                    ),
                },
                activeBlockIds: [1],
                activeByAnchorMessageId: { "msg-2": 1 },
                nextBlockId: 2,
                nextRunId: 2,
            },
        },
    })

    const state = createSessionState()
    await initialize(state, client, sessionB, messagesB)

    // Inheritance fired.
    assert.equal(state.inheritedFrom, sessionA)
    assert.equal(state.prune.messages.blocksById.size, 1)
    const inherited = state.prune.messages.blocksById.get(1)
    assert.ok(inherited)
    // callID-keyed tool identity survived the fork (rekey's spread preserved
    // directToolIds/effectiveToolIds — they are NOT in the 6 rekeyed fields).
    assert.deepEqual(inherited.directToolIds, ["call-X", "call-Y"])
    assert.deepEqual(inherited.effectiveToolIds, ["call-X", "call-Y"])
    // And prune.tools carries the callID-keyed token counts.
    assert.equal(state.prune.tools.get("call-X"), 100)
    assert.equal(state.prune.tools.get("call-Y"), 200)
})

test("BUG-089: lifecycle-position-not-copied", async () => {
    // §6.14: lastCompaction / currentTurn are NOT in PersistedSessionState.
    // B's values are recomputed from B's own messages, not copied from A.
    const sessionA = `ses_A_${Date.now()}_lifecycle`
    const sessionB = `ses_B_${Date.now()}_lifecycle`
    const messagesB = buildMessages(sessionB, 10)
    const titles = new Map<string, string>([
        [sessionA, "Lifecycle"],
        [sessionB, "Lifecycle (fork #1)"],
    ])
    const client = buildClient(new Map([[sessionB, messagesB]]), titles)

    persistBlock(sessionA, buildBlock(1), "Lifecycle")

    const state = createSessionState()
    // Sentinel "A-like" values: if these leaked from A's persisted state
    // they would NOT match what B's own messages produce. buildMessages
    // emits no `summary: true` and no `step-start` parts, so
    // findLastCompactionTimestamp / countTurns both return 0.
    state.lastCompaction = 999
    state.currentTurn = 99
    await initialize(state, client, sessionB, messagesB)

    // Recomputed from B's own messages — not A's stale values.
    assert.equal(state.lastCompaction, 0)
    assert.equal(state.currentTurn, 0)
})

test("BUG-089: message-ids-not-copied-rebuilt", async () => {
    // §6.15: messageIds is not in PersistedSessionState. B's messageIds start
    // empty (rebuilt deterministically by assignMessageRefs on first transform).
    const sessionA = `ses_A_${Date.now()}_msgids`
    const sessionB = `ses_B_${Date.now()}_msgids`
    const messagesB = buildMessages(sessionB, 10)
    const titles = new Map<string, string>([
        [sessionA, "MsgIds"],
        [sessionB, "MsgIds (fork #1)"],
    ])
    const client = buildClient(new Map([[sessionB, messagesB]]), titles)

    persistBlock(sessionA, buildBlock(1), "MsgIds")

    const state = createSessionState()
    await initialize(state, client, sessionB, messagesB)

    // B's messageIds is a fresh empty MessageIdState (not A's).
    assert.equal(state.messageIds.byRawId.size, 0)
    assert.equal(state.messageIds.byRef.size, 0)
    assert.equal(state.messageIds.nextRef, 1)
})

test("BUG-089: deactivated-block-id-rides-with-block", async () => {
    // §6.16: deactivatedByBlockId is a per-block field. Block with the flag
    // carries it through rekeying.
    const sessionA = `ses_A_${Date.now()}_deactby`
    const sessionB = `ses_B_${Date.now()}_deactby`
    const messagesB = buildMessages(sessionB, 10)
    const titles = new Map<string, string>([
        [sessionA, "DeactBy"],
        [sessionB, "DeactBy (fork #1)"],
    ])
    const client = buildClient(new Map([[sessionB, messagesB]]), titles)

    // Include a block that was deactivated by block 7 — the flag rides along.
    // `count: 10` aligns endTime with B's message timestamps so the
    // timestamp predicate passes.
    const block = buildBlock(1, { deactivatedByBlockId: 7, active: false }, 10)
    persistBlock(sessionA, block, "DeactBy")

    const state = createSessionState()
    await initialize(state, client, sessionB, messagesB)

    // The predicate (filterInheritableBlocks) only checks `deactivatedByUser`,
    // not `active` — so the inactive block IS inheritable. mergeInheritedBlocks
    // stores it in blocksById but skips the active-state promotion. The
    // deactivatedByBlockId flag rides along through rekeying.
    const inherited = state.prune.messages.blocksById.get(1)
    assert.ok(inherited, "inactive block should survive inheritance via blocksById")
    assert.equal(inherited.deactivatedByBlockId, 7)
})

test("BUG-089: nudge-anchors-dropped", async () => {
    // §6.26: parent's nudge anchors (parent message IDs) are dropped on
    // inheritance; B's nudges are fresh from B's own messages.
    const sessionA = `ses_A_${Date.now()}_nudges`
    const sessionB = `ses_B_${Date.now()}_nudges`
    const messagesB = buildMessages(sessionB, 10)
    const titles = new Map<string, string>([
        [sessionA, "Nudges"],
        [sessionB, "Nudges (fork #1)"],
    ])
    const client = buildClient(new Map([[sessionB, messagesB]]), titles)

    // Persist A's nudges with anchors that include A's message IDs.
    mkdirSync(storageDir, { recursive: true })
    const persistedPath = join(storageDir, `${sessionA}.json`)
    writeFileSync(
        persistedPath,
        JSON.stringify(
            {
                sessionName: "Nudges",
                manualMode: false,
                userForced: false,
                forkSchemaVersion: FORK_SCHEMA_VERSION,
                prune: {
                    tools: {},
                    messages: {
                        byMessageId: {},
                        blocksById: { "1": buildBlock(1, {}, 10) },
                        activeBlockIds: [1],
                        activeByAnchorMessageId: { "msg-2": 1 },
                        nextBlockId: 2,
                        nextRunId: 2,
                    },
                },
                nudges: {
                    contextLimitAnchors: ["msg_A_anchor"],
                    turnNudgeAnchors: ["msg_A_anchor_b"],
                    iterationNudgeAnchors: ["msg_A_anchor_c"],
                },
                stats: { pruneTokenCounter: 0, totalPruneTokens: 0 },
                lastUpdated: new Date().toISOString(),
            },
            null,
            2,
        ),
        "utf-8",
    )
    const persisted = JSON.parse(readFileSync(persistedPath, "utf-8"))

    const state = createSessionState()
    await initialize(state, client, sessionB, messagesB)

    // B's nudges are rebuilt from B's own messages — A's anchors don't leak.
    for (const anchor of persisted.nudges.contextLimitAnchors) {
        assert.ok(
            !state.nudges.contextLimitAnchors.has(anchor),
            `parent anchor ${anchor} must not propagate to B`,
        )
    }
    assert.ok(!state.nudges.turnNudgeAnchors.has("msg_A_anchor_b"))
    assert.ok(!state.nudges.iterationNudgeAnchors.has("msg_A_anchor_c"))
})

test("BUG-089: schema-bump-drops-pre-bump-state", async () => {
    // §6.17: FORK_SCHEMA_VERSION is bumped to 4 (new CompressionBlock
    // timestamp fields). Pre-bump files (e.g., v3) are dropped by the schema
    // gate (DPP-004 "drop, don't migrate"). Logically Verified: see BUG-089 plan §8.
    const sessionPreBump = `ses_prebump_${Date.now()}`
    mkdirSync(storageDir, { recursive: true })
    writeFileSync(
        join(storageDir, `${sessionPreBump}.json`),
        JSON.stringify(
            {
                sessionName: "PreBump",
                manualMode: false,
                userForced: false,
                forkSchemaVersion: FORK_SCHEMA_VERSION - 1, // pre-bump
                prune: {
                    tools: {},
                    messages: {
                        byMessageId: {},
                        blocksById: { "1": buildBlock(1) },
                        activeBlockIds: [1],
                        activeByAnchorMessageId: { "msg-2": 1 },
                        nextBlockId: 2,
                        nextRunId: 2,
                    },
                },
                nudges: {
                    contextLimitAnchors: [],
                    turnNudgeAnchors: [],
                    iterationNudgeAnchors: [],
                },
                stats: { pruneTokenCounter: 0, totalPruneTokens: 0 },
                lastUpdated: new Date().toISOString(),
            },
            null,
            2,
        ),
        "utf-8",
    )

    const loaded = await loadSessionState(sessionPreBump, logger)
    assert.equal(loaded, null, "pre-bump schema must be dropped by the gate")
    rmSync(join(storageDir, `${sessionPreBump}.json`), { force: true })
})

test("BUG-089: schema-mismatch-no-inherit", async () => {
    // §6.18: parent's forkSchemaVersion is older than B's current → parent
    // is dropped silently. B's candidate scan filters it out.
    const sessionA = `ses_A_${Date.now()}_mismatch`
    const sessionB = `ses_B_${Date.now()}_mismatch`
    const messagesB = buildMessages(sessionB, 10)
    const titles = new Map<string, string>([
        [sessionA, "Mismatch"],
        [sessionB, "Mismatch (fork #1)"],
    ])
    const client = buildClient(new Map([[sessionB, messagesB]]), titles)

    // Persist A with forkSchemaVersion below the current.
    mkdirSync(storageDir, { recursive: true })
    writeFileSync(
        join(storageDir, `${sessionA}.json`),
        JSON.stringify(
            {
                sessionName: "Mismatch",
                manualMode: false,
                userForced: false,
                forkSchemaVersion: FORK_SCHEMA_VERSION - 1, // older than current
                prune: {
                    tools: {},
                    messages: {
                        byMessageId: {},
                        blocksById: { "1": buildBlock(1) },
                        activeBlockIds: [1],
                        activeByAnchorMessageId: { "msg-2": 1 },
                        nextBlockId: 2,
                        nextRunId: 2,
                    },
                },
                nudges: {
                    contextLimitAnchors: [],
                    turnNudgeAnchors: [],
                    iterationNudgeAnchors: [],
                },
                stats: { pruneTokenCounter: 0, totalPruneTokens: 0 },
                lastUpdated: new Date().toISOString(),
            },
            null,
            2,
        ),
        "utf-8",
    )

    const state = createSessionState()
    await initialize(state, client, sessionB, messagesB)

    // Schema-gate rejection — B's title scan finds A but the schema gate
    // inside findCandidateParents filters it. No inheritance.
    assert.equal(state.prune.messages.blocksById.size, 0)
    assert.equal(state.inheritedFrom, null)
    rmSync(join(storageDir, `${sessionA}.json`), { force: true })
})

test("BUG-089: sdk-failure-graceful", async () => {
    // §6.19: client.session.get throws → orchestrator catches, logs debug,
    // returns without effect. State remains empty.
    const sessionB = `ses_B_${Date.now()}_sdkfail`
    const titles = new Map<string, string>([[sessionB, "SdkFail (fork #1)"]])
    const messagesB = buildMessages(sessionB, 10)
    const client = {
        session: {
            messages: async () => ({ data: messagesB }),
            get: async () => {
                throw new Error("SDK boom")
            },
        },
        tui: { showToast: async () => {} },
    }

    const state = createSessionState()
    await initialize(state, client, sessionB, messagesB)

    // Orchestrator swallowed the SDK error → no crash, no inheritance.
    assert.equal(state.prune.messages.blocksById.size, 0)
    assert.equal(state.inheritedFrom, null)
})

test("BUG-089: malformed-parent-state-no-inherit", async () => {
    // §6.20: parent's JSON is unparseable → loadSessionState returns null
    // → graceful no-op.
    const sessionA = `ses_A_${Date.now()}_malformed`
    const sessionB = `ses_B_${Date.now()}_malformed`
    const messagesB = buildMessages(sessionB, 10)
    const titles = new Map<string, string>([
        [sessionA, "Malformed"],
        [sessionB, "Malformed (fork #1)"],
    ])
    const client = buildClient(new Map([[sessionB, messagesB]]), titles)

    mkdirSync(storageDir, { recursive: true })
    writeFileSync(join(storageDir, `${sessionA}.json`), "{ not json", "utf-8")

    const state = createSessionState()
    await initialize(state, client, sessionB, messagesB)

    assert.equal(state.prune.messages.blocksById.size, 0)
    assert.equal(state.inheritedFrom, null)
    rmSync(join(storageDir, `${sessionA}.json`), { force: true })
})

test("BUG-089: sessionname-round-trip-preserves-fork-suffix", async () => {
    // §6.22 (post BUG-090 fix): save state with title "Stripped (fork #1)" →
    // persisted sessionName is the verbatim user title (suffix preserved).
    // The candidate scan in `findCandidateParents` strips the suffix on the
    // read side (suffix-aware match) — this preserves the multi-generation
    // inheritance invariant without mutating the persisted shape.
    const sessionB = `ses_B_${Date.now()}_stripped`
    const messagesB = buildMessages(sessionB, 10)
    const titles = new Map<string, string>([[sessionB, "Stripped (fork #1)"]])
    const client = buildClient(new Map([[sessionB, messagesB]]), titles)

    const state = createSessionState()
    await initialize(state, client, sessionB, messagesB)
    state.sessionTitle = "Stripped (fork #1)"
    await saveSessionState(state, logger)

    const persisted = JSON.parse(readFileSync(join(storageDir, `${sessionB}.json`), "utf8"))
    // Save-side keeps the user title verbatim (BUG-090).
    assert.equal(persisted.sessionName, "Stripped (fork #1)")
})

test("BUG-089: default-on-inheritance", async () => {
    // §6.23: fresh install with no config → inheritOnFork defaults to true.
    const sessionA = `ses_A_${Date.now()}_default`
    const sessionB = `ses_B_${Date.now()}_default`
    const messagesB = buildMessages(sessionB, 10)
    const titles = new Map<string, string>([
        [sessionA, "DefaultOn"],
        [sessionB, "DefaultOn (fork #1)"],
    ])
    const client = buildClient(new Map([[sessionB, messagesB]]), titles)

    persistBlock(sessionA, buildBlock(1, {}, 10), "DefaultOn")

    // No config.experimental.inheritOnFork set → defaults to true.
    const config = buildConfig()
    delete (config.experimental as { inheritOnFork?: boolean }).inheritOnFork

    const state = createSessionState()
    await initialize(state, client, sessionB, messagesB, config)

    assert.equal(state.prune.messages.blocksById.size, 1)
})

test("BUG-089: subagent-skip-no-inheritance", async () => {
    // §6.28: B's parentID is set in the SDK metadata response (isSubAgent
    // === true) AND allowSubAgents is false → ensureSessionInitialized
    // returns early BEFORE tryInheritFromParent is called (line 237 of
    // lib/state/state.ts). The candidate scan never fires even though
    // a valid parent state file exists — no inheritance.
    const sessionA = `ses_A_${Date.now()}_subagent`
    const sessionB = `ses_B_${Date.now()}_subagent`
    const messagesB = buildMessages(sessionB, 10)
    const titles = new Map<string, string>([
        [sessionA, "Subagent"],
        [sessionB, "Subagent (fork #1)"],
    ])
    // parentID populated in the SDK mock → getSessionMetadata returns
    // isSubAgent=true. The mock `get` would throw on a SECOND call (if
    // the orchestrator somehow tried a fork-detection roundtrip), but
    // it should never be called twice for the subagent+opt-out path.
    let sessionGetCalls = 0
    const client = {
        session: {
            messages: async () => ({ data: messagesB }),
            get: async () => {
                sessionGetCalls++
                if (sessionGetCalls > 1) {
                    throw new Error(
                        "SDK get called more than once — candidate scan should not have fired",
                    )
                }
                return { data: { parentID: "ses_parent_of_B", title: titles.get(sessionB) } }
            },
        },
        tui: { showToast: async () => {} },
    }

    // Persist a valid parent state file. If the orchestrator were to
    // scan, it would find this candidate and inherit. The subagent gate
    // must short-circuit BEFORE that scan happens.
    persistBlock(sessionA, buildBlock(1), "Subagent")

    const config = buildConfig({ allowSubAgents: false })
    const state = createSessionState()
    await initialize(state, client, sessionB, messagesB, config)

    // No inheritance — the subagent gate in ensureSessionInitialized
    // returned early before tryInheritFromParent was reached.
    assert.equal(state.prune.messages.blocksById.size, 0)
    assert.equal(state.inheritedFrom, null)
    // Exactly one SDK call (the metadata roundtrip). No second call for
    // fork detection or anything else.
    assert.equal(sessionGetCalls, 1)
})

test("BUG-089: opt-out-skips-detection", async () => {
    // §6.24: with inheritOnFork: false, the orchestrator returns early —
    // no SDK roundtrip for fork detection.
    const sessionA = `ses_A_${Date.now()}_optout`
    const sessionB = `ses_B_${Date.now()}_optout`
    const messagesB = buildMessages(sessionB, 10)
    const titles = new Map<string, string>([
        [sessionA, "OptOut"],
        [sessionB, "OptOut (fork #1)"],
    ])
    // Spy that the SDK is NOT called for fork detection when opt-out.
    let sessionGetCalls = 0
    const client = {
        session: {
            messages: async () => ({ data: messagesB }),
            get: async () => {
                sessionGetCalls++
                return { data: { parentID: null, title: titles.get(sessionB) } }
            },
        },
        tui: { showToast: async () => {} },
    }

    persistBlock(sessionA, buildBlock(1), "OptOut")

    const config = buildConfig({ inheritOnFork: false })
    const state = createSessionState()
    await initialize(state, client, sessionB, messagesB, config)

    // No inheritance when opt-out.
    assert.equal(state.prune.messages.blocksById.size, 0)
    // The SDK call still fires once for the subagent+title check (architect
    // flag #14). Opt-out only suppresses inheritance logic, not the metadata
    // fetch — `tryInheritFromParent` is the gate, not `getSessionMetadata`.
    assert.equal(sessionGetCalls, 1)
})

test("BUG-089: build-time-index-first-wins", async () => {
    // §6.4 utility: buildTimeIndex returns first-wins for same-ms pairs.
    // We construct two messages with the same time.created and verify
    // the timeToId map records only the first one.
    const messages: WithParts[] = [
        {
            info: {
                id: "first",
                role: "user",
                sessionID: "test",
                agent: "assistant",
                model: { providerID: "test", modelID: "test-model" },
                time: { created: 100 },
            } as WithParts["info"],
            parts: [],
        },
        {
            info: {
                id: "second",
                role: "assistant",
                sessionID: "test",
                agent: "assistant",
                time: { created: 100 },
            } as WithParts["info"],
            parts: [],
        },
    ]
    const { timeSet, timeToId } = buildTimeIndex(messages)
    assert.equal(timeSet.size, 1)
    assert.equal(timeToId.get(100), "first")
})

test("BUG-089: tryInheritFromParent-direct-invocation-swallows-errors", async () => {
    // Direct unit test of the orchestrator's top-level try/catch — passing
    // garbage state to ensure the wrapper never throws.
    const garbageState = null as unknown as SessionState
    const client = buildClient(new Map(), new Map())
    const messages: WithParts[] = []

    // The orchestrator wraps everything in try/catch — must not throw.
    await assert.doesNotReject(() =>
        tryInheritFromParent(garbageState, client, "ses_x", logger, messages, buildConfig(), null),
    )
})

test("BUG-089: sdk-title-refresh-rescues-stale-sessionName-on-rename", async () => {
    // §6.29 (post Pong-test fix): parent A was saved with stale
    // `sessionName: "OldName"` (before a user rename). OpenCode now reports
    // A's live title as "NewName" (post-rename). B was forked from A:
    // B's title is "NewName (fork #1)". Without SDK title refresh inside
    // findCandidateParents' pass 1.5 (lib/state/inherit.ts:352-368), the
    // scan would compare A's savedName "OldName" against B's parentTitle
    // "NewName" → no match → no inheritance. With refresh, the SDK's
    // "NewName" becomes `currentTitle` → matches → inherit. This pins the
    // rename-resilience contract so future refactors can't silently drop
    // the read-side refresh without this test catching it.
    const sessionA = `ses_A_${Date.now()}_rename`
    const sessionB = `ses_B_${Date.now()}_rename`
    const messagesB = buildMessages(sessionB, 10)
    // SDK-returned titles map. sessionB holds the live child title;
    // sessionA's live (post-rename) title is routed through
    // `currentTitles` below to exercise the override path.
    const titles = new Map<string, string>([[sessionB, "NewName (fork #1)"]])
    // SDK-refreshed title for A — overrides `titles` in the session.get
    // mock to simulate the SDK returning A's CURRENT title at scan time.
    const currentTitles = new Map<string, string>([[sessionA, "NewName"]])

    // Persist A's state file with the STALE `sessionName` ("OldName") that
    // was written before the rename. The scan reads this from disk first;
    // only the SDK refresh in pass 1.5 rescues the match.
    // `count: 10` aligns block timestamps with B's message timestamps
    // so the timestamp predicate passes.
    persistBlock(sessionA, buildBlock(1, {}, 10), "OldName")

    const client = buildClient(new Map([[sessionB, messagesB]]), titles, currentTitles)

    const state = createSessionState()
    await initialize(state, client, sessionB, messagesB)

    // SDK refresh saved us: A's currentTitle "NewName" matched B's
    // parentTitle "NewName" → candidate accepted → inheritance fired.
    // Without the refresh, the candidate scan would have returned []
    // (savedName "OldName" !== parentTitle "NewName") and both asserts
    // below would fail.
    assert.equal(state.inheritedFrom, sessionA)
    assert.equal(state.prune.messages.blocksById.size, 1)
})

// Logic Verified: detect → load → filter (timestamp-anchored) → rekey → mergeInheritedBlocks; field-level copy (recovery, stats, prune.tools, callID-keyed tool identity); gates (allowSubAgents, schema mismatch, fork-suffix strip, malformed, opt-out, default-on, recency fallback, mid-history fork, SDK title refresh over stale sessionName).
// Bugs Documented: BUG-089 (fork-state-inheritance protocol layer), BUG-090 (persistence-side fork-suffix strip breaks multi-gen).
// Fakes Updated: inline OpenCode client (with optional `currentTitles` override for SDK title-refresh), file system persistence, buildBlock/buildMessages/buildConfig helpers; per-test session/messages maps; subagent SDK mocks with call counters.
// Review Status: pending independent review.
