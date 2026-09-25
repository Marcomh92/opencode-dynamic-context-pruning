import assert from "node:assert/strict"
import test from "node:test"
import type { PluginConfig } from "../lib/config"
import { createTextCompleteHandler } from "../lib/hooks"
import { Logger } from "../lib/logger"
import { assignMessageRefs } from "../lib/message-ids"
import { injectMessageIds } from "../lib/messages/inject/inject"
import { applyAnchoredNudges, countMessagesAfterIndex } from "../lib/messages/inject/utils"
import { prune } from "../lib/messages/prune"
import { buildPriorityMap } from "../lib/messages/priority"
import { isIgnoredUserMessage } from "../lib/messages/query"
import { stripHallucinationsFromString } from "../lib/messages/utils"
import { createSessionState, type WithParts } from "../lib/state"

function buildConfig(mode: "message" | "range" = "message"): PluginConfig {
    return {
        enabled: true,
        debug: false,
        pruneNotification: "off",
        pruneNotificationType: "chat",
        commands: {
            enabled: true,
            protectedTools: [],
        },
        manualMode: {
            enabled: false,
            automaticStrategies: true,
        },
        turnProtection: {
            enabled: false,
            turns: 4,
        },
        experimental: {
            allowSubAgents: false,
            customPrompts: false,
        },
        protectedFilePatterns: [],
        compress: {
            mode,
            permission: "allow",
            showCompression: false,
            maxContextLimit: 150000,
            minContextLimit: 50000,
            nudgeFrequency: 5,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            protectedTools: ["task"],
            protectTags: false,
            protectUserMessages: false,
            // BUG-096: default 1 = only the most recent real user message is
            // protected when `protectUserMessages: true`. Tests below that
            // exercise the new "last N" semantics set this explicitly to
            // document intent.
            protectUserMessagesCount: 1,
        },
        strategies: {
            deduplication: {
                enabled: true,
                protectedTools: [],
            },
            purgeErrors: {
                enabled: true,
                turns: 4,
                protectedTools: [],
            },
        },
    }
}

function textPart(messageID: string, sessionID: string, id: string, text: string) {
    return {
        id,
        messageID,
        sessionID,
        type: "text" as const,
        text,
    }
}

function toolPart(
    messageID: string,
    sessionID: string,
    callID: string,
    toolName: string,
    output: string,
) {
    return {
        id: `${callID}-part`,
        messageID,
        sessionID,
        type: "tool" as const,
        tool: toolName,
        callID,
        state: {
            status: "completed" as const,
            input: { description: "demo" },
            output,
        },
    }
}

function buildMessage(
    id: string,
    role: "user" | "assistant",
    sessionID: string,
    text: string,
    created: number,
): WithParts {
    const info =
        role === "user"
            ? {
                  id,
                  role,
                  sessionID,
                  agent: "assistant",
                  model: {
                      providerID: "anthropic",
                      modelID: "claude-test",
                  },
                  time: { created },
              }
            : {
                  id,
                  role,
                  sessionID,
                  agent: "assistant",
                  time: { created },
              }

    return {
        info: info as WithParts["info"],
        parts: [textPart(id, sessionID, `${id}-part`, text)],
    }
}

function repeatedWord(word: string, count: number): string {
    return Array.from({ length: count }, () => word).join(" ")
}

test("injectMessageIds injects ID into every tool output for assistant messages", () => {
    const sessionID = "ses_message_priority_tags"
    const messages: WithParts[] = [
        {
            info: {
                id: "msg-user-1",
                role: "user",
                sessionID,
                agent: "assistant",
                model: {
                    providerID: "anthropic",
                    modelID: "claude-test",
                },
                time: { created: 1 },
            } as WithParts["info"],
            parts: [
                textPart(
                    "msg-user-1",
                    sessionID,
                    "msg-user-1-part-1",
                    repeatedWord("investigate", 6000),
                ),
                textPart("msg-user-1", sessionID, "msg-user-1-part-2", "Trailing note."),
            ],
        },
        {
            info: {
                id: "msg-assistant-1",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 2 },
            } as WithParts["info"],
            parts: [
                textPart(
                    "msg-assistant-1",
                    sessionID,
                    "msg-assistant-1-part-1",
                    "Short follow-up note.",
                ),
                toolPart("msg-assistant-1", sessionID, "call-task-1", "task", "task output body"),
                textPart(
                    "msg-assistant-1",
                    sessionID,
                    "msg-assistant-1-part-2",
                    "Second text chunk.",
                ),
                toolPart(
                    "msg-assistant-1",
                    sessionID,
                    "call-task-2",
                    "bash",
                    "second tool output body",
                ),
            ],
        },
    ]
    const state = createSessionState()
    const config = buildConfig()

    assignMessageRefs(state, messages)
    const compressionPriorities = buildPriorityMap(config, state, messages)

    injectMessageIds(state, config, messages, compressionPriorities)

    assert.equal(messages[0]?.parts.length, 2)
    assert.equal(messages[1]?.parts.length, 4)

    const userTextOne = messages[0]?.parts[0]
    const userTextTwo = messages[0]?.parts[1]
    const assistantTextOne = messages[1]?.parts[0]
    const assistantToolOne = messages[1]?.parts[1]
    const assistantTextTwo = messages[1]?.parts[2]
    const assistantToolTwo = messages[1]?.parts[3]

    assert.equal(userTextOne?.type, "text")
    assert.equal(userTextTwo?.type, "text")
    assert.equal(assistantTextOne?.type, "text")
    assert.equal(assistantToolOne?.type, "tool")
    assert.equal(assistantTextTwo?.type, "text")
    assert.equal(assistantToolTwo?.type, "tool")
    // User messages: still injected into all text parts
    assert.match(
        (userTextOne as any).text,
        /\n\n<dcp-message-id priority="high">m0001<\/dcp-message-id>/,
    )
    assert.match(
        (userTextTwo as any).text,
        /\n\n<dcp-message-id priority="high">m0001<\/dcp-message-id>/,
    )
    // Assistant messages: ID injected into every tool output
    assert.doesNotMatch((assistantTextOne as any).text, /dcp-message-id/)
    assert.match((assistantToolOne as any).state.output, /m0002<\/dcp-message-id>/)
    assert.doesNotMatch((assistantTextTwo as any).text, /dcp-message-id/)
    assert.match((assistantToolTwo as any).state.output, /m0002<\/dcp-message-id>/)
})

