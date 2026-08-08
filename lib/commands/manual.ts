/**
 * DCP Manual mode command handler.
 * Handles toggling manual mode and triggering individual tool executions.
 *
 * Usage:
 *   /dcp manual [on|off]  - Toggle manual mode or set explicit state
 *   /dcp-compress [focus]  - Trigger manual compress execution
 */

import type { Logger } from "../logger"
import type { SessionState, WithParts } from "../state"
import type { PluginConfig } from "../config"
import { sendIgnoredMessage } from "../ui/notification"
import { saveManualModeSetting } from "../state/persistence"
import { effectiveManualMode } from "../state/utils"
import { getCurrentParams } from "../token-utils"
import { buildCompressedBlockGuidance } from "../prompts/extensions/nudge"

const MANUAL_MODE_ON = "Manual mode is now ON. Use /dcp-compress to trigger context tools manually."

const MANUAL_MODE_OFF = "Manual mode is now OFF."

const COMPRESS_TRIGGER_PROMPT = [
    "<compress triggered manually>",
    "Manual mode trigger received. You must now use the compress tool.",
    "Find the most significant completed conversation content that can be compressed into a high-fidelity technical summary.",
    "Follow the active compress mode, preserve all critical implementation details, and choose safe targets.",
    "Return after compress with a brief explanation of what content was compressed.",
].join("\n\n")

function getTriggerPrompt(
    tool: "compress",
    state: SessionState,
    config: PluginConfig,
    userFocus?: string,
): string {
    const base = COMPRESS_TRIGGER_PROMPT
    const compressedBlockGuidance =
        config.compress.mode === "message" ? "" : buildCompressedBlockGuidance(state)

    const sections = [base, compressedBlockGuidance]
    if (userFocus && userFocus.trim().length > 0) {
        sections.push(`Additional user focus:\n${userFocus.trim()}`)
    }

    return sections.join("\n\n")
}

export interface ManualCommandContext {
    client: any
    state: SessionState
    config: PluginConfig
    logger: Logger
    sessionId: string
    messages: WithParts[]
}

export async function handleManualToggleCommand(
    ctx: ManualCommandContext,
    modeArg?: string,
): Promise<void> {
    const { client, state, logger, sessionId, messages } = ctx

    if (modeArg === "on") {
        // v2 protocol: userForced tracks explicit user intent. recoveryForced
        // is preserved — `/dcp manual on` does not clear it (architect decision
        // per PLAN §6.2).
        state.userForced = true
    } else if (modeArg === "off") {
        // v2 protocol: `/dcp manual off` clears userForced ONLY. recoveryForced
        // must be preserved — only session end, OpenCode restart, or
        // recoveryFadeWindow consecutive good manual compresses clears it.
        state.userForced = false
    } else {
        // BUG-032: refuse to clobber a "compress-pending" transient — the
        // user has issued `/dcp-compress` and the model still owes a compress
        // call. The slash-command handler owns that tri-state value (PAT-007
        // + DPP-016); collapsing it would silently break the pending compress
        // (the next `compress` call would be blocked by prepareSession).
        if (state.manualMode === "compress-pending") {
            const params = getCurrentParams(state, messages, logger)
            await sendIgnoredMessage(
                client,
                sessionId,
                "Cannot toggle manual mode while a compress is pending; let the compress complete first.",
                params,
                logger,
            )
            return
        }
        state.userForced = !state.userForced
    }

    // BUG-006 / BUG-024 / BUG-050 cluster fix (DPP-017, PAT-007): every
    // writer of `userForced`/`recoveryForced` must re-derive the
    // `state.manualMode` cache via `effectiveManualMode` so the cache never
    // drifts from the canonical reader.
    state.manualMode = effectiveManualMode(state)

    const params = getCurrentParams(state, messages, logger)
    // Notify using the user's intent (userForced) rather than the derived
    // cache. The cache can disagree with the user's intent when
    // recoveryForced is set (e.g. "/dcp manual off" while recoveryForced=true
    // leaves the cache at "active" but the user just toggled off).
    await sendIgnoredMessage(
        client,
        sessionId,
        state.userForced ? MANUAL_MODE_ON : MANUAL_MODE_OFF,
        params,
        logger,
    )
    // Persist the user's intent. saveManualModeSetting writes BOTH the
    // legacy `manualMode` boolean and the v2 `userForced` flag in lockstep
    // so a reload via loadManualModeSetting recovers the same value.
    await saveManualModeSetting(sessionId, state.userForced, logger)

    logger.info("Manual mode toggled", { manualMode: state.manualMode })
}

export async function handleManualTriggerCommand(
    ctx: ManualCommandContext,
    tool: "compress",
    userFocus?: string,
): Promise<string> {
    // getTriggerPrompt always returns a non-empty string; the nullable in the
    // old signature was a type lie that misled callers about a contract that
    // doesn't exist. BUG-066.
    return getTriggerPrompt(tool, ctx.state, ctx.config, userFocus)
}
