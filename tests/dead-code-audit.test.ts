/**
 * Static dead-code audit for the lib/ tree.
 *
 * Currently scoped to one symbol: STORAGE_DIR (BUG-057).
 *
 * The module-level `const STORAGE_DIR = join(...)` in
 * `lib/state/persistence.ts` is declared but never read — all callers use
 * `resolveStorageDir()` (which re-derives the path per call) or
 * `getSessionFilePath()` (which calls `resolveStorageDir`). The fix is
 * either to delete the constant or to wire it up as the canonical storage
 * path (with `resolveStorageDir` re-exporting it).
 *
 * This test asserts the FIXED shape: the constant is either gone entirely
 * OR declared and referenced from at least one live site. Currently (in
 * the buggy code) there is exactly one reference — the declaration
 * itself — and the test fails. The implementer round brings the count to
 * 0 (deleted) or >=2 (wired up) and the test passes.
 */

import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const TEST_DIR = dirname(fileURLToPath(import.meta.url))
const LIB_DIR = join(TEST_DIR, "..", "lib")

/** Recursively walk LIB_DIR and return absolute paths of all `.ts` files. */
function walkLib(): string[] {
    const out: string[] = []
    function walk(dir: string): void {
        let entries: ReturnType<typeof readdirSync>
        try {
            entries = readdirSync(dir, { withFileTypes: true })
        } catch {
            return
        }
        for (const entry of entries) {
            const full = join(dir, entry.name)
            if (entry.isDirectory()) {
                walk(full)
            } else if (entry.isFile() && entry.name.endsWith(".ts")) {
                out.push(full)
            }
        }
    }

    // Sanity: LIB_DIR must exist for the test to be meaningful. If the test
    // runner is invoked from the wrong cwd this fails fast with a clear
    // error rather than a silent 0-references pass.
    if (!statSync(LIB_DIR, { throwIfNoEntry: false })?.isDirectory()) {
        throw new Error(`LIB_DIR does not exist or is not a directory: ${LIB_DIR}`)
    }
    walk(LIB_DIR)
    return out
}

/** Count whole-word occurrences of `name` in CODE (comments stripped)
 *  across the lib/ tree. The bug is that the constant is declared but
 *  never *read* — comment references don't count as a use. */
function countReferences(symbol: string): { count: number; locations: string[] } {
    const pattern = new RegExp(`\\b${symbol}\\b`, "g")
    let count = 0
    const locations: string[] = []
    for (const file of walkLib()) {
        const content = readFileSync(file, "utf-8")
        // Strip block comments (`/* ... */`, including JSDoc `/** ... */`)
        // and line comments (`// ...`) before counting. A comment
        // reference to a dead constant is part of the smell, not a use.
        const stripped = content
            .replace(/\/\*[\s\S]*?\*\//g, "") // block comments (non-greedy)
            .replace(/(^|[^:])\/\/[^\n]*/g, "$1") // line comments (skip URLs)
        const matches = stripped.match(pattern)
        if (matches && matches.length > 0) {
            count += matches.length
            locations.push(`${file.replace(LIB_DIR + "/", "")} (${matches.length})`)
        }
    }
    return { count, locations }
}

// ────────────────────────────────────────────────────────────────────────────
// BUG-057: STORAGE_DIR is dead code in the current lib/state/persistence.ts.
// The fix is to either delete the constant OR wire it up as the canonical
// storage path. Both fix shapes are accepted: 0 references (deleted) or
// >=2 references (declaration + at least one live use).
// ────────────────────────────────────────────────────────────────────────────

test("BUG-057: STORAGE_DIR is not dead code (either deleted or wired up across lib/)", () => {
    const { count, locations } = countReferences("STORAGE_DIR")

    assert.ok(
        count === 0 || count >= 2,
        `BUG-057: STORAGE_DIR appears ${count} time(s) across lib/. ` +
            `Expected 0 (deleted) or >=2 (declared + wired). ` +
            `Locations: ${locations.join(", ") || "(none)"}`,
    )
})

test("BUG-057 (strict): STORAGE_DIR is not the lone declaration it is today", () => {
    // Strict variant of the assertion above. Today's bug is specifically
    // the case `count === 1` — the constant is declared but never read.
    // This test pins the failure mode precisely: it will pass once the
    // constant is deleted (count === 0) or wired up (count >= 2).
    const { count, locations } = countReferences("STORAGE_DIR")

    assert.notEqual(
        count,
        1,
        `BUG-057: STORAGE_DIR has exactly 1 reference in lib/ — ` +
            `it is declared but never read. Locations: ${locations.join(", ")}`,
    )
})

// Logic Verified: BUG-057 — STORAGE_DIR is not left as a dead constant.
// Bugs Documented: see per-test KNOWN BUG references — tests fail in
//                  current code, pass after the implementer round.
// Fakes Updated: none (pure static analysis over lib/**/*.ts).
// Review Status: tests assert the FIXED contract; subagent review not
//                requested in this delegation.
// Logic Verified: STORAGE_DIR is either deleted or wired up across lib/ (no lone declaration).
// Bugs Documented: BUG-057.
// Fakes Updated: none (pure static analysis over lib/**/*.ts).
// Review Status: pending independent review.
