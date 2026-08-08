// Regression suite for BUG-016 + BUG-058: `findOpencodeDir` POSIX-only
// `while (current !== "/")` guard. The companion bug is the same loop in
// `lib/prompts/store.ts`. Both copies are internal (not exported), so the
// runtime behavior is exercised through the public `getConfig()` wrapper.
// The behavioral tests verify the function does NOT infinite-loop on
// Windows-style or POSIX-style paths; the static tests pin down that the
// dead POSIX-only guard is removed from BOTH source files.
//
// Fix shape (per the bug reports):
//   while (current !== "/")   -->   while (true)
// with the existing `if (parent === current) break` retained as the sole
// universal termination.
//
// See:
//   - known_issues/BUG-016-findopencode-dir-loop-bound.md
//   - known_issues/BUG-058-findopencode-posix-only.md

import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

// Sandbox XDG_CONFIG_HOME BEFORE importing lib/config so the module-level
// GLOBAL_CONFIG_DIR captures a temp path (it is captured at first import).
// Per-test isolation: node --test spawns each *.test.ts in its own child,
// so this sandboxing does not leak across files.
const testConfigRoot = join(tmpdir(), `opencode-dcp-findopencode-cfg-${process.pid}`)

// GLOBAL_CONFIG_DIR is XDG_CONFIG_HOME/opencode (see lib/config.ts).
mkdirSync(join(testConfigRoot, "opencode"), { recursive: true })
process.env.XDG_CONFIG_HOME = testConfigRoot
delete process.env.OPENCODE_CONFIG_DIR

// Dynamic import so the env-var mutation above is in effect when
// GLOBAL_CONFIG_DIR is captured.
const { getConfig } = await import("../lib/config")

function stubCtx(directory: string | undefined): any {
    return {
        directory,
        client: {
            tui: {
                // no-op: validation warnings are surfaced via toast, but these
                // tests do not produce warnings.
                showToast: () => {},
            },
        },
    }
}

// ponytail: this file proves the cross-platform contract — `findOpencodeDir`
// terminates without infinite-looping regardless of platform-shaped input,
// AND both source copies are free of the POSIX-only `while (current !== "/")`
// guard. The behavioral tests pass on the current code too (the secondary
// `parent === current` break saves the day today); the static tests fail on
// the current code and pass once the implementer replaces the guard with
// `while (true)`.

// ────────────────────────────────────────────────────────────────────────────
// Behavioral: terminate on Windows-style path (regression guard)
// ────────────────────────────────────────────────────────────────────────────

test("BUG-016/058 #walk-up Windows-style path terminates without infinite-loop", () => {
    // Windows drive-rooted path. On POSIX CI, `path.dirname`/`path.join`
    // from `node:path` resolve to `path.posix`, but the algorithm still
    // terminates thanks to `parent === current` (the universal guard).
    // On Windows, `path.win32` similarly terminates. The point of this
    // test: the function must not hang on either shape.
    const win32Path = "C:\\Users\\test\\project"

    const result = getConfig(stubCtx(win32Path))

    assert.ok(result, "getConfig must return a config object, not hang")
    assert.equal(typeof result.compress, "object")
})

test("BUG-016/058 #walk-up nested Windows-style path terminates", () => {
    // Deeper nesting — exercises multiple parent-walk iterations on a
    // Windows-shape path.
    const win32Path = "C:\\Users\\test\\Documents\\projects\\repo\\src\\deep\\nested"

    const result = getConfig(stubCtx(win32Path))

    assert.ok(result)
    assert.ok(Array.isArray(result.compress.protectedTools))
})

// ────────────────────────────────────────────────────────────────────────────
// Behavioral: terminate on POSIX path (regression guard)
// ────────────────────────────────────────────────────────────────────────────

test("BUG-016/058 #walk-up POSIX path terminates and walks to root", () => {
    const posixPath = "/tmp/some/nested/path/that/has/no/opencode"

    const result = getConfig(stubCtx(posixPath))

    assert.ok(result)
    assert.equal(typeof result.compress.mode, "string")
})

// ────────────────────────────────────────────────────────────────────────────
// Behavioral: returns null project config when no `.opencode` ancestor exists
// ────────────────────────────────────────────────────────────────────────────

test("BUG-016/058 #no-config-found returns a config (project layer is null) without infinite-loop", () => {
    // Use a deeply-nested path guaranteed not to live under any `.opencode`
    // directory. The function must walk all the way up and exit cleanly.
    const deepPath = "/tmp/opencode-dcp-findopencode-no-config/deeply/nested/leaf"

    const result = getConfig(stubCtx(deepPath))

    assert.ok(result)
    // No .opencode ancestor exists, so the project config path is null
    // and the merge is skipped — defaults survive unchanged.
    assert.equal(result.compress.permission, "allow")
})