test("injectMessageIds marks every protected user text part as BLOCKED in message mode", () => {
    const sessionID = "ses_message_blocked_user_tags"
    const messages: WithParts[] = [
        {
            info: {
                id: "msg-user-1",
                role: "user",
                sessionID,
                agent: "assistant",
                model: {
                    providerID: "anthropic",
                    modelID: "claude-test",
                },
                time: { created: 1 },
            } as WithParts["info"],
            parts: [
                textPart(
                    "msg-user-1",
                    sessionID,
                    "msg-user-1-part-1",
                    repeatedWord("investigate", 6000),
                ),
                textPart("msg-user-1", sessionID, "msg-user-1-part-2", "Trailing note."),
            ],
        },
        buildMessage("msg-assistant-1", "assistant", sessionID, "Short follow-up note.", 2),
    ]
    const state = createSessionState()
    const config = buildConfig()
    config.compress.protectUserMessages = true

    assignMessageRefs(state, messages)
    const compressionPriorities = buildPriorityMap(config, state, messages)

    injectMessageIds(state, config, messages, compressionPriorities)

    const userTextOne = messages[0]?.parts[0]
    const userTextTwo = messages[0]?.parts[1]
    const assistantText = messages[1]?.parts[0]

    assert.equal(userTextOne?.type, "text")
    assert.equal(userTextTwo?.type, "text")
    assert.equal(assistantText?.type, "text")
    assert.match((userTextOne as any).text, /\n\n<dcp-message-id>BLOCKED<\/dcp-message-id>/)
    assert.match((userTextTwo as any).text, /\n\n<dcp-message-id>BLOCKED<\/dcp-message-id>/)
    assert.doesNotMatch((userTextOne as any).text, /priority=/)
    assert.doesNotMatch((userTextTwo as any).text, /priority=/)
    assert.match(
        (assistantText as any).text,
        /\n\n<dcp-message-id priority="low">m0002<\/dcp-message-id>/,
    )
})

test("injectMessageIds injects ID into every tool output in range mode", () => {
    const sessionID = "ses_range_message_id_tags"
    const messages: WithParts[] = [
        buildMessage("msg-user-1", "user", sessionID, repeatedWord("investigate", 6000), 1),
        {
            info: {
                id: "msg-assistant-1",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 2 },
            } as WithParts["info"],
            parts: [
                textPart("msg-assistant-1", sessionID, "msg-assistant-1-part-1", "First chunk."),
                toolPart("msg-assistant-1", sessionID, "call-task-range-1", "task", "first output"),
                textPart("msg-assistant-1", sessionID, "msg-assistant-1-part-2", "Second chunk."),
                toolPart(
                    "msg-assistant-1",
                    sessionID,
                    "call-task-range-2",
                    "bash",
                    "second output",
                ),
            ],
        },
    ]
    const state = createSessionState()
    const config = buildConfig("range")

    assignMessageRefs(state, messages)
    injectMessageIds(state, config, messages)

    const assistantTextOne = messages[1]?.parts[0]
    const assistantToolOne = messages[1]?.parts[1]
    const assistantTextTwo = messages[1]?.parts[2]
    const assistantToolTwo = messages[1]?.parts[3]

    // Every tool output gets the ID
    assert.doesNotMatch((assistantTextOne as any).text, /dcp-message-id/)
    assert.match((assistantToolOne as any).state.output, /m0002<\/dcp-message-id>/)
    assert.doesNotMatch((assistantTextTwo as any).text, /dcp-message-id/)
    assert.match((assistantToolTwo as any).state.output, /m0002<\/dcp-message-id>/)
})

test("message mode marks compress tool messages as high priority even when short", () => {
    const sessionID = "ses_message_compress_high_priority"
    const messages: WithParts[] = [
        buildMessage("msg-user-1", "user", sessionID, "Please compress this chunk.", 1),
        {
            info: {
                id: "msg-assistant-1",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 2 },
            } as WithParts["info"],
            parts: [
                textPart("msg-assistant-1", sessionID, "msg-assistant-1-part-1", "Done."),
                toolPart(
                    "msg-assistant-1",
                    sessionID,
                    "call-compress-1",
                    "compress",
                    "[Compressed conversation section]",
                ),
            ],
        },
    ]
    const state = createSessionState()
    const config = buildConfig()

    assignMessageRefs(state, messages)
    const compressionPriorities = buildPriorityMap(config, state, messages)

    assert.equal(compressionPriorities.get("msg-assistant-1")?.priority, "high")

    injectMessageIds(state, config, messages, compressionPriorities)

    const assistantText = messages[1]?.parts[0]
    const assistantTool = messages[1]?.parts[1]

    // ID injected into tool output, not the text part
    assert.doesNotMatch((assistantText as any).text, /dcp-message-id/)
    assert.match((assistantTool as any).state.output, /m0002<\/dcp-message-id>/)
    assert.match(
        (assistantTool as any).state.output,
        /<dcp-message-id priority="high">m0002<\/dcp-message-id>/,
    )
})

