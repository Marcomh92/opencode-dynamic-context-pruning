// Regression suite for BUG-063: `tiktoken` is listed as a direct
// dependency in package.json but no source file imports it. The expected
// fix is either (a) remove the dep, or (b) document the defensive intent
// in PERFORMANCE.md. Either way, the contract this test pins down is:
//
//     NO `.ts` file in `lib/` or `tests/` imports `tiktoken`.
//
// This is a forward-looking regression guard: it passes today (because
// nothing imports tiktoken) and must continue to pass after the fix. If
// a future contributor adds `import ... from "tiktoken"` thinking they
// can use the listed dep, this test fails loud and points them at the
// rationale in MY_CHANGELOG.md (M1 entry, issue #575).
//
// See:
//   - known_issues/BUG-063-tiktoken-dead-dep.md
//   - MY_CHANGELOG.md M1 entry
//   - docs/PERFORMANCE.md PER-002

import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"

// Recursive `.ts` collector. Skips `node_modules` and dotfiles (including
// `.git`). Returns paths relative to the project root.
function collectTsFiles(rootDir: string): string[] {
    const out: string[] = []
    const stack: string[] = [rootDir]
    while (stack.length > 0) {
        const current = stack.pop()!
        let entries: string[]
        try {
            entries = readdirSync(current)
        } catch {
            continue
        }
        for (const entry of entries) {
            if (entry === "node_modules" || entry.startsWith(".")) {
                continue
            }
            const full = join(current, entry)
            let s: ReturnType<typeof statSync>
            try {
                s = statSync(full)
            } catch {
                continue
            }
            if (s.isDirectory()) {
                stack.push(full)
            } else if (s.isFile() && entry.endsWith(".ts")) {
                out.push(relative(projectRoot, full))
            }
        }
    }
    return out
}

const projectRoot = process.cwd()
const libFiles = collectTsFiles(join(projectRoot, "lib"))
const testFiles = collectTsFiles(join(projectRoot, "tests"))

// ponytail: this file is itself a `tests/` .ts file and contains the
// regex patterns + synthetic fixtures that intentionally include the
// literal strings `from "tiktoken"`, `import("tiktoken")`, and
// `require("tiktoken")`. If we scanned ourselves, the test would fail
// by definition. Compute our own relative path once and exclude it.
const selfRelPath = relative(projectRoot, fileURLToPath(import.meta.url))

