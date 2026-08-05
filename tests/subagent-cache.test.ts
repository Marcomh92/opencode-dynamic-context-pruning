import assert from "node:assert/strict"
import test from "node:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdirSync } from "node:fs"
import { buildSearchContext } from "../lib/compress/search"
import { appendProtectedTools } from "../lib/compress/protected-content"
import { buildSubAgentCacheKey, olderWinsWrite } from "../lib/subagents/cache-key"
import type { SearchContext, SelectionResolution } from "../lib/compress/types"
import { Logger } from "../lib/logger"
import { createSessionState, type CachedSubAgentResult, type SessionState, type WithParts } from "../lib/state"
import { injectExtendedSubAgentResults } from "../lib/messages/inject/subagent-results"

// Per-test isolation: redirect XDG_DATA_HOME/XDG_CONFIG_HOME away from the
// real user dir so the persistence layer never touches the host filesystem.
const testDataHome = join(tmpdir(), `opencode-dcp-subagent-cache-data-${process.pid}`)
const testConfigHome = join(tmpdir(), `opencode-dcp-subagent-cache-config-${process.pid}`)

process.env.XDG_DATA_HOME = testDataHome
process.env.XDG_CONFIG_HOME = testConfigHome

mkdirSync(testDataHome, { recursive: true })
mkdirSync(testConfigHome, { recursive: true })

const logger = new Logger(false)

/** Build a parent message stream containing N completed `task` tool parts,
 *  each with its own subagent session id and a `<task_result>...</task_result>`
 *  wrapper around a distinct round-specific marker text in `state.output`.
 *  This mirrors the shape that nested `task()` produces in a live OpenCode
 *  session after multiple rounds. */
function buildParentMessagesWithRounds(
    sessionID: string,
    rounds: Array<{
        callID: string
        subAgentSessionId: string
        marker: string
    }>,
): WithParts[] {
    return [
        {
            info: {
                id: "msg-parent-user-1",
                role: "user",
                sessionID,
                agent: "assistant",
                model: { providerID: "anthropic", modelID: "claude-test" },
                time: { created: 1 },
            } as WithParts["info"],
            parts: [
                {
                    id: "msg-parent-user-1-part-1",
                    messageID: "msg-parent-user-1",
                    sessionID,
                    type: "text" as const,
                    text: "Dispatch a subagent and resume across multiple rounds.",
                },
            ],
        },
        ...rounds.map((round, idx) => ({
            info: {
                id: `msg-parent-assistant-${idx + 1}`,
                role: "assistant" as const,
                sessionID,
                agent: "assistant",
                time: { created: 2 + idx },
            } as WithParts["info"],
            parts: [
                {
                    id: `msg-parent-assistant-${idx + 1}-part-tool`,
                    messageID: `msg-parent-assistant-${idx + 1}`,
                    sessionID,
                    type: "tool" as const,
                    tool: "task",
                    callID: round.callID,
                    state: {
                        status: "completed" as const,
                        input: { description: `round ${idx + 1}` },
                        output: `<task_result>\nROUND_${idx + 1}_MARKER:${round.marker}\n</task_result>`,
                        metadata: {
                            sessionId: round.subAgentSessionId,
                        },
                    },
                },
            ],
        })),
    ]
}

function buildClientStub(): any {
    // The new #595 code path must NOT fetch on cache miss. If the production
    // code calls client.session.messages during the test, we want the test
    // to fail loudly — that is itself a regression of the load-bearing fix.
    return {
        session: {
            messages: () => {
                throw new Error(
                    "client.session.messages must NOT be called on a cache miss (#595 fallback)",
                )
            },
        },
    }
}

// ────────────────────────────────────────────────────────────────────────────
// Scenario 1 — cold-cache fallback (the load-bearing test for #595).
// Three rounds of nested `task()`. State is constructed from a fresh
// createSessionState() (cold cache) for each parent re-emit. The fallback
// to `part.state.output` is what preserves round-correctness across resume.
// ────────────────────────────────────────────────────────────────────────────

test("#595 cold-cache: each round's part.state.output is preserved untouched", async () => {
    const sessionID = `ses_595_cold_${Date.now()}`
    const rounds = [
        {
            callID: "call-round-1",
            subAgentSessionId: "ses-sub-1",
            marker: "alpha",
        },
        {
            callID: "call-round-2",
            subAgentSessionId: "ses-sub-1", // same subagent, resumed via task_id
            marker: "beta",
        },
        {
            callID: "call-round-3",
            subAgentSessionId: "ses-sub-1", // same subagent, resumed again
            marker: "gamma",
        },
    ]

    const messages = buildParentMessagesWithRounds(sessionID, rounds)
    const state = createSessionState() // cold cache
    state.sessionId = sessionID
    const client = buildClientStub()

    // Parent re-emits the message stream (transform hook runs).
    await injectExtendedSubAgentResults(client, state, logger, messages, true)

    // Each round's part must contain its own marker — the fallback to
    // state.output is the load-bearing correctness fix.
    for (let idx = 0; idx < rounds.length; idx++) {
        const part = messages[idx + 1]?.parts[0] as any
        assert.ok(part?.state?.output, `round ${idx + 1} output should exist`)
        assert.match(
            part.state.output,
            new RegExp(`ROUND_${idx + 1}_MARKER:${rounds[idx]!.marker}`),
            `round ${idx + 1} should keep its own marker (cold-cache fallback)`,
        )
    }

    // No cache writes on the miss path — the cache is still cold.
    assert.equal(state.subAgentResultCache.size, 0)
})

