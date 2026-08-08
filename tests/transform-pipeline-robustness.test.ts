import assert from "node:assert/strict"
import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

// Per-test isolation: redirect XDG_DATA_HOME / XDG_CONFIG_HOME so the
// persistence layer and the logger never touch the host filesystem.
const testDataHome = join(tmpdir(), `opencode-dcp-robustness-data-${process.pid}`)
const testConfigHome = join(tmpdir(), `opencode-dcp-robustness-config-${process.pid}`)
process.env.XDG_DATA_HOME = testDataHome
process.env.XDG_CONFIG_HOME = testConfigHome
mkdirSync(testDataHome, { recursive: true })
mkdirSync(testConfigHome, { recursive: true })

import { createChatMessageTransformHandler, createSystemPromptHandler } from "../lib/hooks"
import type { PluginConfig } from "../lib/config"
import { Logger } from "../lib/logger"
import { MESSAGE_REF_MAX_INDEX, formatMessageRef } from "../lib/message-ids"
import { createSessionState, type WithParts } from "../lib/state"
import type { HostPermissionSnapshot } from "../lib/host-permissions"

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

function buildConfig(permission: "allow" | "ask" | "deny" = "allow"): PluginConfig {
    return {
        enabled: true,
        debug: false,
        pruneNotification: "off",
        pruneNotificationType: "chat",
        commands: { enabled: true, protectedTools: [] },
        manualMode: { enabled: false, automaticStrategies: true },
        turnProtection: { enabled: false, turns: 4 },
        experimental: { allowSubAgents: false, customPrompts: false },
        protectedFilePatterns: [],
        compress: {
            mode: "message",
            permission,
            showCompression: false,
            maxContextLimit: 150000,
            minContextLimit: 50000,
            nudgeFrequency: 5,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            protectedTools: [],
            protectTags: false,
            protectUserMessages: false,
        },
        strategies: {
            deduplication: { enabled: true, protectedTools: [] },
            purgeErrors: { enabled: true, turns: 4, protectedTools: [] },
        },
    }
}

function buildPromptsStub() {
    return {
        reload() {},
        getRuntimePrompts() {
            return {
                system: "",
                compressRange: "",
                compressMessage: "",
                contextLimitNudge: "",
                turnNudge: "",
                iterationNudge: "",
                manualExtension: "",
                subagentExtension: "",
            }
        },
    } as any
}

function buildHostPermissions(): HostPermissionSnapshot {
    return { global: undefined, agents: {} }
}

function buildClientStub() {
    return {
        session: {
            messages: async () => ({ data: [] }),
            get: async () => ({ data: { parentID: null } }),
        },
    } as any
}

// Use string-built regexes to keep the source readable. The literal regex
// notation can confuse some renderers that treat angle-bracketed tokens as
// XML tags, so the helpers below build the patterns via RegExp constructors.
// Use string-built regexes to keep the source readable.<dcp-message-id...`
// gets displayed without the opening tag by some renderers.
const DCP_MESSAGE_ID_OPEN_TAG_RE = /m\d+<\/dcp-message-id>/

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
function saturateMessageIdCapacity(state: ReturnType<typeof createSessionState>) {
    for (let i = 1; i <= MESSAGE_REF_MAX_INDEX; i++) {
        const ref = formatMessageRef(i)
        state.messageIds.byRef.set(ref, `synthetic-raw-${i}`)
        state.messageIds.byRawId.set(`synthetic-raw-${i}`, ref)
    }
    state.messageIds.nextRef = 1
    // byRef is fully populated, so allocateNextMessageRef's
    // `while (!byRef.has(ref))` loop will exhaust 1..9999 and throw.
}

// ---------------------------------------------------------------------------
// BUG-028 — outer try/catch around the 13-step transform pipeline
// ---------------------------------------------------------------------------

test("BUG-028: transform pipeline does not throw when assignMessageRefs exhausts capacity", async () => {
    const sessionID = `ses_bug028_capacity_${Date.now()}`
    const messages: WithParts[] = [
        buildUserMessage("msg-user-1", sessionID, "Hello, world", 1),
        buildAssistantMessage("msg-assistant-1", sessionID, "Hi there", 2),
    ]
    const state = createSessionState()
    state.sessionId = sessionID
    saturateMessageIdCapacity(state)

    const logger = new Logger(false)
    const handler = createChatMessageTransformHandler(
        buildClientStub(),
        state,
        logger,
        buildConfig("allow"),
        buildPromptsStub(),
        buildHostPermissions(),
    )

    // Pre-fix behaviour: `assignMessageRefs` throws uncaught, the hook
    // propagates the error out of `await handler(...)`, and OpenCode's
    // experimental chat pipeline surfaces `Message ID alias capacity exceeded`
    // mid-session.
    await assert.doesNotReject(
        async () => await handler({}, { messages }),
        /Message ID alias capacity exceeded/,
    )

    // Outer try/catch contract: on a step failure the pipeline returns the
    // messages array unchanged (or close to unchanged — the diagnostic step
    // may not have run). The hook must not have left the array half-pruned.
    // Concretely: every message's text part must still be present and the
    // messages array must still contain both inputs.
    assert.equal(messages.length, 2, "messages array must not be truncated on step failure")
    assert.equal((messages[0]?.parts[0] as any)?.text, "Hello, world")
    assert.equal((messages[1]?.parts[0] as any)?.text, "Hi there")
})

