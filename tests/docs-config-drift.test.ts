// G12 — docs drift tests.
//
// Each test pins the FIXED prose of a documentation file. They MUST fail
// against the current docs so the implementer round can correct the docs and
// the tests then pass.
//
// Bugs covered:
//   BUG-055  docs/CONFIGURATION.md says "up to three sources" but lists four.
//   BUG-056  docs/CONFIGURATION.md uses key `state.maxAgeDays` (canonical is
//            `compress.stateMaxAgeDays`).
//   BUG-062  docs/TESTING.md layout table incomplete vs actual test directory.

import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

const repoRoot = join(import.meta.dirname, "..")
const configurationDoc = readFileSync(join(repoRoot, "docs", "CONFIGURATION.md"), "utf-8")
const testingDoc = readFileSync(join(repoRoot, "docs", "TESTING.md"), "utf-8")

// ────────────────────────────────────────────────────────────────────────────
// BUG-055 — docs/CONFIGURATION.md Layered-merge section says "up to three
// sources" but enumerates four layers (defaults, global, configDir, project).
// Fix: change the prose to "up to four sources". Tests pin the corrected
// prose and reject the old "three sources" / "3 sources" wording.
// ────────────────────────────────────────────────────────────────────────────

test("BUG-055: docs/CONFIGURATION.md Layered-merge section says 'four sources', not 'three'", () => {
    // The buggy prose is "up to three sources" (case-insensitive) appearing
    // in the Layered-merge section. The fix replaces it with "up to four
    // sources" — the same wording with one digit changed, matching the
    // four-layer model (defaults, global, configDir, project).
    assert.ok(
        !/up to three sources/i.test(configurationDoc),
        `docs/CONFIGURATION.md must not claim "up to three sources"; the list below enumerates four layers. See: known_issues/BUG-055-config-drift-three-sources.md`,
    )
    assert.ok(
        /up to four sources/i.test(configurationDoc),
        `docs/CONFIGURATION.md must state "up to four sources" to match the four-layer merge model (defaults + global + configDir + project)`,
    )
})

// ────────────────────────────────────────────────────────────────────────────
// BUG-056 — docs/CONFIGURATION.md Runtime defaults table references
// `state.maxAgeDays`; the canonical key is `compress.stateMaxAgeDays`.
// VALID_CONFIG_KEYS only contains the canonical key, so a user following
// the docs gets an "Unknown keys" warning. Test pins the canonical key in
// the table.
// ────────────────────────────────────────────────────────────────────────────

test("BUG-056: docs/CONFIGURATION.md Runtime defaults table uses canonical key 'compress.stateMaxAgeDays'", () => {
    // Reject the bug wording: a bare `state.maxAgeDays` (NOT prefixed with
    // `compress.`) appearing as a row in the Runtime defaults table.
    // We match it inside a markdown table row to avoid false positives in
    // any prose that might reference the function-arg name.
    const tableRowRegex = /^\|\s*`?state\.maxAgeDays`?\s*\|/m
    assert.ok(
        !tableRowRegex.test(configurationDoc),
        `docs/CONFIGURATION.md Runtime defaults table must not use the bare key "state.maxAgeDays"; canonical key is "compress.stateMaxAgeDays". See: known_issues/BUG-056-config-drift-state-key.md`,
    )
    // And confirm the canonical key IS present in the table.
    const canonicalRowRegex = /^\|\s*`?compress\.stateMaxAgeDays`?\s*\|/m
    assert.ok(
        canonicalRowRegex.test(configurationDoc),
        `docs/CONFIGURATION.md Runtime defaults table must reference the canonical key "compress.stateMaxAgeDays"`,
    )
})

// ────────────────────────────────────────────────────────────────────────────
// BUG-062 — docs/TESTING.md Layout section is missing rows for several
// test files. The drift has grown since the report was filed (the directory
// is at 47 files, the doc references ~32). Test pins the count drift:
// actual test files in `tests/` must be within ±2 of the unique `.test.ts`
// filenames mentioned in the Layout section.
// ────────────────────────────────────────────────────────────────────────────

function listActualTestFiles(): string[] {
    return readdirSync(join(repoRoot, "tests"))
        .filter((name) => name.endsWith(".test.ts"))
        .map((name) => name)
        .sort()
}

function listDocReferencedTestFiles(doc: string): string[] {
    // Match anything that looks like a `.test.ts` filename in backticks
    // (the docs use this convention) OR in bare form. The set dedupes the
    // multiple references to the same file in different rows (e.g.
    // `hooks-permission.test.ts` is in both the Hooks and Permissions rows).
    const re = /`?([a-z0-9-]+\.test\.ts)`?/gi
    const found = new Set<string>()
    let match: RegExpExecArray | null
    while ((match = re.exec(doc)) !== null) {
        found.add(match[1].toLowerCase())
    }
    return Array.from(found).sort()
}

test("BUG-062: docs/TESTING.md layout mentions all test files (drift within ±2)", () => {
    const actual = listActualTestFiles()
    const actualLower = actual.map((n) => n.toLowerCase())
    const referenced = listDocReferencedTestFiles(testingDoc)

    const actualSet = new Set(actualLower)
    const referencedSet = new Set(referenced)

    const missing = actualLower.filter((n) => !referencedSet.has(n))
    const extra = referenced.filter((n) => !actualSet.has(n))

    const drift = missing.length

    assert.ok(
        drift <= 2,
        `docs/TESTING.md layout mentions ${referenced.length} test file(s), but the tests/ directory contains ${actual.length}. ` +
            `Drift = ${drift} (must be ≤ 2). ` +
            `Missing from docs: ${JSON.stringify(missing)}. ` +
            `Extra in docs (not on disk): ${JSON.stringify(extra)}. ` +
            `See: known_issues/BUG-062-test-layout-table-drift.md`,
    )
})

// Audit trailer — one bare test() per concern; no describe / before* /
// test.only. Each test is a self-contained AAA block on the docs files.
// New regression tests for this file must:
//   1. Match a single BUG-### in known_issues/.
//   2. Pin the FIXED prose (what the implementer will produce in docs/).
//   3. Fail today, pass after the docs correction lands.
//   4. Add the issue number to the test name.
// Logic Verified: docs/CONFIGURATION.md and docs/TESTING.md prose matches current canonical config keys and test layout.
// Bugs Documented: BUG-055, BUG-056, BUG-062.
// Fakes Updated: none
// Review Status: pending independent review.
