import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "fs"
import { join, dirname } from "path"
import { homedir } from "os"
// ponytail: resolve via the package's `main` field (CJS UMD) instead of the
// deep ESM path. Same library, same `parse` function — only the loader path
// changes. The deep path `jsonc-parser/lib/esm/main.js` works for bundlers
// (tsup bundles it via noExternal) but trips Node 24 + tsx in test mode
// because the file uses ESM syntax inside a CJS package (no `type: "module"`),
// so Node's static-export analysis can't expose named exports. The CJS UMD
// build sets `exports.parse = parser.parse` and Node's ESM-CJS interop
// surfaces that as a real named export. Revert to the deep path if/when the
// upstream package ships a proper `exports` map with an ESM entry.
import { parse } from "jsonc-parser"
import type { PluginInput } from "@opencode-ai/plugin"

type Permission = "ask" | "allow" | "deny"
type CompressMode = "range" | "message"

export interface Deduplication {
    enabled: boolean
    protectedTools: string[]
}

export interface CompressConfig {
    mode: CompressMode
    permission: Permission
    showCompression: boolean
    summaryBuffer: boolean
    maxContextLimit: number | `${number}%`
    minContextLimit: number | `${number}%`
    modelMaxLimits?: Record<string, number | `${number}%`>
    modelMinLimits?: Record<string, number | `${number}%`>
    nudgeFrequency: number
    iterationNudgeThreshold: number
    nudgeForce: "strong" | "soft"
    protectedTools: string[]
    protectTags: boolean
    protectUserMessages: boolean
    // v2 fork protocol (issue #573 + #590, PLAN §6.1-§6.3).
    maxCompactionRatio: number
    maxContextLimitRecovery: number
    recoveryFadeWindow: number
    forkSchemaVersion: number
    stateMaxAgeDays: number | null
}

export interface Commands {
    enabled: boolean
    protectedTools: string[]
}

export interface ManualModeConfig {
    enabled: boolean
    automaticStrategies: boolean
}

export interface PurgeErrors {
    enabled: boolean
    turns: number
    protectedTools: string[]
}

export interface TurnProtection {
    enabled: boolean
    turns: number
}

export interface ExperimentalConfig {
    allowSubAgents: boolean
    customPrompts: boolean
}

export interface PluginConfig {
    enabled: boolean
    autoUpdate: boolean
    debug: boolean
    pruneNotification: "off" | "minimal" | "detailed"
    pruneNotificationType: "chat" | "toast"
    commands: Commands
    manualMode: ManualModeConfig
    turnProtection: TurnProtection
    experimental: ExperimentalConfig
    protectedFilePatterns: string[]
    compress: CompressConfig
    strategies: {
        deduplication: Deduplication
        purgeErrors: PurgeErrors
    }
}

type CompressOverride = Partial<CompressConfig>

// ponytail: empty by design. The user's dcp.jsonc is the single source of truth
// for protectedTools — any non-empty constant here would silently leak through
// the layered merge (the merge in mergeCompress / mergeCommands / mergeStrategies
// is replace-semantics per user override). See README "Protected tools" for the
// migration story: prior behavior shipped an additive default of ["task","skill",
// "todowrite","todoread"]; the user's explicit list now fully dictates protection.
const DEFAULT_PROTECTED_TOOLS: string[] = []

const COMPRESS_DEFAULT_PROTECTED_TOOLS: string[] = []

export const VALID_CONFIG_KEYS = new Set([
    "$schema",
    "enabled",
    "autoUpdate",
    "debug",
    "pruneNotification",
    "pruneNotificationType",
    "turnProtection",
    "turnProtection.enabled",
    "turnProtection.turns",
    "experimental",
    "experimental.allowSubAgents",
    "experimental.customPrompts",
    "protectedFilePatterns",
    "commands",
    "commands.enabled",
    "commands.protectedTools",
    "manualMode",
    "manualMode.enabled",
    "manualMode.automaticStrategies",
    "compress",
    "compress.mode",
    "compress.permission",
    "compress.showCompression",
    "compress.summaryBuffer",
    "compress.maxContextLimit",
    "compress.minContextLimit",
    "compress.modelMaxLimits",
    "compress.modelMinLimits",
    "compress.nudgeFrequency",
    "compress.iterationNudgeThreshold",
    "compress.nudgeForce",
    "compress.protectedTools",
    "compress.protectTags",
    "compress.protectUserMessages",
    "compress.maxCompactionRatio",
    "compress.maxContextLimitRecovery",
    "compress.recoveryFadeWindow",
    "compress.forkSchemaVersion",
    "compress.stateMaxAgeDays",
    "strategies",
    "strategies.deduplication",
    "strategies.deduplication.enabled",
    "strategies.deduplication.protectedTools",
    "strategies.purgeErrors",
    "strategies.purgeErrors.enabled",
    "strategies.purgeErrors.turns",
    "strategies.purgeErrors.protectedTools",
])

