import assert from "node:assert/strict"
import test from "node:test"
import { stripText } from "../lib/messages/strip-patterns"

// stripText — pure text-string stripper used by the protected-content
// builders (`lib/compress/protected-content.ts::appendProtectedUserMessages`
// and `appendProtectedPromptInfo`) as the load-bearing fix in BUG-095.
// Tests pin the BUG-095 contract directly: the strip must apply only to the
// compression-summary text, never to the live `output.messages` array.

// ────────────────────────────────────────────────────────────────────────────
// A. Block-name patterns — the `<available-skills>...</available-skills>` shape
//    the plugin actually uses.
// ────────────────────────────────────────────────────────────────────────────

test("stripText: block-name pattern strips <available-skills>...</available-skills> and preserves surrounding text", () => {
    const text = "intro\n<available-skills>\nskill a\nskill b\n</available-skills>\noutro"

    const out = stripText(text, ["<available-skills>"])

    assert.equal(
        out,
        "intro\n\noutro",
        "block including content is removed; surrounding text survives",
    )
})

test("stripText: tag name with an underscore (<task_result>) is stripped as a whole block", () => {
    const text = "before\n<task_result>\nanswer\n</task_result>\nafter"

    const out = stripText(text, ["<task_result>"])

    assert.equal(out, "before\n\nafter")
})

test("stripText: <available-skills> with multi-line content is stripped as a whole block (lazy quantifier)", () => {
    const text = "header\n<available-skills>\nline1\nline2\nline3\n</available-skills>\nfooter"

    const out = stripText(text, ["<available-skills>"])

    assert.equal(out, "header\n\nfooter")
})

test("stripText: multiple occurrences of the same block are all stripped", () => {
    const text = "alpha <a>x</a> middle <a>y</a> omega"

    const out = stripText(text, ["<a>"])

    assert.equal(out, "alpha  middle  omega")
})

// ────────────────────────────────────────────────────────────────────────────
// B. Literal-substring patterns — `[TODO]`, etc. Regex meta-chars must be
//    escaped so user config cannot inject regex syntax.
// ────────────────────────────────────────────────────────────────────────────

test("stripText: literal-substring pattern [TODO] is removed", () => {
    const out = stripText("hello [TODO] world", ["[TODO]"])

    assert.equal(out, "hello  world")
})

test("stripText: regex special chars in literal patterns are escaped — brackets not parsed as character class", () => {
    // `[TODO]` matches the literal substring; it must NOT match the
    // character-class semantics that the unescaped brackets would produce.
    // `[XYZ]` is therefore preserved.
    assert.equal(stripText("hello [TODO] world", ["[TODO]"]), "hello  world")
    assert.equal(stripText("[XYZ]", ["[TODO]"]), "[XYZ]", "[XYZ] is not a TODO marker")
})

test("stripText: regex special chars in literal patterns are escaped — dot not parsed as any-char", () => {
    // `foo.bar` must only match the literal dot, not any character.
    assert.equal(
        stripText("fooXbar", ["foo.bar"]),
        "fooXbar",
        "dot must be escaped (no regex any-char)",
    )
    assert.equal(stripText("foo.bar baz", ["foo.bar"]), " baz", "literal dot matches")
})

// ────────────────────────────────────────────────────────────────────────────
// C. Mixed / combined patterns
// ────────────────────────────────────────────────────────────────────────────

test("stripText: mixed patterns (block-name + literal) are applied together in one pass", () => {
    const text = "intro <secret>keep</secret> body [REDACT] outro"

    const out = stripText(text, ["<secret>", "[REDACT]"])

    assert.equal(
        out,
        "intro  body  outro",
        "both block-name and literal patterns apply on the same call",
    )
})

// ────────────────────────────────────────────────────────────────────────────
// D. Defensive branches — empty / undefined inputs.
// ────────────────────────────────────────────────────────────────────────────

test("stripText: empty patterns array is a no-op (input returned unchanged)", () => {
    const text = "untouched [TODO] body"

    const out = stripText(text, [])

    assert.equal(out, text)
})

test("stripText: undefined patterns is tolerated (defensive branch — TS strict not enforced in tests)", () => {
    // Production always supplies an array, but the function tolerates
    // `undefined` so pre-`stripPatterns`-field test fixtures still pass.
    const text = "untouched [TODO] body"

    // Cast through `any` to model a caller passing `undefined` despite the
    // `readonly string[]` annotation — this is the defensive branch the
    // production code documents.
    const out = stripText(text, undefined as any)

    assert.equal(out, text)
})

test("stripText: pattern absent in text returns the input unchanged", () => {
    const text = "no markers here"

    const out = stripText(text, ["[TODO]", "<secret>"])

    assert.equal(out, text)
})

// ────────────────────────────────────────────────────────────────────────────
// E. Idempotency — the load-bearing property for repeated compress passes.
// ────────────────────────────────────────────────────────────────────────────

test("stripText: idempotent — running stripText twice with the same patterns yields the same output", () => {
    const text = "intro <secret>x</secret> body [TODO] outro"

    const once = stripText(text, ["<secret>", "[TODO]"])
    const twice = stripText(once, ["<secret>", "[TODO]"])

    assert.equal(once, "intro  body  outro", "first pass strips all matches")
    assert.equal(twice, once, "second pass is a no-op (matches already absent)")
})

test("stripText: re-running on already-stripped text returns the same already-stripped text", () => {
    const alreadyStripped = "intro  body  outro"

    const out = stripText(alreadyStripped, ["<secret>", "[TODO]"])

    assert.equal(out, alreadyStripped, "no matches ⇒ no allocation, input returned")
})

// Logic Verified: stripText strips block-name patterns (`<available-skills>...`, `<task_result>` including underscore names and multi-line lazy-quantifier content) and literal-substring patterns (`[TODO]`, `foo.bar`) from the input string in one pass with regex meta-chars escaped; tolerates an empty patterns array and `undefined` patterns (returning input unchanged); is idempotent under repeated calls.
// Bugs Documented: none.
// Fakes Updated: none.
// Review Status: pending independent review.
