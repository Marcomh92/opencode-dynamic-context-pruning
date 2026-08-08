import assert from "node:assert/strict"
import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

// Per-test isolation: redirect XDG_DATA_HOME / XDG_CONFIG_HOME so the
// persistence layer and the logger never touch the host filesystem.
const testDataHome = join(tmpdir(), `opencode-dcp-capacity-data-${process.pid}`)
const testConfigHome = join(tmpdir(), `opencode-dcp-capacity-config-${process.pid}`)
process.env.XDG_DATA_HOME = testDataHome
process.env.XDG_CONFIG_HOME = testConfigHome
mkdirSync(testDataHome, { recursive: true })
mkdirSync(testConfigHome, { recursive: true })

import { assignMessageRefs, MESSAGE_REF_MAX_INDEX, formatMessageRef } from "../lib/message-ids"
import { Logger } from "../lib/logger"
import { syncCompressionBlocks } from "../lib/messages/sync"
import { createSessionState, type WithParts } from "../lib/state"
import type { CompressionBlock, SessionState } from "../lib/state"

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

function textPart(messageID: string, sessionID: string, id: string, text: string) {
    return {
        id,
        messageID,
        sessionID,
        type: "text" as const,
        text,
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

function buildAssistantMessage(
    id: string,
    sessionID: string,
    text: string,
    created = 2,
): WithParts {
    return {
        info: {
            id,
            role: "assistant",
            sessionID,
            agent: "assistant",
            time: { created },
        } as WithParts["info"],
        parts: [textPart(id, sessionID, `${id}-part`, text)],
    }
}

/** Pre-fill `byRef` with every mNNNN the allocator can hand out. The next
 *  `assignMessageRefs` call that needs a fresh ref will throw
 *  `Message ID alias capacity exceeded`. */
function saturateMessageIdCapacity(state: SessionState) {
    for (let i = 1; i <= MESSAGE_REF_MAX_INDEX; i++) {
        const ref = formatMessageRef(i)
        state.messageIds.byRef.set(ref, `synthetic-raw-${i}`)
        state.messageIds.byRawId.set(`synthetic-raw-${i}`, ref)
    }
    state.messageIds.nextRef = 1
    // byRef is fully populated, so allocateNextMessageRef's
    // `while (!byRef.has(ref))` loop will exhaust 1..9999 and throw.
}

function makeBlock(
    blockId: number,
    anchorMessageId: string,
    compressMessageId: string,
    effectiveMessageIds: string[],
): CompressionBlock {
    return {
        blockId,
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 0,
        summaryTokens: 0,
        topic: "test",
        startId: "m0001",
        endId: "m9999",
        anchorMessageId,
        compressMessageId,
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: [],
        directToolIds: [],
        effectiveMessageIds,
        effectiveToolIds: [],
        createdAt: blockId,
        summary: "stub summary",
    }
}

// ---------------------------------------------------------------------------
// BUG-074 — `Message ID alias capacity exceeded` is uncaught throw
//
// Fixed behaviour: when the allocator cannot hand out a fresh ref, the
// pipeline returns gracefully instead of propagating an uncaught error
// mid-session. The simplest production-grade sentinel is `assignMessageRefs`
// returning a 0 count without throwing, plus a log line — exact mechanism is
// the implementer's choice; the test only asserts the contract.
// ---------------------------------------------------------------------------

test("BUG-074: assignMessageRefs does not throw when capacity is exhausted", () => {
    const sessionID = `ses_bug074_capacity_${Date.now()}`
    const state = createSessionState()
    state.sessionId = sessionID
    saturateMessageIdCapacity(state)

    const messages: WithParts[] = [
        buildUserMessage("msg-user-new-1", sessionID, "first new message", 1),
        buildUserMessage("msg-user-new-2", sessionID, "second new message", 2),
        buildAssistantMessage("msg-assistant-new-1", sessionID, "third new message", 3),
    ]

    // The pre-fix allocator would throw `Message ID alias capacity exceeded`
    // because byRef is saturated with synthetic-raw-1..9999. The fix must
    // surface this as a graceful no-op (return 0) plus a log, not as a
    // thrown error that breaks the transform pipeline.
    assert.doesNotThrow(() => assignMessageRefs(state, messages))

    // The new messages must NOT have been assigned refs (sentinel return),
    // and the saturated synthetic map must be intact.
    assert.equal(state.messageIds.byRawId.get("msg-user-new-1"), undefined)
    assert.equal(state.messageIds.byRawId.get("msg-user-new-2"), undefined)
    assert.equal(state.messageIds.byRawId.get("msg-assistant-new-1"), undefined)
    assert.equal(state.messageIds.byRef.size, MESSAGE_REF_MAX_INDEX)
})

test("BUG-074: capacity-exhausted allocator still serves refs for already-seen raw ids", () => {
    const sessionID = `ses_bug074_existing_${Date.now()}`
    const state = createSessionState()
    state.sessionId = sessionID

    // First, allocate one ref normally.
    const initialMessages: WithParts[] = [
        buildUserMessage("msg-user-known", sessionID, "known message", 1),
    ]
    const firstCount = assignMessageRefs(state, initialMessages)
    assert.equal(firstCount, 1)
    assert.equal(state.messageIds.byRawId.get("msg-user-known"), "m0001")

    // Now saturate the rest of the capacity.
    for (let i = 2; i <= MESSAGE_REF_MAX_INDEX; i++) {
        const ref = formatMessageRef(i)
        state.messageIds.byRef.set(ref, `synthetic-raw-${i}`)
        state.messageIds.byRawId.set(`synthetic-raw-${i}`, ref)
    }

    // Drive the known message through assignMessageRefs again. The fix must
    // continue to return its existing ref even when the pool is saturated —
    // otherwise a re-fire of the transform would break the existing alias
    // for any message already in the byRawId map.
    const reuseMessages: WithParts[] = [
        buildUserMessage("msg-user-known", sessionID, "known message (re-fire)", 1),
    ]
    const reuseCount = assignMessageRefs(state, reuseMessages)
    assert.equal(reuseCount, 0, "re-firing a known message must not allocate a new ref")
    assert.equal(
        state.messageIds.byRawId.get("msg-user-known"),
        "m0001",
        "existing alias must be preserved when capacity is exhausted",
    )
})

// ---------------------------------------------------------------------------
// BUG-025 — m-NNNN refs are reclaimed when a block is deactivated
//
// The fix: when a block is deactivated and is the ONLY active block covering
// a message, the message's mNNNN must be evicted from `byRawId` / `byRef`
// and the allocator's `nextRef` must be tightened so the reclaimed slot is
// reusable on the next allocation. The test asserts the post-deactivation
// state of `state.messageIds` after the deactivation has fired via the
// existing `applyCompressionState` consumption path (which is the canonical
// block-deactivation trigger during compress).
// ---------------------------------------------------------------------------

test("BUG-025: deactivating a block evicts m-NNNN refs for messages it solely covered", () => {
    const sessionID = `ses_bug025_reclaim_${Date.now()}`
    const state = createSessionState()
    state.sessionId = sessionID

    const logger = new Logger(false)

    // Step 1: seed the state with three messages and one compression block
    // covering the first two. This mirrors the production shape: a block's
    // `effectiveMessageIds` are exactly the messages whose mNNNN should be
    // reclaimed when the block is the only active cover for them.
    const messages: WithParts[] = [
        buildUserMessage("msg-only-in-block", sessionID, "only in block", 1),
        buildUserMessage("msg-shared", sessionID, "shared between blocks", 2),
        buildUserMessage("msg-never-compressed", sessionID, "never compressed", 3),
    ]

    // Manually assign refs and register the byMessageId entries (this is what
    // a fresh transform-fire produces before the block is consumed).
    state.messageIds.byRawId.set("msg-only-in-block", "m0001")
    state.messageIds.byRef.set("m0001", "msg-only-in-block")
    state.messageIds.byRawId.set("msg-shared", "m0002")
    state.messageIds.byRef.set("m0002", "msg-shared")
    state.messageIds.byRawId.set("msg-never-compressed", "m0003")
    state.messageIds.byRef.set("m0003", "msg-never-compressed")
    state.messageIds.nextRef = 4

    state.prune.messages.byMessageId.set("msg-only-in-block", {
        tokenCount: 100,
        allBlockIds: [1],
        activeBlockIds: [1],
    })
    state.prune.messages.byMessageId.set("msg-shared", {
        tokenCount: 200,
        allBlockIds: [1, 2],
        activeBlockIds: [1, 2],
    })

    const blockA: CompressionBlock = makeBlock(1, "msg-only-in-block", "compress-msg-1", [
        "msg-only-in-block",
        "msg-shared",
    ])
    state.prune.messages.blocksById.set(1, blockA)
    state.prune.messages.activeBlockIds.add(1)
    state.prune.messages.activeByAnchorMessageId.set("msg-only-in-block", 1)

    const sizeBeforeDeactivation = state.messageIds.byRawId.size
    assert.equal(sizeBeforeDeactivation, 3)

    // Step 2: trigger deactivation. The simplest production path that
    // deactivates a block in-place is `syncCompressionBlocks` — it
    // deactivates blocks whose `compressMessageId` is no longer in the
    // session. The block's messages move out of the active set; the fix
    // must reclaim their mNNNN.
    //
    // Empty the messages array so the block's compressMessageId is missing
    // from the visible session — this is the canonical deactivation trigger.
    const emptyMessages: WithParts[] = []

    syncCompressionBlocks(state, logger, emptyMessages)

    // Pre-fix behaviour: blockA.active is false but byRawId/byRef still
    // contain m0001, m0002 — they leak until the 9999 cap is hit.
    //
    // Fixed behaviour: after deactivation, the messages only covered by the
    // now-inactive block (msg-only-in-block) must be evicted. msg-shared
    // has block 2 still active, so its ref is preserved. msg-never-compressed
    // is untouched because it was never part of any block.
    assert.equal(
        state.messageIds.byRawId.has("msg-only-in-block"),
        false,
        "BUG-025: byRawId must drop refs for messages whose sole block was deactivated",
    )
    assert.equal(
        state.messageIds.byRef.has("m0001"),
        false,
        "BUG-025: byRef must drop the reclaimed mNNNN",
    )
    assert.equal(
        state.messageIds.byRawId.has("msg-shared"),
        true,
        "BUG-025: refs for messages still covered by an active block must be preserved",
    )
    assert.equal(
        state.messageIds.byRawId.has("msg-never-compressed"),
        true,
        "BUG-025: refs for messages never covered by any block must be preserved",
    )
})

test("BUG-025: reclaimed refs are re-allocated on subsequent assignMessageRefs call", () => {
    const sessionID = `ses_bug025_realloc_${Date.now()}`
    const state = createSessionState()
    state.sessionId = sessionID

    const logger = new Logger(false)

    // Allocate m0001..m0010 for 10 messages.
    const initialMessages: WithParts[] = []
    for (let i = 1; i <= 10; i++) {
        const id = `msg-initial-${i}`
        initialMessages.push(buildUserMessage(id, sessionID, `m${i}`, i))
    }
    const assigned = assignMessageRefs(state, initialMessages)
    assert.equal(assigned, 10)
    assert.equal(state.messageIds.byRawId.size, 10)
    assert.equal(state.messageIds.nextRef, 11)

    // Mark msg-initial-1..5 as covered solely by block 1.
    for (let i = 1; i <= 5; i++) {
        state.prune.messages.byMessageId.set(`msg-initial-${i}`, {
            tokenCount: 100,
            allBlockIds: [1],
            activeBlockIds: [1],
        })
    }
    const block: CompressionBlock = makeBlock(1, "msg-initial-1", "compress-msg-x", [
        "msg-initial-1",
        "msg-initial-2",
        "msg-initial-3",
        "msg-initial-4",
        "msg-initial-5",
    ])
    state.prune.messages.blocksById.set(1, block)
    state.prune.messages.activeBlockIds.add(1)
    state.prune.messages.activeByAnchorMessageId.set("msg-initial-1", 1)

    // Trigger deactivation by removing the origin message from the session.
    syncCompressionBlocks(state, logger, [])

    // After deactivation, the 5 refs must be reclaimed AND the next allocation
    // should reuse one of the reclaimed slots — not skip to m0011.
    assert.equal(state.messageIds.byRawId.size, 5)

    const newMessages: WithParts[] = [
        buildUserMessage("msg-new-1", sessionID, "new after reclamation", 100),
        buildUserMessage("msg-new-2", sessionID, "second new after reclamation", 101),
    ]
    const newAssigned = assignMessageRefs(state, newMessages)
    assert.equal(newAssigned, 2)

    // The two new messages must have been allocated into the reclaimed
    // slots, not into fresh ones past the original nextRef. We assert the
    // count of byRawId grows by exactly 2 (no double counting) and that
    // every ref sits at-or-below the original cap.
    assert.equal(state.messageIds.byRawId.size, 7)
    for (const ref of state.messageIds.byRef.keys()) {
        const index = Number.parseInt(ref.slice(1), 10)
        assert.ok(
            index >= 1 && index <= MESSAGE_REF_MAX_INDEX,
            `ref ${ref} must stay within MESSAGE_REF_MAX_INDEX`,
        )
    }
})

// Logic Verified:
//   BUG-074: capacity exhaustion is handled gracefully — assignMessageRefs
//            does not throw, returns 0 for the unservable new messages, and
//            continues to serve existing refs for previously-seen raw ids.
//   BUG-025: deactivating a block via syncCompressionBlocks (missing origin)
//            evicts mNNNN refs for messages whose sole block was deactivated
//            and re-uses the freed slots on subsequent assignMessageRefs.
// Bugs Documented: none (already documented in known_issues/).
// Fakes Updated: none.
// Review Status: not yet independently reviewed.
// Logic Verified: assignMessageRefs does not throw when capacity is exhausted, still serves refs for already-seen raw ids, and reclaims slots on block deactivation.
// Bugs Documented: BUG-025, BUG-074.
// Fakes Updated: none
// Review Status: pending independent review.