function getConfigKeyPaths(obj: Record<string, any>, prefix = ""): string[] {
    const keys: string[] = []
    for (const key of Object.keys(obj)) {
        const fullKey = prefix ? `${prefix}.${key}` : key
        keys.push(fullKey)

        // model*Limits are dynamic maps keyed by providerID/modelID; do not recurse into arbitrary IDs.
        if (fullKey === "compress.modelMaxLimits" || fullKey === "compress.modelMinLimits") {
            continue
        }

        if (obj[key] && typeof obj[key] === "object" && !Array.isArray(obj[key])) {
            keys.push(...getConfigKeyPaths(obj[key], fullKey))
        }
    }
    return keys
}

export function getInvalidConfigKeys(userConfig: Record<string, any>): string[] {
    const userKeys = getConfigKeyPaths(userConfig)
    return userKeys.filter((key) => !VALID_CONFIG_KEYS.has(key))
}

interface ValidationError {
    key: string
    expected: string
    actual: string
}

// ponytail: shared per-item validator for the four protectedTools arrays.
// Rejects whitespace and empty strings — they would break the `<...>` wrapping
// and silently miss `isToolNameProtected` exact-set membership. Regex
// `/^\S+$/` matches SDK tool naming conventions (dots allowed; some OpenCode
// tool providers use them). BUG-084.
const TOOL_NAME_REGEX = /^\S+$/
const validateProtectedToolsEntries = (
    keyPath: string,
    entries: unknown,
    errors: ValidationError[],
): void => {
    if (!Array.isArray(entries)) {
        return
    }
    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i]
        if (typeof entry !== "string" || !TOOL_NAME_REGEX.test(entry)) {
            errors.push({
                key: `${keyPath}[${i}]`,
                expected: `non-empty tool name without whitespace (regex ${TOOL_NAME_REGEX.source})`,
                actual: JSON.stringify(entry),
            })
        }
    }
}