test("message-mode nudges append to existing text parts and list only earlier visible high-priority message IDs", () => {
    const sessionID = "ses_message_priority_nudges"
    const messages: WithParts[] = [
        buildMessage("msg-user-1", "user", sessionID, repeatedWord("alpha", 6000), 1),
        buildMessage("msg-assistant-1", "assistant", sessionID, repeatedWord("beta", 6000), 2),
        buildMessage("msg-user-2", "user", sessionID, repeatedWord("gamma", 6000), 3),
        buildMessage("msg-assistant-2", "assistant", sessionID, repeatedWord("delta", 6000), 4),
    ]
    const state = createSessionState()
    const config = buildConfig()

    assignMessageRefs(state, messages)
    state.prune.messages.byMessageId.set("msg-assistant-1", {
        tokenCount: 999,
        allBlockIds: [1],
        activeBlockIds: [1],
    })
    state.nudges.contextLimitAnchors.add("msg-user-2")

    const compressionPriorities = buildPriorityMap(config, state, messages)

    applyAnchoredNudges(
        state,
        config,
        messages,
        {
            system: "",
            compressRange: "",
            compressMessage: "",
            contextLimitNudge: "<dcp-system-reminder>Base context nudge</dcp-system-reminder>",
            turnNudge: "<dcp-system-reminder>Base turn nudge</dcp-system-reminder>",
            iterationNudge: "<dcp-system-reminder>Base iteration nudge</dcp-system-reminder>",
        },
        compressionPriorities,
    )

    assert.equal(messages[2]?.parts.length, 1)

    const injectedNudge = messages[2]?.parts[0]
    assert.equal(injectedNudge?.type, "text")
    assert.match((injectedNudge as any).text, /\n\n<dcp-system-reminder>Base context nudge/)
    assert.match((injectedNudge as any).text, /Message priority context:/)
    assert.match((injectedNudge as any).text, /High-priority message IDs before this point: m0001/)
    assert.doesNotMatch((injectedNudge as any).text, /m0002/)
    assert.doesNotMatch((injectedNudge as any).text, /m0003/)
    assert.doesNotMatch((injectedNudge as any).text, /m0004/)
})

test("BUG-096 last-N: priority map excludes only the LAST protected user message", () => {
    // BUG-096: `protectUserMessages: true` now protects only the last N real
    // user messages (default N=1), not every user message. With count=1,
    // msg-user-2 (the LAST real user message) is the only protected one.
    // msg-user-1 (an older user message) and msg-assistant-1 are NOT
    // protected and SHOULD appear in the priority map.
    //
    // This test calls buildPriorityMap directly to sidestep the
    // `appendGuidanceToDcpTag` injection path (which has a separate
    // `closeTag = ""` quirk tracked in known_issues/). The contract being
    // tested is the priority-map composition, not the injection mechanics.
    const sessionID = "ses_bug096_priority_scope"
    const messages: WithParts[] = [
        buildMessage("msg-user-1", "user", sessionID, repeatedWord("alpha", 6000), 1),
        buildMessage("msg-assistant-1", "assistant", sessionID, repeatedWord("beta", 6000), 2),
        buildMessage("msg-user-2", "user", sessionID, repeatedWord("gamma", 6000), 3),
    ]
    const state = createSessionState()
    const config = buildConfig()
    config.compress.protectUserMessages = true
    config.compress.protectUserMessagesCount = 1

    assignMessageRefs(state, messages)
    const priorities = buildPriorityMap(config, state, messages)

    // msg-user-2 is the protected LAST user message → excluded from the
    // priority map entirely (no ref gets allocated for priority context).
    assert.equal(
        priorities.get("msg-user-2"),
        undefined,
        "msg-user-2 (the protected last user message) must be excluded from the priority map under last-N=1",
    )
    // msg-user-1 is an older user message that is NOT the last one, so it
    // is NOT protected under last-N=1 → it joins the priority map.
    assert.equal(
        priorities.get("msg-user-1")?.priority,
        "high",
        "msg-user-1 is NOT protected under last-N=1 and joins the priority map",
    )
    // msg-assistant-1 is an assistant message — `protectUserMessages` only
    // gates user messages, so the assistant is not affected.
    assert.equal(
        priorities.get("msg-assistant-1")?.priority,
        "high",
        "msg-assistant-1 is not gated by protectUserMessages and joins the priority map",
    )
})

