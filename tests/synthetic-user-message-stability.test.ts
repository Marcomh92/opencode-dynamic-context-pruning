import assert from "node:assert/strict"
import test from "node:test"
import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { UserMessage } from "@opencode-ai/sdk/v2"
import { createSyntheticUserMessage } from "../lib/messages/utils"
import type { WithParts } from "../lib/state"

// Per-test isolation: redirect XDG_DATA_HOME / XDG_CONFIG_HOME so the
// persistence layer and the logger never touch the host filesystem.
const testDataHome = join(tmpdir(), `opencode-dcp-synthetic-stability-data-${process.pid}`)
const testConfigHome = join(tmpdir(), `opencode-dcp-synthetic-stability-config-${process.pid}`)
process.env.XDG_DATA_HOME = testDataHome
process.env.XDG_CONFIG_HOME = testConfigHome
mkdirSync(testDataHome, { recursive: true })
mkdirSync(testConfigHome, { recursive: true })

test("createSyntheticUserMessage is byte-stable for the same content and seed", () => {
    const info: UserMessage = {
        sessionID: "ses_synthetic_stability",
        id: "msg-base",
        role: "user",
        agent: "assistant",
        model: { providerID: "anthropic", modelID: "claude-test" },
        time: { created: 123 },
    }
    const baseMessage = { info, parts: [] } as WithParts

    const first = createSyntheticUserMessage(baseMessage, "Stable summary.", "block-1:msg-base")
    const second = createSyntheticUserMessage(baseMessage, "Stable summary.", "block-1:msg-base")

    assert.equal(JSON.stringify(first), JSON.stringify(second))
    assert.deepEqual(first.info.time, { created: 0 })
    assert.equal(first.info.id, second.info.id)
    assert.equal(first.parts[0]?.id, second.parts[0]?.id)
    assert.equal(first.parts[0]?.messageID, first.info.id)
    assert.notEqual(
        createSyntheticUserMessage(baseMessage, "Stable summary.", "block-2:msg-base").info.id,
        first.info.id,
    )
})

test("BUG-098: createSyntheticUserMessage with the nudge seed is byte-stable across re-fires", () => {
    // BUG-098: the nudge injection site uses a deterministic seed of
    // `dcp_nudge:<nudgeType>:<anchorId>`. Two calls with the same seed must
    // produce byte-identical synthetic user messages — the second
    // `applyAnchoredNudges` fire relies on this to detect the already-injected
    // synthetic via the adjacent-id check and skip the splice. Different
    // seeds (different anchorId OR different nudgeType) must NOT collide.
    const info: UserMessage = {
        sessionID: "ses_bug098_nudge_seed_stability",
        id: "msg-anchor-1",
        role: "user",
        agent: "assistant",
        model: { providerID: "anthropic", modelID: "claude-test" },
        time: { created: 7 },
    }
    const baseMessage = { info, parts: [] } as WithParts

    const seed = "dcp_nudge:iteration:msg-anchor-1"
    const first = createSyntheticUserMessage(baseMessage, "Iterating.", seed, true)
    const second = createSyntheticUserMessage(baseMessage, "Iterating.", seed, true)

    assert.equal(JSON.stringify(first), JSON.stringify(second))
    assert.equal(first.info.id, second.info.id)
    assert.equal(first.parts[0]?.id, second.parts[0]?.id)
    assert.equal(first.parts[0]?.messageID, first.info.id)
    assert.equal((first.parts[0] as { synthetic?: boolean }).synthetic, true)

    // Different anchorId OR different nudgeType must produce a different id,
    // so the adjacent-id idempotency check does not suppress a distinct
    // nudge anchor.
    const differentAnchor = createSyntheticUserMessage(
        baseMessage,
        "Iterating.",
        "dcp_nudge:iteration:msg-anchor-2",
        true,
    )
    assert.notEqual(differentAnchor.info.id, first.info.id)
    const differentType = createSyntheticUserMessage(
        baseMessage,
        "Iterating.",
        "dcp_nudge:turn:msg-anchor-1",
        true,
    )
    assert.notEqual(differentType.info.id, first.info.id)
})

// Logic Verified: deterministic synthetic message bytes, timestamp sentinel, and stable IDs (including BUG-098 nudge-seed contract).
// Bugs Documented: BUG-098 (nudge seed byte-stability pinned across re-fires).
// Fakes Updated: none.
// Review Status: independent review completed; ID/linkage assertions strengthened.
