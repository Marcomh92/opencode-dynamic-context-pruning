import type { WithParts } from "../state"

// ponytail: regex special chars from MDN; covers all escape requirements for
// literal substring matching. Plain-text patterns from user config must not
// inject regex syntax into a compiled RegExp.
const REGEX_SPECIAL_CHARS = /[.*+?^${}()|[\]\\]/g
function escapeRegex(s: string): string {
    return s.replace(REGEX_SPECIAL_CHARS, "\\$&")
}

/** Compile one user pattern into a global regex.
 *  - `<name>` (single angle-bracketed tag, no other `>`): matches the entire
 *    `<name>...</name>` block including content. Lazy match. Matches the
 *    `<available-skills>...</available-skills>` shape that plugins use.
 *  - anything else: literal substring match (regex special chars escaped).
 *
 *  ponytail: two-mode because the block-name case is what users actually write
 *  (`<available-skills>`); literal-substring is the fallback for arbitrary
 *  strings (`[TODO]`, `End of section`, etc.). Add a third mode (full regex
 *  passthrough) when a user needs anchor semantics.
 *
 *  Caveat: an orphan tag like `<a>` (no matching `</a>`) is always interpreted
 *  as a block-name pattern — the literal-substring fallback does not match the
 *  shape. To literally match `<a>`, escape it or pass a different substring. */
export const compileStripPattern = (pattern: string): RegExp => {
    if (/^<[^>]+>$/.test(pattern)) {
        const name = pattern.slice(1, -1)
        return new RegExp(`<${escapeRegex(name)}>[\\s\\S]*?</${escapeRegex(name)}>`, "g")
    }
    return new RegExp(escapeRegex(pattern), "g")
}

/** Strip matching text patterns from a single string. Each entry in `patterns`
 *  is interpreted by `compileStripPattern`: `<name>` becomes a whole-block
 *  match; any other string becomes a literal substring. Returns the input
 *  unchanged when `patterns` is empty. Idempotent — re-running on already-
 *  stripped text is a no-op. Compile-once-strip-many: caller pays the regex
 *  compile cost once per call regardless of how many patterns are listed. */
export function stripText(text: string, patterns: readonly string[]): string {
    if (!patterns || patterns.length === 0) return text
    // ponytail: pre-compile once per fire; reuse the regex across all parts.
    // Avoids per-part recompile on hot path (every LLM fetch).
    const compiled = patterns.map(compileStripPattern)
    let next = text
    for (const re of compiled) {
        next = next.replace(re, "")
    }
    return next
}

// ponytail: dead at runtime since the BUG-095 fix moved stripPatterns out of
// the transform pipeline (see `known_issues/BUG-095-strippatterns-llm-context-
// strip.md`). The 14 tests in `tests/strip-patterns.test.ts` still pin
// `compileStripPattern`'s regex shape and serve as the contract for `stripText`.
// Delete this function and its tests only when `stripText` also has direct
// regex-shape coverage.
export function stripPatterns(
    messages: WithParts[],
    patterns: readonly string[] | undefined,
): void {
    // ponytail: tolerate `undefined` so test fixtures that pre-date the
    // `CompressConfig.stripPatterns` field still pass — TS does not check
    // `tests/**` per tsconfig.json. Production `getConfig()` always provides
    // a value (default `[]`); the defensive branch is for fixtures only.
    if (!patterns || patterns.length === 0) return

    // ponytail: pre-compile once per fire; reuse the regex across all parts.
    // Avoids per-part recompile on hot path (every LLM fetch).
    const compiled = patterns.map(compileStripPattern)

    for (const message of messages) {
        if (!message.parts) continue
        for (const part of message.parts) {
            if (part.type === "text" && typeof part.text === "string") {
                let next = part.text
                for (const re of compiled) {
                    next = next.replace(re, "")
                }
                if (next !== part.text) {
                    part.text = next
                }
            }
            if (
                part.type === "tool" &&
                part.state?.status === "completed" &&
                typeof part.state.output === "string"
            ) {
                let next = part.state.output
                for (const re of compiled) {
                    next = next.replace(re, "")
                }
                if (next !== part.state.output) {
                    part.state.output = next
                }
            }
        }
    }
}