export function validateConfigTypes(config: Record<string, any>): ValidationError[] {
    const errors: ValidationError[] = []

    if (config.enabled !== undefined && typeof config.enabled !== "boolean") {
        errors.push({ key: "enabled", expected: "boolean", actual: typeof config.enabled })
    }

    if (config.autoUpdate !== undefined && typeof config.autoUpdate !== "boolean") {
        errors.push({ key: "autoUpdate", expected: "boolean", actual: typeof config.autoUpdate })
    }

    if (config.debug !== undefined && typeof config.debug !== "boolean") {
        errors.push({ key: "debug", expected: "boolean", actual: typeof config.debug })
    }

    if (config.pruneNotification !== undefined) {
        const validValues = ["off", "minimal", "detailed"]
        if (!validValues.includes(config.pruneNotification)) {
            errors.push({
                key: "pruneNotification",
                expected: '"off" | "minimal" | "detailed"',
                actual: JSON.stringify(config.pruneNotification),
            })
        }
    }

    if (config.pruneNotificationType !== undefined) {
        const validValues = ["chat", "toast"]
        if (!validValues.includes(config.pruneNotificationType)) {
            errors.push({
                key: "pruneNotificationType",
                expected: '"chat" | "toast"',
                actual: JSON.stringify(config.pruneNotificationType),
            })
        }
    }

    if (config.protectedFilePatterns !== undefined) {
        if (!Array.isArray(config.protectedFilePatterns)) {
            errors.push({
                key: "protectedFilePatterns",
                expected: "string[]",
                actual: typeof config.protectedFilePatterns,
            })
        } else if (!config.protectedFilePatterns.every((v: unknown) => typeof v === "string")) {
            errors.push({
                key: "protectedFilePatterns",
                expected: "string[]",
                actual: "non-string entries",
            })
        }
    }

    if (config.turnProtection) {
        if (
            config.turnProtection.enabled !== undefined &&
            typeof config.turnProtection.enabled !== "boolean"
        ) {
            errors.push({
                key: "turnProtection.enabled",
                expected: "boolean",
                actual: typeof config.turnProtection.enabled,
            })
        }

        if (
            config.turnProtection.turns !== undefined &&
            typeof config.turnProtection.turns !== "number"
        ) {
            errors.push({
                key: "turnProtection.turns",
                expected: "number",
                actual: typeof config.turnProtection.turns,
            })
        }
        if (typeof config.turnProtection.turns === "number" && config.turnProtection.turns < 1) {
            errors.push({
                key: "turnProtection.turns",
                expected: "positive number (>= 1)",
                actual: `${config.turnProtection.turns}`,
            })
        }
    }

    const experimental = config.experimental
    if (experimental !== undefined) {
        if (
            typeof experimental !== "object" ||
            experimental === null ||
            Array.isArray(experimental)
        ) {
            errors.push({
                key: "experimental",
                expected: "object",
                actual: typeof experimental,
            })
        } else {
            if (
                experimental.allowSubAgents !== undefined &&
                typeof experimental.allowSubAgents !== "boolean"
            ) {
                errors.push({
                    key: "experimental.allowSubAgents",
                    expected: "boolean",
                    actual: typeof experimental.allowSubAgents,
                })
            }

            if (
                experimental.customPrompts !== undefined &&
                typeof experimental.customPrompts !== "boolean"
            ) {
                errors.push({
                    key: "experimental.customPrompts",
                    expected: "boolean",
                    actual: typeof experimental.customPrompts,
                })
            }
        }
    }

    const commands = config.commands
    if (commands !== undefined) {
        if (typeof commands !== "object" || commands === null || Array.isArray(commands)) {
            errors.push({
                key: "commands",
                expected: "object",
                actual: typeof commands,
            })
        } else {
            if (commands.enabled !== undefined && typeof commands.enabled !== "boolean") {
                errors.push({
                    key: "commands.enabled",
                    expected: "boolean",
                    actual: typeof commands.enabled,
                })
            }
            if (commands.protectedTools !== undefined && !Array.isArray(commands.protectedTools)) {
                errors.push({
                    key: "commands.protectedTools",
                    expected: "string[]",
                    actual: typeof commands.protectedTools,
                })
            }
            validateProtectedToolsEntries(
                "commands.protectedTools",
                commands.protectedTools,
                errors,
            )
        }
    }

    const manualMode = config.manualMode
    if (manualMode !== undefined) {
        if (typeof manualMode !== "object" || manualMode === null || Array.isArray(manualMode)) {
            errors.push({
                key: "manualMode",
                expected: "object",
                actual: typeof manualMode,
            })
        } else {
            if (manualMode.enabled !== undefined && typeof manualMode.enabled !== "boolean") {
                errors.push({
                    key: "manualMode.enabled",
                    expected: "boolean",
                    actual: typeof manualMode.enabled,
                })
            }

            if (
                manualMode.automaticStrategies !== undefined &&
                typeof manualMode.automaticStrategies !== "boolean"
            ) {
                errors.push({
                    key: "manualMode.automaticStrategies",
                    expected: "boolean",
                    actual: typeof manualMode.automaticStrategies,
                })
            }
        }
    }

    const compress = config.compress
    if (compress !== undefined) {
        if (typeof compress !== "object" || compress === null || Array.isArray(compress)) {
            errors.push({
                key: "compress",
                expected: "object",
                actual: typeof compress,
            })
        } else {
            if (
                compress.mode !== undefined &&
                compress.mode !== "range" &&
                compress.mode !== "message"
            ) {
                errors.push({
                    key: "compress.mode",
                    expected: '"range" | "message"',
                    actual: JSON.stringify(compress.mode),
                })
            }

            if (
                compress.summaryBuffer !== undefined &&
                typeof compress.summaryBuffer !== "boolean"
            ) {
                errors.push({
                    key: "compress.summaryBuffer",
                    expected: "boolean",
                    actual: typeof compress.summaryBuffer,
                })
            }

            if (
                compress.nudgeFrequency !== undefined &&
                typeof compress.nudgeFrequency !== "number"
            ) {
                errors.push({
                    key: "compress.nudgeFrequency",
                    expected: "number",
                    actual: typeof compress.nudgeFrequency,
                })
            }

            if (typeof compress.nudgeFrequency === "number" && compress.nudgeFrequency < 1) {
                errors.push({
                    key: "compress.nudgeFrequency",
                    expected: "positive number (>= 1)",
                    actual: `${compress.nudgeFrequency} (will be clamped to 1)`,
                })
            }

            if (
                compress.iterationNudgeThreshold !== undefined &&
                typeof compress.iterationNudgeThreshold !== "number"
            ) {
                errors.push({
                    key: "compress.iterationNudgeThreshold",
                    expected: "number",
                    actual: typeof compress.iterationNudgeThreshold,
                })
            }

            if (
                compress.nudgeForce !== undefined &&
                compress.nudgeForce !== "strong" &&
                compress.nudgeForce !== "soft"
            ) {
                errors.push({
                    key: "compress.nudgeForce",
                    expected: '"strong" | "soft"',
                    actual: JSON.stringify(compress.nudgeForce),
                })
            }

            if (compress.protectedTools !== undefined && !Array.isArray(compress.protectedTools)) {
                errors.push({
                    key: "compress.protectedTools",
                    expected: "string[]",
                    actual: typeof compress.protectedTools,
                })
            }
            validateProtectedToolsEntries(
                "compress.protectedTools",
                compress.protectedTools,
                errors,
            )

            if (compress.protectTags !== undefined && typeof compress.protectTags !== "boolean") {
                errors.push({
                    key: "compress.protectTags",
                    expected: "boolean",
                    actual: typeof compress.protectTags,
                })
            }

            if (
                compress.protectUserMessages !== undefined &&
                typeof compress.protectUserMessages !== "boolean"
            ) {
                errors.push({
                    key: "compress.protectUserMessages",
                    expected: "boolean",
                    actual: typeof compress.protectUserMessages,
                })
            }

            if (
                typeof compress.iterationNudgeThreshold === "number" &&
                compress.iterationNudgeThreshold < 1
            ) {
                errors.push({
                    key: "compress.iterationNudgeThreshold",
                    expected: "positive number (>= 1)",
                    actual: `${compress.iterationNudgeThreshold} (will be clamped to 1)`,
                })
            }

            const validateLimitValue = (
                key: string,
                value: unknown,
                actualValue: unknown = value,
            ): void => {
                const isValidNumber = typeof value === "number"
                const isPercentString = typeof value === "string" && value.endsWith("%")

                if (!isValidNumber && !isPercentString) {
                    errors.push({
                        key,
                        expected: 'number | "${number}%"',
                        actual: JSON.stringify(actualValue),
                    })
                }
            }

            const validateModelLimits = (
                key: "compress.modelMaxLimits" | "compress.modelMinLimits",
                limits: unknown,
            ): void => {
                if (limits === undefined) {
                    return
                }

                if (typeof limits !== "object" || limits === null || Array.isArray(limits)) {
                    errors.push({
                        key,
                        expected: "Record<string, number | ${number}%>",
                        actual: typeof limits,
                    })
                    return
                }

                for (const [providerModelKey, limit] of Object.entries(limits)) {
                    const isValidNumber = typeof limit === "number"
                    const isPercentString =
                        typeof limit === "string" && /^\d+(?:\.\d+)?%$/.test(limit)
                    if (!isValidNumber && !isPercentString) {
                        errors.push({
                            key: `${key}.${providerModelKey}`,
                            expected: 'number | "${number}%"',
                            actual: JSON.stringify(limit),
                        })
                    }
                }
            }

            if (compress.maxContextLimit !== undefined) {
                validateLimitValue("compress.maxContextLimit", compress.maxContextLimit)
            }

            if (compress.minContextLimit !== undefined) {
                validateLimitValue("compress.minContextLimit", compress.minContextLimit)
            }

            validateModelLimits("compress.modelMaxLimits", compress.modelMaxLimits)
            validateModelLimits("compress.modelMinLimits", compress.modelMinLimits)

            const validValues = ["ask", "allow", "deny"]
            if (compress.permission !== undefined && !validValues.includes(compress.permission)) {
                errors.push({
                    key: "compress.permission",
                    expected: '"ask" | "allow" | "deny"',
                    actual: JSON.stringify(compress.permission),
                })
            }

            if (
                compress.showCompression !== undefined &&
                typeof compress.showCompression !== "boolean"
            ) {
                errors.push({
                    key: "compress.showCompression",
                    expected: "boolean",
                    actual: typeof compress.showCompression,
                })
            }

            // v2 fork-protocol keys (issue #573 + #590).
            if (
                compress.maxCompactionRatio !== undefined &&
                typeof compress.maxCompactionRatio !== "number"
            ) {
                errors.push({
                    key: "compress.maxCompactionRatio",
                    expected: "number",
                    actual: typeof compress.maxCompactionRatio,
                })
            }
            if (
                typeof compress.maxCompactionRatio === "number" &&
                (compress.maxCompactionRatio <= 0 || compress.maxCompactionRatio > 1)
            ) {
                errors.push({
                    key: "compress.maxCompactionRatio",
                    expected: "number in (0, 1]",
                    actual: `${compress.maxCompactionRatio} (will be clamped)`,
                })
            }

            if (
                compress.maxContextLimitRecovery !== undefined &&
                typeof compress.maxContextLimitRecovery !== "number"
            ) {
                errors.push({
                    key: "compress.maxContextLimitRecovery",
                    expected: "number",
                    actual: typeof compress.maxContextLimitRecovery,
                })
            }
            if (
                typeof compress.maxContextLimitRecovery === "number" &&
                compress.maxContextLimitRecovery < 1
            ) {
                errors.push({
                    key: "compress.maxContextLimitRecovery",
                    expected: "positive number (>= 1)",
                    actual: `${compress.maxContextLimitRecovery} (will be clamped to 1)`,
                })
            }

            if (
                compress.recoveryFadeWindow !== undefined &&
                typeof compress.recoveryFadeWindow !== "number"
            ) {
                errors.push({
                    key: "compress.recoveryFadeWindow",
                    expected: "number",
                    actual: typeof compress.recoveryFadeWindow,
                })
            }
            if (
                typeof compress.recoveryFadeWindow === "number" &&
                compress.recoveryFadeWindow < 1
            ) {
                errors.push({
                    key: "compress.recoveryFadeWindow",
                    expected: "positive number (>= 1)",
                    actual: `${compress.recoveryFadeWindow} (will be clamped to 1)`,
                })
            }

            if (
                compress.forkSchemaVersion !== undefined &&
                typeof compress.forkSchemaVersion !== "number"
            ) {
                errors.push({
                    key: "compress.forkSchemaVersion",
                    expected: "number",
                    actual: typeof compress.forkSchemaVersion,
                })
            }

            if (
                compress.stateMaxAgeDays !== undefined &&
                compress.stateMaxAgeDays !== null &&
                typeof compress.stateMaxAgeDays !== "number"
            ) {
                errors.push({
                    key: "compress.stateMaxAgeDays",
                    expected: "number | null",
                    actual: typeof compress.stateMaxAgeDays,
                })
            }
            if (typeof compress.stateMaxAgeDays === "number" && compress.stateMaxAgeDays < 0) {
                errors.push({
                    key: "compress.stateMaxAgeDays",
                    expected: "non-negative number or null",
                    actual: `${compress.stateMaxAgeDays}`,
                })
            }
        }
    }

    const strategies = config.strategies
    if (strategies) {
        if (
            strategies.deduplication?.enabled !== undefined &&
            typeof strategies.deduplication.enabled !== "boolean"
        ) {
            errors.push({
                key: "strategies.deduplication.enabled",
                expected: "boolean",
                actual: typeof strategies.deduplication.enabled,
            })
        }

        if (
            strategies.deduplication?.protectedTools !== undefined &&
            !Array.isArray(strategies.deduplication.protectedTools)
        ) {
            errors.push({
                key: "strategies.deduplication.protectedTools",
                expected: "string[]",
                actual: typeof strategies.deduplication.protectedTools,
            })
        }
        validateProtectedToolsEntries(
            "strategies.deduplication.protectedTools",
            strategies.deduplication?.protectedTools,
            errors,
        )

        if (strategies.purgeErrors) {
            if (
                strategies.purgeErrors.enabled !== undefined &&
                typeof strategies.purgeErrors.enabled !== "boolean"
            ) {
                errors.push({
                    key: "strategies.purgeErrors.enabled",
                    expected: "boolean",
                    actual: typeof strategies.purgeErrors.enabled,
                })
            }

            if (
                strategies.purgeErrors.turns !== undefined &&
                typeof strategies.purgeErrors.turns !== "number"
            ) {
                errors.push({
                    key: "strategies.purgeErrors.turns",
                    expected: "number",
                    actual: typeof strategies.purgeErrors.turns,
                })
            }
            // Warn if turns is 0 or negative - will be clamped to 1
            if (
                typeof strategies.purgeErrors.turns === "number" &&
                strategies.purgeErrors.turns < 1
            ) {
                errors.push({
                    key: "strategies.purgeErrors.turns",
                    expected: "positive number (>= 1)",
                    actual: `${strategies.purgeErrors.turns} (will be clamped to 1)`,
                })
            }
            if (
                strategies.purgeErrors.protectedTools !== undefined &&
                !Array.isArray(strategies.purgeErrors.protectedTools)
            ) {
                errors.push({
                    key: "strategies.purgeErrors.protectedTools",
                    expected: "string[]",
                    actual: typeof strategies.purgeErrors.protectedTools,
                })
            }
            validateProtectedToolsEntries(
                "strategies.purgeErrors.protectedTools",
                strategies.purgeErrors.protectedTools,
                errors,
            )
        }
    }

    return errors
}

