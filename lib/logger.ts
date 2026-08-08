import { writeFile, mkdir, appendFile } from "fs/promises"
import { join } from "path"
import { existsSync } from "fs"
import { homedir } from "os"
import { createHash } from "node:crypto"

export class Logger {
    private logDir: string
    public enabled: boolean
    // M2.5c Fix 4 — saveContext change-detection cache. Hashes the minimized
    // payload per session so a transform-hook fire with no real change skips
    // the disk write entirely. Module-level Map is shared across Logger
    // instances inside one process — the fork constructs one Logger per
    // session, so the key is sessionId. BUG-046/069: cap at 500 entries
    // with FIFO eviction so long-lived TUI/desktop sidecars do not grow
    // this map linearly with session count over the process lifetime.
    // ponytail: FIFO over LRU — the change-detection only needs the most
    // recent hash, so re-insertion is cheap. Upgrade to LRU if hot sessions
    // churn and the cap starts evicting them.
    private static lastMinimizedHashBySession = new Map<string, string>()
    private static lastMinimizedHashOrder: string[] = []
    private static readonly HASH_CACHE_CAP = 500
    // ponytail: process-local sequence prevents same-millisecond collisions; add cross-process coordination only if dump writers multiply.
    private static saveContextSequence = 0
    // BUG-044: per-session write timestamp — gates saveContext behind a real
    // rate-limit so content churn (synthetic timestamps, nudges, message-ids)
    // does not produce one disk write per transform fire. The change-detection
    // hash above still short-circuits exact-match fires; this gate kicks in
    // for distinct payloads in rapid succession. ponytail: 60s ceiling —
    // transform fires within the window dedupe; add per-fire cache eviction
    // only if the session count ever causes the map to grow unbounded.
    private static lastWriteMsBySession = new Map<string, number>()

    constructor(enabled: boolean) {
        this.enabled = enabled
        const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
        this.logDir = join(configHome, "opencode", "logs", "dcp")
    }

    private async ensureLogDir() {
        if (!existsSync(this.logDir)) {
            await mkdir(this.logDir, { recursive: true })
        }
    }

    private formatData(data?: any): string {
        if (!data) return ""

        const parts: string[] = []
        for (const [key, value] of Object.entries(data)) {
            if (value === undefined || value === null) continue

            // Format arrays compactly
            if (Array.isArray(value)) {
                if (value.length === 0) continue
                parts.push(
                    `${key}=[${value.slice(0, 3).join(",")}${value.length > 3 ? `...+${value.length - 3}` : ""}]`,
                )
            } else if (typeof value === "object") {
                const str = JSON.stringify(value)
                if (str.length < 50) {
                    parts.push(`${key}=${str}`)
                }
            } else {
                parts.push(`${key}=${value}`)
            }
        }
        return parts.join(" ")
    }

    // ponytail: amortised call-site cache keyed by `file:line`. The same call
    // site (e.g., a tight loop calling logger.info 100x) hits the cache after
    // the first stack parse — no prepareStackTrace swap, no CallSite array.
    // BUG-036: 100 log calls previously triggered 100 stack walks AND 100
    // global prepareStackTrace swaps; now they trigger 1 of each (just the
    // string stack parse). Cap at 256 entries to bound memory in long-lived
    // processes that churn through distinct call sites.
    private static callerFileCache = new Map<string, string>()
    private static callerFileCacheOrder: string[] = []
    private static readonly CALLER_CACHE_CAP = 256

    private getCallerFile(skipFrames: number = 3): string {
        try {
            // Parse the string-form stack (default behaviour, no
            // prepareStackTrace swap required). Format per frame is
            // `    at <func> (<file>:<line>:<col>)`. We extract the first
            // non-logger frame after `skipFrames` skips.
            const stackStr = new Error().stack ?? ""
            const lines = stackStr.split("\n")
            for (let i = skipFrames; i < lines.length; i++) {
                const line = lines[i]
                const m = line.match(/\((.+?):(\d+):\d+\)/)
                if (!m) continue
                const filename = m[1]
                if (!filename || filename.includes("/logger.")) continue

                const lineno = m[2]
                const cacheKey = `${filename}:${lineno}`
                const cached = Logger.callerFileCache.get(cacheKey)
                if (cached !== undefined) return cached

                const fileMatch = filename.match(/([^/\\]+)\.[tj]s$/)
                const component = fileMatch ? fileMatch[1] : filename

                if (Logger.callerFileCache.size >= Logger.CALLER_CACHE_CAP) {
                    const evict = Logger.callerFileCacheOrder.shift()
                    if (evict !== undefined) Logger.callerFileCache.delete(evict)
                }
                Logger.callerFileCache.set(cacheKey, component)
                Logger.callerFileCacheOrder.push(cacheKey)
                return component
            }
            return "unknown"
        } catch {
            return "unknown"
        }
    }