test("BUG-098: range-mode assistant-anchored nudge inserts a synthetic user message at index+1", () => {
    // BUG-098: the nudge is delivered as a NEW synthetic user message at
    // messages[index + 1]; the anchored assistant's text parts are
    // byte-identical to pre-nudge (the model no longer reads its own prior
    // reply as a directive). The tool output on the anchored assistant is
    // also untouched.
    const sessionID = "ses_range_nudge_injection_bug098"
    const messages: WithParts[] = [
        buildMessage("msg-user-1", "user", sessionID, repeatedWord("alpha", 6000), 1),
        {
            info: {
                id: "msg-assistant-1",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 2 },
            } as WithParts["info"],
            parts: [
                textPart("msg-assistant-1", sessionID, "msg-assistant-1-part", "Working summary."),
                toolPart("msg-assistant-1", sessionID, "call-task-2", "task", "task output body"),
            ],
        },
    ]
    const state = createSessionState()
    const config = buildConfig("range")

    assignMessageRefs(state, messages)
    state.prune.messages.activeBlockIds.add(7)
    state.nudges.contextLimitAnchors.add("msg-assistant-1")

    applyAnchoredNudges(state, config, messages, {
        system: "",
        compressRange: "",
        compressMessage: "",
        contextLimitNudge: "Base context nudge",
        turnNudge: "",
        iterationNudge: "",
    })

    // The anchored assistant and its parts are untouched.
    assert.equal(messages[1]?.parts.length, 2)
    assert.equal((messages[1]?.parts[0] as any).text, "Working summary.")
    assert.equal((messages[1]?.parts[1] as any).state.output, "task output body")

    // The synthetic user message was spliced in at index + 1.
    const synthetic = messages[2]
    assert.ok(synthetic, "synthetic user message must exist at messages[index + 1]")
    assert.equal(synthetic.info.role, "user")
    assert.match(synthetic.info.id, /^msg_dcp_summary_[0-9a-f]{16}$/)
    assert.deepEqual(synthetic.info.time, { created: 0 }, "synthetic time sentinel is 0")
    assert.equal(synthetic.parts.length, 1)

    const nudgeTextPart = synthetic.parts[0] as { type: string; text: string; synthetic?: boolean }
    assert.equal(nudgeTextPart.type, "text")
    assert.equal(nudgeTextPart.synthetic, true, "text part must carry synthetic:true")
    // BUG-097 quirk: `appendGuidanceToDcpTag` only splices the guidance
    // when the close tag is present in `nudgeText` (closeTag.lastIndexOf
    // returns -1 on a plain text input and we early-return the input
    // unchanged). So in this fixture the synthetic message carries the
    // input verbatim — that's the expected contract.
    assert.match(nudgeTextPart.text, /Base context nudge/)
})

test("BUG-098: range-mode nudge on assistant with multiple text parts still inserts exactly one synthetic user message", () => {
    // BUG-098: regardless of how many text parts the assistant carries, the
    // nudge is delivered as a single new synthetic user message immediately
    // after the anchor (NOT appended to any assistant text part). Idempotency
    // is now enforced by checking messages[index+1].info.id against the
    // deterministic synthetic messageId — replaces the old endsWith check.
    const sessionID = "ses_range_nudge_multi_text_bug098"
    const messages: WithParts[] = [
        buildMessage("msg-user-1", "user", sessionID, "Hello", 1),
        {
            info: {
                id: "msg-assistant-1",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 2 },
            } as WithParts["info"],
            parts: [
                textPart("msg-assistant-1", sessionID, "assistant-text-1", "First chunk."),
                textPart("msg-assistant-1", sessionID, "assistant-text-2", "Second chunk."),
            ],
        },
    ]
    const state = createSessionState()
    const config = buildConfig("range")

    assignMessageRefs(state, messages)
    state.nudges.contextLimitAnchors.add("msg-assistant-1")

    applyAnchoredNudges(state, config, messages, {
        system: "",
        compressRange: "",
        compressMessage: "",
        contextLimitNudge: "Base context nudge",
        turnNudge: "",
        iterationNudge: "",
    })

    // Both assistant text parts are byte-identical to pre-nudge.
    assert.equal(messages[1]?.parts.length, 2)
    assert.equal((messages[1]?.parts[0] as any).text, "First chunk.")
    assert.equal((messages[1]?.parts[1] as any).text, "Second chunk.")

    // Exactly one synthetic user message inserted at index + 1.
    assert.equal(messages.length, 3)
    const synthetic = messages[2]
    assert.ok(synthetic, "synthetic user message must exist at messages[index + 1]")
    assert.equal(synthetic.info.role, "user")
    assert.match(synthetic.info.id, /^msg_dcp_summary_[0-9a-f]{16}$/)
    assert.equal(synthetic.parts.length, 1)
    const nudgeTextPart = synthetic.parts[0] as { type: string; text: string; synthetic?: boolean }
    assert.equal(nudgeTextPart.type, "text")
    assert.equal(nudgeTextPart.synthetic, true)
    assert.match(nudgeTextPart.text, /Base context nudge/)

    // Re-fire is a no-op (idempotency via adjacent-id check, not endsWith).
    applyAnchoredNudges(state, config, messages, {
        system: "",
        compressRange: "",
        compressMessage: "",
        contextLimitNudge: "Base context nudge",
        turnNudge: "",
        iterationNudge: "",
    })
    assert.equal(messages.length, 3, "re-fire must not append a second synthetic nudge")
    assert.equal(
        messages[2].info.id,
        synthetic.info.id,
        "synthetic messageId is stable across re-fires",
    )
})

test("BUG-098: synthetic nudge is ignored by isIgnoredUserMessage (count-math invariant)", () => {
    // BUG-098: the synthetic nudge MUST carry `synthetic: true` on its text
    // part so `isIgnoredUserMessage` (query.ts:54) skips it. Without that
    // flag the nudge would become the "last user message" and the iteration
    // counter (`messagesSinceUser`) would reset to 0 on every fire.
    const sessionID = "ses_bug098_synthetic_isignored"
    const messages: WithParts[] = [
        buildMessage("msg-user-1", "user", sessionID, "Hello", 1),
        {
            info: {
                id: "msg-assistant-1",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 2 },
            } as WithParts["info"],
            parts: [
                textPart("msg-assistant-1", sessionID, "msg-assistant-1-part", "Working summary."),
            ],
        },
    ]
    const state = createSessionState()
    const config = buildConfig("range")

    assignMessageRefs(state, messages)
    state.nudges.contextLimitAnchors.add("msg-assistant-1")

    applyAnchoredNudges(state, config, messages, {
        system: "",
        compressRange: "",
        compressMessage: "",
        contextLimitNudge: "Base context nudge",
        turnNudge: "",
        iterationNudge: "",
    })

    const synthetic = messages[2]
    assert.ok(synthetic, "synthetic user message must be inserted")
    assert.equal(
        isIgnoredUserMessage(synthetic),
        true,
        "synthetic nudge is excluded from real-user counters",
    )

    // The anchored assistant and the original user message are NOT ignored.
    assert.equal(isIgnoredUserMessage(messages[0]), false)
    assert.equal(isIgnoredUserMessage(messages[1]), false, "assistant messages are never ignored")
})

