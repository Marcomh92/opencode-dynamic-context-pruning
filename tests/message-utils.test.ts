import assert from "node:assert/strict"
import test from "node:test"
import { isIgnoredUserMessage } from "../lib/messages/query"
import type { WithParts } from "../lib/state"

function buildMessage(role: "user" | "assistant", parts: WithParts["parts"]): WithParts {
    const sessionID = "ses_message_utils"

    const info =
        role === "user"
            ? {
                  id: `msg-${role}`,
                  role,
                  sessionID,
                  agent: "assistant",
                  model: {
                      providerID: "anthropic",
                      modelID: "claude-test",
                  },
                  time: { created: 1 },
              }
            : {
                  id: `msg-${role}`,
                  role,
                  sessionID,
                  agent: "assistant",
                  time: { created: 1 },
              }

    return {
        info: info as WithParts["info"],
        parts,
    }
}

test("isIgnoredUserMessage only ignores user messages", () => {
    const ignoredUserMessage = buildMessage("user", [])
    const assistantMessage = buildMessage("assistant", [])

    assert.equal(isIgnoredUserMessage(ignoredUserMessage), true)
    assert.equal(isIgnoredUserMessage(assistantMessage), false)
})

test("isIgnoredUserMessage treats synthetic text as ignored", () => {
    const message = buildMessage("user", [
        {
            id: "part-synthetic",
            sessionID: "ses_message_utils",
            messageID: "msg-user",
            type: "text" as const,
            text: "synthetic injected context",
            synthetic: true,
        },
    ])

    assert.equal(isIgnoredUserMessage(message), true)
})

test("isIgnoredUserMessage returns false for real user text with synthetic:false", () => {
    const message = buildMessage("user", [
        {
            id: "part-real-explicit",
            sessionID: "ses_message_utils",
            messageID: "msg-user",
            type: "text" as const,
            text: "hello there",
            synthetic: false,
        },
    ])

    assert.equal(isIgnoredUserMessage(message), false)
})

test("isIgnoredUserMessage returns false when synthetic is absent on real user text", () => {
    const message = buildMessage("user", [
        {
            id: "part-real-omitted",
            sessionID: "ses_message_utils",
            messageID: "msg-user",
            type: "text" as const,
            text: "hello there",
        },
    ])

    assert.equal(isIgnoredUserMessage(message), false)
})

test("isIgnoredUserMessage still ignores text with ignored:true (regression guard)", () => {
    const message = buildMessage("user", [
        {
            id: "part-ignored-only",
            sessionID: "ses_message_utils",
            messageID: "msg-user",
            type: "text" as const,
            text: "ignored text",
            ignored: true,
        },
    ])

    assert.equal(isIgnoredUserMessage(message), true)
})

test("isIgnoredUserMessage ignores text when both ignored:true and synthetic:true", () => {
    const message = buildMessage("user", [
        {
            id: "part-both-flags",
            sessionID: "ses_message_utils",
            messageID: "msg-user",
            type: "text" as const,
            text: "double-flagged",
            ignored: true,
            synthetic: true,
        },
    ])

    assert.equal(isIgnoredUserMessage(message), true)
})

test("isIgnoredUserMessage returns false when one text part is non-synthetic", () => {
    const message = buildMessage("user", [
        {
            id: "part-real",
            sessionID: "ses_message_utils",
            messageID: "msg-user",
            type: "text" as const,
            text: "real user text",
            synthetic: false,
        },
        {
            id: "part-synthetic",
            sessionID: "ses_message_utils",
            messageID: "msg-user",
            type: "text" as const,
            text: "synthetic follow-up",
            synthetic: true,
        },
    ])

    assert.equal(isIgnoredUserMessage(message), false)
})

test("isIgnoredUserMessage returns false when a non-text part is present alongside synthetic text", () => {
    const message = buildMessage("user", [
        {
            id: "part-synthetic",
            sessionID: "ses_message_utils",
            messageID: "msg-user",
            type: "text" as const,
            text: "synthetic context",
            synthetic: true,
        },
        {
            id: "part-step-start",
            sessionID: "ses_message_utils",
            messageID: "msg-user",
            type: "step-start" as const,
        },
    ])

    assert.equal(isIgnoredUserMessage(message), false)
})

test("isIgnoredUserMessage ignores multiple synthetic text parts", () => {
    const message = buildMessage("user", [
        {
            id: "part-synthetic-1",
            sessionID: "ses_message_utils",
            messageID: "msg-user",
            type: "text" as const,
            text: "synthetic chunk one",
            synthetic: true,
        },
        {
            id: "part-synthetic-2",
            sessionID: "ses_message_utils",
            messageID: "msg-user",
            type: "text" as const,
            text: "synthetic chunk two",
            synthetic: true,
        },
    ])

    assert.equal(isIgnoredUserMessage(message), true)
})

// Logic Verified: isIgnoredUserMessage ignores user messages whose text parts all carry `ignored: true` OR `synthetic: true` (assistant messages are never ignored; mixed non-text parts or any non-ignored non-synthetic text part disqualifies the message).
// Bugs Documented: BUG-094 (synthetic user messages with `part.synthetic: true` are now excluded from `isProtectedUserMessage`).
// Fakes Updated: none
// Review Status: pending independent review.
