// Tests for bug group G9 — `as any` audit + cast documentation contract.
//
// These tests assert the FIXED behavior described in:
//   - known_issues/BUG-038-ui-utils-as-any.md
//   - known_issues/BUG-049-async-ignored-type-cast.md
//   - known_issues/BUG-073-as-any-12-occurrences.md
//
// They MUST fail in the current (pre-fix) production code and MUST pass
// once the implementer removes the documented unnecessary casts and
// documents the remaining intentional SDK seams with `// ponytail: ...`
// comments per PAT-001.
//
// Execution mode: PARALLEL — this file is created without compiling or
// running `npm test`. Other test_creators may be writing adjacent files
// at the same time; we deliberately skip compile so we don't drop
// build artefacts into their workspace.

import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative } from "node:path"

const ROOT = process.cwd()
const LIB_DIR = join(ROOT, "lib")

// ----------------------------------------------------------------------------
// Budget rationale (BUG-073)
//
// Current count: 12 `as any` in lib/ (architect-corrected: query.ts:53,
// ui/utils.ts:199/221, config.ts:1085/1086/1091/1096, shape.ts:8/9,
// token-utils.ts:6, tui/commands.ts:4, tui/data.ts:16).
//
// Mandatory drops for BUG-038 + BUG-049: 3 casts
//   - lib/ui/utils.ts:199    — AssistantMessage narrows via the
//                              `if (msg.info.role !== "assistant") continue`
//                              guard immediately above.
//   - lib/ui/utils.ts:221    — TextPart.ignored is a declared SDK field.
//   - lib/messages/query.ts:53 — direct `part.ignored` access already
//                                compiles in lib/commands/manual.ts:124
//                                and lib/logger.ts:186.
//
// After those drops, 9 casts remain — every one is an intentional SDK seam
// per the architect's PARTIAL verdict on BUG-073:
//
//   - lib/config.ts:1085/1086/1091/1096 — mergeLayer(data) parameter typed
//     as `Record<string, any>`. Tightening to `DeepPartial<PluginConfig>`
//     is the documented upgrade path; not required for BUG-038/049.
//   - lib/messages/shape.ts:8-9  — `(message as any).info`/`.parts` on
//     the sealed `WithParts` type.
//   - lib/token-utils.ts:6       — dual ESM/CJS export of
//     `@anthropic-ai/tokenizer`.
//   - lib/tui/commands.ts:4      — TUI `api.keymap` field on sealed SDK.
//   - lib/tui/data.ts:16         — TUI `api` → plugin-config seam.
//
// Budget = 9 covers the mandatory drops while leaving room for the
// optional mergeLayer typing improvement without forcing it. Each
// remaining cast must carry a `// ponytail: ...` comment per PAT-001.
// ----------------------------------------------------------------------------
const TOTAL_BUDGET = 9

// Walk `lib/` recursively, returning every `.ts` path (relative to ROOT).
function walkTs(dir: string): string[] {
    const out: string[] = []
    for (const entry of readdirSync(dir)) {
        const p = join(dir, entry)
        const st = statSync(p)
        if (st.isDirectory()) {
            out.push(...walkTs(p))
        } else if (entry.endsWith(".ts")) {
            out.push(p)
        }
    }
    return out
}

// Find every line in `content` whose source-code text contains `as any`.
// Strips line comments before matching so a literal `// as any` in a
// comment block is not counted. String literals are not pre-stripped
// (acceptable — no production source uses `as any` inside a string).
function castLines(content: string): number[] {
    const lines = content.split(/\r?\n/)
    const hits: number[] = []
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i]
        const code = raw.replace(/\/\/.*$/, "")
        if (/\bas\s+any\b/.test(code)) {
            hits.push(i + 1)
        }
    }
    return hits
}

// Count `as any` casts across all `.ts` files under `dir`.
function totalCasts(files: string[]): number {
    let n = 0
    for (const f of files) {
        n += castLines(readFileSync(f, "utf8")).length
    }
    return n
}

