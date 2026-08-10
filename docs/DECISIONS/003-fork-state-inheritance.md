# ADR 003: Fork-state inheritance via timestamp-anchored filter

**Status:** Accepted (in this fork).
**Date:** 2026-08-08.
**Supersedes (in part):** ADR-002 — Path B is now accepted with a timestamp-anchored predicate, an always-pick fallback chain, and a schema bump. Per-session file isolation is preserved; only selected fields cross the boundary.

## Context

ADR-002 (2026-08-07) rejected Path B (cross-session inheritance) because the plugin would inherit A's current state at B's first transform (not A's state at fork time), and per-session isolation was a load-bearing invariant. The residual symptom — forked session B sees the full uncompressed history of A — remained. BUG-087 added UX hints only; those are now removed in favour of a real implementation.

Two new facts changed the calculus:

1. **SQLite probe 2026-08-08** against the user's local OpenCode DB (`C:\Users\marco\.local\share\opencode\opencode.db`) confirmed `parentID` is **NULL** on UI forks. The schema exists but is unused. Event-hook approaches keyed on `info.parentID` are dead.
2. **OpenCode fork semantics (same probe)**: copied messages preserve `time.created` byte-exact; message IDs are regenerated. `time.created` is the only surviving identity-like value across a fork.

## Decision

Implement fork-state inheritance with these properties:

| Property                                 | Choice                                                                                                  | Why                                                                                                                             |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Inheritance key                          | `time.created` (6 fields on `CompressionBlock`)                                                         | The only value that survives the fork. Message-ID-anchored inheritance is silently dead.                                        |
| Disambiguator                            | Always-pick chain: single → longest prefix → recency → graceful give-up                                 | When candidates exist, always pick one. Wrong-parent picks are filtered by the timestamp predicate — safe degradation.          |
| Schema                                   | Bump `FORK_SCHEMA_VERSION` to 4; pre-v4 files DROPPED by the gate at `lib/state/persistence.ts:303-316` | DPP-004 / PAT-008: drop, don't migrate. Honest cost on upgrade.                                                                 |
| Default                                  | `experimental.inheritOnFork: true`                                                                      | User intent is "always attempt to copy"; opt-OUT for strict isolation.                                                          |
| System-prompt hint                       | Removed entirely (`lib/hooks.ts:162-179` deleted)                                                       | The hint was wrong in both directions: it lied about non-visible blocks and contradicted visible ones once inheritance shipped. |
| Third writer of `state.prune.messages.*` | `mergeInheritedBlocks` in `lib/compress/state.ts`                                                       | Amends DPP-006 / PAT-002. Upholds the same invariants `applyCompressionState` does.                                             |

## The inheritable-block predicate

Timestamp-anchored. A block survives only if every key timestamp appears in B's message set AND every block-graph reference resolves in the parent set.

| Field                                                    | Predicate                     | Source                                          |
| -------------------------------------------------------- | ----------------------------- | ----------------------------------------------- |
| `startTime`, `endTime`, `anchorTime`, `compressTime`     | `bTimeSet.has(t)` for each    | `lib/state/inherit.ts::filterInheritableBlocks` |
| `effectiveTimeMs`, `directTimeMs`                        | `every(bTimeSet.has)`         | same                                            |
| `includedBlockIds`, `consumedBlockIds`, `parentBlockIds` | `every(parentBlocksById.has)` | same — graph-closure safety                     |
| `deactivatedByUser`                                      | must be `false`               | never resurrect user-decompress                 |

After the predicate, `rekeyBlocksToFork` rewrites the 6 ID-shaped fields from parent's message IDs to B's via `bTimeToId` (architect flag #1). Without the anchor + compress rekey, `lib/messages/sync.ts:42-53` deactivates every inherited block on B's first sync.

## Always-pick fallback chain

| Step | Condition                                                            | Action                                                                                                       | Source                                       |
| ---- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| 1    | `candidates.length === 0`                                            | Graceful give-up (debug log) — the only legitimate "no parent" case besides subagent / schema / missing file | `lib/state/inherit.ts:343-348`               |
| 2    | `candidates.length === 1`                                            | Direct pick                                                                                                  | `pickParentCandidate`                        |
| 3    | `candidates.length > 1`, longest shared `time.created` prefix with B | Pick that candidate (tie-break by mtime)                                                                     | `pickParentCandidate` + `computePrefixScore` |
| 4    | All-zero scores                                                      | Pick most recently modified state file (mtime)                                                               | `pickMostRecent`                             |

The strict timestamp filter is the safety net: a wrong-parent pick yields at most a partial (safe) inheritance. Logged at info level so the user can verify.

## Fields copied (one-to-one intent per user feedback 2026-08-08)

| Field                                                                                           | Source on `parentState`              | How                                                                   |
| ----------------------------------------------------------------------------------------------- | ------------------------------------ | --------------------------------------------------------------------- |
| `prune.messages.blocksById`                                                                     | filtered + rekeyed                   | `lib/state/inherit.ts::filterInheritableBlocks` + `rekeyBlocksToFork` |
| `prune.messages.{byMessageId, activeBlockIds, activeByAnchorMessageId, nextBlockId, nextRunId}` | derived                              | rebuilt inside `mergeInheritedBlocks`                                 |
| `prune.tools`                                                                                   | `parentState.prune.tools`            | copy verbatim                                                         |
| `userForced`, `manualMode`, `recoveryForced`, `nonCompactingRunCount`, `recoveryFadeCounter`    | parent flags                         | copy verbatim                                                         |
| `stats.totalPruneTokens`                                                                        | `parentState.stats.totalPruneTokens` | copy; BUG-088 tracks the all-time double-count                        |
| `nudges.*`                                                                                      | dropped                              | parent message IDs invalid in B; regenerate from live traffic         |
| `sessionName`                                                                                   | defaults from `state.sessionTitle`   | `lib/state/persistence.ts:132`                                        |

Fields not copied: `lastCompaction`, `currentTurn` (recomputed from B's own messages), `messageIds.*` (regenerated deterministically by `assignMessageRefs`), `pendingManualTrigger`, `compressionTiming`, in-memory caches.

## Third sanctioned writer

`mergeInheritedBlocks` in `lib/compress/state.ts` joins `applyCompressionState` and `syncCompressionBlocks` as the third sanctioned writer of `state.prune.messages.*`. Amends `DPP-006` and `PAT-002`. Upholds: monotonic block / run IDs, anchor-index consistency, block-graph closure (assumed via `filterInheritableBlocks`), and `byMessageId` rebuild from each block's `effectiveMessageIds`. `lib/state/inherit.ts` does NOT write block state directly; it routes through this function.

## Schema bump

`FORK_SCHEMA_VERSION = 4` (`lib/state/types.ts:200`). `CompressionBlock` gains 6 timestamp fields. `SessionState` gains 2 in-memory fields (`sessionTitle`, `inheritedFrom`). `PersistedSessionState` gains 3 fields (`recoveryForced`, `nonCompactingRunCount`, `recoveryFadeCounter`) so recovery state can be inherited.

Pre-v4 state files are dropped by the schema gate at `lib/state/persistence.ts:303-316` (DPP-004 / PAT-008). Users who upgrade and want fork inheritance must keep A's session active in the same plugin version, or accept the data loss. This contradicts the "no data loss" claim in earlier revisions; corrected here.

## Consequences

Positive:

- Forked session B inherits A's compression blocks on first transform. The dominant UX surprise (fork-bloat) is closed.
- Default-on reflects user intent. Opt-OUT via `experimental.inheritOnFork: false` preserves the strict-isolation semantics ADR-002 originally argued for.
- The disambiguator is safe by construction: wrong-parent picks are filtered by the strict timestamp predicate.
- Multi-generation inheritance (A→B→C) works automatically — transitivity is via B's own persisted state, not a chain walk.

Negative:

- **Honest data loss on schema bump.** All pre-v4 state files are dropped. Users with active sessions in a previous plugin version must upgrade in a single step or accept state loss.
- **Per-fork SDK roundtrip.** `client.session.get` is called once at session transition. Adds ~50-200 ms to first transform of B. Disabling via `inheritOnFork: false` saves the roundtrip.
- **Wrong-parent picks are partially inherited.** The timestamp filter drops blocks whose keys aren't in B, so wrong-parent picks yield at most a safe partial set. Logged at info level.
- **Fork-to-reset workflow inherits recovery state.** If A is in recovery mode and the user forks to "reset", B inherits the recovery flags and stays locked down. This is per user feedback 2026-08-08 ("always attempt to copy the original session's state"); document in `docs/features/SESSION_FORK.md`.
- **All-time stat inflated per fork.** `stats.totalPruneTokens` is copied per §4.5; `loadAllSessionStats` will sum once for A and once for B. BUG-088 tracks the recommended fix (Option B: split `sessionOwnPruneTokens` vs `inheritedPruneTokens`).

## Compliance

| Rule                                   | Where enforced                                                                                                        |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Schema gate (pre-v4 dropped)           | `lib/state/persistence.ts:303-316`                                                                                    |
| Inheritance key default `true`         | `lib/config.ts:849`, `lib/state/inherit.ts:327`                                                                       |
| Predicate (timestamp-anchored)         | `lib/state/inherit.ts::filterInheritableBlocks`                                                                       |
| Rekey pass (architect flag #1)         | `lib/state/inherit.ts::rekeyBlocksToFork`                                                                             |
| Third sanctioned writer                | `lib/compress/state.ts::mergeInheritedBlocks`                                                                         |
| Single SDK roundtrip for title         | `lib/state/utils.ts::getSessionMetadata`                                                                              |
| Always-pick disambiguator              | `lib/state/inherit.ts::pickParentCandidate`                                                                           |
| Subagent-skip wins over fork detection | `lib/state/state.ts:237-240` (existing)                                                                               |
| `experimental.inheritOnFork` validator | `lib/config.ts:335-341`                                                                                               |
| Test coverage                          | `tests/session-fork-inherit.test.ts` (new) + `tests/session-fork.test.ts` (rewritten multi-generation + hint-removal) |

## Amendments

- **DPP-006 / PAT-002:** `mergeInheritedBlocks` is the third sanctioned writer of `state.prune.messages.*`.
- **PAT-015:** `applyCompressionState` side-effect funnel now has a third valid entry point (inheritance via `mergeInheritedBlocks`).
- **DPP-004 / PAT-008:** pre-v4 state files are dropped at the schema gate at `lib/state/persistence.ts:303-316`. Honest data loss on upgrade.

## Related

- `docs/plans/fork-state-inheritance.md` — full design (≥1,055 lines across 15 files).
- `known_issues/BUG-089-fork-state-inheritance-protocol-layer.md` — the bug this ADR closes.
- `known_issues/fixed/BUG-090-persistence-fork-suffix-strip-breaks-multi-gen.md` — scan-side suffix-aware match added during implementation; multi-generation invariant holds.
- `known_issues/BUG-088-load-all-session-stats-double-count.md` — open: lifetime-aggregation inflation per fork. Recommended fix: Option B.
- `docs/DECISIONS/002-compression-state-is-session-scoped.md` — superseded in part (see ADR-002's "Superseded sections" subsection).
- `docs/features/SESSION_FORK.md` — user-facing behavior, config, edge cases.
