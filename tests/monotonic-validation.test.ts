// BUG-001 + BUG-075 — `validateMonotonicEnd` monotonicity + hint filtering.
//
// The bugs:
//   * BUG-001 — `validateMonotonicEnd` in `lib/compress/range-utils.ts`
//     compares `newStart`/`newEnd` to `prevAnchorEnd` with the default
//     lexicographic `localeCompare`. Because of that, `"b10".localeCompare("b9")`
//     returns `-1` (lexicographic, where '1' < '9' at the second char)
//     so a legitimate `b9 → b10` progression is wrongly rejected as
//     `__DCP_MONOTONIC_VIOLATION__`. The companion `listValidBoundaryIds`
//     on the same file (line 32) already uses `{ numeric: true }` — the
//     divergence is the bug.
//   * BUG-075 — The `validNextHint` built inside `validateMonotonicEnd`
//     enumerates every valid boundary ID via `listValidBoundaryIds(state)`
//     without filtering. It includes IDs that would themselves fail the
//     strict-greater check the agent is trying to satisfy, making the
//     self-correction path noisier than needed.
//
// References:
//   * known_issues/BUG-001-monotonic-locale-compare.md
//   * known_issues/BUG-075-monotonic-hint-all-not-greater.md
// Docs:
//   * docs/PATTERNS.md PAT-006 (numeric-aware sort)
//   * docs/DESIGN_PRINCIPLES.md DPP-005 (monotonic invariants)

import assert from "node:assert/strict"
import test from "node:test"
import { validateMonotonicEnd, listValidBoundaryIds } from "../lib/compress/range-utils"
import { createSessionState, type SessionState } from "../lib/state"

// Register active compressed blocks 1..N on `state`. The minimal shape
// `isBoundaryIdValid` checks is `blockId` + `active: true` — `formatBlockRef`
// reads `blockId`, and the active gate filters out retired blocks.
function setActiveBlocks(state: SessionState, ids: number[]): void {
    for (const blockId of ids) {
        state.prune.messages.blocksById.set(blockId, {
            blockId,
            active: true,
        } as any)
    }
}

// ---------------------------------------------------------------------------
// BUG-001 — `validateMonotonicEnd` uses lexicographic localeCompare
// ---------------------------------------------------------------------------

// Block range `b9 → b10` is the canonical repro: lexicographically
// "b10" < "b9" because at index 1 the digit '1' < '9'. The numeric-aware
// comparator must accept this transition.
test("BUG-001: validateMonotonicEnd accepts b9 → b10 (numeric, not lexicographic)", () => {
    // KNOWN BUG (BUG-001): `validateMonotonicEnd` uses default lexicographic
    // localeCompare; "b10" < "b9" lexicographically so this currently throws.
    // See: known_issues/BUG-001-monotonic-locale-compare.md
    //
    // After the fix, `{ numeric: true }` is applied at range-utils.ts:99, 105.
    // The call below must NOT throw — b10 is strictly greater than b9 in
    // numeric terms.
    const state = createSessionState()
    setActiveBlocks(state, [1, 2, 9, 10])

    assert.doesNotThrow(() => validateMonotonicEnd("b9", "b10", "b10", state))
})

// Block range `b1 → b10` is a sanity check that should pass in BOTH the
// pre-fix and post-fix code (b10 > b1 in both lexicographic and numeric
// orderings). It guards against the fix accidentally flipping polarity.
test("BUG-001 regression guard: validateMonotonicEnd accepts b1 → b10", () => {
    const state = createSessionState()
    setActiveBlocks(state, [1, 9, 10])

    assert.doesNotThrow(() => validateMonotonicEnd("b1", "b10", "b10", state))
})

// Block range `b10 → b1` is the *correct* rejection path: a new range
// that starts before the previous anchor must always throw. Pre-fix and
// post-fix must both throw.
test("BUG-001 regression guard: validateMonotonicEnd rejects b10 → b1", () => {
    const state = createSessionState()
    setActiveBlocks(state, [1, 9, 10])

    assert.throws(
        () => validateMonotonicEnd("b10", "b1", "b10", state),
        /__DCP_MONOTONIC_VIOLATION__/,
    )
})

// Block range `b2 → b2` (equal) is the *correct* equality rejection:
// strict-greater means equal is also a violation. Pre-fix and post-fix
// must both throw.
test("BUG-001 regression guard: validateMonotonicEnd rejects equal b2 → b2", () => {
    const state = createSessionState()
    setActiveBlocks(state, [1, 2, 9, 10])

    assert.throws(
        () => validateMonotonicEnd("b2", "b2", "b2", state),
        /__DCP_MONOTONIC_VIOLATION__/,
    )
})

