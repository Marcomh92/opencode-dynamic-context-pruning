import assert from "node:assert/strict"
import test from "node:test"
import { compileStripPattern, stripPatterns } from "../lib/messages/strip-patterns"
import type { WithParts } from "../lib/state"

// stripPatterns — config-driven text block / substring stripper for message
// parts. Tests drive the production module directly (no fixtures dir) per
// PAT-010; per-test fixtures are built inline.

const SESSION = "ses_strip_patterns"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function userTextPart(text: string, metadata?: Record<string, unknown>) {
    const part: any = { type: "text", text }
    if (metadata) part.metadata = metadata
    return part
}

function userMessage(
    text: string,
    opts: { id?: string; metadata?: Record<string, unknown> } = {},
): WithParts {
    return {
        info: {
            id: opts.id ?? "msg-user",
            role: "user",
            sessionID: SESSION,
            agent: "assistant",
            model: { providerID: "anthropic", modelID: "claude-test" },
            time: { created: 1 },
        } as any,
        parts: [userTextPart(text, opts.metadata)],
    }
}

function assistantTextMessage(
    text: string,
    opts: { id?: string; metadata?: Record<string, unknown> } = {},
): WithParts {
    return {
        info: {
            id: opts.id ?? "msg-asst",
            role: "assistant",
            sessionID: SESSION,
            agent: "assistant",
            modelID: "claude-test",
            providerID: "anthropic",
            time: { created: 2 },
        } as any,
        parts: [userTextPart(text, opts.metadata)],
    }
}

function toolPart(
    callID: string,
    status: "completed" | "pending" | "running" | "error",
    output?: string,
): any {
    const state: any = { status, input: { description: "demo" } }
    if (output !== undefined) state.output = output
    return {
        id: `${callID}-part`,
        messageID: "msg-asst",
        sessionID: SESSION,
        type: "tool",
        tool: "bash",
        callID,
        state,
    }
}

function assistantToolMessage(tool: any, id = "msg-asst"): WithParts {
    return {
        info: {
            id,
            role: "assistant",
            sessionID: SESSION,
            agent: "assistant",
            modelID: "claude-test",
            providerID: "anthropic",
            time: { created: 2 },
        } as any,
        parts: [tool],
    }
}

function stepStartPart(): any {
    return { id: "ss1", messageID: "msg-asst", sessionID: SESSION, type: "step-start" }
}

function reasoningPart(text: string): any {
    return {
        id: "r1",
        messageID: "msg-asst",
        sessionID: SESSION,
        type: "reasoning",
        text,
    }
}

function stepStartMessage(): WithParts {
    return {
        info: {
            id: "msg-step",
            role: "assistant",
            sessionID: SESSION,
            agent: "assistant",
            modelID: "claude-test",
            providerID: "anthropic",
            time: { created: 2 },
        } as any,
        parts: [stepStartPart()],
    }
}

function reasoningMessage(): WithParts {
    return {
        info: {
            id: "msg-reason",
            role: "assistant",
            sessionID: SESSION,
            agent: "assistant",
            modelID: "claude-test",
            providerID: "anthropic",
            time: { created: 2 },
        } as any,
        parts: [reasoningPart("thinking aloud <block>noise</block>")],
    }
}

// ---------------------------------------------------------------------------
// A. compileStripPattern — direct regex compilation tests
// ---------------------------------------------------------------------------

test("compileStripPattern: <available-skills> matches the whole block including multi-line content", () => {
    const re = compileStripPattern("<available-skills>")
    const text = "header\n<available-skills>\nline1\nline2\n</available-skills>\nfooter"
    assert.equal(
        text.replace(re, ""),
        "header\n\nfooter",
        "block including content is stripped, surrounding text is preserved",
    )
})

test("compileStripPattern: <task_result> with underscore in name matches the whole block", () => {
    const re = compileStripPattern("<task_result>")
    const text = "before\n<task_result>\nanswer\n</task_result>\nafter"
    assert.equal(text.replace(re, ""), "before\n\nafter")
})

test("compileStripPattern: <available-skills> lazy-match strips sequential blocks independently", () => {
    // Lazy quantifier `*?` makes each block strip on its own rather than
    // spanning from the first opening tag to the last closing tag.
    const re = compileStripPattern("<a>")
    const text = "<a>x</a> middle <a>y</a>"
    assert.equal(text.replace(re, ""), " middle ")
})

test("compileStripPattern: [TODO] matches literal substring — brackets are escaped, not a character class", () => {
    const re = compileStripPattern("[TODO]")
    // Hits literal substring; literal "[" and "]" are matched, not the
    // character-class syntax that would otherwise interpret the bracket as
    // the start of a set.
    assert.equal("hello [TODO] world".replace(re, ""), "hello  world")
    // A `[XYZ]` substring must NOT be removed: no regex char-class semantics.
    assert.equal("[XYZ]".replace(re, ""), "[XYZ]", "[XYZ] is not a TODO marker")
})