test("#595 cold-cache: protected-content path also falls back to state.output", async () => {
    const sessionID = `ses_595_cold_protected_${Date.now()}`
    const rounds = [
        {
            callID: "call-round-1",
            subAgentSessionId: "ses-sub-1",
            marker: "alpha",
        },
        {
            callID: "call-round-2",
            subAgentSessionId: "ses-sub-1",
            marker: "beta",
        },
        {
            callID: "call-round-3",
            subAgentSessionId: "ses-sub-1",
            marker: "gamma",
        },
    ]

    const messages = buildParentMessagesWithRounds(sessionID, rounds)
    const state = createSessionState() // cold cache
    state.sessionId = sessionID

    const searchContext: SearchContext = buildSearchContext(state, messages)
    const selection: SelectionResolution = {
        startReference: { kind: "message", rawIndex: 1, messageId: "msg-parent-assistant-1" },
        endReference: { kind: "message", rawIndex: 3, messageId: "msg-parent-assistant-3" },
        messageIds: [
            "msg-parent-assistant-1",
            "msg-parent-assistant-2",
            "msg-parent-assistant-3",
        ],
        messageTokenById: new Map(),
        toolIds: ["call-round-1", "call-round-2", "call-round-3"],
        requiredBlockIds: [],
    }

    const summary = await appendProtectedTools(
        buildClientStub(),
        state,
        true, // allowSubAgents
        "",
        selection,
        searchContext,
        ["task"],
    )

    // The summary must contain each round's marker in its OWN task block —
    // not all rounds collapsing to the latest (gamma).
    assert.match(summary, /ROUND_1_MARKER:alpha/)
    assert.match(summary, /ROUND_2_MARKER:beta/)
    assert.match(summary, /ROUND_3_MARKER:gamma/)

    // Cold-cache: nothing written.
    assert.equal(state.subAgentResultCache.size, 0)
})

// ────────────────────────────────────────────────────────────────────────────
// Scenario 2 — cache HIT: a primed entry wins over `state.output`.
// ────────────────────────────────────────────────────────────────────────────

test("#595 cache HIT: primed entry is merged into part.state.output", async () => {
    const sessionID = `ses_595_hit_${Date.now()}`
    const subAgentSessionId = "ses-sub-hit"
    const callID = "call-hit-1"

    const messages: WithParts[] = [
        {
            info: {
                id: "msg-parent-user-1",
                role: "user",
                sessionID,
                agent: "assistant",
                model: { providerID: "anthropic", modelID: "claude-test" },
                time: { created: 1 },
            } as WithParts["info"],
            parts: [
                {
                    id: "msg-parent-user-1-part-1",
                    messageID: "msg-parent-user-1",
                    sessionID,
                    type: "text" as const,
                    text: "Dispatch a subagent.",
                },
            ],
        },
        {
            info: {
                id: "msg-parent-assistant-1",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 2 },
            } as WithParts["info"],
            parts: [
                {
                    id: "msg-parent-assistant-1-part-tool",
                    messageID: "msg-parent-assistant-1",
                    sessionID,
                    type: "tool" as const,
                    tool: "task",
                    callID,
                    state: {
                        status: "completed" as const,
                        input: { description: "test" },
                        output: "<task_result>stale-truncated-output</task_result>",
                        metadata: { sessionId: subAgentSessionId },
                    },
                },
            ],
        },
    ]

    const state = createSessionState()
    state.sessionId = sessionID

    // Prime the cache with a known-good entry — this is the case where the
    // parent has already seen the full round text in the same session and
    // can reuse it without re-fetching.
    const cacheKey = buildSubAgentCacheKey(subAgentSessionId, callID)
    const primed: CachedSubAgentResult = {
        subAgentSessionId,
        toolCallId: callID,
        capturedAt: 100,
        text: "FULL_CACHED_TEXT_FROM_ROUND_1",
    }
    state.subAgentResultCache.set(cacheKey, primed)

    await injectExtendedSubAgentResults(buildClientStub(), state, logger, messages, true)

    const toolPart = messages[1]?.parts[0] as any
    assert.match(
        toolPart.state.output,
        /FULL_CACHED_TEXT_FROM_ROUND_1/,
        "cached text should replace <task_result> body on cache HIT",
    )
    assert.doesNotMatch(
        toolPart.state.output,
        /stale-truncated-output/,
        "stale state.output body should be overwritten by cached text",
    )
})

