import type { SessionState, WithParts } from "./state"
import type { Logger } from "./logger"
import type { PluginConfig } from "./config"
import { assignMessageRefs } from "./message-ids"
import {
    applyPendingManualTrigger,
    buildPriorityMap,
    buildToolIdList,
    injectCompressNudges,
    injectExtendedSubAgentResults,
    injectMessageIds,
    prune,
    stripHallucinations,
    stripHallucinationsFromString,
    stripStaleMetadata,
    syncCompressionBlocks,
} from "./messages"
import { renderSystemPrompt, type PromptStore } from "./prompts"
import { buildProtectedToolsExtension } from "./prompts/extensions/system"
import {
    applyPendingCompressionDurations,
    buildCompressionTimingKey,
    consumeCompressionStart,
    resolveCompressionDuration,
} from "./compress/timing"
import { filterMessages, filterMessagesInPlace } from "./messages/shape"
import { getLastUserMessage } from "./messages/query"
import {
    handleContextCommand,
    handleDecompressCommand,
    handleHelpCommand,
    handleManualToggleCommand,
    handleManualTriggerCommand,
    handleRecompressCommand,
    handleStatsCommand,
    handleSweepCommand,
} from "./commands"
import { resolveEffectiveCompressPermission, type HostPermissionSnapshot } from "./host-permissions"
import { compressPermission, syncCompressPermissionState } from "./compress-permission"
import { checkSession, ensureSessionInitialized, saveSessionState, syncToolCache } from "./state"
import { cacheSystemPromptTokens } from "./ui/utils"
import { buildDiagnosticEvent } from "./diagnostic"

const INTERNAL_AGENT_SIGNATURES = [
    "You are a title generator",
    "You are a helpful AI assistant tasked with summarizing conversations",
    "You are an anchored context summarization assistant for coding sessions",
    "Summarize what was done in this conversation",
]

// ponytail: Unicode whitespace beyond ASCII (\u00a0 NBSP, ideographic space, etc.)
// must collapse to ASCII space so substring matching survives upstream prompt
// drift. Add new Unicode classes here only when an upstream OpenCode agent
// surfaces a new whitespace variant; the set covers all known v1.x and v2.x
// title-generator / summarizer prompts.
const UNICODE_WHITESPACE_RE = /[\u00a0\u2000-\u200b\u2028\u2029\u202f\u205f\u3000]/g

/** Collapse whitespace (incl. Unicode NBSP and ideographic space) and trim. */
function normalizePrompt(prompt: string): string {
    return prompt.replace(UNICODE_WHITESPACE_RE, " ").replace(/\s+/g, " ").trim()
}

/** True only when every supplied system prompt is from an internal OpenCode agent.
 *  Matches the signature directly (with case/whitespace tolerance) or as the
 *  primary directive following an internal metadata prefix (e.g. OpenCode's
 *  `OpenCode <role> metadata: ...`). A quoted reference like `The user quoted:
 *  You are a title generator` does NOT match. */
export function isInternalAgentSystem(systemPrompts: string[]): boolean {
    if (systemPrompts.length === 0) {
        return false
    }
    return systemPrompts.every((prompt) => {
        const normalized = normalizePrompt(prompt).toLowerCase()
        if (normalized.length === 0) {
            return false
        }
        for (const sig of INTERNAL_AGENT_SIGNATURES) {
            const sigNormalized = normalizePrompt(sig).toLowerCase()
            if (normalized === sigNormalized) {
                return true
            }
            if (
                normalized.startsWith(sigNormalized + " ") ||
                normalized.startsWith(sigNormalized)
            ) {
                return true
            }
        }
        // Fallback: OpenCode wraps its internal-agent prompts with a
        // `<role> metadata:` prefix. A signature in that context is an
        // instruction, not a user quote.
        if (/\bmetadata:\s/i.test(prompt)) {
            const lower = prompt.toLowerCase()
            for (const sig of INTERNAL_AGENT_SIGNATURES) {
                if (lower.includes(sig.toLowerCase())) {
                    return true
                }
            }
        }
        return false
    })
}

