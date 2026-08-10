import type { Plugin } from "@opencode-ai/plugin"
import { getConfig } from "./lib/config"
import { createCompressMessageTool, createCompressRangeTool } from "./lib/compress"
import { compressDisabledByOpencode, type HostPermissionSnapshot } from "./lib/host-permissions"
import { Logger } from "./lib/logger"
import { createSessionState } from "./lib/state"
import { PromptStore } from "./lib/prompts/store"
import {
    createChatMessageTransformHandler,
    createCommandExecuteHandler,
    createEventHandler,
    createSystemPromptHandler,
    createTextCompleteHandler,
} from "./lib/hooks"
import { configureClientAuth, isSecureMode } from "./lib/auth"
import { startAutoUpdate } from "./lib/update"

const server: Plugin = (async (ctx) => {
    const config = getConfig(ctx)

    if (!config.enabled) {
        return {}
    }

    const logger = new Logger(config.debug)
    const state = createSessionState()
    const prompts = new PromptStore(logger, ctx.directory, config.experimental.customPrompts)
    const hostPermissions: HostPermissionSnapshot = {
        global: undefined,
        agents: {},
    }

    if (isSecureMode()) {
        configureClientAuth(ctx.client)
        // logger.info("Secure mode detected, configured client authentication")
    }

    logger.info("DCP initialized", {
        strategies: config.strategies,
    })

    startAutoUpdate(ctx, config.autoUpdate)

    const compressToolContext = {
        client: ctx.client,
        state,
        logger,
        config,
        prompts,
    }

    return {
        "experimental.chat.system.transform": createSystemPromptHandler(
            state,
            logger,
            config,
            prompts,
            hostPermissions,
        ),
        "experimental.chat.messages.transform": createChatMessageTransformHandler(
            ctx.client,
            state,
            logger,
            config,
            prompts,
            hostPermissions,
        ) as any,
        "experimental.text.complete": createTextCompleteHandler(),
        "command.execute.before": createCommandExecuteHandler(
            ctx.client,
            state,
            logger,
            config,
            ctx.directory,
            hostPermissions,
        ),
        event: createEventHandler(state, logger, config),
        tool: {
            ...(config.compress.permission !== "deny" && {
                compress:
                    config.compress.mode === "message"
                        ? createCompressMessageTool(compressToolContext)
                        : createCompressRangeTool(compressToolContext),
            }),
        },
        config: async (opencodeConfig) => {
            // DPP-010: do NOT mutate the user's compress.permission. The host
            // baseline may deny, but a user `allow` in dcp.jsonc must survive.
            // Downstream gates read config.compress.permission directly, so the
            // user's value is the single source of truth.
            const hostDisables = compressDisabledByOpencode(opencodeConfig.permission)
            if (hostDisables && config.compress.permission !== "deny") {
                logger.warn(
                    'DCP: host permission baseline denies compress (e.g. *:deny). User explicit "compress": "allow" in dcp.jsonc re-enables it.',
                    {
                        hostPermission: opencodeConfig.permission,
                        userPermission: config.compress.permission,
                    },
                )
            }

            if (config.commands.enabled && config.compress.permission !== "deny") {
                opencodeConfig.command ??= {}
                opencodeConfig.command["dcp-compress"] = {
                    template: "",
                    description: "Trigger DCP manual compression with: /dcp-compress [focus]",
                }
                opencodeConfig.command["dcp"] = {
                    template: "",
                    description:
                        "DCP panel: /dcp stats, /dcp context, /dcp sweep, /dcp manual, ...",
                }
            }

            const toolsToAdd: string[] = []
            if (config.compress.permission !== "deny" && !config.experimental.allowSubAgents) {
                toolsToAdd.push("compress")
            }

            if (toolsToAdd.length > 0) {
                const existingPrimaryTools = opencodeConfig.experimental?.primary_tools ?? []
                opencodeConfig.experimental = {
                    ...opencodeConfig.experimental,
                    primary_tools: [...existingPrimaryTools, ...toolsToAdd],
                }
            }

            // Re-append compress so the user's DCP permission is the last matching
            // host rule without mutating config.compress.permission.
            const permission = Object.fromEntries(
                Object.entries(opencodeConfig.permission ?? {}).filter(
                    ([tool]) => tool !== "compress",
                ),
            )
            opencodeConfig.permission = {
                ...permission,
                compress: config.compress.permission,
            } as typeof opencodeConfig.permission

            hostPermissions.global = opencodeConfig.permission
            hostPermissions.agents = Object.fromEntries(
                Object.entries(opencodeConfig.agent ?? {}).map(([name, agent]) => [
                    name,
                    agent?.permission,
                ]),
            )
        },
    }
}) satisfies Plugin

export default server