// Collect every `as any` site as (file, line, source line, surrounding lines).
function collectSites(
    files: string[],
): Array<{ file: string; line: number; text: string; prev: string; next: string }> {
    const sites: Array<{ file: string; line: number; text: string; prev: string; next: string }> =
        []
    for (const f of files) {
        const content = readFileSync(f, "utf8")
        const lines = content.split(/\r?\n/)
        const hits = castLines(content)
        for (const ln of hits) {
            sites.push({
                file: relative(ROOT, f),
                line: ln,
                text: lines[ln - 1],
                prev: lines[ln - 2] ?? "",
                next: lines[ln] ?? "",
            })
        }
    }
    return sites
}

// True if the cast line itself, or the line immediately preceding it,
// contains a `// ponytail:` marker. Accepts both inline and above-line
// placements (PAT-001 allows either).
function hasPonytailMarker(site: { text: string; prev: string }): boolean {
    return /\/\/\s*ponytail\s*:/.test(site.text) || /\/\/\s*ponytail\s*:/.test(site.prev)
}

// ----------------------------------------------------------------------------
// BUG-038 — lib/ui/utils.ts must drop both `as any` casts.
//
//   Line 199: `const info = msg.info as any` — unnecessary because the
//     surrounding `if (msg.info.role !== "assistant") continue` already
//     narrows `msg.info` to `AssistantMessage`, which declares
//     `tokens.input` and `tokens.cache.{read,write}`.
//
//   Line 221: `if (part.type === "text" && !(part as any).ignored)` —
//     unnecessary because `TextPart.ignored?: boolean` is a declared
//     SDK field; direct access compiles.
//
// Architect verdict (BUG-038, 2026-08-07): PARTIAL; both casts unnecessary;
// the proposed type guard is over-engineered and retains an internal cast.
// ----------------------------------------------------------------------------

test("BUG-038 lib/ui/utils.ts has no `as any` casts", () => {
    const f = join(LIB_DIR, "ui", "utils.ts")
    const content = readFileSync(f, "utf8")
    const hits = castLines(content)

    assert.deepEqual(
        hits,
        [],
        `Expected zero \`as any\` casts in lib/ui/utils.ts after BUG-038 fix. ` +
            `Found casts at lines: ${hits.join(", ")}.\n` +
            "BUG-038: both casts are unnecessary — AssistantMessage narrows via " +
            '`if (msg.info.role !== "assistant") continue`, and TextPart.ignored ' +
            "is a declared SDK field. See known_issues/BUG-038-ui-utils-as-any.md.",
    )
})

// ----------------------------------------------------------------------------
// BUG-049 — lib/messages/query.ts must drop the `(part as any).ignored`
// cast in `isIgnoredUserMessage`.
//
// The for-loop over `parts` already narrows on `part.type`; direct
// `part.ignored` access compiles in two other sites in this repo
// (lib/commands/manual.ts:124, lib/logger.ts:186). The cast is dead
// weight; if OpenCode renames `ignored` → `noReply` or moves it to
// `part.metadata`, the plugin would silently misbehave.
//
// Architect verdict (BUG-049, 2026-08-07): PARTIAL; cast is inconsistent
// with two other sites that use `part.ignored` directly.
// ----------------------------------------------------------------------------

test("BUG-049 lib/messages/query.ts has no `as any` casts", () => {
    const f = join(LIB_DIR, "messages", "query.ts")
    const content = readFileSync(f, "utf8")
    const hits = castLines(content)

    assert.deepEqual(
        hits,
        [],
        `Expected zero \`as any\` casts in lib/messages/query.ts after BUG-049 fix. ` +
            `Found casts at lines: ${hits.join(", ")}.\n` +
            "BUG-049: direct `part.ignored` access already compiles in " +
            "lib/commands/manual.ts:124 and lib/logger.ts:186. " +
            "See known_issues/BUG-049-async-ignored-type-cast.md.",
    )
})