    private async write(level: string, component: string, message: string, data?: any) {
        if (!this.enabled) return

        try {
            await this.ensureLogDir()

            const timestamp = new Date().toISOString()
            const dataStr = this.formatData(data)

            const logLine = `${timestamp} ${level.padEnd(5)} ${component}: ${message}${dataStr ? " | " + dataStr : ""}\n`

            const dailyLogDir = join(this.logDir, "daily")
            if (!existsSync(dailyLogDir)) {
                await mkdir(dailyLogDir, { recursive: true })
            }

            const logFile = join(dailyLogDir, `${new Date().toISOString().split("T")[0]}.log`)
            await writeFile(logFile, logLine, { flag: "a" })
        } catch (error) {}
    }

    info(message: string, data?: any) {
        const component = this.getCallerFile(2)
        return this.write("INFO", component, message, data)
    }

    /** Append a structured diagnostic event as one JSONL line under
     *  `{logDir}/diagnostic/{date}-{sessionShort}.jsonl`. Used for cache /
     *  prefix tracking across transform fires — easier to parse with `jq`
     *  than the human-readable daily log. Ponytail: gated on `enabled`
     *  like the other methods so debug-off sessions stay quiet. */
    async diagnostic(event: Record<string, unknown>): Promise<void> {
        if (!this.enabled) return
        try {
            await this.ensureLogDir()
            const diagDir = join(this.logDir, "diagnostic")
            if (!existsSync(diagDir)) {
                await mkdir(diagDir, { recursive: true })
            }
            const today = new Date().toISOString().split("T")[0]
            const sessionShort = ((event.sessionId as string | null) || "unknown").substring(0, 16)
            const diagFile = join(diagDir, `${today}-${sessionShort}.jsonl`)
            await appendFile(diagFile, JSON.stringify(event) + "\n")
        } catch {
            // Diagnostic writes are best-effort — never block the transform.
        }
    }

    debug(message: string, data?: any) {
        const component = this.getCallerFile(2)
        return this.write("DEBUG", component, message, data)
    }

    warn(message: string, data?: any) {
        const component = this.getCallerFile(2)
        return this.write("WARN", component, message, data)
    }

    error(message: string, data?: any) {
        const component = this.getCallerFile(2)
        return this.write("ERROR", component, message, data)
    }

