import type { Logger } from "../logger"
import type { SessionState, WithParts } from "../state"
import { isIgnoredUserMessage } from "./query"

/** Rewrite the user message identified by `pending.commandMessageId` (or, as
 *  a backward-compat fallback, the last non-ignored user message) with
 *  `pending.prompt`. Clears `state.pendingManualTrigger` once applied.
 *
 *  BUG-029: the previous backward-walk picked "the latest non-ignored user
 *  message", which in a narrow race window let the trigger overwrite a
 *  NEWER user message typed after the slash command but before the transform
 *  fired. Identifying the target by stable `commandMessageId` (set by the
 *  slash-command handler) closes that race.
 *
 *  BUG-061: the transform pipeline runs this step BEFORE `injectMessageIds`
 *  so the rewritten prompt receives a fresh mNNNN tag rather than the stale
 *  one assigned to the original text. */
export function applyPendingManualTrigger(
    state: SessionState,
    messages: WithParts[],
    logger: Logger,
): void {
    const pending = state.pendingManualTrigger
    if (!pending) {
        return
    }

    if (!state.sessionId || pending.sessionId !== state.sessionId) {
        state.pendingManualTrigger = null
        return
    }

    // Primary path: target the exact user message that issued the slash
    // command. Stable across the race window where the user types more
    // messages before the transform fires.
    if (typeof pending.commandMessageId === "string" && pending.commandMessageId.length > 0) {
        const target = messages.find((msg) => msg.info.id === pending.commandMessageId)
        if (target && applyPromptToFirstTextPart(target, pending.prompt)) {
            state.pendingManualTrigger = null
            logger.debug("Applied manual prompt by commandMessageId", {
                sessionId: pending.sessionId,
                commandMessageId: pending.commandMessageId,
            })
            return
        }
    }

    // Fallback: backward walk. Used when the slash-command handler predates
    // the commandMessageId field (the v1 wiring) — the rewrite still lands
    // on the slash-command's own message in the common case because that
    // message is the most-recently-pushed non-ignored user message at the
    // time the trigger was queued.
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        if (msg.info.role !== "user" || isIgnoredUserMessage(msg)) {
            continue
        }
        if (applyPromptToFirstTextPart(msg, pending.prompt)) {
            state.pendingManualTrigger = null
            logger.debug("Applied manual prompt via fallback walk", {
                sessionId: pending.sessionId,
            })
            return
        }
    }

    // No eligible user message — drop the trigger so it doesn't linger across
    // transforms (BUG-029 bonus: a stale `pendingManualTrigger` from a prior
    // session must not fire on an arbitrary later message).
    state.pendingManualTrigger = null
}

function applyPromptToFirstTextPart(message: WithParts, prompt: string): boolean {
    for (const part of message.parts) {
        if (part.type !== "text" || part.ignored || part.synthetic) {
            continue
        }
        part.text = prompt
        return true
    }
    return false
}