test("compileStripPattern: foo.bar escapes the dot — only literal foo.bar matches", () => {
    const re = compileStripPattern("foo.bar")
    assert.equal(
        "fooXbar".replace(re, ""),
        "fooXbar",
        "dot must be escaped (no regex any-char semantics)",
    )
    assert.equal("foo.bar baz".replace(re, ""), " baz", "literal dot matches")
})

test("compileStripPattern: empty string compiles to a regex with zero-width matches", () => {
    // Production behaviour with `patterns = [""]`:
    //   `new RegExp("", "g")` matches at every position with zero width;
    //   replacing with "" leaves the original text unchanged (no
    //   infinite-loop or wipe-out). The contract test below pins the
    //   observable: "abc".replace(re, "") === "abc".
    const re = compileStripPattern("")
    assert.ok(re instanceof RegExp, "empty pattern still compiles a RegExp")
    assert.equal("abc".replace(re, ""), "abc", "zero-width matches do not change text")
})

// ---------------------------------------------------------------------------
// B. stripPatterns — text parts
// ---------------------------------------------------------------------------

test("stripPatterns: block-name pattern strips <available-skills>...</available-skills> but preserves surrounding text", () => {
    const messages = [
        userMessage("intro\n<available-skills>\nskill a\nskill b\n</available-skills>\noutro", {
            id: "u-1",
        }),
    ]

    stripPatterns(messages, ["<available-skills>"])

    assert.equal(
        (messages[0].parts[0] as any).text,
        "intro\n\noutro",
        "block including content is removed; the lines around it survive",
    )
})

test("stripPatterns: literal-substring pattern [TODO] is removed from user text", () => {
    const messages = [userMessage("hello [TODO] world", { id: "u-todo" })]

    stripPatterns(messages, ["[TODO]"])

    assert.equal((messages[0].parts[0] as any).text, "hello  world")
})

test("stripPatterns: mixed patterns (block-name + literal) are applied together", () => {
    const messages = [
        userMessage("intro <secret>keep</secret> body [REDACT] outro", { id: "u-mix" }),
    ]

    stripPatterns(messages, ["<secret>", "[REDACT]"])

    assert.equal(
        (messages[0].parts[0] as any).text,
        "intro  body  outro",
        "both block-name and literal-substring patterns apply in one pass",
    )
})

test("stripPatterns: empty patterns array is a no-op", () => {
    const text = "untouched [TODO] body"
    const messages = [userMessage(text, { id: "u-empty" })]

    stripPatterns(messages, [])

    assert.equal((messages[0].parts[0] as any).text, text)
})

test("stripPatterns: undefined patterns is tolerated (defensive branch)", () => {
    // Production always supplies an array, but the function tolerates
    // `undefined` so pre-`stripPatterns`-field test fixtures still pass.
    const text = "untouched [TODO] body"
    const messages = [userMessage(text, { id: "u-undef" })]

    assert.doesNotThrow(() => stripPatterns(messages, undefined))
    assert.equal((messages[0].parts[0] as any).text, text)
})

test("stripPatterns: pattern absent in text leaves the message unchanged", () => {
    const text = "no markers here"
    const messages = [userMessage(text, { id: "u-absent" })]

    stripPatterns(messages, ["[TODO]", "<secret>"])

    assert.equal((messages[0].parts[0] as any).text, text)
})

test("stripPatterns: multiple occurrences of the same block are all stripped", () => {
    const messages = [userMessage("alpha <a>x</a> middle <a>y</a> omega", { id: "u-multi" })]

    stripPatterns(messages, ["<a>"])

    assert.equal((messages[0].parts[0] as any).text, "alpha  middle  omega")
})

test("stripPatterns: idempotent — running twice with the same patterns produces the same text", () => {
    const messages = [userMessage("intro <secret>x</secret> body [TODO] outro", { id: "u-idem" })]

    stripPatterns(messages, ["<secret>", "[TODO]"])
    const once = (messages[0].parts[0] as any).text
    stripPatterns(messages, ["<secret>", "[TODO]"])
    const twice = (messages[0].parts[0] as any).text

    assert.equal(once, "intro  body  outro", "first pass strips all matches")
    assert.equal(twice, once, "second pass is a no-op (matches already absent)")
})

// ---------------------------------------------------------------------------
// C. stripPatterns — tool parts
// ---------------------------------------------------------------------------

test("stripPatterns: completed tool output containing a block-name pattern is stripped", () => {
    const part = toolPart("call-1", "completed", "ok <secret>leak</secret> tail")
    const messages = [assistantToolMessage(part)]

    stripPatterns(messages, ["<secret>"])

    assert.equal(
        part.state.output,
        "ok  tail",
        "block-name strip applies to completed tool output, not just text parts",
    )
})