test("BUG-028: transform pipeline does not throw when logger.saveContext throws on disk-full", async () => {
    const sessionID = `ses_bug028_save_${Date.now()}`
    const messages: WithParts[] = [
        buildUserMessage("msg-user-1", sessionID, "Hello", 1),
        buildAssistantMessage("msg-assistant-1", sessionID, "Hi", 2),
    ]
    const state = createSessionState()
    state.sessionId = sessionID

    const logger = new Logger(false)
    // Force saveContext to throw — the trailing save must be wrapped.
    logger.saveContext = async () => {
        throw new Error("disk full")
    }

    const handler = createChatMessageTransformHandler(
        buildClientStub(),
        state,
        logger,
        buildConfig("allow"),
        buildPromptsStub(),
        buildHostPermissions(),
    )

    await assert.doesNotReject(async () => await handler({}, { messages }))

    // Pipeline must still have completed — message refs should have been
    // assigned for both inputs.
    assert.equal(state.messageIds.byRawId.get("msg-user-1"), "m0001")
    assert.equal(state.messageIds.byRawId.get("msg-assistant-1"), "m0002")
})

// ---------------------------------------------------------------------------
// BUG-029 — applyPendingManualTrigger attaches to the slash-command message,
//           identified by commandMessageId, not by "last user message".
// ---------------------------------------------------------------------------

test("BUG-029: applyPendingManualTrigger attaches to the slash-command user message, not the latest one", async () => {
    const sessionID = `ses_bug029_race_${Date.now()}`

    // The slash-command user message is the FIRST user message in the array.
    // After the slash-command fires but before the transform runs, the user
    // types three more messages. The trigger must overwrite msg-user-cmd,
    // not msg-user-newest.
    const cmdText = "/dcp-compress focus on tokens"
    const messages: WithParts[] = [
        buildUserMessage("msg-user-cmd", sessionID, cmdText, 1),
        buildAssistantMessage("msg-assistant-1", sessionID, "ack", 2),
        buildUserMessage("msg-user-mid", sessionID, "in the middle of a long thread", 3),
        buildAssistantMessage("msg-assistant-2", sessionID, "ok", 4),
        buildUserMessage(
            "msg-user-newest",
            sessionID,
            "the latest user input the model must NOT clobber",
            5,
        ),
    ]

    const state = createSessionState()
    state.sessionId = sessionID
    const triggerPrompt = "<compress triggered manually>\nPlease compress the conversation."
    // The fix introduces a `commandMessageId` field on PendingManualTrigger
    // that identifies which user message the trigger originated from.
    state.pendingManualTrigger = {
        sessionId: sessionID,
        prompt: triggerPrompt,
        commandMessageId: "msg-user-cmd",
    } as any

    const logger = new Logger(false)
    const handler = createChatMessageTransformHandler(
        buildClientStub(),
        state,
        logger,
        buildConfig("allow"),
        buildPromptsStub(),
        buildHostPermissions(),
    )

    await handler({}, { messages })

    const cmdPart = messages[0]?.parts[0] as any
    const newestPart = messages[4]?.parts[0] as any
    const midPart = messages[2]?.parts[0] as any

    // The slash-command message's text must be replaced with the trigger.
    assert.match(cmdPart?.text ?? "", /<compress triggered manually>/)
    // The user's actual messages must remain untouched.
    assert.ok(
        (midPart?.text ?? "").startsWith("in the middle of a long thread"),
        "BUG-029: middle user message must not be clobbered by trigger prompt overwrite",
    )
    assert.ok(
        (newestPart?.text ?? "").startsWith("the latest user input the model must NOT clobber"),
        "BUG-029: race-window overwrite must not clobber the latest user message",
    )
    // The pending trigger must have been cleared exactly once.
    assert.equal(state.pendingManualTrigger, null)
})

// ---------------------------------------------------------------------------
// BUG-061 — applyPendingManualTrigger runs BEFORE injectMessageIds so the
//           rewritten prompt receives a fresh mNNNN, not a stale one.
// ---------------------------------------------------------------------------