function showConfigWarnings(
    ctx: PluginInput,
    configPath: string,
    configData: Record<string, any>,
    isProject: boolean,
): void {
    const invalidKeys = getInvalidConfigKeys(configData)
    const typeErrors = validateConfigTypes(configData)

    if (invalidKeys.length === 0 && typeErrors.length === 0) {
        return
    }

    const configType = isProject ? "project config" : "config"
    const messages: string[] = []

    if (invalidKeys.length > 0) {
        const keyList = invalidKeys.slice(0, 3).join(", ")
        const suffix = invalidKeys.length > 3 ? ` (+${invalidKeys.length - 3} more)` : ""
        messages.push(`Unknown keys: ${keyList}${suffix}`)
    }

    if (typeErrors.length > 0) {
        for (const err of typeErrors.slice(0, 2)) {
            messages.push(`${err.key}: expected ${err.expected}, got ${err.actual}`)
        }
        if (typeErrors.length > 2) {
            messages.push(`(+${typeErrors.length - 2} more type errors)`)
        }
    }

    setTimeout(() => {
        try {
            ctx.client.tui.showToast({
                body: {
                    title: `DCP: ${configType} warning`,
                    message: `${configPath}\n${messages.join("\n")}`,
                    variant: "warning",
                    duration: 7000,
                },
            })
        } catch {}
    }, 7000)
}

