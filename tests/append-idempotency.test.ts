import assert from "node:assert/strict"
import test from "node:test"
import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { appendToTextPart, appendToToolPart } from "../lib/messages/utils"
import type { WithParts } from "../lib/state"

// Per-test isolation: redirect XDG_DATA_HOME / XDG_CONFIG_HOME so the
// persistence layer and the logger never touch the host filesystem.
const testDataHome = join(tmpdir(), `opencode-dcp-append-idempotency-data-${process.pid}`)
const testConfigHome = join(tmpdir(), `opencode-dcp-append-idempotency-config-${process.pid}`)
process.env.XDG_DATA_HOME = testDataHome
process.env.XDG_CONFIG_HOME = testConfigHome
mkdirSync(testDataHome, { recursive: true })
mkdirSync(testConfigHome, { recursive: true })

type TextPart = Extract<WithParts["parts"][number], { type: "text" }>
type ToolPart = Extract<WithParts["parts"][number], { type: "tool" }>

function textPart(text: string): TextPart {
    return {
        id: "prt-text",
        messageID: "msg-append",
        sessionID: "ses_append",
        type: "text",
        text,
    }
}

function toolPart(output: string): ToolPart {
    return {
        id: "prt-tool",
        messageID: "msg-append",
        sessionID: "ses_append",
        type: "tool",
        tool: "bash",
        callID: "call-append",
        state: { status: "completed", input: {}, output, title: "bash", metadata: {}, time: { start: 0, end: 1 } },
    }
}

test("append helpers are idempotent when the same tag is re-fired", () => {
    const text = textPart("body")
    const tool = toolPart("output")
    const tag = "<dcp-tag>stable</dcp-tag>"

    appendToTextPart(text, tag)
    appendToToolPart(tool, tag)
    const textAfterFirst = text.text
    const outputAfterFirst = tool.state.output
    appendToTextPart(text, tag)
    appendToToolPart(tool, tag)

    assert.equal(text.text, textAfterFirst)
    assert.equal(tool.state.output, outputAfterFirst)
})

test("appendToTextPart leaves a tail-position tag unchanged", () => {
    const tag = "<dcp-tag>tail</dcp-tag>"
    const part = textPart(`body\n\n${tag}`)

    appendToTextPart(part, tag)

    assert.equal(part.text, `body\n\n${tag}`)
})

test("appendToTextPart re-appends a tag found earlier but not at the tail", () => {
    const tag = "<dcp-tag>repeatable</dcp-tag>"
    const part = textPart(`before ${tag} after`)

    // Deliberate trade-off: endsWith only suppresses an exact tail match, so
    // an earlier occurrence is appended again rather than treated as current.
    appendToTextPart(part, tag)

    assert.equal(part.text.split(tag).length - 1, 2)
    assert.ok(part.text.endsWith(tag))
})

test("a different tag appends after the current tail tag", () => {
    const firstTag = "<dcp-tag>first</dcp-tag>"
    const secondTag = "<dcp-tag>second</dcp-tag>"
    const part = textPart(`body\n\n${firstTag}`)

    appendToTextPart(part, secondTag)

    assert.ok(part.text.includes(firstTag))
    assert.ok(part.text.endsWith(secondTag))
})

// Logic Verified: exact-tail idempotency and deliberate non-tail re-append semantics.
// Bugs Documented: none.
// Fakes Updated: none.
// Review Status: independent review completed; non-empty tag fixtures verified.
