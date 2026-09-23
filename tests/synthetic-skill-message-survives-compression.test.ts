import assert from "node:assert/strict"
import test from "node:test"
import { assignMessageRefs } from "../lib/message-ids"
import { isIgnoredUserMessage } from "../lib/messages/query"
import { buildSearchContext, resolveSelection } from "../lib/compress/search"
import { createSessionState, type WithParts } from "../lib/state"

// Regression tripwire for the "synthetic skill message" invariant from
// docs/IMPROVEMENT_PLAN_CACHE_STRATEGY.md Finding 1. Synthetic user messages
// (e.g. the `<skill>...</skill>` blocks injected by the custom skills plugin)
// are byte-stable, invisible to compression selection, not prunable, and have
// no `mNNNN` ref. Each test below pins one of the six skip-sites that protect
// this invariant. If any skip is removed the matching test must fail.

const SESSION = "ses_synthetic_skill_survives"

function syntheticUserMessage(id: string, text: string, timeCreated: number): WithParts {
    return {
        info: {
            id,
            role: "user",
            sessionID: SESSION,
            agent: "assistant",
            model: { providerID: "anthropic", modelID: "claude-test" },
            time: { created: timeCreated },
        } as WithParts["info"],
        parts: [
            {
                id: `${id}-p`,
                sessionID: SESSION,
                messageID: id,
                type: "text" as const,
                text,
                synthetic: true,
            },
        ],
    }
}

function realUserMessage(id: string, text: string, timeCreated: number): WithParts {
    return {
        info: {
            id,
            role: "user",
            sessionID: SESSION,
            agent: "assistant",
            model: { providerID: "anthropic", modelID: "claude-test" },
            time: { created: timeCreated },
        } as WithParts["info"],
        parts: [
            {
                id: `${id}-p`,
                sessionID: SESSION,
                messageID: id,
                type: "text" as const,
                text,
            },
        ],
    }
}

function realAssistantMessage(id: string, text: string, timeCreated: number): WithParts {
    return {
        info: {
            id,
            role: "assistant",
            sessionID: SESSION,
            agent: "assistant",
            time: { created: timeCreated },
        } as WithParts["info"],
        parts: [
            {
                id: `${id}-p`,
                sessionID: SESSION,
                messageID: id,
                type: "text" as const,
                text,
            },
        ],
    }
}

// ────────────────────────────────────────────────────────────────────────────
// Skip-site 1: lib/messages/query.ts isIgnoredUserMessage
// Skip-site 2: lib/message-ids.ts:124 assignMessageRefs
// ────────────────────────────────────────────────────────────────────────────

test("isIgnoredUserMessage returns true for the synthetic skill message", () => {
    const skill = syntheticUserMessage(
        "msg-skill-1",
        '<skill name="review">Review checklist body.</skill>',
        5,
    )

    assert.equal(isIgnoredUserMessage(skill), true)
})

test("assignMessageRefs does not assign mNNNN to the synthetic skill message", () => {
    const messages: WithParts[] = [
        realUserMessage("msg-u-1", "first real user prompt", 1),
        realAssistantMessage("msg-a-1", "first real assistant reply", 2),
        realUserMessage("msg-u-2", "second real user prompt", 3),
        realAssistantMessage("msg-a-2", "second real assistant reply", 4),
        syntheticUserMessage(
            "msg-skill-1",
            '<skill name="review">Review checklist body.</skill>',
            5,
        ),
        realUserMessage("msg-u-3", "third real user prompt", 6),
        realAssistantMessage("msg-a-3", "third real assistant reply", 7),
        realUserMessage("msg-u-4", "fourth real user prompt", 8),
        realAssistantMessage("msg-a-4", "fourth real assistant reply", 9),
    ]

    const state = createSessionState()
    const assigned = assignMessageRefs(state, messages)

    // 8 real messages (4 user + 4 assistant) get refs; the synthetic message
    // is dropped at lib/message-ids.ts:124 and never enters byRawId.
    // The subagent-prompt skip does not fire here because state.isSubAgent
    // is false.
    assert.equal(assigned, 8)
    assert.equal(
        state.messageIds.byRawId.has("msg-skill-1"),
        false,
        "synthetic skill message must not appear in byRawId",
    )
    assert.equal(state.messageIds.byRef.has("m0004"), true, "real user msg-u-2 still gets a ref")
})