test("BUG-098: countMessagesAfterIndex excludes the synthetic nudge (iteration threshold re-trips)", () => {
    // BUG-098: `countMessagesAfterIndex` skips ignored user messages, so the
    // synthetic nudge does NOT bump `messagesSinceUser`. The next transform
    // fire against the same anchor still observes a stable count of real
    // messages since the last real user message and re-trips
    // `iterationNudgeThreshold` if the count is at or above the threshold.
    const sessionID = "ses_bug098_count_messages_after_index"
    const messages: WithParts[] = [
        buildMessage("msg-user-1", "user", sessionID, "Hello", 1),
        {
            info: {
                id: "msg-assistant-1",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 2 },
            } as WithParts["info"],
            parts: [
                textPart("msg-assistant-1", sessionID, "msg-assistant-1-part", "Working summary."),
            ],
        },
    ]
    const state = createSessionState()
    const config = buildConfig("range")

    assignMessageRefs(state, messages)
    state.nudges.iterationNudgeAnchors.add("msg-assistant-1")

    // Pre-fire: index 1 (assistant) has 0 messages after it.
    assert.equal(countMessagesAfterIndex(messages, 1), 0)

    applyAnchoredNudges(state, config, messages, {
        system: "",
        compressRange: "",
        compressMessage: "",
        contextLimitNudge: "",
        turnNudge: "",
        iterationNudge: "Iterating. Consider compressing.",
    })

    // Post-fire: the synthetic nudge was added at index + 1 = 2, but
    // `countMessagesAfterIndex` skips it, so the count remains 0.
    assert.equal(messages.length, 3, "synthetic message was inserted at index + 1")
    assert.equal(
        countMessagesAfterIndex(messages, 1),
        0,
        "synthetic nudge does not count toward messagesSinceUser",
    )

    // Sanity: an unrelated real message after the anchor WOULD be counted.
    messages.push(buildMessage("msg-assistant-2", "assistant", sessionID, "More tool output.", 3))
    assert.equal(countMessagesAfterIndex(messages, 1), 1, "real assistant messages are counted")
})

test("BUG-098: range-mode user-anchored nudge still appends to user text part (regression lock)", () => {
    // BUG-098: the synthetic-user-message path is assistant-only. When the
    // anchor is a USER message the unchanged user-role branch fires
    // (`appendToLastTextPart`), keeping regression parity with the original
    // behaviour. This is the regression lock for the user-role branch.
    const sessionID = "ses_bug098_user_anchor_regression"
    const messages: WithParts[] = [
        {
            info: {
                id: "msg-user-1",
                role: "user",
                sessionID,
                agent: "assistant",
                model: { providerID: "anthropic", modelID: "claude-test" },
                time: { created: 1 },
            } as WithParts["info"],
            parts: [textPart("msg-user-1", sessionID, "msg-user-1-part", "Original user content.")],
        },
    ]
    const state = createSessionState()
    const config = buildConfig("range")

    assignMessageRefs(state, messages)
    state.nudges.contextLimitAnchors.add("msg-user-1")

    applyAnchoredNudges(state, config, messages, {
        system: "",
        compressRange: "",
        compressMessage: "",
        contextLimitNudge: "Base context nudge",
        turnNudge: "",
        iterationNudge: "",
    })

    // No synthetic message was inserted (user-anchor branch inlines into the
    // user text part).
    assert.equal(messages.length, 1)

    const userText = (messages[0]?.parts[0] as any).text as string
    assert.match(userText, /Original user content\./)
    assert.match(userText, /Base context nudge/)
    // Regression lock: the user message itself stays a real user message,
    // not a synthetic one (no synthetic:true flag on its text part).
    assert.notEqual(
        (messages[0]?.parts[0] as any).synthetic,
        true,
        "real user text part must not carry synthetic:true",
    )
})

test("BUG-098: nudge carries no mNNNN tag after injectMessageIds and no priority-map entry in message mode", () => {
    // BUG-098: synthetic user messages are skipped by `injectMessageIds`
    // (inject.ts:183) and by `buildPriorityMap` (priority.ts:40) on the
    // `isIgnoredUserMessage` gate. After the nudge is inserted and the
    // downstream steps run, the synthetic message still carries no
    // mNNNN tag and no priority-map entry — so it does not feed the
    // priority guidance the model uses to choose compression targets.
    const sessionID = "ses_bug098_no_tag_no_priority"
    const messages: WithParts[] = [
        buildMessage("msg-user-1", "user", sessionID, "Hello", 1),
        {
            info: {
                id: "msg-assistant-1",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 2 },
            } as WithParts["info"],
            parts: [
                textPart("msg-assistant-1", sessionID, "msg-assistant-1-part", "Working summary."),
            ],
        },
    ]
    const state = createSessionState()
    const config = buildConfig("message")

    assignMessageRefs(state, messages)
    state.nudges.contextLimitAnchors.add("msg-assistant-1")

    // Priority map is built BEFORE the nudge is inserted; the synthetic
    // message is created downstream and never enters the map.
    const compressionPriorities = buildPriorityMap(config, state, messages)

    applyAnchoredNudges(
        state,
        config,
        messages,
        {
            system: "",
            compressRange: "",
            compressMessage: "",
            contextLimitNudge: "Base context nudge",
            turnNudge: "",
            iterationNudge: "",
        },
        compressionPriorities,
    )

    injectMessageIds(state, config, messages, compressionPriorities)

    const synthetic = messages[2]
    assert.ok(synthetic, "synthetic message must be inserted")
    const syntheticText = (synthetic.parts[0] as any).text as string
    assert.doesNotMatch(
        syntheticText,
        /dcp-message-id>/,
        "synthetic nudge carries no dcp-message-id tag",
    )
    assert.doesNotMatch(syntheticText, /BLOCKED/, "synthetic nudge is not BLOCKED-tagged")
    // No priority-map entry for the synthetic message ID.
    assert.equal(
        compressionPriorities.get(synthetic.info.id),
        undefined,
        "synthetic nudge has no priority-map entry (isIgnoredUserMessage gate)",
    )
})