export function createSystemPromptHandler(
    state: SessionState,
    logger: Logger,
    config: PluginConfig,
    prompts: PromptStore,
    hostPermissions: HostPermissionSnapshot = { global: undefined, agents: {} },
) {
    return async (
        input: { sessionID?: string; model: { limit: { context: number } } },
        output: { system: string[] },
    ) => {
        if (input.model?.limit?.context) {
            state.modelContextLimit = input.model.limit.context
            logger.debug("Cached model context limit", { limit: state.modelContextLimit })
        }

        // Cache the latest system prompts so the message-transform handler can
        // honor DPP-009 (skip internal OpenCode agents) without a new hook
        // surface. State field is read by both handlers; written here only.
        ;(state as { lastSystem?: string[] }).lastSystem = output.system

        if (state.isSubAgent && !config.experimental.allowSubAgents) {
            return
        }

        if (isInternalAgentSystem(output.system)) {
            logger.info("Skipping DCP system prompt injection for internal agent")
            return
        }

        // ponytail: same-session fires have already synced state.compressPermission
        // via syncCompressPermissionState. On the very first injection the state
        // cache is still null, so resolve against host permissions directly.
        // Agent-scoped denies land on the next messages.transform — the system-
        // transform input carries no agent field, by design.
        const effectivePermission =
            input.sessionID && state.sessionId === input.sessionID
                ? compressPermission(state, config)
                : resolveEffectiveCompressPermission(config.compress.permission, hostPermissions)

        if (effectivePermission === "deny") {
            return
        }

        prompts.reload()
        const runtimePrompts = prompts.getRuntimePrompts()
        let newPrompt = renderSystemPrompt(
            runtimePrompts,
            buildProtectedToolsExtension(config.compress.protectedTools),
            !!state.manualMode,
            state.isSubAgent && config.experimental.allowSubAgents,
        )
        if (output.system.length > 0) {
            output.system[output.system.length - 1] += "\n\n" + newPrompt
        } else {
            output.system.push(newPrompt)
        }
    }
}