const defaultConfig: PluginConfig = {
    enabled: true,
    autoUpdate: false,
    debug: false,
    pruneNotification: "detailed",
    pruneNotificationType: "chat",
    commands: {
        enabled: true,
        protectedTools: [...DEFAULT_PROTECTED_TOOLS],
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
        mode: "range",
        permission: "allow",
        showCompression: false,
        summaryBuffer: true,
        maxContextLimit: 100000,
        minContextLimit: 50000,
        nudgeFrequency: 5,
        iterationNudgeThreshold: 15,
        nudgeForce: "soft",
        protectedTools: [...COMPRESS_DEFAULT_PROTECTED_TOOLS],
        protectTags: false,
        protectUserMessages: false,
        maxCompactionRatio: 0.7,
        maxContextLimitRecovery: 3,
        recoveryFadeWindow: 5,
        forkSchemaVersion: 3,
        stateMaxAgeDays: null,
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

function findOpencodeDir(startDir: string): string | null {
    let current = startDir
    while (true) {
        const candidate = join(current, ".opencode")
        if (existsSync(candidate) && statSync(candidate).isDirectory()) {
            return candidate
        }
        const parent = dirname(current)
        // ponytail: universal termination — `parent === current` is the sole
        // root guard (works on POSIX `/` and Windows `C:\`). The previous
        // loop header compared `current` to the POSIX root path, which is
        // always true on Windows; the loop only ended via this secondary
        // break. BUG-016.
        if (parent === current) {
            break
        }
        current = parent
    }
    return null
}

function getConfigPaths(ctx?: PluginInput): {
    global: string | null
    configDir: string | null
    project: string | null
} {
    // Resolve XDG_CONFIG_HOME when loading, not when this module is imported.
    const globalConfigDir = process.env.XDG_CONFIG_HOME
        ? join(process.env.XDG_CONFIG_HOME, "opencode")
        : join(homedir(), ".config", "opencode")
    const globalConfigPathJsonc = join(globalConfigDir, "dcp.jsonc")
    const globalConfigPathJson = join(globalConfigDir, "dcp.json")
    const global = existsSync(globalConfigPathJsonc)
        ? globalConfigPathJsonc
        : existsSync(globalConfigPathJson)
          ? globalConfigPathJson
          : null

    let configDir: string | null = null
    const opencodeConfigDir = process.env.OPENCODE_CONFIG_DIR
    if (opencodeConfigDir) {
        const configJsonc = join(opencodeConfigDir, "dcp.jsonc")
        const configJson = join(opencodeConfigDir, "dcp.json")
        configDir = existsSync(configJsonc)
            ? configJsonc
            : existsSync(configJson)
              ? configJson
              : null
    }

    let project: string | null = null
    if (ctx?.directory) {
        const opencodeDir = findOpencodeDir(ctx.directory)
        if (opencodeDir) {
            const projectJsonc = join(opencodeDir, "dcp.jsonc")
            const projectJson = join(opencodeDir, "dcp.json")
            project = existsSync(projectJsonc)
                ? projectJsonc
                : existsSync(projectJson)
                  ? projectJson
                  : null
        }
    }

    return { global, configDir, project }
}

interface ConfigLoadResult {
    data: Record<string, any> | null
    parseError?: string
}

function loadConfigFile(configPath: string): ConfigLoadResult {
    let fileContent = ""
    try {
        fileContent = readFileSync(configPath, "utf-8")
    } catch {
        return { data: null }
    }

    try {
        const parsed = parse(fileContent, undefined, { allowTrailingComma: true })
        if (parsed === undefined || parsed === null) {
            return { data: null, parseError: "Config file is empty or invalid" }
        }
        return { data: parsed }
    } catch (error: any) {
        return { data: null, parseError: error.message || "Failed to parse config" }
    }
}

function mergeStrategies(
    base: PluginConfig["strategies"],
    override?: Partial<PluginConfig["strategies"]>,
): PluginConfig["strategies"] {
    if (!override) {
        return base
    }

    return {
        deduplication: {
            enabled: override.deduplication?.enabled ?? base.deduplication.enabled,
            // ponytail: replace-semantics per user override — see mergeCompress rationale.
            protectedTools:
                override.deduplication?.protectedTools ?? base.deduplication.protectedTools,
        },
        purgeErrors: {
            enabled: override.purgeErrors?.enabled ?? base.purgeErrors.enabled,
            turns: clampMin1(override.purgeErrors?.turns ?? base.purgeErrors.turns),
            // ponytail: replace-semantics per user override — see mergeCompress rationale.
            protectedTools: override.purgeErrors?.protectedTools ?? base.purgeErrors.protectedTools,
        },
    }
}

function mergeCompress(
    base: PluginConfig["compress"],
    override?: CompressOverride,
): PluginConfig["compress"] {
    if (!override) {
        return base
    }

    return {
        mode: override.mode ?? base.mode,
        permission: override.permission ?? base.permission,
        showCompression: override.showCompression ?? base.showCompression,
        summaryBuffer: override.summaryBuffer ?? base.summaryBuffer,
        maxContextLimit: override.maxContextLimit ?? base.maxContextLimit,
        minContextLimit: override.minContextLimit ?? base.minContextLimit,
        // ponytail: per-key additive merge (Set-union by providerID/modelID).
        // Pre-fix this was replace-semantics: a project-layer entry for one
        // model silently wiped every global override. The schema treats these
        // as per-model overrides, so per-key merge matches user intent.
        // Add when the user asks for full-replace semantics.
        modelMaxLimits: { ...base.modelMaxLimits, ...override.modelMaxLimits },
        modelMinLimits: { ...base.modelMinLimits, ...override.modelMinLimits },
        nudgeFrequency: clampMin1(override.nudgeFrequency ?? base.nudgeFrequency),
        iterationNudgeThreshold: clampMin1(
            override.iterationNudgeThreshold ?? base.iterationNudgeThreshold,
        ),
        nudgeForce: override.nudgeForce ?? base.nudgeForce,
        // ponytail: replace-semantics, not additive. The user's dcp.jsonc is the
        // single source of truth — `protectedTools: []` must mean "nothing
        // protected", not "merge with the hardcoded default". Pre-fix this line
        // was `[...new Set([...base.protectedTools, ...override.protectedTools ?? []])]`,
        // which silently kept the legacy default alive. Add when the user asks
        // for inheritance from a different layer (e.g., env-scoped).
        protectedTools: override.protectedTools ?? base.protectedTools,
        protectTags: override.protectTags ?? base.protectTags,
        protectUserMessages: override.protectUserMessages ?? base.protectUserMessages,
        // v2 fork protocol
        maxCompactionRatio: clampRatio(override.maxCompactionRatio ?? base.maxCompactionRatio),
        maxContextLimitRecovery: clampMin1(
            override.maxContextLimitRecovery ?? base.maxContextLimitRecovery,
        ),
        recoveryFadeWindow: clampMin1(override.recoveryFadeWindow ?? base.recoveryFadeWindow),
        forkSchemaVersion: override.forkSchemaVersion ?? base.forkSchemaVersion,
        stateMaxAgeDays: clampNullOrNonNeg(
            override.stateMaxAgeDays === undefined
                ? base.stateMaxAgeDays
                : override.stateMaxAgeDays,
        ),
    }
}

export function clampRatio(value: number): number {
    if (typeof value !== "number" || !Number.isFinite(value)) return 0.7
    if (value <= 0) return 0.7
    if (value > 1) return 1
    return value
}

export function clampMin1(value: number): number {
    if (typeof value !== "number" || !Number.isFinite(value)) return 1
    return value < 1 ? 1 : value
}

export function clampNullOrNonNeg(value: number | null | undefined): number | null {
    if (value === null || value === undefined) return null
    if (typeof value !== "number" || !Number.isFinite(value)) return null
    return value < 0 ? 0 : value
}

function mergeCommands(
    base: PluginConfig["commands"],
    override?: Partial<PluginConfig["commands"]>,
): PluginConfig["commands"] {
    if (!override) {
        return base
    }

    return {
        enabled: override.enabled ?? base.enabled,
        // ponytail: replace-semantics per user override — see mergeCompress rationale.
        protectedTools: override.protectedTools ?? base.protectedTools,
    }
}

function mergeManualMode(
    base: PluginConfig["manualMode"],
    override?: Partial<PluginConfig["manualMode"]>,
): PluginConfig["manualMode"] {
    if (override === undefined) return base

    return {
        enabled: override.enabled ?? base.enabled,
        automaticStrategies: override.automaticStrategies ?? base.automaticStrategies,
    }
}

function mergeExperimental(
    base: PluginConfig["experimental"],
    override?: Partial<PluginConfig["experimental"]>,
): PluginConfig["experimental"] {
    if (override === undefined) return base

    return {
        allowSubAgents: override.allowSubAgents ?? base.allowSubAgents,
        customPrompts: override.customPrompts ?? base.customPrompts,
    }
}

function deepCloneConfig(config: PluginConfig): PluginConfig {
    return {
        ...config,
        commands: {
            enabled: config.commands.enabled,
            protectedTools: [...config.commands.protectedTools],
        },
        manualMode: {
            enabled: config.manualMode.enabled,
            automaticStrategies: config.manualMode.automaticStrategies,
        },
        turnProtection: { ...config.turnProtection },
        experimental: { ...config.experimental },
        protectedFilePatterns: [...config.protectedFilePatterns],
        compress: {
            ...config.compress,
            modelMaxLimits: { ...config.compress.modelMaxLimits },
            modelMinLimits: { ...config.compress.modelMinLimits },
            protectedTools: [...config.compress.protectedTools],
        },
        strategies: {
            deduplication: {
                ...config.strategies.deduplication,
                protectedTools: [...config.strategies.deduplication.protectedTools],
            },
            purgeErrors: {
                ...config.strategies.purgeErrors,
                protectedTools: [...config.strategies.purgeErrors.protectedTools],
            },
        },
    }
}

function mergeLayer(config: PluginConfig, data: Record<string, any>): PluginConfig {
    return {
        enabled: data.enabled ?? config.enabled,
        autoUpdate: data.autoUpdate ?? config.autoUpdate,
        debug: data.debug ?? config.debug,
        pruneNotification: data.pruneNotification ?? config.pruneNotification,
        pruneNotificationType: data.pruneNotificationType ?? config.pruneNotificationType,
        // ponytail: mergeLayer's `data` parameter is `Record<string, any>`, so per-section casts bridge into the typed merge helpers. Tighten to `DeepPartial<PluginConfig>` to drop all four casts in one pass.
        commands: mergeCommands(config.commands, data.commands as any),
        // ponytail: same mergeLayer seam as the commands cast above — see header comment.
        manualMode: mergeManualMode(config.manualMode, data.manualMode as any),
        turnProtection: {
            enabled: data.turnProtection?.enabled ?? config.turnProtection.enabled,
            turns: data.turnProtection?.turns ?? config.turnProtection.turns,
        },
        // ponytail: same mergeLayer seam as the commands cast above — see header comment.
        experimental: mergeExperimental(config.experimental, data.experimental as any),
        protectedFilePatterns: [
            ...new Set([...config.protectedFilePatterns, ...(data.protectedFilePatterns ?? [])]),
        ],
        compress: mergeCompress(config.compress, data.compress as CompressOverride),
        // ponytail: same mergeLayer seam as the commands cast above — see header comment.
        strategies: mergeStrategies(config.strategies, data.strategies as any),
    }
}

function scheduleParseWarning(ctx: PluginInput, title: string, message: string): void {
    setTimeout(() => {
        try {
            ctx.client.tui.showToast({
                body: {
                    title,
                    message,
                    variant: "warning",
                    duration: 7000,
                },
            })
        } catch {}
    }, 7000)
}

export function getConfig(ctx: PluginInput): PluginConfig {
    let config = deepCloneConfig(defaultConfig)
    const configPaths = getConfigPaths(ctx)

    // ponytail: no unrequested side-effects at plugin init — a user who
    // intentionally deleted dcp.jsonc gets defaults, not a silently recreated
    // file. BUG-068.

    const layers: Array<{ path: string | null; name: string; isProject: boolean }> = [
        { path: configPaths.global, name: "config", isProject: false },
        { path: configPaths.configDir, name: "configDir config", isProject: true },
        { path: configPaths.project, name: "project config", isProject: true },
    ]

    for (const layer of layers) {
        if (!layer.path) {
            continue
        }

        const result = loadConfigFile(layer.path)
        if (result.parseError) {
            scheduleParseWarning(
                ctx,
                `DCP: Invalid ${layer.name}`,
                `${layer.path}\n${result.parseError}\nUsing previous/default values`,
            )
            continue
        }

        if (!result.data) {
            continue
        }

        showConfigWarnings(ctx, layer.path, result.data, layer.isProject)
        config = mergeLayer(config, result.data)
    }

    return config
}