// ────────────────────────────────────────────────────────────────────────────
// Behavioral: undefined ctx.directory short-circuits the walk (no hang)
// ────────────────────────────────────────────────────────────────────────────

test("BUG-016/058 #walk-up skipped when ctx.directory is undefined", () => {
    // getConfigPaths() only invokes findOpencodeDir when ctx?.directory is
    // truthy. This guards against callers passing no directory.
    const result = getConfig(stubCtx(undefined))

    assert.ok(result)
})

// ────────────────────────────────────────────────────────────────────────────
// Static: BOTH copies of the buggy loop are fixed.
// The POSIX-only `while (current !== "/")` guard must be gone from both
// lib/config.ts and lib/prompts/store.ts. After the fix the loop header is
// `while (true)` and `parent === current` is the sole termination.
// ────────────────────────────────────────────────────────────────────────────

const POSIX_GUARD_RE = /while\s*\(\s*current\s*!==\s*"\/"\s*\)/

test('BUG-016/058 #lib/config.ts source no longer uses POSIX-only `while (current !== "/")` guard', () => {
    const src = readFileSync(join(process.cwd(), "lib/config.ts"), "utf8")

    assert.doesNotMatch(
        src,
        POSIX_GUARD_RE,
        'lib/config.ts still has the POSIX-only `while (current !== "/")` guard ' +
            "(BUG-016/BUG-058). Fix: replace with `while (true)` and keep " +
            "`if (parent === current) break` as the sole termination.",
    )
})

test('BUG-016 #lib/prompts/store.ts source no longer uses POSIX-only `while (current !== "/")` guard', () => {
    const src = readFileSync(join(process.cwd(), "lib/prompts/store.ts"), "utf8")

    assert.doesNotMatch(
        src,
        POSIX_GUARD_RE,
        'lib/prompts/store.ts still has the POSIX-only `while (current !== "/")` guard ' +
            "(BUG-016). Fix: replace with `while (true)` and keep " +
            "`if (parent === current) break` as the sole termination.",
    )
})

// ────────────────────────────────────────────────────────────────────────────
// Static: both fixed copies use the universal `while (true)` loop shape.
// This is a forward-looking check — if the implementer keeps the secondary
// `parent === current` break but forgets to swap to `while (true)`, the
// POSIX_GUARD_RE assertion above catches that. If the implementer removes
// `parent === current`, the behavioral "must terminate" assertions above
// catch that on a sufficiently-long walk. The combo pins the fix.
// ────────────────────────────────────────────────────────────────────────────

const WHILE_TRUE_RE = /while\s*\(\s*true\s*\)/

test("BUG-016/058 #lib/config.ts source uses `while (true)` for the upward walk", () => {
    const src = readFileSync(join(process.cwd(), "lib/config.ts"), "utf8")

    assert.match(
        src,
        WHILE_TRUE_RE,
        "Expected lib/config.ts to use `while (true)` as the loop header after the fix.",
    )
})

test("BUG-016 #lib/prompts/store.ts source uses `while (true)` for the upward walk", () => {
    const src = readFileSync(join(process.cwd(), "lib/prompts/store.ts"), "utf8")

    assert.match(
        src,
        WHILE_TRUE_RE,
        "Expected lib/prompts/store.ts to use `while (true)` as the loop header after the fix.",
    )
})

// Logic Verified: findOpencodeDir terminates on Windows-style and POSIX-style
//                  inputs; returns null when no .opencode ancestor exists;
//                  both source copies (lib/config.ts, lib/prompts/store.ts)
//                  no longer use the POSIX-only `while (current !== "/")`
//                  guard and instead use `while (true)` with the existing
//                  `parent === current` break as the universal termination.
// Bugs Documented: BUG-016-findopencode-dir-loop-bound.md,
//                  BUG-058-findopencode-posix-only.md.
// Fakes Updated: none (sandboxed XDG_CONFIG_HOME; reads source via fs).
// Review Status: pending independent review.
// Logic Verified: walk-up terminates on Windows-style and POSIX paths without infinite loop and skips when ctx.directory is undefined.
// Bugs Documented: BUG-016, BUG-058.
// Fakes Updated: none (sandboxed XDG_CONFIG_HOME; reads source via fs).
// Review Status: pending independent review.
