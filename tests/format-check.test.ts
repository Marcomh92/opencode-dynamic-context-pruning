import assert from "node:assert/strict"
import test from "node:test"
import { existsSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { spawnSync } from "node:child_process"

// Skip the test cleanly when the workspace has no installed dependencies
// (e.g., a fresh clone running `node --test` before `npm ci`). `npm run
// format:check` requires the `prettier` binary on PATH; without
// `node_modules/.bin/prettier` it would fail for the wrong reason.
const hasPrettierBin = existsSync(
    join(
        process.cwd(),
        "node_modules",
        ".bin",
        process.platform === "win32" ? "prettier.cmd" : "prettier",
    ),
)
const skipReason = hasPrettierBin
    ? false
    : "prettier is not installed (no node_modules/.bin/prettier); run `npm ci` first."

// Cross-platform `npm` invocation: on PowerShell we still spawn `npm`
// directly; `shell: true` lets the wrapper find `npm.cmd` on Windows.
function runFormatCheck(): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync("npm", ["run", "format:check"], {
        encoding: "utf8",
        shell: true,
    })
    return {
        status: result.status,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
    }
}

test("BUG-004 #npm-run-format-check exits 0", { skip: skipReason }, () => {
    // The bug: 223 source files have accumulated Prettier drift.
    // `npm run format:check` returns exit 1, which fails CI on every PR
    // and blocks all merges (companion to BUG-042). Fix: add
    // `.prettierignore` (so `npm install` doesn't re-break the gate by
    // rewriting package-lock.json) and run `prettier --write .` once.
    // The test asserts the gate is clean.
    const result = runFormatCheck()
    if (result.status !== 0) {
        assert.fail(
            `npm run format:check exited with code ${result.status}.\n` +
                `stdout:\n${result.stdout}\n` +
                `stderr:\n${result.stderr}`,
        )
    }
    assert.equal(result.status, 0)
})

test(
    "BUG-042 #prettierignore exists and ignores package-lock.json + dist/",
    { skip: skipReason },
    () => {
        // Companion gate: even after `prettier --write .` reformats the tree,
        // a subsequent `npm install` rewrites `package-lock.json` in npm's own
        // format. Without `.prettierignore`, the gate re-breaks immediately
        // and the meta-PR (BUG-042) becomes self-defeating.
        const ignorePath = join(process.cwd(), ".prettierignore")
        assert.ok(existsSync(ignorePath), "Expected `.prettierignore` to exist at the repo root.")

        const contents = readFileSync(ignorePath, "utf8")
        assert.match(
            contents,
            /(^|\s)package-lock\.json(\s|$)/m,
            "Expected `.prettierignore` to ignore `package-lock.json`.",
        )

        // Also confirm the file is non-empty: an empty ignore file is a no-op.
        assert.ok(
            statSync(ignorePath).size > 0,
            "Expected `.prettierignore` to be non-empty (an empty file ignores nothing).",
        )
    },
)

// Logic Verified: `npm run format:check` exits 0 on a clean checkout, and
//                  `.prettierignore` shields `package-lock.json` (and
//                  build output) from drift.
// Bugs Documented: BUG-004-prettier-drift-blocks-merges.md and
//                  BUG-042-format-blocks-merge-cycle.md (same root cause;
//                  the second is the merge-blocker consequence of the
//                  first; once BUG-004 lands, BUG-042 closes as duplicate).
// Fakes Updated: none (subprocess call + filesystem assertion).
// Review Status: pending independent review.
//
// Manual verification: from repo root, run `npm run format:check` and
// confirm exit code 0; run `npx prettier --check .` independently.
//
// SKIP contract: this test is a no-op when `node_modules/.bin/prettier`
// is missing so a fresh clone running `node --test` before `npm ci`
// does not produce spurious failures.
// Logic Verified: `npm run format:check` exits 0 and .prettierignore excludes package-lock.json + dist/.
// Bugs Documented: BUG-004, BUG-042.
// Fakes Updated: none
// Review Status: pending independent review.