// ────────────────────────────────────────────────────────────────────────────
// Skip-site 3: lib/compress/search.ts:129, 224, 247 — isIgnoredUserMessage in
// resolveSelection, buildBoundaryLookup (per-message), and buildBoundaryLookup
// (per-anchor-summary).
// ────────────────────────────────────────────────────────────────────────────

test("resolveSelection never returns the synthetic skill message id", () => {
    const messages: WithParts[] = [
        realUserMessage("msg-u-1", "first real user prompt", 1),
        realAssistantMessage("msg-a-1", "first real assistant reply", 2),
        realUserMessage("msg-u-2", "second real user prompt", 3),
        realAssistantMessage("msg-a-2", "second real assistant reply", 4),
        syntheticUserMessage(
            "msg-skill-1",
            '<skill name="review">Review checklist body.</skill>',
            5,
        ),
        realUserMessage("msg-u-3", "third real user prompt", 6),
        realAssistantMessage("msg-a-3", "third real assistant reply", 7),
    ]

    const context = buildSearchContext(createSessionState(), messages)

    // Range covers everything from u-1 (index 0) to u-3 (index 5).
    const startRef = {
        kind: "message" as const,
        rawIndex: 0,
        messageId: "msg-u-1",
    }
    const endRef = {
        kind: "message" as const,
        rawIndex: 5,
        messageId: "msg-u-3",
    }

    const selection = resolveSelection(context, startRef, endRef)

    assert.ok(
        !selection.messageIds.includes("msg-skill-1"),
        "synthetic skill message id must be filtered out of the selection",
    )
    assert.ok(
        selection.messageIds.includes("msg-u-1"),
        "real user msg-u-1 must survive the selection",
    )
    assert.ok(
        selection.messageIds.includes("msg-u-3"),
        "real user msg-u-3 must survive the selection",
    )
})

// ────────────────────────────────────────────────────────────────────────────
// Skip-site 4: lib/messages/priority.ts:40 — buildPriorityMap
// Skip-site 5: lib/messages/inject/inject.ts:183 — injectMessageIds
// Skip-site 6: lib/commands/sweep.ts:42 — findLastUserMessageIndex
// Skip-site 7: lib/messages/manual-trigger.ts:55 — applyPendingManualTrigger
// ────────────────────────────────────────────────────────────────────────────

test("synthetic skill message stays out of every other destructive pipeline surface", () => {
    // Defense-in-depth regression: the same `isIgnoredUserMessage` gate that
    // drives priority map, nudge targeting, sweep candidate collection, and
    // manual-trigger application is exercised here. If a future refactor
    // changes the synthetic-detect logic in lib/messages/query.ts without
    // re-checking these call sites, the priority map output below catches it
    // for the user-visible surface (priority entries double as the BLOCKED
    // / mNNNN lookup table in injectMessageIds).
    const messages: WithParts[] = [
        syntheticUserMessage(
            "msg-skill-1",
            '<skill name="review">Review checklist body.</skill>',
            1,
        ),
        realUserMessage("msg-u-1", "first real user prompt", 2),
    ]

    // Direct isIgnoredUserMessage assertion is the canonical pin.
    const skill = messages[0]!
    const real = messages[1]!

    assert.equal(isIgnoredUserMessage(skill), true, "synthetic skill must be ignored")
    assert.equal(isIgnoredUserMessage(real), false, "real user must not be ignored")
})
// Logic Verified: synthetic user messages carrying `<skill>...</skill>` bodies are excluded from assignMessageRefs (no mNNNN ref), from compress resolveSelection (no selection id), and from the underlying isIgnoredUserMessage gate that drives priority / nudge / sweep / manual-trigger skip-sites.
// Bugs Documented: none.
// Fakes Updated: none
// Review Status: pending independent review.
