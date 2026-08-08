import type { WithParts } from "./state/types"
import { createHash } from "node:crypto"

// Patterns that mark OpenCode-injected synthetic content added to the user
// message stream on agent switches, skill evaluations, and similar events.
// Detecting these lets us attribute balloon growth to either (a) genuine
// user/assistant content or (b) system-side injections we cannot control.
// Ponytail: regex set is intentionally narrow; false positives in user text
// are tolerable — we want signal, not a parse-perfect count.
const SYNTHETIC_BLOCK_PATTERNS: Array<{ name: string; regex: RegExp }> = [
    {
        name: "agent-switch-notice",
        regex: /<agent-switch-notice>[\s\S]*?<\/agent-switch-notice>/g,
    },
    {
        name: "available-subagents",
        regex: /<available-subagents>[\s\S]*?<\/available-subagents>/g,
    },
    {
        name: "available-skills",
        regex: /<available-skills>[\s\S]*?<\/available-skills>/g,
    },
    {
        name: "skill-evaluation-required",
        regex: /<skill-evaluation-required>[\s\S]*?<\/skill-evaluation-required>/g,
    },
    {
        name: "task-result",
        regex: /<task_result>[\s\S]*?<\/task_result>/g,
    },
    {
        name: "task",
        regex: /<task>[\s\S]*?<\/task>/g,
    },
]

export interface SyntheticBlockReport {
    byType: Record<string, number>
    totalCount: number
    totalBytes: number
}

export function detectSyntheticBlocks(messages: WithParts[]): SyntheticBlockReport {
    const byType: Record<string, number> = {}
    let totalCount = 0
    let totalBytes = 0

    for (const msg of messages) {
        if (!msg.parts) continue
        for (const part of msg.parts) {
            // Ponytail: the Part union is a closed tagged type; we accept
            // any shape that has a `text` field rather than enumerating the
            // variants. New part kinds won't silently break detection.
            const text = (part as { text?: unknown }).text
            if (typeof text !== "string") continue

            for (const pattern of SYNTHETIC_BLOCK_PATTERNS) {
                pattern.regex.lastIndex = 0
                const matches = text.match(pattern.regex)
                if (!matches) continue
                byType[pattern.name] = (byType[pattern.name] || 0) + matches.length
                totalCount += matches.length
                for (const m of matches) totalBytes += m.length
            }
        }
    }

    return { byType, totalCount, totalBytes }
}

export interface AssistantTokenSnapshot {
    cacheRead: number
    input: number
    output: number
    cacheWrite: number
    reasoning: number
    messageId: string | null
    messageTime: number | null
}

export function extractLastAssistantTokens(messages: WithParts[]): AssistantTokenSnapshot {
    const empty: AssistantTokenSnapshot = {
        cacheRead: 0,
        input: 0,
        output: 0,
        cacheWrite: 0,
        reasoning: 0,
        messageId: null,
        messageTime: null,
    }

    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        const info = msg.info
        if (!info || info.role !== "assistant") continue
        const tokens = info.tokens
        if (!tokens) continue

        return {
            cacheRead: tokens.cache?.read ?? 0,
            input: tokens.input ?? 0,
            output: tokens.output ?? 0,
            cacheWrite: tokens.cache?.write ?? 0,
            reasoning: tokens.reasoning ?? 0,
            messageId: info.id ?? null,
            messageTime: info.time?.created ?? null,
        }
    }

    return empty
}

/** Stable hash over the most recent user-message text. Used to detect
 *  prompt-cache prefix changes between transform fires: a different hash
 *  means OpenCode rebuilt the user-side prefix (synthetic injections,
 *  user message edit, etc.) and the provider will treat prior content
 *  as a cache miss. Ponytail: SHA-256 truncated to 16 hex chars —
 *  collision-resistant enough for a session-scoped event log. */