test("stripPatterns: pending tool output (status === 'pending') is NOT modified", () => {
    // `state.status !== "completed"` means stripPatterns skips the part
    // entirely. Even when `state.output` is set (e.g. a partial streaming
    // output captured before completion), it must remain untouched.
    const part = toolPart("call-pending", "pending", "[TODO] should not be stripped")
    const before = JSON.parse(JSON.stringify(part.state))
    const messages = [assistantToolMessage(part)]

    stripPatterns(messages, ["[TODO]"])

    assert.deepEqual(part.state, before, "pending tool state is byte-identical after strip")
    assert.equal(part.state.output, "[TODO] should not be stripped")
})

test("stripPatterns: pending tool with no state.output is not mutated", () => {
    // No output captured yet — stripPatterns still must not touch the part.
    const part = toolPart("call-empty", "pending")
    const before = JSON.parse(JSON.stringify(part))
    const messages = [assistantToolMessage(part)]

    stripPatterns(messages, ["[TODO]", "<a>"])

    assert.deepEqual(part, before)
})

test("stripPatterns: non-text, non-tool parts (step-start, reasoning) are skipped without error", () => {
    // reasoning carries text-like content; stripPatterns intentionally does
    // NOT touch it. Only `text` and completed-tool `state.output` are in
    // scope (see lib/messages/strip-patterns.ts:53-74).
    const messages = [stepStartMessage(), reasoningMessage()]

    assert.doesNotThrow(() => stripPatterns(messages, ["<block>"]))

    assert.equal(messages[0].parts.length, 1, "step-start part count unchanged")
    assert.equal((messages[0].parts[0] as any).type, "step-start")
    assert.equal(
        (messages[1].parts[0] as any).text,
        "thinking aloud <block>noise</block>",
        "reasoning text is left untouched by stripPatterns",
    )
})

// ---------------------------------------------------------------------------
// D. Pipeline interactions
// ---------------------------------------------------------------------------

test("stripPatterns: applies to every message in the array, not just the first", () => {
    const messages = [
        userMessage("a [TODO] b", { id: "u-1" }),
        assistantTextMessage("c [TODO] d", { id: "a-2" }),
        userMessage("e [TODO] f", { id: "u-3" }),
    ]

    stripPatterns(messages, ["[TODO]"])

    assert.equal((messages[0].parts[0] as any).text, "a  b")
    assert.equal((messages[1].parts[0] as any).text, "c  d")
    assert.equal((messages[2].parts[0] as any).text, "e  f")
})

test("stripPatterns: only mutates part.text — other fields (e.g. metadata) are preserved", () => {
    // Caller identity on a text part is a real surface (see
    // lib/logger.ts:188) — strip must not erase it.
    const metadata = {
        caller: "parent-session-xyz",
        sessionId: "task-session-abc",
        traceId: "trace-7",
    }
    const messages = [userMessage("hello [TODO] world", { id: "u-meta", metadata })]

    stripPatterns(messages, ["[TODO]"])

    const part = messages[0].parts[0] as any
    assert.equal(part.text, "hello  world", "text field is mutated")
    assert.deepEqual(
        part.metadata,
        metadata,
        "metadata object is preserved exactly — only text is in scope",
    )
})

test("stripPatterns: tool with non-string state.output (object) is skipped", () => {
    // Some tools return structured objects, not strings. stripPatterns
    // must not stringify or mutate them; the guard
    // `typeof part.state.output === "string"` filters them out.
    const structured = { rows: [{ id: 1, name: "[TODO]" }] }
    const part = toolPart("call-obj", "completed")
    part.state.output = structured
    const messages = [assistantToolMessage(part)]

    stripPatterns(messages, ["[TODO]"])

    assert.strictEqual(part.state.output, structured, "structured output is left untouched")
    assert.deepEqual(part.state.output, { rows: [{ id: 1, name: "[TODO]" }] })
})

test("stripPatterns: text identical before/after leaves the field unchanged", () => {
    // When no pattern matches, the function short-circuits assignment to
    // avoid allocating a new string. Observable contract: the field still
    // reads the same value.
    const text = "no markers in this body"
    const messages = [userMessage(text, { id: "u-noop" })]

    stripPatterns(messages, ["[TODO]", "<a>"])

    assert.equal((messages[0].parts[0] as any).text, text)
})

// Logic Verified: compileStripPattern emits (a) a global regex matching the full `<name>...</name>` block including multi-line content with lazy quantifier so sequential blocks are stripped independently and underscore tag names are accepted, and (b) a literal-substring regex with all regex special chars escaped (brackets not parsed as character class, dot not parsed as any-char). stripPatterns applies the compiled patterns to text parts and completed tool outputs in place; tolerates undefined and empty patterns arrays, preserves non-text fields on text parts (e.g. caller metadata), skips non-text/non-tool parts (step-start, reasoning), skips pending tool states entirely, and skips completed tools whose output is not a string. Running twice with the same patterns is a no-op (idempotency).
// Bugs Documented: none.
// Fakes Updated: none.
// Review Status: pending independent review.