// ----------------------------------------------------------------------------
// BUG-073 — total `as any` count in lib/ must be at or below the budget.
//
// Pre-fix count is 12; post-fix budget is 9 (see rationale at the top of
// this file). The implementer is expected to:
//   1. Drop the 3 mandatory casts covered by BUG-038 + BUG-049.
//   2. Either (a) leave the remaining 9 SDK seams as-is but document each
//      with `// ponytail: ...` per PAT-001, OR (b) also tighten
//      mergeLayer's `data` parameter to `DeepPartial<PluginConfig>` and
//      drop the 4 config.ts merge casts for a final count of 5.
// Either path satisfies this assertion.
// ----------------------------------------------------------------------------

test("BUG-073 total `as any` in lib/ is at or below budget", () => {
    const files = walkTs(LIB_DIR)
    const total = totalCasts(files)

    assert.ok(
        total <= TOTAL_BUDGET,
        `Expected at most ${TOTAL_BUDGET} \`as any\` casts across lib/**/*.ts ` +
            `(BUG-073 budget); found ${total}. ` +
            "The current code has 12; BUG-038 + BUG-049 mandate dropping 3. " +
            "See known_issues/BUG-073-as-any-12-occurrences.md and the budget " +
            "rationale at the top of this test file.",
    )
})

// ----------------------------------------------------------------------------
// BUG-073 — every remaining `as any` site must be documented as a
// deliberate simplification with a `// ponytail: ...` comment naming
// the ceiling and the upgrade path (PAT-001).
//
// This test enforces the documentation contract independently of the
// count budget: a site can stay (it's an intentional seam) but it must
// explain itself. Currently no cast site carries a `// ponytail:`
// comment, so this test fails on every pre-fix site.
// ----------------------------------------------------------------------------

test("BUG-073 every remaining `as any` site has a `// ponytail:` justification", () => {
    const files = walkTs(LIB_DIR)
    const sites = collectSites(files)
    const undocumented = sites.filter((s) => !hasPonytailMarker(s))

    assert.deepEqual(
        undocumented,
        [],
        `Every remaining \`as any\` site must carry a \`// ponytail: ...\` comment ` +
            `(PAT-001). Found ${undocumented.length} undocumented site(s):\n` +
            undocumented.map((s) => `  - ${s.file}:${s.line}  ${s.text.trim()}`).join("\n") +
            "\nSee known_issues/BUG-073-as-any-12-occurrences.md and docs/PATTERNS.md (PAT-001).",
    )
})

// Logic Verified: lib/ui/utils.ts and lib/messages/query.ts have zero
//                  `as any` after BUG-038 + BUG-049; total `as any` in
//                  lib/ stays at or below the documented budget; every
//                  remaining cast is annotated with a `// ponytail:`
//                  justification per PAT-001.
// Bugs Documented: BUG-038 (ui/utils.ts unnecessary cast),
//                  BUG-049 (query.ts `ignored` cast unnecessary),
//                  BUG-073 (12-occurrence audit + ponytail contract).
// Fakes Updated: none (pure static-analysis assertions over lib/**/*.ts;
//                  no module imports, no subprocesses, no test doubles).
// Review Status: pending independent review.
//
// Manual verification: from repo root, run
//   node --import tsx --test tests/type-safety.test.ts
// and confirm all four tests pass. In current (pre-fix) code, all four
// fail — that is the expected state before the implementer round.
// Logic Verified: lib/ui/utils.ts and lib/messages/query.ts have no `as any` casts, total `as any` in lib/ stays within budget, and every remaining site carries a `// ponytail:` justification.
// Bugs Documented: BUG-038, BUG-049, BUG-073.
// Fakes Updated: none
// Review Status: pending independent review.