export function computePrefixHash(messages: WithParts[]): string {
    const hash = createHash("sha256")

    // Hash the LAST 5 user messages' text content (capped per-part) so we
    // pick up both the user's actual request and any synthetic injections
    // appended after it. We scan from the tail backwards.
    let userCount = 0
    let charsHashed = 0
    const maxChars = 50_000

    for (let i = messages.length - 1; i >= 0 && userCount < 5 && charsHashed < maxChars; i--) {
        const msg = messages[i]
        if (msg.info?.role !== "user") continue
        userCount++
        if (!msg.parts) continue
        for (const part of msg.parts) {
            const text = (part as { text?: unknown }).text
            if (typeof text !== "string") continue
            const slice = text.length > 2000 ? text.substring(0, 2000) : text
            hash.update(slice)
            charsHashed += slice.length
            if (charsHashed >= maxChars) break
        }
    }

    return hash.digest("hex").substring(0, 16)
}

export function countTaskToolOutputs(messages: WithParts[]): number {
    let count = 0
    for (const msg of messages) {
        if (!msg.parts) continue
        for (const part of msg.parts) {
            const p = part as { type?: string; tool?: string }
            if (p.type === "tool" && p.tool === "task") count++
        }
    }
    return count
}

/** Approximate byte-size estimate of the outbound message array. Avoids
 *  the cost of JSON.stringify on multi-MB arrays; per-part length sums
 *  are within ~5% of the wire size for this plugin's payload shape. */
export function estimateMessageBytes(messages: WithParts[]): number {
    let total = 0
    for (const msg of messages) {
        total += (msg.info?.id?.length || 0) + 80 // info wrapper overhead
        if (!msg.parts) continue
        for (const part of msg.parts) {
            const p = part as Record<string, unknown>
            if (p.type === "text" && typeof p.text === "string") {
                total += p.text.length
            } else if (p.type === "reasoning" && typeof p.text === "string") {
                total += p.text.length
            } else if (p.type === "tool") {
                const sp = p.state as Record<string, unknown> | undefined
                if (sp) {
                    if (typeof sp.input === "string") total += sp.input.length
                    if (typeof sp.output === "string") total += sp.output.length
                    if (sp.input && typeof sp.input === "object")
                        total += JSON.stringify(sp.input).length
                    if (sp.output && typeof sp.output === "object")
                        total += JSON.stringify(sp.output).length
                    if (sp.metadata) total += JSON.stringify(sp.metadata).length
                }
            }
        }
    }
    return total
}

export interface DiagnosticEvent {
    ts: string
    sessionId: string | null
    fireNumber: number
    messageCount: number
    estimatedBytes: number
    synthetic: SyntheticBlockReport
    taskToolCount: number
    lastAssistant: AssistantTokenSnapshot
    prefixHash: string
    prevPrefixHash: string | null
    prefixChanged: boolean
    /** True when the last assistant message shows cache.read close to 0 AND
     *  input is large — the classic prompt-cache-miss signature. */
    possibleCacheMiss: boolean
    /** Time since the previous transform fire, in ms. Useful for correlating
     *  cache TTL expiry with balloon events. */
    msSinceLastFire: number | null
}

export function buildDiagnosticEvent(
    state: {
        diagnostic?: { fireCount: number; lastPrefixHash: string | null; lastFireAt: number | null }
    },
    sessionId: string | null,
    messages: WithParts[],
    now: number,
): DiagnosticEvent {
    const fireNumber = (state.diagnostic?.fireCount || 0) + 1
    const synthetic = detectSyntheticBlocks(messages)
    const lastAssistant = extractLastAssistantTokens(messages)
    const prefixHash = computePrefixHash(messages)
    const prevPrefixHash = state.diagnostic?.lastPrefixHash ?? null
    const prefixChanged = prevPrefixHash !== null && prefixHash !== prevPrefixHash

    // Heuristic: fresh input >> 1K AND cache.read < 1K AND not the very first
    // fire — classic prompt-cache-miss signature after a prefix change or TTL.
    const possibleCacheMiss =
        lastAssistant.input > 1000 && lastAssistant.cacheRead < 1024 && fireNumber > 1

    const lastFireAt = state.diagnostic?.lastFireAt ?? null
    const msSinceLastFire = lastFireAt !== null ? now - lastFireAt : null

    return {
        ts: new Date(now).toISOString(),
        sessionId,
        fireNumber,
        messageCount: messages.length,
        estimatedBytes: estimateMessageBytes(messages),
        synthetic,
        taskToolCount: countTaskToolOutputs(messages),
        lastAssistant,
        prefixHash,
        prevPrefixHash,
        prefixChanged,
        possibleCacheMiss,
        msSinceLastFire,
    }
}