// `listValidBoundaryIds` already uses `{ numeric: true }`; pin that as the
// reference sort. If the comparator fix extracts a helper, this test is the
// canonical oracle for "b9 < b10" / "b10 > b9".
test("BUG-001 reference: listValidBoundaryIds sorts b1..b10 numerically", () => {
    const state = createSessionState()
    setActiveBlocks(state, [1, 2, 9, 10])

    assert.deepEqual(listValidBoundaryIds(state), ["b1", "b2", "b9", "b10"])
})

// ---------------------------------------------------------------------------
// BUG-075 — `validNextHint` lists all valid IDs, not strictly-greater
// ---------------------------------------------------------------------------

// The hint inside a `__DCP_MONOTONIC_VIOLATION__` error must list ONLY
// IDs that are strictly greater than `prevAnchorEnd`. Pre-fix the hint
// includes every valid ID (including ones that themselves fail the
// strict-greater check the agent is trying to satisfy).
test("BUG-075: violation hint lists IDs strictly greater than prevAnchorEnd", () => {
    // KNOWN BUG (BUG-075): the hint is built from `listValidBoundaryIds(state)`
    // without filtering, so it includes b1..b5 which all fail the same
    // strict-greater check the agent is trying to satisfy.
    // See: known_issues/BUG-075-monotonic-hint-all-not-greater.md
    //
    // After the fix, the hint is filtered by
    //   `id.localeCompare(prevAnchorEnd, undefined, { numeric: true }) > 0`
    // so it carries only candidates the agent can actually use as the
    // next anchor.
    const state = createSessionState()
    setActiveBlocks(state, [1, 2, 3, 4, 5, 6, 7, 8])

    // Trigger a violation: prevAnchorEnd="b5", newStart="b3" — b3 < b5,
    // so the newStart check throws. The hint should enumerate only IDs
    // strictly greater than "b5".
    assert.throws(
        () => validateMonotonicEnd("b5", "b3", "b5", state),
        /__DCP_MONOTONIC_VIOLATION__/,
    )

    let captured = ""
    try {
        validateMonotonicEnd("b5", "b3", "b5", state)
    } catch (err) {
        captured = (err as Error).message
    }

    // Strictly-greater IDs (b6, b7, b8) MUST appear in the hint.
    assert.match(captured, /\bb6\b/)
    assert.match(captured, /\bb7\b/)
    assert.match(captured, /\bb8\b/)

    // IDs that fail the strict-greater check (≤ b5) MUST NOT appear.
    assert.doesNotMatch(captured, /\bb1\b/)
    assert.doesNotMatch(captured, /\bb2\b/)
    assert.doesNotMatch(captured, /\bb3\b/)
    assert.doesNotMatch(captured, /\bb4\b/)
    assert.doesNotMatch(captured, /\bb5\b/)
})

// Pin the hint-filter boundary: prevAnchorEnd="b3", violation throws,
// hint must carry exactly b4..b8 (not b1..b3). This catches both
// off-by-one filters (e.g., filtering out the boundary itself is correct
// here, but if someone accidentally filters out b4+ they'd also drop
// legitimate candidates).
test("BUG-075: violation hint with prevAnchorEnd=b3 includes b4..b8 and excludes b1..b3", () => {
    // KNOWN BUG (BUG-075): the hint includes IDs ≤ prevAnchorEnd.
    // See: known_issues/BUG-075-monotonic-hint-all-not-greater.md
    const state = createSessionState()
    setActiveBlocks(state, [1, 2, 3, 4, 5, 6, 7, 8])

    let captured = ""
    try {
        validateMonotonicEnd("b3", "b3", "b3", state)
    } catch (err) {
        captured = (err as Error).message
    }

    // Sanity: we did catch a violation.
    assert.match(captured, /__DCP_MONOTONIC_VIOLATION__/)

    // IDs > b3 must all appear.
    for (const id of ["b4", "b5", "b6", "b7", "b8"]) {
        assert.match(captured, new RegExp(`\\b${id}\\b`), `expected hint to include ${id}`)
    }

    // IDs ≤ b3 must NOT appear.
    for (const id of ["b1", "b2", "b3"]) {
        assert.doesNotMatch(captured, new RegExp(`\\b${id}\\b`), `expected hint to exclude ${id}`)
    }
})
// Logic Verified: validateMonotonicEnd accepts strictly greater numeric boundaries (b9→b10), rejects equal/descending, and the violation hint lists IDs strictly greater than prevAnchorEnd.
// Bugs Documented: BUG-001, BUG-075.
// Fakes Updated: none
// Review Status: pending independent review.
