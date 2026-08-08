import assert from "node:assert/strict"
import test from "node:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

type PackageJson = {
    scripts?: Record<string, string>
}

function loadPackageJson(): PackageJson {
    return JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as PackageJson
}

// POSIX `rm -rf` only exists in POSIX shells (sh, bash, zsh, dash).
// PowerShell and cmd.exe do not have `rm`; running the script on Windows
// without git-bash in PATH fails with `'rm' is not recognized` (BUG-005).
const POSIX_RM_RE = /\brm\s+-rf\b/

test("BUG-005 #clean-script does not invoke POSIX rm -rf", () => {
    // Today `package.json:24` defines `"clean": "rm -rf dist"`, which fails
    // on Windows PowerShell. The fix replaces it with a cross-platform
    // cleaner (`node -e "fs.rmSync(...)"` or `tsup --clean` or `rimraf`).
    const pkg = loadPackageJson()
    const clean = pkg.scripts?.clean

    assert.ok(
        typeof clean === "string",
        "Expected `package.json` to define a string `scripts.clean`.",
    )
    assert.doesNotMatch(
        clean,
        POSIX_RM_RE,
        "Expected `scripts.clean` to no longer use POSIX `rm -rf` (BUG-005: Windows broken).",
    )
})

test("BUG-005 #clean-script uses a cross-platform mechanism", () => {
    // The fix must use one of: Node's `fs.rmSync`, `rimraf`, or `tsup`.
    // The script `node -e "require('fs').rmSync(...)"` qualifies via
    // `fs.rmSync`; `rimraf dist` qualifies via the package name; a no-op
    // script that delegates to `tsup --clean` or relies on `tsup({clean:true})`
    // qualifies via `tsup`.
    const pkg = loadPackageJson()
    const clean = pkg.scripts?.clean ?? ""

    // Matches `fs.rmSync`, `node:fs').rmSync`, and any other require-based
    // form — `\brmSync\b` is a Node.js stdlib-only identifier, so a word-
    // boundary match is sufficient to detect a cross-platform cleaner.
    const usesFsRmSync = /\brmSync\b/.test(clean)
    const usesRimraf = /\brimraf\b/.test(clean)
    const usesTsup = /\btsup\b/.test(clean)
    const isNoOp = clean.trim() === ""

    assert.ok(
        usesFsRmSync || usesRimraf || usesTsup || isNoOp,
        `Expected \`scripts.clean\` to use a cross-platform cleaner ` +
            `(fs.rmSync / rimraf / tsup / empty). Got: ${JSON.stringify(clean)}`,
    )
})

test("BUG-005 #clean-script when interpreted as shell does not rely on POSIX-only commands", () => {
    // Negative assertion: regardless of which cross-platform command the
    // implementer picks, it must not silently introduce another POSIX shell
    // dependency (`ls`, `cat`, `grep`, `sed`, `awk` are common offenders).
    // `node`, `rimraf`, `tsup` are all acceptable.
    const pkg = loadPackageJson()
    const clean = pkg.scripts?.clean ?? ""

    const banned = /\b(rm|ls|cat|grep|sed|awk)\s+[^&|;]/
    assert.doesNotMatch(
        clean,
        banned,
        `Expected \`scripts.clean\` to avoid POSX-only shell commands. Got: ${JSON.stringify(clean)}`,
    )
})

test("BUG-005 #scripts-build remains intact and non-empty", () => {
    // Sanity: the implementer's fix to `clean` must not accidentally
    // drop or empty `scripts.build`. The Windows failure mode is narrow
    // (the `clean` step only); `build` itself only references `clean`,
    // `tsup`, and `tsc --emitDeclarationOnly`, all of which cross-platform.
    const pkg = loadPackageJson()
    const build = pkg.scripts?.build
    assert.ok(
        typeof build === "string" && build.length > 0,
        "Expected `package.json` to define a non-empty `scripts.build`.",
    )
})

// Logic Verified: package.json's `scripts.clean` no longer invokes
//                  `rm -rf`, uses a cross-platform cleaner (Node's
//                  fs.rmSync, rimraf, or tsup), and the `build` script
//                  chain remains coherent.
// Bugs Documented: BUG-005-build-script-windows-broken.md (POSIX
//                  `rm -rf` in `scripts.clean` breaks `npm run build`
//                  on Windows PowerShell without git-bash).
// Fakes Updated: none (reads package.json from disk; assertions on script
//                 strings).
// Review Status: pending independent review.
//
// Manual verification (PowerShell without git-bash in PATH):
//     npm run build
// must complete without `'rm' is not recognized as an internal or
// external command`. The CI pipeline (ubuntu-latest) does not exercise
// this path; this test is the only gate against the regression.
//
// Note on long-term upgrade path: per AGENTS.md ("No new deps without
// justification"), prefer `node -e "require('fs').rmSync(...)"` (stdlib,
// no new dep). `rimraf` adds a dep; the implementer should justify it.
// Logic Verified: scripts/verify-package.mjs #clean step avoids POSIX-only `rm -rf` and stays cross-platform.
// Bugs Documented: BUG-005.
// Fakes Updated: none
// Review Status: pending independent review.