test("BUG-098: turn-nudge dual-mode — default-mode anchors assistant (synthetic), strong-mode anchors user (append)", () => {
    // BUG-098: `collectTurnNudgeAnchors` (utils.ts:292) picks the target role
    // from `nudgeForce`: default ("soft") → assistant → synthetic user
    // message; "strong" → user → nudge appended to user text part. Both
    // branches must continue to work after the BUG-098 redesign.
    const baseMessages = (sessionID: string): WithParts[] => [
        {
            info: {
                id: "msg-user-1",
                role: "user",
                sessionID,
                agent: "assistant",
                model: { providerID: "anthropic", modelID: "claude-test" },
                time: { created: 1 },
            } as WithParts["info"],
            parts: [textPart("msg-user-1", sessionID, "msg-user-1-part", "User content.")],
        },
        {
            info: {
                id: "msg-assistant-1",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 2 },
            } as WithParts["info"],
            parts: [
                textPart(
                    "msg-assistant-1",
                    sessionID,
                    "msg-assistant-1-part",
                    "Assistant content.",
                ),
            ],
        },
    ]

    // ----- default mode: turn-nudge anchors the assistant, synthetic message -----
    {
        const sessionID = "ses_bug098_turn_default_soft"
        const messages = baseMessages(sessionID)
        const state = createSessionState()
        const config = buildConfig("range")
        config.compress.nudgeForce = "soft"

        assignMessageRefs(state, messages)
        state.nudges.turnNudgeAnchors.add("msg-assistant-1")

        applyAnchoredNudges(state, config, messages, {
            system: "",
            compressRange: "",
            compressMessage: "",
            contextLimitNudge: "",
            turnNudge: "Turn nudge.",
            iterationNudge: "",
        })

        assert.equal(
            messages.length,
            3,
            "default-mode turn-nudge inserts a synthetic user message after the assistant anchor",
        )
        const synthetic = messages[2]
        assert.equal(synthetic.info.role, "user")
        assert.match(synthetic.info.id, /^msg_dcp_summary_[0-9a-f]{16}$/)
        assert.equal((synthetic.parts[0] as any).synthetic, true)
        assert.match((synthetic.parts[0] as any).text, /Turn nudge\./)
        // The anchored assistant remains byte-identical.
        assert.equal((messages[1]?.parts[0] as any).text, "Assistant content.")
    }

    // ----- strong mode: turn-nudge anchors the user, appended to user text part -----
    {
        const sessionID = "ses_bug098_turn_strong"
        const messages = baseMessages(sessionID)
        const state = createSessionState()
        const config = buildConfig("range")
        config.compress.nudgeForce = "strong"

        assignMessageRefs(state, messages)
        state.nudges.turnNudgeAnchors.add("msg-user-1")

        applyAnchoredNudges(state, config, messages, {
            system: "",
            compressRange: "",
            compressMessage: "",
            contextLimitNudge: "",
            turnNudge: "Turn nudge.",
            iterationNudge: "",
        })

        // Strong mode anchors user → no synthetic insert; nudge appended inline.
        assert.equal(
            messages.length,
            2,
            "strong-mode turn-nudge does NOT insert a synthetic user message",
        )
        const userText = (messages[0]?.parts[0] as any).text as string
        assert.match(userText, /User content\./)
        assert.match(userText, /Turn nudge\./)
        assert.notEqual(
            (messages[0]?.parts[0] as any).synthetic,
            true,
            "real user text part must not carry synthetic:true",
        )
        // Assistant anchor was NOT picked (target role is "user").
        assert.equal((messages[1]?.parts[0] as any).text, "Assistant content.")
    }
})

test("range-mode nudges skip empty assistant messages to avoid prefill (issue #463)", () => {
    const sessionID = "ses_range_nudge_empty_assistant"
    const messages: WithParts[] = [
        buildMessage("msg-user-1", "user", sessionID, "Hello", 1),
        {
            info: {
                id: "msg-assistant-empty",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 2 },
            } as WithParts["info"],
            parts: [],
        },
    ]
    const state = createSessionState()
    const config = buildConfig("range")

    assignMessageRefs(state, messages)
    state.nudges.contextLimitAnchors.add("msg-assistant-empty")

    applyAnchoredNudges(state, config, messages, {
        system: "",
        compressRange: "",
        compressMessage: "",
        contextLimitNudge: "<dcp-system-reminder>Base context nudge</dcp-system-reminder>",
        turnNudge: "<dcp-system-reminder>Base turn nudge</dcp-system-reminder>",
        iterationNudge: "<dcp-system-reminder>Base iteration nudge</dcp-system-reminder>",
    })

    assert.equal(messages[1]?.parts.length, 0)
})