export function createChatMessageTransformHandler(
    client: any,
    state: SessionState,
    logger: Logger,
    config: PluginConfig,
    prompts: PromptStore,
    hostPermissions: HostPermissionSnapshot,
) {
    return async (input: {}, output: { messages: WithParts[] }) => {
        // DPP-009: skip the full pipeline for internal OpenCode agents (title
        // generators, summarizers). Mirrors the gate in createSystemPromptHandler
        // using the cached state.lastSystem, because the message-transform input
        // carries no `system` field.
        const lastSystem = (state as { lastSystem?: string[] }).lastSystem
        if (lastSystem && isInternalAgentSystem(lastSystem)) {
            return
        }

        const receivedMessages = Array.isArray(output.messages) ? output.messages.length : 0
        const messages = filterMessagesInPlace(output.messages)
        if (messages.length !== receivedMessages) {
            logger.warn("Skipping messages with unexpected shape during chat transform", {
                received: receivedMessages,
                usable: messages.length,
            })
        }

        await checkSession(
            client,
            state,
            logger,
            output.messages,
            config.manualMode.enabled,
            config,
            config.compress.stateMaxAgeDays,
            config.experimental.allowSubAgents,
        )

        syncCompressPermissionState(state, config, hostPermissions, output.messages)

        if (state.isSubAgent && !config.experimental.allowSubAgents) {
            return
        }

        // Diagnostic fire — record prefix hash, message metrics, synthetic
        // block counts, and the latest assistant token snapshot. Runs on
        // every transform fire when `debug: true` so we can attribute the
        // next context balloon to a specific fire. Best-effort: never throws
        // into the transform pipeline. ponytail: gated on debug via Logger.
        try {
            const now = Date.now()
            const event = buildDiagnosticEvent(state, state.sessionId, output.messages, now)
            state.diagnostic.fireCount = event.fireNumber
            state.diagnostic.lastPrefixHash = event.prefixHash
            state.diagnostic.lastFireAt = now
            await logger.diagnostic(event as unknown as Record<string, unknown>)
            // ponytail: only mirror to the daily log when something interesting
            // changed; every-fire mirroring balloons the log without debug
            // signal value.
            if (event.prefixChanged || event.possibleCacheMiss) {
                logger.info("DCP transform fire", {
                    fire: event.fireNumber,
                    msgs: event.messageCount,
                    bytes: event.estimatedBytes,
                    tasks: event.taskToolCount,
                    synthetic: event.synthetic.totalCount,
                    prefixChanged: event.prefixChanged,
                    cacheMiss: event.possibleCacheMiss,
                    lastCacheRead: event.lastAssistant.cacheRead,
                    lastInput: event.lastAssistant.input,
                    msSinceLast: event.msSinceLastFire,
                })
            }
        } catch {
            // Swallow — diagnostic failure must not break the transform.
        }

        // BUG-028: outer try/catch wraps the 13-step pipeline plus the
        // trailing saveContext. Any step throwing (e.g. assignMessageRefs
        // capacity exhausted, saveContext disk-full) is logged and swallowed
        // — OpenCode's experimental chat hook contract does not promise a
        // graceful recovery path, so the defensive move is to return the
        // un-transformed messages instead of breaking the LLM call.
        try {
            stripHallucinations(output.messages)
            cacheSystemPromptTokens(state, output.messages)
            assignMessageRefs(state, output.messages)
            syncCompressionBlocks(state, logger, output.messages)
            syncToolCache(state, config, logger, output.messages)
            buildToolIdList(state, output.messages, config)
            prune(state, logger, config, output.messages)
            await injectExtendedSubAgentResults(
                client,
                state,
                logger,
                output.messages,
                config.experimental.allowSubAgents,
            )
            const compressionPriorities = buildPriorityMap(config, state, output.messages)
            prompts.reload()
            injectCompressNudges(
                state,
                config,
                logger,
                output.messages,
                prompts.getRuntimePrompts(),
                compressionPriorities,
            )
            // BUG-061: apply the pending manual trigger BEFORE injectMessageIds so
            // the rewritten prompt receives a fresh mNNNN tag rather than the
            // stale one assigned to the original text.
            applyPendingManualTrigger(state, output.messages, logger)
            injectMessageIds(state, config, output.messages, compressionPriorities)
            stripStaleMetadata(output.messages)

            if (state.sessionId) {
                try {
                    await logger.saveContext(state.sessionId, output.messages)
                } catch (err: any) {
                    logger.warn("DCP saveContext failed; transform returned anyway", {
                        error: err?.message ?? String(err),
                    })
                }
            }
        } catch (err: any) {
            logger.warn("DCP transform failed; returning un-transformed messages", {
                error: err?.message ?? String(err),
            })
            return
        }
    }
}

export function createCommandExecuteHandler(
    client: any,
    state: SessionState,
    logger: Logger,
    config: PluginConfig,
    workingDirectory: string,
    hostPermissions: HostPermissionSnapshot,
) {
    return async (
        input: { command: string; sessionID: string; arguments: string },
        output: { parts: any[] },
    ) => {
        if (!config.commands.enabled) {
            return
        }

        if (input.command === "dcp" || input.command === "dcp-compress") {
            const messagesResponse = await client.session.messages({
                path: { id: input.sessionID },
            })
            const messages = filterMessages(messagesResponse.data || messagesResponse)

            await ensureSessionInitialized(
                client,
                state,
                input.sessionID,
                logger,
                messages,
                config.manualMode.enabled,
                config,
                config.compress.stateMaxAgeDays,
                config.experimental.allowSubAgents,
            )

            syncCompressPermissionState(state, config, hostPermissions, messages)

            const effectivePermission = compressPermission(state, config)
            if (effectivePermission === "deny") {
                return
            }

            const args = (input.arguments || "").trim().split(/\s+/).filter(Boolean)
            const isCompressCommand = input.command === "dcp-compress"
            const subcommand = isCompressCommand ? "compress" : args[0]?.toLowerCase() || ""
            const subArgs = isCompressCommand ? args : args.slice(1)

            const commandCtx = {
                client,
                state,
                config,
                logger,
                sessionId: input.sessionID,
                messages,
            }

            if (subcommand === "context") {
                await handleContextCommand(commandCtx)
                return
            }

            if (subcommand === "stats") {
                await handleStatsCommand(commandCtx)
                return
            }

            if (subcommand === "sweep") {
                await handleSweepCommand({
                    ...commandCtx,
                    args: subArgs,
                    workingDirectory,
                })
                return
            }

            if (subcommand === "manual") {
                await handleManualToggleCommand(commandCtx, subArgs[0]?.toLowerCase())
                return
            }

            if (subcommand === "compress") {
                const userFocus = subArgs.join(" ").trim()
                const prompt = await handleManualTriggerCommand(commandCtx, "compress", userFocus)

                state.manualMode = "compress-pending"
                // BUG-029: capture the slash-command user message's id at
                // slash-command time. The `command.execute.before` hook
                // input carries no message id (per the OpenCode SDK), so we
                // identify the originating message by walking the messages
                // we just fetched. This runs synchronously with the slash
                // command — the user cannot type a new message until this
                // handler returns — so the last non-ignored user message is
                // the slash-command message in the common case. The
                // backward-walk fallback in `applyPendingManualTrigger` is
                // retained for legacy / unusual paths.
                state.pendingManualTrigger = {
                    sessionId: input.sessionID,
                    prompt,
                    commandMessageId: getLastUserMessage(messages)?.info.id,
                }
                const rawArgs = (input.arguments || "").trim()
                output.parts.length = 0
                output.parts.push({
                    type: "text",
                    text: isCompressCommand
                        ? rawArgs
                            ? `/dcp-compress ${rawArgs}`
                            : "/dcp-compress"
                        : rawArgs
                          ? `/dcp ${rawArgs}`
                          : `/dcp ${subcommand}`,
                })
                return
            }

            if (subcommand === "decompress") {
                await handleDecompressCommand({
                    ...commandCtx,
                    args: subArgs,
                })
                return
            }

            if (subcommand === "recompress") {
                await handleRecompressCommand({
                    ...commandCtx,
                    args: subArgs,
                })
                return
            }

            await handleHelpCommand(commandCtx)
            return
        }
    }
}

