import assert from "node:assert/strict"
import test from "node:test"
import { isFilePathProtected, matchesGlob } from "../lib/protected-patterns"

// POSIX paths — the fix is a no-op on forward-slash-only paths.
test("matchesGlob POSIX path matches **/secrets.ts", () => {
    assert.equal(matchesGlob("/home/user/repo/secrets.ts", "**/secrets.ts"), true)
})

test("matchesGlob POSIX path rejects non-matching **/config/*.ts", () => {
    assert.equal(matchesGlob("/home/user/repo/secrets.ts", "**/config/*.ts"), false)
})

test("matchesGlob POSIX path matches /Users prefix", () => {
    assert.equal(matchesGlob("/Users/user/repo/secrets.ts", "**/secrets.ts"), true)
})

test("isFilePathProtected returns true when one POSIX path matches", () => {
    assert.equal(isFilePathProtected(["/home/user/repo/secrets.ts"], ["**/secrets.ts"]), true)
})

test("isFilePathProtected returns false when no POSIX path matches", () => {
    assert.equal(isFilePathProtected(["/home/user/repo/src/main.ts"], ["**/secrets.ts"]), false)
})

// M3 fork fix (#592): Windows paths now normalize correctly (single "\\" matches).
test("matchesGlob Windows C:\\ path matches **/secrets.ts", () => {
    assert.equal(matchesGlob("C:\\repo\\src\\secrets.ts", "**/secrets.ts"), true)
})

test("matchesGlob Windows C:\\ path rejects non-matching **/config/*.ts", () => {
    assert.equal(matchesGlob("C:\\repo\\src\\secrets.ts", "**/config/*.ts"), false)
})

test("matchesGlob Windows D:\\ path matches nested **/proj/*.ts", () => {
    assert.equal(matchesGlob("D:\\work\\proj\\secrets.ts", "**/proj/*.ts"), true)
})

test("isFilePathProtected returns true when a Windows path matches", () => {
    assert.equal(isFilePathProtected(["C:\\repo\\src\\secrets.ts"], ["**/secrets.ts"]), true)
})

// POSIX path with backslash-segments produced by some tooling should normalize too.
test("matchesGlob mixed separators normalize on input", () => {
    assert.equal(matchesGlob("/home/user\\repo/secrets.ts", "**/secrets.ts"), true)
})
// Logic Verified: matchesGlob handles POSIX and Windows-style paths with backslash-segments, and isFilePathProtected returns true when any POSIX/Windows path matches.
// Bugs Documented: none.
// Fakes Updated: none
// Review Status: pending independent review.