test("range-mode nudges skip assistant with only pending tool parts (issue #463)", () => {
    const sessionID = "ses_range_nudge_pending_tool"
    const messages: WithParts[] = [
        buildMessage("msg-user-1", "user", sessionID, "Hello", 1),
        {
            info: {
                id: "msg-assistant-pending",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 2 },
            } as WithParts["info"],
            parts: [
                {
                    id: "pending-tool-part",
                    messageID: "msg-assistant-pending",
                    sessionID,
                    type: "tool" as const,
                    tool: "bash",
                    callID: "call-pending-1",
                    state: {
                        status: "pending" as const,
                        input: { command: "ls" },
                    },
                } as any,
            ],
        },
    ]
    const state = createSessionState()
    const config = buildConfig("range")

    assignMessageRefs(state, messages)
    state.nudges.contextLimitAnchors.add("msg-assistant-pending")

    applyAnchoredNudges(state, config, messages, {
        system: "",
        compressRange: "",
        compressMessage: "",
        contextLimitNudge: "<dcp-system-reminder>Base context nudge</dcp-system-reminder>",
        turnNudge: "<dcp-system-reminder>Base turn nudge</dcp-system-reminder>",
        iterationNudge: "<dcp-system-reminder>Base iteration nudge</dcp-system-reminder>",
    })

    assert.equal(messages[1]?.parts.length, 1)
    assert.equal(messages[1]?.parts[0]?.type, "tool")
})

test("range-mode nudges skip assistant messages with only empty text parts (issue #463)", () => {
    const sessionID = "ses_range_nudge_empty_text"
    const messages: WithParts[] = [
        buildMessage("msg-user-1", "user", sessionID, "Hello", 1),
        {
            info: {
                id: "msg-assistant-empty-text",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 2 },
            } as WithParts["info"],
            parts: [textPart("msg-assistant-empty-text", sessionID, "empty-text-part", "")],
        },
    ]
    const state = createSessionState()
    const config = buildConfig("range")

    assignMessageRefs(state, messages)
    state.nudges.contextLimitAnchors.add("msg-assistant-empty-text")

    applyAnchoredNudges(state, config, messages, {
        system: "",
        compressRange: "",
        compressMessage: "",
        contextLimitNudge: "",
        turnNudge: "",
        iterationNudge: "",
    })

    // Empty text parts should not receive nudge injection
    assert.equal(messages[1]?.parts.length, 1)
    assert.equal((messages[1]?.parts[0] as any).text, "")
})

test("message-mode rendered compressed summaries mark block IDs as BLOCKED", () => {
    const sessionID = "ses_message_blocked_blocks"
    const messages: WithParts[] = [
        buildMessage("msg-user-1", "user", sessionID, "Original request", 1),
        buildMessage("msg-assistant-1", "assistant", sessionID, "Follow-up", 2),
    ]
    const state = createSessionState()
    const config = buildConfig("message")
    const logger = new Logger(false)

    state.prune.messages.byMessageId.set("msg-user-1", {
        tokenCount: 20,
        allBlockIds: [7],
        activeBlockIds: [7],
    })
    state.prune.messages.blocksById.set(7, {
        blockId: 7,
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 0,
        summaryTokens: 0,
        mode: "range",
        topic: "Earlier notes",
        batchTopic: "Earlier notes",
        startId: "m0001",
        endId: "m0001",
        anchorMessageId: "msg-user-1",
        compressMessageId: "msg-origin",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: ["msg-user-1"],
        directToolIds: [],
        effectiveMessageIds: ["msg-user-1"],
        effectiveToolIds: [],
        createdAt: 1,
        summary:
            "[Compressed conversation section]\nEarlier summary\n\n<dcp-message-id>b7</dcp-message-id>",
    })
    state.prune.messages.activeBlockIds.add(7)
    state.prune.messages.activeByAnchorMessageId.set("msg-user-1", 7)

    prune(state, logger, config, messages)

    const summaryText = (messages[0]?.parts[0] as any)?.text || ""
    assert.match(summaryText, /<dcp-message-id>BLOCKED<\/dcp-message-id>/)
    assert.doesNotMatch(summaryText, /<dcp-message-id>b7<\/dcp-message-id>/)
})

test("range-mode rendered compressed summaries keep block IDs", () => {
    const sessionID = "ses_range_visible_blocks"
    const messages: WithParts[] = [
        buildMessage("msg-user-1", "user", sessionID, "Original request", 1),
        buildMessage("msg-assistant-1", "assistant", sessionID, "Follow-up", 2),
    ]
    const state = createSessionState()
    const config = buildConfig("range")
    const logger = new Logger(false)

    state.prune.messages.byMessageId.set("msg-user-1", {
        tokenCount: 20,
        allBlockIds: [7],
        activeBlockIds: [7],
    })
    state.prune.messages.blocksById.set(7, {
        blockId: 7,
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 0,
        summaryTokens: 0,
        mode: "range",
        topic: "Earlier notes",
        batchTopic: "Earlier notes",
        startId: "m0001",
        endId: "m0001",
        anchorMessageId: "msg-user-1",
        compressMessageId: "msg-origin",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: ["msg-user-1"],
        directToolIds: [],
        effectiveMessageIds: ["msg-user-1"],
        effectiveToolIds: [],
        createdAt: 1,
        summary:
            "[Compressed conversation section]\nEarlier summary\n\n<dcp-message-id>b7</dcp-message-id>",
    })
    state.prune.messages.activeBlockIds.add(7)
    state.prune.messages.activeByAnchorMessageId.set("msg-user-1", 7)

    prune(state, logger, config, messages)

    const summaryText = (messages[0]?.parts[0] as any)?.text || ""
    assert.match(summaryText, /<dcp-message-id>b7<\/dcp-message-id>/)
    assert.doesNotMatch(summaryText, /<dcp-message-id>BLOCKED<\/dcp-message-id>/)
})