export function createTextCompleteHandler() {
    return async (
        _input: { sessionID: string; messageID: string; partID: string },
        output: { text: string },
    ) => {
        output.text = stripHallucinationsFromString(output.text)
    }
}

export function createEventHandler(state: SessionState, logger: Logger) {
    return async (input: { event: any }) => {
        const eventTime =
            typeof input.event?.time === "number" && Number.isFinite(input.event.time)
                ? input.event.time
                : typeof input.event?.properties?.time === "number" &&
                    Number.isFinite(input.event.properties.time)
                  ? input.event.properties.time
                  : undefined

        if (input.event.type !== "message.part.updated") {
            return
        }

        const part = input.event.properties?.part
        if (part?.type !== "tool" || part.tool !== "compress") {
            return
        }

        if (part.state.status === "pending") {
            if (typeof part.callID !== "string" || typeof part.messageID !== "string") {
                return
            }

            const startedAt = eventTime ?? Date.now()
            const key = buildCompressionTimingKey(part.messageID, part.callID)
            if (state.compressionTiming.startsByCallId.has(key)) {
                return
            }
            state.compressionTiming.startsByCallId.set(key, startedAt)
            logger.debug("Recorded compression start", {
                messageID: part.messageID,
                callID: part.callID,
                startedAt,
            })
            return
        }

        if (part.state.status === "completed") {
            if (typeof part.callID !== "string" || typeof part.messageID !== "string") {
                return
            }

            const key = buildCompressionTimingKey(part.messageID, part.callID)
            const start = consumeCompressionStart(state, part.messageID, part.callID)
            const durationMs = resolveCompressionDuration(start, eventTime, part.state.time)
            if (typeof durationMs !== "number") {
                return
            }

            state.compressionTiming.pendingByCallId.set(key, {
                messageId: part.messageID,
                callId: part.callID,
                durationMs,
            })

            const updates = applyPendingCompressionDurations(state)
            if (updates === 0) {
                return
            }

            await saveSessionState(state, logger)

            logger.info("Attached compression time to blocks", {
                messageID: part.messageID,
                callID: part.callID,
                blocks: updates,
                durationMs,
            })
            return
        }

        if (part.state.status === "running") {
            return
        }

        if (typeof part.callID === "string" && typeof part.messageID === "string") {
            state.compressionTiming.startsByCallId.delete(
                buildCompressionTimingKey(part.messageID, part.callID),
            )
        }
    }
}