    /**
     * Strips unnecessary metadata from messages for cleaner debug logs.
     *
     * Removed:
     * - All IDs (id, sessionID, messageID, parentID)
     * - summary, path, cost, model, agent, mode, finish, providerID, modelID
     * - step-start and step-finish parts entirely
     * - snapshot fields
     * - ignored text parts
     *
     * Kept:
     * - role, time (created only), tokens (input, output, reasoning, cache)
     * - text, reasoning, tool parts with content
     * - tool calls with: tool, callID, input, output, metadata
     */
    private minimizeForDebug(messages: any[]): any[] {
        return messages.map((msg) => {
            const minimized: any = {
                role: msg.info?.role,
            }

            if (msg.info?.time?.created) {
                minimized.time = msg.info.time.created
            }

            if (msg.info?.tokens) {
                minimized.tokens = {
                    input: msg.info.tokens.input,
                    output: msg.info.tokens.output,
                    reasoning: msg.info.tokens.reasoning,
                    cache: msg.info.tokens.cache,
                }
            }

            if (msg.parts) {
                minimized.parts = msg.parts
                    .map((part: any) => {
                        if (part.type === "step-start" || part.type === "step-finish") {
                            return null
                        }

                        if (part.type === "text") {
                            if (part.ignored) return null
                            const textPart: any = { type: "text", text: part.text }
                            if (part.metadata) textPart.metadata = part.metadata
                            return textPart
                        }

                        if (part.type === "reasoning") {
                            const reasoningPart: any = { type: "reasoning", text: part.text }
                            if (part.metadata) reasoningPart.metadata = part.metadata
                            return reasoningPart
                        }

                        if (part.type === "tool") {
                            const toolPart: any = {
                                type: "tool",
                                tool: part.tool,
                                callID: part.callID,
                            }

                            if (part.state?.status) {
                                toolPart.status = part.state.status
                            }
                            if (part.state?.input) {
                                toolPart.input = part.state.input
                            }
                            if (part.state?.output) {
                                toolPart.output = part.state.output
                            }
                            if (part.state?.error) {
                                toolPart.error = part.state.error
                            }
                            if (part.metadata) {
                                toolPart.metadata = part.metadata
                            }
                            if (part.state?.metadata) {
                                toolPart.metadata = {
                                    ...(toolPart.metadata || {}),
                                    ...part.state.metadata,
                                }
                            }
                            if (part.state?.title) {
                                toolPart.title = part.state.title
                            }

                            return toolPart
                        }

                        return null
                    })
                    .filter(Boolean)
            }

            return minimized
        })
    }

    async saveContext(sessionId: string, messages: any[]) {
        if (!this.enabled) return

        // BUG-044: per-session write rate-limit. Bounds disk writes when the
        // payload churns every fire (synthetic timestamps, nudges, message-ids).
        // The change-detection hash check below still short-circuits exact-match
        // fires; this gate catches the churn case where every fire is unique.
        const lastWriteMs = Logger.lastWriteMsBySession.get(sessionId) ?? 0
        if (lastWriteMs !== 0 && Date.now() - lastWriteMs < 60_000) {
            return
        }

        try {
            const minimized = this.minimizeForDebug(messages).filter(
                (msg) => msg.parts && msg.parts.length > 0,
            )

            // M2.5c Fix 4 — change-detection. Hash the minimized payload and
            // skip the disk write when nothing changed since the last fire
            // for this session. The fork transforms can fire many times per
            // second when nudges / message-ids mutate every pass; without
            // this gate, a debug session writes a multi-MB JSON per fire.
            // ponytail: stringify once and reuse — the hash uses the compact
            // form (no indentation) and the write uses pretty-print; they
            // share the same canonical field order from minimizeForDebug so
            // both produce the same hash input.
            const payload = JSON.stringify(minimized)
            const hash = createHash("sha256").update(payload).digest("hex")
            const previousHash = Logger.lastMinimizedHashBySession.get(sessionId)
            if (hash === previousHash) {
                return
            }
            Logger.lastMinimizedHashBySession.set(sessionId, hash)
            Logger.lastMinimizedHashOrder.push(sessionId)
            if (Logger.lastMinimizedHashBySession.size > Logger.HASH_CACHE_CAP) {
                const evict = Logger.lastMinimizedHashOrder.shift()
                if (evict !== undefined) Logger.lastMinimizedHashBySession.delete(evict)
            }

            const contextDir = join(this.logDir, "context", sessionId)
            if (!existsSync(contextDir)) {
                await mkdir(contextDir, { recursive: true })
            }
            const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
            const contextFile = join(
                contextDir,
                `${timestamp}-${++Logger.saveContextSequence}.json`,
            )
            await writeFile(contextFile, `${payload}\n`)
            Logger.lastWriteMsBySession.set(sessionId, Date.now())
        } catch (error) {}
    }

    /** Test-only — clear the change-detection hash cache between tests.
     *  ponytail: this exists because module-level Map state survives across
     *  tests within one process; tests need a deterministic reset rather
     *  than relying on `Date.now()`-suffixed sessionIds. Add when tests
     *  cannot derive fresh sessionIds per case. */
    static clearSaveContextCache(): void {
        Logger.lastMinimizedHashBySession.clear()
        Logger.lastWriteMsBySession.clear()
    }
}