test("BUG-061: pending manual trigger prompt receives a fresh mNNNN tag", async () => {
    const sessionID = `ses_bug061_fresh_${Date.now()}`

    const messages: WithParts[] = [
        buildUserMessage("msg-user-cmd", sessionID, "/dcp-compress", 1),
        buildAssistantMessage("msg-assistant-1", sessionID, "acknowledged", 2),
    ]

    const state = createSessionState()
    state.sessionId = sessionID

    // Pre-assign a ref for the slash-command user message so we can prove
    // the FIX swaps the order and re-tags the message after the rewrite.
    state.messageIds.byRawId.set("msg-user-cmd", "m0001")
    state.messageIds.byRef.set("m0001", "msg-user-cmd")
    state.messageIds.byRawId.set("msg-assistant-1", "m0002")
    state.messageIds.byRef.set("m0002", "msg-assistant-1")
    state.messageIds.nextRef = 3

    const triggerPrompt = "<compress triggered manually>\nCompress now."
    state.pendingManualTrigger = {
        sessionId: sessionID,
        prompt: triggerPrompt,
        commandMessageId: "msg-user-cmd",
    } as any

    const logger = new Logger(false)
    const handler = createChatMessageTransformHandler(
        buildClientStub(),
        state,
        logger,
        buildConfig("allow"),
        buildPromptsStub(),
        buildHostPermissions(),
    )

    await handler({}, { messages })

    const cmdPart = messages[0]?.parts[0] as any
    const cmdText = String(cmdPart?.text ?? "")

    // The rewritten prompt must carry a dcp-message-id tag referring to
    // msg-user-cmd (NOT to a stale different ref). Pre-fix behaviour leaves
    // the rewritten prompt without a fresh tag because injectMessageIds has
    // already finished walking messages before applyPendingManualTrigger
    // overwrites the text.
    assert.match(
        cmdText,
        DCP_MESSAGE_ID_OPEN_TAG_RE,
        "BUG-061: trigger prompt must carry a fresh dcp-message-id tag for the rewritten message",
    )
    assert.match(
        cmdText,
        /m0001/,
        "BUG-061: trigger prompt must reference the rewritten message's ref",
    )

    // The trigger prompt must appear as the visible text (not the original
    // slash-command text).
    assert.match(cmdText, /<compress triggered manually>/)
})

// ---------------------------------------------------------------------------
// Helper: prove the diagnostic step is best-effort even after the outer
// try/catch — wrapping the pipeline must not regress the existing diagnostic
// fire contract.
// ---------------------------------------------------------------------------

test("BUG-028: outer try/catch does not regress the diagnostic fire (when no step throws)", async () => {
    const sessionID = `ses_bug028_diag_${Date.now()}`
    const messages: WithParts[] = [
        buildUserMessage("msg-user-1", sessionID, "Hello", 1),
        buildAssistantMessage("msg-assistant-1", sessionID, "Hi", 2),
    ]
    const state = createSessionState()
    state.sessionId = sessionID

    const logger = new Logger(false)
    const handler = createChatMessageTransformHandler(
        buildClientStub(),
        state,
        logger,
        buildConfig("allow"),
        buildPromptsStub(),
        buildHostPermissions(),
    )

    await handler({}, { messages })

    // The diagnostic state was written when no step threw.
    assert.ok(state.diagnostic.fireCount >= 1, "diagnostic fireCount must be incremented")
    assert.equal(state.messageIds.byRawId.get("msg-user-1"), "m0001")
    assert.equal(state.messageIds.byRawId.get("msg-assistant-1"), "m0002")
})

// Touch `createSystemPromptHandler` so the import stays used even if the
// test file is reorganised. (Some test runners lint unused imports.)
void createSystemPromptHandler

// Logic Verified:
//   BUG-028: outer try/catch catches any pipeline step throw (assignMessageRefs
//            capacity exhaustion and logger.saveContext IO failure tested).
//   BUG-029: applyPendingManualTrigger attaches by commandMessageId (stable
//            content identity), not by "last user message" — race-window
//            overwrite of a later user message is rejected.
//   BUG-061: applyPendingManualTrigger runs before injectMessageIds — the
//            rewritten trigger prompt carries a fresh dcp-message-id tag.
// Bugs Documented: none (all six bugs are documented in known_issues/).
// Fakes Updated: none.
// Review Status: not yet independently reviewed.
// Logic Verified: transform pipeline outer try/catch isolates per-step throws (capacity exhaustion, saveContext disk-full), applyPendingManualTrigger attaches to the slash-command user message, and the rewritten trigger prompt carries a fresh dcp-message-id tag.
// Bugs Documented: BUG-028, BUG-029, BUG-061.
// Fakes Updated: none
// Review Status: pending independent review.
