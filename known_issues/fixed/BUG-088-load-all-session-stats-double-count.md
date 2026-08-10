# BUG-088: loadAllSessionStats double-counts `totalPruneTokens` when compression blocks are inherited across forked sessions

**Status:** Fixed 2026-08-10
**Severity:** Low (lifetime-stat inflation; no correctness hole)
**Component:** lib/state/inherit.ts fork-copy block (`tryInheritFromParent`)

## Resolution (2026-08-10)

The original bug report recommended a full Option-B rename (`totalPruneTokens` →
`sessionOwnPruneTokens`) plus a per-session UI change. That scope was too large
for the v2 fork-protocol round and was deferred. The implemented fix is the
**minimum-impact Option-B variant** that closes the double-count without
touching the on-disk field name or `/dcp stats` UI.

**Fix:** In the fork-copy block at `lib/state/inherit.ts:660-679`,
`parentState.stats.totalPruneTokens` is no longer copied into the child's
`stats.totalPruneTokens`. Instead, it lands in the child's new
`stats.inheritedPruneTokens` field (display-only). Multi-gen forks accumulate
parent's `inheritedPruneTokens` into the child's `inheritedPruneTokens` so the
transitive display is correct, but **never** into `totalPruneTokens`. Because
`loadAllSessionStats` sums `totalPruneTokens` across files, A and B can no
longer both report A's original savings — A reports it as `totalPruneTokens`,
B reports it as `inheritedPruneTokens` (which the all-time aggregator
deliberately ignores).

**No schema bump, no rename, no UI change.** The aggregation path is
unchanged; only the write side is fixed. Q2 (the "copied push on 0 accumulator"
follow-up): the copy log now fires only when the final `inheritedAccumulator`
is > 0, so a parent with `totalPruneTokens: 0` no longer logs a copy that
wrote nothing.

**Tests:** existing fork-inherit tests cover the copy semantics; the Q2 fix
log-line behaviour is exercised by the debug-log summary test in the
fork-inherit suite. New clamp/validation tests for `stateRetentionDays` (a
sibling fix shipped in the same round) live in the BUG-092 fix file.

**Severity rationale:** Lifetime stat inflation is a UX defect, not a
correctness hole. Architect-verified Low: the per-session stat is correct,
the per-session inherit display is correct, and only the cross-session
aggregation was wrong — and only after the BUG-089 fork-inheritance feature
became live (it was latent before). Same cluster shape as BUG-087/089/091.

## Problem

`loadAllSessionStats` sums `totalPruneTokens` across every persisted session file in the DCP storage dir (`lib/state/persistence.ts:503`). When a session A compresses 5,000 tokens, A's persisted state records `totalPruneTokens: 5000`. When A is forked to session B and B inherits A's compression blocks (per the fork-state-inheritance plan in `docs/plans/fork-state-inheritance.md`), B's persisted state also records `totalPruneTokens: 5000` — reflecting B's actual inherited savings.

`loadAllSessionStats` then reports `totalTokens = 5000 + 5000 = 10000`, double-counting the same savings once for A and once for B. The displayed "all-time" stat is wrong by exactly the size of A's contribution, every time a fork inherits blocks.

## Steps to reproduce

1. Session A accumulates 20 messages with substantial tool output.
2. Compress A — A's state records `stats.totalPruneTokens = 5000` (hypothetical; actual depends on content).
3. A's persisted file is at `{storageDir}/ses_A.json` with `stats.totalPruneTokens: 5000`.
4. Fork A → B (sessionId = ses_B, parentSessionId effectively null per BUG-087; detected via title pattern).
5. With `experimental.inheritOnFork: true`, B inherits A's compression blocks per the fork-state-inheritance plan.
6. B's persisted state (after inheritance + first save) records `stats.totalPruneTokens: 5000` (copied from A).
7. Run `/dcp stats` (which calls `loadAllSessionStats` at `lib/commands/stats.ts:167`).
8. Observe: `allTime.totalTokens = 10000`, not `5000`. The displayed all-time savings is inflated by A's contribution.

## Root cause

`loadAllSessionStats` at `lib/state/persistence.ts:479-512` is a pure sum across files:

```ts
for (const file of jsonFiles) {
    // ...
    if (state?.stats?.totalPruneTokens && state?.prune) {
        result.totalTokens += state.stats.totalPruneTokens // line 503
        // ...
    }
}
```

This summation assumes each file represents independent savings. With cross-session inheritance (or any future cross-session block-sharing mechanism), the assumption breaks: A's 5000 tokens are the SAME 5000 tokens that B reports.

The single-file merge path (`lib/state/persistence.ts:166-169`) correctly uses `Math.max(state.stats.totalPruneTokens, onDisk.stats.totalPruneTokens)` — it never double-counts within a single session. The bug is specifically in the all-sessions aggregation.

## Impact

- **Lifetime stat inflation**: `/dcp stats` over-reports lifetime savings proportional to fork-derived inheritance. After N forks with full inheritance, the stat is N+1× the actual savings.
- **UX confusion**: User sees "10000 tokens saved" when they've really only saved 5000. Undermines trust in the stat.
- **No correctness hole**: the per-session `state.stats.totalPruneTokens` is correct. The double-count only happens in the all-time aggregation.
- **Currently latent**: until the fork-state-inheritance plan ships (or any other cross-session block-sharing mechanism lands), the bug is dormant — every session is independent.

## Fix paths

### Option A: Track contributing sessions (cheap)

Maintain a `Set<sessionId>` of sessions whose `totalPruneTokens` has been counted in any given aggregation pass. At read time:

```ts
// lib/state/persistence.ts — loadAllSessionStats, around line 502
const seen = new Set<string>()
for (const file of jsonFiles) {
    const state = JSON.parse(content) as PersistedSessionState
    const ownId = state.sessionId
    const inheritedFrom = state.inheritedFrom ?? null
    if (ownId && seen.has(ownId)) continue
    seen.add(ownId)
    if (inheritedFrom) seen.add(inheritedFrom)
    // ...
}
```

**Pros**:

- Minimal diff to existing code (one Set, one skip check).
- Works regardless of how inheritance is recorded (the plan keeps `inheritedFrom` in-memory only; this would require persisting it, which contradicts the plan — but a small schema bump can make it persistent for aggregation purposes).

**Cons**:

- Requires persisting `inheritedFrom` (small schema bump).
- Requires every cross-session block-sharing mechanism (now or future) to populate `inheritedFrom` correctly.
- Edge case: A and B both have `inheritedFrom: A` if user forks B from A and then forks A from B (cycle). Need a `seen.has(ownId) || seen.has(inheritedFrom)` early-exit.

### Option B: Split per-session vs aggregate (clean, recommended)

Change the stat semantics. Two separate fields:

| Field                                      | Semantics                                      | Aggregation                                                                            |
| ------------------------------------------ | ---------------------------------------------- | -------------------------------------------------------------------------------------- |
| `stats.totalPruneTokens`                   | Current session's lifetime savings.            | Per-session, never summed across sessions.                                             |
| `stats.totalPruneTokensIncludingInherited` | Current session's savings + inherited savings. | Optional aggregate (sum is correct because inherited savings are unique to each fork). |

Or rename to make the semantics explicit:

```ts
// lib/state/types.ts — Stats interface
interface Stats {
    sessionOwnPruneTokens: number // default 0; current-session-only, never summed
    inheritedPruneTokens: number // default 0; copied at fork time, never sums into anything
    // deprecate totalPruneTokens or keep it as sessionOwnPruneTokens alias for backward compat
}
```

`loadAllSessionStats` then reports:

- `sessionOwnPruneTokens` summed across all sessions (this is the true "savings across all my work" stat).
- `inheritedPruneTokens` reported per-session only (the count of tokens inherited from a parent).

The user can then choose: "show me my total work" (= sum of sessionOwnPruneTokens) vs "show me my current session" (= current session's own + inherited).

**Pros**:

- No schema version bump required (additive fields with defaults).
- Works regardless of future cross-session sharing mechanisms.
- Cleaner semantics — "own" vs "inherited" is unambiguous.
- No need to persist `inheritedFrom` for aggregation purposes.

**Cons**:

- Larger refactor (rename/alias throughout the codebase).
- Backward compatibility: existing state files don't have the new fields; default to 0.
- Affects `/dcp stats` UI; may need user-facing change.

### Option C: Defer until fork-state-inheritance ships

Do nothing now; file this bug as a latent issue; revisit when the plan lands and the double-count becomes user-visible.

**Pros**:

- Zero work.

**Cons**:

- Latent bugs have a way of becoming urgent at the worst time. Better to fix proactively.

## Recommended approach

**Option B (split per-session vs aggregate).** Cleaner semantics, future-proof against any cross-session sharing mechanism, and the refactor is bounded. Effort: ~4-6 hours (rename or add parallel fields throughout the codebase + update `/dcp stats` output).

The fork-state-inheritance plan should:

1. Update §4.6 to copy `stats.totalPruneTokens` (per user feedback: should be a one-to-one copy).
2. Reference this bug (BUG-088) and Option B as the resolution path.
3. Update §7 Risks to flag this as a known consequence that will be fixed by Option B.

## Files affected (under Option B)

- `lib/state/types.ts:22` — `Stats.totalPruneTokens` becomes `Stats.sessionOwnPruneTokens` (with alias for back-compat).
- `lib/state/persistence.ts:382, 95, 145, 166-169, 479-512` — aggregation path.
- `lib/state/state.ts:95, 143, 269` — initialization / load.
- `lib/strategies/purge-errors.ts:123` — increment site.
- `lib/strategies/deduplication.ts:133` — increment site.
- `lib/commands/recompress.ts:203` — increment site.
- `lib/commands/stats.ts:11, 139, 167` — UI consumer.
- `lib/commands/context.ts:81` — header line.
- `lib/commands/decompress.ts:254` — decrement site.
- `lib/tui/data.ts:77` — TUI consumer.
- `lib/ui/notification.ts:34, 46, 348` — notification consumer.
- `tests/` — any tests asserting on the old name.

## Related

- **Plan**: `docs/plans/fork-state-inheritance.md` — the fork-inheritance plan makes this bug live (was dormant).
- **BUG-087**: `known_issues/fixed/BUG-087-forked-session-context-bloat.md` — initial UX-only mitigation for fork bloat; precedes both this bug and the fork-inheritance plan.
- **BUG-089**: `known_issues/fixed/BUG-089-fork-state-inheritance-protocol-layer.md` — the fork-inheritance feature that surfaced this defect.
- **BUG-091**: `known_issues/fixed/BUG-091-rekeyed-boundary-refs-preserve-m-NNNN-bN.md` — sibling fix in the same fork-protocol round; same `lib/state/inherit.ts` area.
- **lib/state/persistence.ts:166-169**: single-file merge correctly uses `Math.max` — no double-count within a session.
- **lib/state/persistence.ts:479-512**: the buggy all-sessions aggregation (now safe: the write side no longer contributes to it).
- **lib/commands/stats.ts:167**: consumer of `loadAllSessionStats`.
