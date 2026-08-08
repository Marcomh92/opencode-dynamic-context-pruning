import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
    createSessionState,
    syncPruneToolsFromActiveBlocks,
    type CompressionBlock,
} from "../lib/state"

// BUG-051 — state.prune.tools token count is stale.
//
// Two acceptable fix paths are recognised in the report:
//   (1) Drop the value (use Set<string>) because callers use .has/.keys only
//       and the tokenCount snapshot is unused. This is the report's "ponytail"
//       answer.
//   (2) Wire the value up so the cached tokenCount in state.prune.tools tracks
//       the fresh toolParameters.tokenCount even after trimToolParametersCache
//       evictions and re-population.
//
// This test accepts EITHER fix. If the field is dropped from Prune.tools (the
// static check finds no Map<string, number ...> on the `tools` line), the test
// passes immediately. If the field is kept, the test exercises the canonical
// recompute path (syncPruneToolsFromActiveBlocks) and asserts the cached value
// reflects the fresh toolParameters entry. In current code the field is kept
// and the recompute skips already-present IDs (state/utils.ts:378), so the
// value remains stale and the test fails — pinning the bug for the
// implementer round.

const repoRoot = join(import.meta.dirname, "..")
const typesPath = join(repoRoot, "lib", "state", "types.ts")
const typesContent = readFileSync(typesPath, "utf-8")

// Match `tools: Map<string, number...>` (with or without trailing type args).
// Accepts:  tools: Map<string, number>
//           tools:Map<string,number,anything>
//           tools: Map<string, number | undefined>
// Rejects:  tools: Set<string>
//           (field removed entirely)
const hasVestigialField = /tools\s*:\s*Map<\s*string\s*,\s*number\b/.test(typesContent)

test("BUG-051 #vestigial-tokenCount either dropped from Prune.tools or kept fresh", () => {
    if (!hasVestigialField) {
        // Fix path (1) — field dropped. Document the contract for future
        // readers: callers must not depend on prune.tools.get(id).
        assert.ok(
            true,
            "Prune.tools no longer carries a vestigial tokenCount (Map<string, number> removed)",
        )
        return
    }

    // Fix path (2) — wire up. The cached value in state.prune.tools must
    // reflect the FRESH toolParameters.tokenCount even when the entry was
    // already in prune.tools before the recompute ran. Current code's
    // syncPruneToolsFromActiveBlocks skips already-present IDs (utils.ts:378),
    // so a stale 100 stays after a fresh 200 is written — that is the bug.
    const state = createSessionState()
    const id = "call-bug051-token"

    // Pre-existing entry with a stale value.
    state.prune.tools.set(id, 100)
    // Fresh underlying data — recompute must surface this.
    state.toolParameters.set(id, { tool: "bash", parameters: {}, turn: 1, tokenCount: 200 })

    // Anchor the tool in an active block so syncPruneToolsFromActiveBlocks
    // preserves the entry across its "wipe & re-seed" pass.
    const block: CompressionBlock = {
        blockId: 1,
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 0,
        summaryTokens: 0,
        durationMs: 0,
        topic: "bug051",
        startId: "s",
        endId: "e",
        anchorMessageId: "a",
        compressMessageId: "c",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: [],
        directToolIds: [id],
        effectiveMessageIds: [],
        effectiveToolIds: [id],
        createdAt: Date.now(),
        summary: "",
    }
    state.prune.messages.blocksById.set(1, block)
    state.prune.messages.activeBlockIds.add(1)

    syncPruneToolsFromActiveBlocks(state)

    assert.equal(
        state.prune.tools.get(id),
        200,
        "After recompute, state.prune.tools must reflect the fresh toolParameters.tokenCount (was frozen at first write; see BUG-051)",
    )
})

// Logic Verified: either the vestigial tokenCount field is removed from
//                  Prune.tools, OR the field stays and the value tracks
//                  fresh toolParameters.tokenCount across recomputes.
// Bugs Documented: BUG-051-prune-token-count-stale.md
// Fakes Updated:  none (uses production state factory + recompute helper).
// Review Status:  pending independent review.
// Logic Verified: vestigial tokenCount is either dropped from Prune.tools or kept fresh across recomputes.
// Bugs Documented: BUG-051.
// Fakes Updated: none (uses production state factory + recompute helper).
// Review Status: pending independent review.
