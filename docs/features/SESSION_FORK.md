# SESSION_FORK

How DCP handles OpenCode session forks (UI fork action). The fork-detection logic lives in `lib/state/inherit.ts`; the trigger is `tryInheritFromParent` called inside `ensureSessionInitialized`'s `persisted === null` branch.

## Boundaries

| Boundary                                                    | Behavior                                                                                                                                                             |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `experimental.inheritOnFork: false`                         | One SDK roundtrip (subagent + title metadata fetch via `getSessionMetadata` — architect flag #14); no candidate scan, no inheritance — strict per-session isolation. |
| Subagent session with `experimental.allowSubAgents = false` | Subagent-skip wins; fork detection never runs.                                                                                                                       |
| `experimental.allowSubAgents = true`                        | Subagent sessions are processed; fork detection runs against the title pattern.                                                                                      |
| Internal agent (title generator / summarizer)               | Skipped upstream in `lib/hooks.ts::createChatMessageTransformHandler`; fork detection never runs.                                                                    |
| Session title does not match `(fork #N)` pattern            | Detection returns `isForked: false`; no inheritance. The common case.                                                                                                |
| Zero parent candidates in DCP storage dir                   | Debug-logged graceful give-up — the only legitimate "no parent" case.                                                                                                |

## What gets inherited

A forked session B copies from its parent A on first transform:

| Field                                                                                        | Source                                                       | Notes                                                                         |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| Compression blocks                                                                           | `parentState.prune.messages.blocksById` (filtered + rekeyed) | Timestamp-anchored predicate (§"The inheritable-block predicate" in ADR-003). |
| `prune.tools`                                                                                | `parentState.prune.tools`                                    | Copy verbatim.                                                                |
| `userForced`, `manualMode`, `recoveryForced`, `nonCompactingRunCount`, `recoveryFadeCounter` | Parent flags                                                 | B inherits A's manual-mode intent and recovery state.                         |
| `stats.totalPruneTokens`                                                                     | `parentState.stats.totalPruneTokens`                         | Copy. The all-time aggregation bug is tracked by BUG-088.                     |

Nudge anchors (`nudges.*`) are dropped — parent's anchor IDs are invalid in B; regenerate from B's live traffic. `messageIds.*`, `lastCompaction`, `currentTurn` are not persisted (architect flag #7) or are regenerated deterministically by `assignMessageRefs`.

## Configuration

| Key                          | Type    | Default | Effect                                                                                     |
| ---------------------------- | ------- | ------- | ------------------------------------------------------------------------------------------ |
| `experimental.inheritOnFork` | boolean | `true`  | Default-on per user direction 2026-08-08. Set to `false` for strict per-session isolation. |

Add the key under the existing `experimental` block in `dcp.jsonc`:

```jsonc
{
    "experimental": {
        "inheritOnFork": false,
    },
}
```

Setting to `false` short-circuits the inheritance orchestrator at `lib/state/inherit.ts:366-368` (the `inheritOnFork === false` early return inside `tryInheritFromParent`) — no candidate scan, no inheritance. The SDK roundtrip at `lib/state/state.ts:227` (`getSessionMetadata` — combined subagent + title check) still fires once per session-init because architect flag #14 combined it with the unconditional subagent guard. The system-prompt hint is gone regardless.

## Caveats

| Caveat                                                              | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Schema bump drops pre-bump state**                                | `FORK_SCHEMA_VERSION` was bumped from 3 to 4 (`lib/state/types.ts:200`). Pre-v4 state files are dropped by the schema gate (`lib/state/persistence.ts:303-316`) per DPP-004 / PAT-008. Honest data loss on upgrade.                                                                                                                                                                                                                                                                                                               |
| **Fork-point-before-A's-first-compress yields no inheritance**      | If the fork point precedes A's first `compress` tool call, the inheritable set is empty (no blocks exist). Correct behavior — but inheritance only helps when the fork happens after compression.                                                                                                                                                                                                                                                                                                                                 |
| **Fork-to-reset inherits recovery state**                           | If A is in recovery mode (`recoveryForced: true`) and the user forks to "reset", B inherits the recovery flags and stays locked down. Per user feedback 2026-08-08 ("always attempt to copy the original session's state"). Document this when forking to recover.                                                                                                                                                                                                                                                                |
| **All-time `/dcp stats` inflates per fork**                         | `loadAllSessionStats` (`lib/state/persistence.ts:479-512`) sums `totalPruneTokens` across files; copying the value per fork double-counts in the all-time display. Open as BUG-088 (recommended fix: Option B — split `sessionOwnPruneTokens` vs `inheritedPruneTokens`). `/dcp stats` is informational; not a correctness gate.                                                                                                                                                                                                  |
| **Multi-generation is automatic**                                   | A→B→C inheritance works through B's own persisted state (architect flag #6). C's candidate scan finds B because B's saved `sessionName` includes the `(fork #N)` suffix verbatim (BUG-090 fix: scan-side suffix-aware match in `lib/state/inherit.ts:281-288`).                                                                                                                                                                                                                                                                   |
| **OpenCode regenerates `time.created` on fork in a future version** | The timestamp predicate degrades gracefully to "no inheritance" (timestamp set miss). No silent corruption.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Tool identity is callID-keyed**                                   | `directToolIds`/`effectiveToolIds`/`prune.tools` are keyed by `part.callID` (not `part.id`), which OpenCode preserves verbatim on fork (verified via SQLite probe 2026-08-08). Inheritance spreads these arrays without rekeying. Guard test: `tests/session-fork-inherit.test.ts` `BUG-089: tool-identity-callID-survives-fork`. If a future OpenCode version regenerates callIDs on fork, tool-output suppression on inherited blocks silently no-ops until the next compress — same degradation class as the timestamp caveat. |
| **Parent renamed between compresses**                               | The saved `sessionName` lags behind the live OpenCode title until the next save. Inheritance still works: `findCandidateParents` refreshes each candidate's title via SDK at scan time. Without this refresh, forks of a renamed parent would silently give up. Caveat: if the SDK call fails, the scan falls back to saved `sessionName` and may miss the parent.                                                                                                                                                                |

## Edge cases

| Edge case                                                                        | Outcome                                                                                                                                                                                   |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Zero candidates**                                                              | Graceful give-up. Debug log: `fork detected (#N); no parent state files found for "<parentTitle>"`.                                                                                       |
| **Single candidate**                                                             | Direct pick (no SDK call beyond the title fetch).                                                                                                                                         |
| **Multiple candidates with shared timestamp prefix**                             | Pick the candidate with the longest exact `time.created` prefix shared with B's messages. Tie-break by most recent mtime.                                                                 |
| **Multiple candidates with no prefix match**                                     | Pick the candidate with the most recently modified state file (mtime). The strict timestamp filter drops blocks whose keys aren't in B; net effect is reduced inheritance, no corruption. |
| **Mid-history fork (fork point inside candidates' shared prefix)**               | Same as "no prefix match" — recency fallback. Per the always-pick chain, the orchestrator never gives up when candidates exist.                                                           |
| **SDK call fails**                                                               | Catch + debug log; transform continues without inheritance.                                                                                                                               |
| **Malformed parent state file**                                                  | `loadSessionState` returns `null`; graceful no-op.                                                                                                                                        |
| **Parent was a subagent** (skipped persistence per `lib/state/state.ts:216-219`) | `loadSessionState` returns `null`; graceful no-op.                                                                                                                                        |
| **Schema mismatch (parent is older version)**                                    | Dropped silently by the schema gate.                                                                                                                                                      |
| **Parent file deleted between fork and B's first transform**                     | `loadSessionState` returns `null`; graceful no-op.                                                                                                                                        |

## How inheritance fires

| Step | Where                                                   | What                                                                                                                                                                            |
| ---- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `lib/state/state.ts:227-230`                            | `getSessionMetadata` fetches `title` and `isSubAgent` in one SDK roundtrip. Cached on `state.sessionTitle` / `state.isSubAgent`.                                                |
| 2    | `lib/state/state.ts:246`                                | `loadSessionState(sessionId)` — if it returns a non-null value, B has its own prior state and inheritance is skipped (B's own state wins).                                      |
| 3    | `lib/state/state.ts:254-262`                            | If `persisted === null` and `inheritOnFork !== false`, call `tryInheritFromParent`.                                                                                             |
| 4    | `lib/state/inherit.ts:335-348`                          | Detect fork pattern via `detectParentSessionFromTitle(state.sessionTitle)`. Bail early if not forked or no candidates.                                                          |
| 4b   | `lib/state/inherit.ts::findCandidateParents` (Pass 1.5) | Refresh each candidate's title via `client.session.get` in parallel. Defeats stale `sessionName` saved before a parent rename. Falls back to `savedName` if the SDK call fails. |
| 5    | `lib/state/inherit.ts:351`                              | `pickParentCandidate` — always-pick chain.                                                                                                                                      |
| 6    | `lib/state/inherit.ts:355-365`                          | `loadSessionState(parentSessionId)` — schema + age gate.                                                                                                                        |
| 7    | `lib/state/inherit.ts:368-394`                          | `buildTimeIndex(bMessages)` → `filterInheritableBlocks` → `rekeyBlocksToFork`.                                                                                                  |
| 8    | `lib/state/inherit.ts:400`                              | `mergeInheritedBlocks(state, rekeyed, parentId)` — third sanctioned writer (DPP-006 / PAT-002 amendment).                                                                       |
| 9    | `lib/state/inherit.ts:416-445`                          | Copy `prune.tools`, recovery flags, `stats.totalPruneTokens`; re-derive `manualMode`.                                                                                           |
| 10   | `lib/state/inherit.ts:452-453`                          | `coalesceSaveSessionState` (also writes `sessionName`) + `state.inheritedFrom = parentId`.                                                                                      |

**Fork detection handles arbitrary depth.** `detectParentSessionFromTitle` returns the immediate parent's title for depth-N forks: `"X (fork #N)"` → `parentTitle: "X (fork #N-1)"` for N≥2, or just `"X"` for N=1. The scan matches the saved parent's title (or its bare-stripped form) against this computed parent title.

The orchestrator swallows every error via `logger.debug` and returns a non-throwing sentinel. Inheritance must never break the transform pipeline.

## Performance

One SDK call per session transition (`client.session.get` for the title + subagent check via `getSessionMetadata`) — ~50-200 ms added to first transform of B. The candidate scan reads up to a few files in `$XDG_DATA_HOME/opencode/storage/plugin/dcp/`. Disabling via `experimental.inheritOnFork: false` skips the candidate scan and inheritance orchestrator — only the early return in `lib/state/inherit.ts::tryInheritFromParent` is suppressed. The combined subagent + title SDK roundtrip (`lib/state/state.ts:227`) still fires once per session-init (architect flag #14), regardless of this setting.

## Where to look

- Trigger: `lib/state/state.ts:246-265` (the `persisted === null` branch).
- Orchestrator: `lib/state/inherit.ts::tryInheritFromParent`.
- Predicate: `lib/state/inherit.ts::filterInheritableBlocks`.
- Rekey: `lib/state/inherit.ts::rekeyBlocksToFork`.
- Disambiguator: `lib/state/inherit.ts::pickParentCandidate`.
- Third writer: `lib/compress/state.ts::mergeInheritedBlocks`.
- ADR: `docs/DECISIONS/003-fork-state-inheritance.md`.
- Tests: `tests/session-fork-inherit.test.ts` (new, ~22 tests) + `tests/session-fork.test.ts` (rewritten for always-pick semantics).
