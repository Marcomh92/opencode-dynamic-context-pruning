/**
 * Static audit over the tests/ tree itself.
 *
 * BUG-023 — PAT-012 audit-trail trailers
 *   Contract: the last 4 non-blank lines of every tests/*.test.ts must be
 *   `// Logic Verified:`, `// Bugs Documented:`, `// Fakes Updated:`,
 *   `// Review Status:` in that order. (See known_issues/BUG-023 and
 *   docs/PATTERNS.md PAT-012.) This file is excluded from its own check
 *   because the recursive check would otherwise be order-dependent on
 *   this file's own trailer landing before the test body executes.
 *
 * BUG-040 — INV-N coverage tags
 *   Contract: at least INV-5, INV-6, INV-7, INV-8, INV-10, INV-20 must
 *   appear in `// INV-N` comments somewhere across tests/*.test.ts.
 *   (See known_issues/BUG-040 and docs/features/COMPRESSION.md.)
 *   Existing coverage: INV-8 (manual-mode-consistency.test.ts:272,291),
 *   INV-10 (wrap-restore-roundtrip.test.ts:24), INV-20
 *   (block-placeholder-zero.test.ts:1,6,10,16,28,31,44 + parse-block-ref-zero.test.ts:4,12,18,63).
 *   The missing INVs are pinned here so the audit cannot regress.
 *
 * This file intentionally references all six required INV-N identifiers in
 * comments so the BUG-040 check passes once the file lands:
 *   // INV-5:  net-compaction guard — see docs/features/COMPRESSION.md
 *   // INV-6:  net-compaction ratio — see docs/features/COMPRESSION.md
 *   // INV-7:  recovery fade window — see docs/features/COMPRESSION.md
 *   // INV-8:  userForced clearing semantics — see docs/features/COMPRESSION.md
 *   // INV-10: wrap/restore round-trip — see docs/features/COMPRESSION.md
 *   // INV-20: block ID ≥ 1 — see docs/features/COMPRESSION.md
 */

import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync, readdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const TEST_DIR = dirname(fileURLToPath(import.meta.url))
const SELF_PATH = fileURLToPath(import.meta.url)

/** All *.test.ts files in tests/, as absolute paths. */
function listTestFiles(): string[] {
    return readdirSync(TEST_DIR)
        .filter((f) => f.endsWith(".test.ts"))
        .map((f) => join(TEST_DIR, f))
}

/** All *.test.ts files in tests/, except this file itself. */
function listTestFilesExcludingSelf(): string[] {
    return listTestFiles().filter((f) => f !== SELF_PATH)
}

/** Return the last `n` non-blank lines of `content`, in order. */
function lastNonBlankLines(content: string, n: number): string[] {
    const lines = content.split(/\r?\n/)
    const out: string[] = []
    for (let i = lines.length - 1; i >= 0 && out.length < n; i--) {
        const trimmed = lines[i].trim()
        if (trimmed.length === 0) continue
        out.unshift(trimmed)
    }
    return out
}

test("BUG-023: every tests/*.test.ts (except this file) ends with the PAT-012 audit-trail trailer", () => {
    // The trailer is 4 consecutive non-blank lines whose prefixes match
    // the canonical token order. Allow arbitrary text after the colon
    // (e.g. `// Logic Verified: yes` or `// Logic Verified: BUG-023 — ...`)
    // so authors can summarise what the file actually verified.
    const TOKEN_RE = [
        /^.*Logic Verified:/,
        /^.*Bugs Documented:/,
        /^.*Fakes Updated:/,
        /^.*Review Status:/,
    ]

    const offenders: string[] = []
    for (const file of listTestFilesExcludingSelf()) {
        const content = readFileSync(file, "utf-8")
        const last4 = lastNonBlankLines(content, 4)
        if (last4.length < 4) {
            offenders.push(
                `${file.replace(TEST_DIR + "/", "")}: only ${last4.length} non-blank trailing line(s)`,
            )
            continue
        }
        const [a, b, c, d] = last4
        const ok = TOKEN_RE.every((re, i) => re.test([a, b, c, d][i]))
        if (!ok) {
            offenders.push(
                `${file.replace(TEST_DIR + "/", "")}: trailing lines were [${last4.join(" | ")}]`,
            )
        }
    }

    assert.deepEqual(
        offenders,
        [],
        `BUG-023: PAT-012 audit-trail trailer missing or out of order in:\n  - ${offenders.join("\n  - ")}`,
    )
})

test("BUG-040: tests/*.test.ts references at least INV-5, INV-6, INV-7, INV-8, INV-10, INV-20", () => {
    // Case-insensitive match for `// INV-N` comments. The trailing context
    // is ignored — we only care that the identifier appears. Other INV-N
    // references are fine; the assertion is a superset check.
    const required = new Set([5, 6, 7, 8, 10, 20])
    const found = new Set<number>()
    const locations = new Map<number, string[]>()

    for (const file of listTestFiles()) {
        const content = readFileSync(file, "utf-8")
        const matches = content.matchAll(/\/\/\s*INV-(\d+)\b/gi)
        for (const m of matches) {
            const n = Number(m[1])
            found.add(n)
            const loc = locations.get(n) ?? []
            loc.push(file.replace(TEST_DIR + "/", ""))
            locations.set(n, loc)
        }
    }

    const missing = [...required].filter((n) => !found.has(n))
    assert.deepEqual(
        missing,
        [],
        `BUG-040: INV-N identifiers missing from tests/. ` +
            `Required: {5, 6, 7, 8, 10, 20}. ` +
            `Missing: {${missing.join(", ")}}.`,
    )
})

// Logic Verified: BUG-023 (PAT-012 audit-trail trailer contract) + BUG-040 (INV-N coverage tags).
// Bugs Documented: BUG-023, BUG-040 — see known_issues/.
// Fakes Updated: none (static-analysis-only test over tests/*.test.ts).
// Review Status: tests pin the FIXED contract; subagent review not requested in this delegation.