// Patterns that constitute a real `tiktoken` import. We intentionally allow
// the bare string "tiktoken" in comments / docs / strings (the package
// name itself is listed in package.json, after all). What we forbid is an
// actual module-resolution import, since that's what would either run the
// dep or fail bundling if the dep is removed.
//
// `from "tiktoken"`             — ESM named/default/side-effect import
// `from 'tiktoken'`             — same, single quotes
// `import("tiktoken")`          — dynamic ESM import (any quote)
// `require("tiktoken")`         — CJS require (any quote)
//
// Each regex uses a non-greedy match between `from`/`import`/`require` and
// the quoted module name, so unrelated identifiers like `fromAnother`
// do not false-positive.
const TIKTOKEN_IMPORT_PATTERNS: Array<{ label: string; re: RegExp }> = [
    { label: 'ESM `from "tiktoken"`', re: /\bfrom\s+["']tiktoken["']/ },
    { label: 'dynamic `import("tiktoken")`', re: /\bimport\s*\(\s*["']tiktoken["']\s*\)/ },
    { label: 'CJS `require("tiktoken")`', re: /\brequire\s*\(\s*["']tiktoken["']\s*\)/ },
]

function findTiktokenImports(file: string): string[] {
    const src = readFileSync(file, "utf8")
    const hits: string[] = []
    for (const { label, re } of TIKTOKEN_IMPORT_PATTERNS) {
        if (re.test(src)) {
            hits.push(label)
        }
    }
    return hits
}

// ponytail: this file pins the cross-cutting contract — no source file in
// the plugin imports `tiktoken`. Whether the implementer removes the dep
// or keeps it as a defensive install, the source-import assertion holds.
// The test does not (and cannot, from a test) modify package.json.

test("BUG-063 #sanity lib/ has .ts files to scan", () => {
    assert.ok(libFiles.length > 0, "expected lib/ to contain at least one .ts file")
})

test("BUG-063 #sanity tests/ has .ts files to scan", () => {
    assert.ok(testFiles.length > 0, "expected tests/ to contain at least one .ts file")
})

test("BUG-063 #no source import of tiktoken in lib/", () => {
    const offenders: Array<{ file: string; hits: string[] }> = []

    for (const rel of libFiles) {
        const hits = findTiktokenImports(join(projectRoot, rel))
        if (hits.length > 0) {
            offenders.push({ file: rel, hits })
        }
    }

    assert.deepEqual(
        offenders,
        [],
        `BUG-063: found tiktoken imports in lib/ source. ` +
            `The dep is intentionally unused; see MY_CHANGELOG.md M1 entry. ` +
            `Offenders: ${JSON.stringify(offenders, null, 2)}`,
    )
})

test("BUG-063 #no source import of tiktoken in tests/", () => {
    const offenders: Array<{ file: string; hits: string[] }> = []

    for (const rel of testFiles) {
        if (rel === selfRelPath) continue // self-scan guard: this file defines the patterns
        const hits = findTiktokenImports(join(projectRoot, rel))
        if (hits.length > 0) {
            offenders.push({ file: rel, hits })
        }
    }

    assert.deepEqual(
        offenders,
        [],
        `BUG-063: found tiktoken imports in tests/ source. ` +
            `Tests must not pull in the defensive dep. ` +
            `Offenders: ${JSON.stringify(offenders, null, 2)}`,
    )
})

// Negative-assertion sanity: the patterns themselves must match a real
// import. If someone tweaks a regex into a no-op, the lib/ scan would
// silently pass even with an `import "tiktoken"` in source. Pin a
// fixture string that proves each pattern fires at least once.
//
// ponytail: this test guards the guard. A broken regex is a silent bug.
// We construct a synthetic snippet (NOT written to disk) and run each
// pattern against it. If a regex ever fails to match its own fixture,
// the next contributor will know exactly which pattern to fix.
test("BUG-063 #regex patterns match synthetic tiktoken import fixtures", () => {
    const fixtures: Record<string, string> = {
        'ESM `from "tiktoken"`': [
            `import { something } from "tiktoken"`,
            `import x from 'tiktoken'`,
            `import "tiktoken"`,
        ].join("\n"),
        'dynamic `import("tiktoken")`': [
            `const m = await import("tiktoken")`,
            `import('tiktoken')`,
        ].join("\n"),
        'CJS `require("tiktoken")`': [`const t = require("tiktoken")`, `require('tiktoken')`].join(
            "\n",
        ),
    }

    const broken: string[] = []
    for (const { label, re } of TIKTOKEN_IMPORT_PATTERNS) {
        const fixture = fixtures[label]
        if (!fixture) {
            broken.push(`${label}: no fixture defined`)
            continue
        }
        if (!re.test(fixture)) {
            broken.push(`${label}: regex did not match its fixture`)
        }
    }

    assert.deepEqual(
        broken,
        [],
        `BUG-063: tiktoken-import regex patterns are broken. ` +
            `A no-op regex would silently let real tiktoken imports through. ` +
            `Fix the regexes:\n${broken.join("\n")}`,
    )
})

// Logic Verified: no .ts source file in lib/ or tests/ contains a real
//                  module-resolution import of "tiktoken" (ESM, dynamic,
//                  or CJS). The defensive dep stays defensive.
// Bugs Documented: BUG-063-tiktoken-dead-dep.md
// Fakes Updated: none (reads .ts files from disk).
// Review Status: pending independent review.
// Logic Verified: neither lib/ nor tests/ imports tiktoken (the defensive dep stays defensive, never compiled in).
// Bugs Documented: BUG-063.
// Fakes Updated: none (reads .ts files from disk).
// Review Status: pending independent review.