// ────────────────────────────────────────────────────────────────────────────
// Scenario 4 — composite key prevents collision across distinct subagents.
// Defensive against future callID reuse under different subagents.
// ────────────────────────────────────────────────────────────────────────────

test("#595 composite key: distinct subAgentSessionId prevents collision on shared callID", async () => {
    const sessionID = `ses_595_key_${Date.now()}`
    const callID = "call-shared"

    const messages: WithParts[] = [
        {
            info: {
                id: "msg-parent-user-1",
                role: "user",
                sessionID,
                agent: "assistant",
                model: { providerID: "anthropic", modelID: "claude-test" },
                time: { created: 1 },
            } as WithParts["info"],
            parts: [
                {
                    id: "msg-parent-user-1-part-1",
                    messageID: "msg-parent-user-1",
                    sessionID,
                    type: "text" as const,
                    text: "Dispatch a subagent.",
                },
            ],
        },
        {
            info: {
                id: "msg-parent-assistant-1",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 2 },
            } as WithParts["info"],
            parts: [
                {
                    id: "msg-parent-assistant-1-part-tool",
                    messageID: "msg-parent-assistant-1",
                    sessionID,
                    type: "tool" as const,
                    tool: "task",
                    callID,
                    state: {
                        status: "completed" as const,
                        input: { description: "test" },
                        output: "<task_result>part-state-output</task_result>",
                        metadata: { sessionId: "ses-sub-B" },
                    },
                },
            ],
        },
    ]

    const state: SessionState = createSessionState()
    state.sessionId = sessionID

    // Prime the cache under a DIFFERENT subAgentSessionId. With the legacy
    // bare-callID key this entry would leak into the wrong subagent's
    // output. With the composite key it must not.
    const cacheKey = buildSubAgentCacheKey("ses-sub-A", callID)
    state.subAgentResultCache.set(cacheKey, {
        subAgentSessionId: "ses-sub-A",
        toolCallId: callID,
        capturedAt: 100,
        text: "WRONG_SUBAGENT_TEXT",
    })

    await injectExtendedSubAgentResults(buildClientStub(), state, logger, messages, true)

    const toolPart = messages[1]?.parts[0] as any
    assert.doesNotMatch(
        toolPart.state.output,
        /WRONG_SUBAGENT_TEXT/,
        "composite key must isolate cache entries by subAgentSessionId",
    )
    assert.match(
        toolPart.state.output,
        /part-state-output/,
        "fallback to state.output when no entry exists for this (subAgentSessionId, callID)",
    )
})

// ────────────────────────────────────────────────────────────────────────────
// olderWinsWrite helper — reference implementation for the future
// write-on-completion path (see lib/subagents/cache-key.ts). No production
// caller exists yet; these tests lock the contract so a future write site
// can't silently change the rule.
// ────────────────────────────────────────────────────────────────────────────

function makeCachedResult(
    subAgentSessionId: string,
    toolCallId: string,
    capturedAt: number,
    text: string,
): CachedSubAgentResult {
    return { subAgentSessionId, toolCallId, capturedAt, text }
}

test("olderWinsWrite: returns incoming when existing is undefined", () => {
    const incoming = makeCachedResult("ses-sub", "call-1", 100, "incoming text")

    const result = olderWinsWrite(undefined, incoming)

    assert.equal(result, incoming)
})

test("olderWinsWrite: returns incoming when incoming.capturedAt is strictly older", () => {
    const existing = makeCachedResult("ses-sub", "call-1", 200, "newer existing text")
    const incoming = makeCachedResult("ses-sub", "call-1", 100, "older incoming text")

    const result = olderWinsWrite(existing, incoming)

    assert.equal(result, incoming)
    assert.equal(result.capturedAt, 100)
})

test("olderWinsWrite: returns existing when incoming.capturedAt is strictly newer", () => {
    const existing = makeCachedResult("ses-sub", "call-1", 100, "older existing text")
    const incoming = makeCachedResult("ses-sub", "call-1", 200, "newer incoming text")

    const result = olderWinsWrite(existing, incoming)

    assert.equal(result, existing)
    assert.equal(result.capturedAt, 100)
})

test("olderWinsWrite: returns existing when capturedAt is equal (tie keeps existing)", () => {
    const existing = makeCachedResult("ses-sub", "call-1", 100, "existing text")
    const incoming = makeCachedResult("ses-sub", "call-1", 100, "incoming text")

    const result = olderWinsWrite(existing, incoming)

    assert.equal(result, existing)
    assert.equal(result.capturedAt, 100)
    assert.equal(result.text, "existing text")
})

test("olderWinsWrite: returns existing when incoming.capturedAt is NaN (invalid)", () => {
    const existing = makeCachedResult("ses-sub", "call-1", 100, "existing text")
    const incoming = makeCachedResult("ses-sub", "call-1", Number.NaN, "garbage incoming")

    const result = olderWinsWrite(existing, incoming)

    // NaN < x is always false, so the comparison falls through to existing.
    assert.equal(result, existing)
    assert.equal(result.capturedAt, 100)
    assert.equal(result.text, "existing text")
})