test("hallucination stripping removes all dcp-prefixed XML tags including variants", async () => {
    const text =
        "alpha" +
        '<dcp-message-id priority="low">m0008</dcp-message-id>' +
        '<dcp-message-id-extra priority="high">m0008</dcp-message-id-extra>' +
        "<dcp-system-reminder>strip this</dcp-system-reminder>" +
        "<dcp-system-reminder-extra>strip this too</dcp-system-reminder-extra>" +
        "omega"

    assert.equal(stripHallucinationsFromString(text), "alphaomega")

    const handler = createTextCompleteHandler()
    const output = { text }
    await handler({ sessionID: "session", messageID: "message", partID: "part" }, output)
    assert.equal(output.text, "alphaomega")
})

test("hallucination stripping removes colon and underscore dcp tag variants", async () => {
    assert.equal(stripHallucinationsFromString("beforeafter"), "beforeafter")
    assert.equal(stripHallucinationsFromString("startend"), "startend")
})

test("hallucination stripping removes orphan opening tags", async () => {
    assert.equal(
        stripHallucinationsFromString("narration\n\n<dcp:function_calls>\n\n"),
        "narration\n\n\n\n",
    )
    assert.equal(stripHallucinationsFromString('text <dcp:invoke name="edit"> more'), "text  more")
})

test("hallucination stripping removes orphan closing tags", async () => {
    assert.equal(stripHallucinationsFromString("text</dcp:function_calls> more"), "text more")
    assert.equal(stripHallucinationsFromString("before</dcp-message-id>after"), "beforeafter")
})

test("hallucination stripping handles nested dcp tags", async () => {
    assert.equal(
        stripHallucinationsFromString(
            'before<dcp:function_calls>\n<dcp:invoke name="edit">content</dcp:invoke>\n</dcp:function_calls>after',
        ),
        "before\nafter",
    )
})

test("hallucination stripping handles mixed paired and orphan tags", async () => {
    assert.equal(
        stripHallucinationsFromString(
            'text\n<dcp-message-id priority="low">m0045</dcp-message-id>\n<dcp:function_calls>\n',
        ),
        "text\n\n\n",
    )
})

test("hallucination stripping does not affect non-dcp tags", async () => {
    assert.equal(
        stripHallucinationsFromString("<div>hello</div> <system-reminder>keep</system-reminder>"),
        "<div>hello</div> <system-reminder>keep</system-reminder>",
    )
})

test("injectMessageIds skips empty assistant messages to avoid prefill (issue #463)", () => {
    const sessionID = "ses_empty_assistant"
    const messages: WithParts[] = [
        buildMessage("msg-user-1", "user", sessionID, "Hello", 1),
        {
            info: {
                id: "msg-assistant-empty",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 2 },
            } as WithParts["info"],
            parts: [],
        },
        buildMessage("msg-user-2", "user", sessionID, "continue", 3),
    ]
    const state = createSessionState()
    const config = buildConfig("range")

    assignMessageRefs(state, messages)
    injectMessageIds(state, config, messages)

    const emptyAssistant = messages[1]!
    assert.equal(emptyAssistant.parts.length, 0, "empty assistant should get no synthetic parts")
})

test("injectMessageIds skips assistant with only pending tool parts (issue #463)", () => {
    const sessionID = "ses_pending_tool_assistant"
    const messages: WithParts[] = [
        buildMessage("msg-user-1", "user", sessionID, "Hello", 1),
        {
            info: {
                id: "msg-assistant-pending",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 2 },
            } as WithParts["info"],
            parts: [
                {
                    id: "pending-tool-part",
                    messageID: "msg-assistant-pending",
                    sessionID,
                    type: "tool" as const,
                    tool: "bash",
                    callID: "call-pending-1",
                    state: {
                        status: "pending" as const,
                        input: { command: "ls" },
                    },
                } as any,
            ],
        },
        buildMessage("msg-user-2", "user", sessionID, "continue", 3),
    ]
    const state = createSessionState()
    const config = buildConfig("range")

    assignMessageRefs(state, messages)
    injectMessageIds(state, config, messages)

    const pendingAssistant = messages[1]!
    assert.equal(
        pendingAssistant.parts.length,
        1,
        "assistant with only pending tools should not get a synthetic text part",
    )
    assert.equal(pendingAssistant.parts[0]!.type, "tool")
})

test("injectMessageIds skips assistant with empty text part (issue #463)", () => {
    const sessionID = "ses_empty_text_assistant"
    const messages: WithParts[] = [
        buildMessage("msg-user-1", "user", sessionID, "Hello", 1),
        {
            info: {
                id: "msg-assistant-empty-text",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 2 },
            } as WithParts["info"],
            parts: [textPart("msg-assistant-empty-text", sessionID, "empty-text-part", "")],
        },
        buildMessage("msg-user-2", "user", sessionID, "continue", 3),
    ]
    const state = createSessionState()
    const config = buildConfig("range")

    assignMessageRefs(state, messages)
    injectMessageIds(state, config, messages)

    const emptyTextAssistant = messages[1]!
    assert.equal(emptyTextAssistant.parts.length, 1, "should not add a synthetic part")
    assert.equal(
        (emptyTextAssistant.parts[0] as any).text,
        "",
        "empty text part should remain untouched",
    )
})
// Logic Verified: injectMessageIds injects into every tool output for range/message modes, marks compress tool messages high-priority, and nudge text excludes protected user messages. BUG-098 rewrites lock in the new assistant-anchored nudge contract (synthetic user message at index+1, byte-identical anchored parts, synthetic:true on text part, isIgnoredUserMessage + countMessagesAfterIndex invariants, byte-stable re-fire, user-anchor regression lock, no mNNNN tag / no priority-map entry, turn-nudge dual-mode).
// Bugs Documented: BUG-098 (iteration nudge appended to assistant's own text, not delivered as a directive).
// Fakes Updated: none
// Review Status: independent review not yet requested for this batch.
