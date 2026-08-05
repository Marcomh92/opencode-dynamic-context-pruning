/** @jsxImportSource @opentui/solid */

// M3 fork fix: Bun is a runtime global provided by the Bun runtime; @types/bun is not installed.
// ponytail: declare only — remove this line if @types/bun is later added.
declare const Bun: { version?: string } | undefined

import type { TuiPluginModule } from "@opencode-ai/plugin/tui"

const tui: TuiPluginModule["tui"] = async (api) => {
    // M3 fork fix: gate @opentui-dependent imports on the Bun runtime.
    // OpenCode Desktop's Node sidecar has no @opentui/core; loading it throws.
    if (typeof Bun === "undefined") {
        return
    }

    const { registerCommands } = await import("./lib/tui/commands")
    const { loadConfig } = await import("./lib/tui/data")
    const { openPanelModal } = await import("./lib/tui/modals")

    const config = loadConfig(api)
    if (!config.enabled || !config.commands.enabled) return

    registerCommands(api, [
        {
            title: "DCP",
            name: "dcp.panel",
            description: "Open DCP panel",
            slashName: "dcp",
            run: () => openPanelModal(api, config),
        },
    ])
}

export default {
    id: "opencode-dcp",
    tui,
} satisfies TuiPluginModule
