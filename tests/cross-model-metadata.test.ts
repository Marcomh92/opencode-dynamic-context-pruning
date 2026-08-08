import assert from "node:assert/strict"
import test from "node:test"
import { stripStaleMetadata } from "../lib/messages/reasoning-strip"
import type { WithParts } from "../lib/state"

// BUG-043 — stripStaleMetadata drops caller metadata on cross-model switches.
//
// Contract: a third-party tool (e.g. `task`) that records caller identity on
// `part.metadata` (the legacy surface) must see that identity survive across a
// model/provider switch in the same session. The current implementation
// unconditionally removes `part.metadata` for text/tool/reasoning parts whose
// assistant message differs from the latest user message's model. The fix
// preserves caller identity and only strips stale, model-internal fields.
//
// These tests drive stripStaleMetadata directly so the contract is independent
// of the chat-transform wiring. Each case asserts OBSERVABLE behavior — the
// presence of caller metadata on the resulting part — not the order of
// internal mutations.

const SESSION = "ses_cross_model_meta"

function userMessage(modelID: string, providerID: string, id = "u-last"): WithParts {
    return {
        info: {
            id,
            role: "user",
            sessionID: SESSION,
            agent: "assistant",
            model: { providerID, modelID },
            time: { created: 1 },
        } as any,
        parts: [{ type: "text", text: "user prompt" } as any],
    }
}

function assistantWithTool(
    toolName: string,
    callID: string,
    metadata: Record<string, unknown>,
    modelID: string,
    providerID: string,
    id = "a-other",
): WithParts {
    return {
        info: {
            id,
            role: "assistant",
            sessionID: SESSION,
            agent: "assistant",
            modelID,
            providerID,
            time: { created: 2 },
        } as any,
        parts: [
            {
                type: "tool",
                tool: toolName,
                callID,
                metadata,
                state: { status: "completed", input: {}, output: "ok" },
            } as any,
        ],
    }
}

function assistantWithText(
    text: string,
    metadata: Record<string, unknown> | undefined,
    modelID: string,
    providerID: string,
    id = "a-text",
): WithParts {
    const parts: any[] = [{ type: "text", text }]
    if (metadata) parts[0].metadata = metadata
    return {
        info: {
            id,
            role: "assistant",
            sessionID: SESSION,
            agent: "assistant",
            modelID,
            providerID,
            time: { created: 2 },
        } as any,
        parts,
    }
}

test("BUG-043 #cross-model-switch preserves caller identity on tool part metadata", () => {
    // User message is on model m1/p1. Assistant message is on m2/p2.
    // The tool part carries caller identity — what the `task` tool writes:
    //   metadata.sessionId = the subagent session id
    //   metadata.caller     = the parent session id
    // stripStaleMetadata must preserve that identity.
    const messages: WithParts[] = [
        userMessage("m1", "p1"),
        assistantWithTool(
            "task",
            "call-task-1",
            { sessionId: "task-session-abc", caller: "parent-session-xyz" },
            "m2",
            "p2",
        ),
    ]

    stripStaleMetadata(messages)

    const toolPart = messages[1].parts[0] as any
    assert.ok(toolPart.metadata, "caller metadata must survive cross-model switch")
    assert.equal(toolPart.metadata.sessionId, "task-session-abc", "task sessionId preserved")
    assert.equal(toolPart.metadata.caller, "parent-session-xyz", "parent caller preserved")
})

test("BUG-043 #cross-model-switch preserves caller on text part metadata", () => {
    // Text parts carry the same `part.metadata` surface (see lib/logger.ts:188).
    // A model switch must not erase caller attribution that a tool attaches
    // to a text part.
    const messages: WithParts[] = [
        userMessage("m1", "p1"),
        assistantWithText(
            "summary line",
            { caller: "parent-session-xyz", traceId: "trace-7" },
            "m2",
            "p2",
        ),
    ]

    stripStaleMetadata(messages)

    const textPart = messages[1].parts[0] as any
    assert.ok(textPart.metadata, "text part caller metadata must survive cross-model switch")
    assert.equal(textPart.metadata.caller, "parent-session-xyz")
    assert.equal(textPart.metadata.traceId, "trace-7")
})

test("BUG-043 #cross-model-switch caller survives when part also carries model-internal fields", () => {
    // Mixed payload: caller identity co-exists with model/provider fields the
    // fix may legitimately strip (e.g. an internal `modelVersion` snapshot).
    // The contract is "caller identity is preserved" — model-internal noise
    // may be removed, but `metadata.caller` / `metadata.sessionId` survive.
    const messages: WithParts[] = [
        userMessage("m1", "p1"),
        assistantWithTool(
            "task",
            "call-task-1",
            {
                caller: "parent-session-xyz",
                sessionId: "task-session-abc",
                modelVersion: "internal-snapshot-should-go",
                requestId: "internal-snapshot-should-go",
            },
            "m2",
            "p2",
        ),
    ]

    stripStaleMetadata(messages)

    const toolPart = messages[1].parts[0] as any
    assert.ok(toolPart.metadata, "metadata surface must survive")
    assert.equal(toolPart.metadata.caller, "parent-session-xyz", "caller survives")
    assert.equal(toolPart.metadata.sessionId, "task-session-abc", "sessionId survives")
})

// Logic Verified: stripStaleMetadata preserves caller identity (sessionId /
//                  caller) on text and tool parts across a model switch while
//                  still allowing model-internal metadata to be dropped.
// Bugs Documented: BUG-043-stale-meta-strip.md
// Fakes Updated:  none (drives production stripStaleMetadata directly)
// Review Status:  pending independent review.
// Logic Verified: cross-model switch preserves caller identity on tool/text part metadata even when model-internal fields are present.
// Bugs Documented: BUG-043.
// Fakes Updated: none (drives production stripStaleMetadata directly).
// Review Status: pending independent review.
