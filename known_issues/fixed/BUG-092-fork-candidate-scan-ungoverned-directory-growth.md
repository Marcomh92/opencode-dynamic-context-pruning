# BUG-092: Fork candidate scan is O(entire state dir) with no bound — log spam + latency grows with months of use

**Status:** Fixed 2026-08-10
**Severity:** Low (correctness unaffected; scalability + log hygiene)
**Component:** lib/state/inherit.ts::findCandidateParents, lib/state/persistence.ts (sweep)

## Resolution (2026-08-10)

The original report proposed four ranked fixes (mtime pre-filter, log
collapse, sweep on save, side-index file). The fix ships **all three first-tier
options** plus the new `compress.stateRetentionDays` config that wires them
together:

1. **mtime pre-filter** in `findCandidateParents` at `lib/state/inherit.ts:365-398`.
   `stat` before parse; files older than `stateRetentionDays` are skipped
   without the per-file debug line. Semantically identical to the load gate —
   an expired parent can't load anyway (`loadSessionState` → null), so
   skipping it earlier is just cheaper.
2. **Log collapse** at `lib/state/inherit.ts:430-437`. The per-file `dropping
pre-bump file` line is replaced by one summary line (`fork candidate scan
summary`) carrying both `schemaSkipped` and `ageSkipped` counts. No-op when
   both counts are zero (clean-dir startup).
3. **Sweep on save** at `lib/state/persistence.ts:96-156` (new helper
   `sweepExpiredStateFiles`). Triggered on the first save with a non-null
   `stateRetentionDays`; throttled module-level via `sweepDone` so subsequent
   saves are a no-op. Operates on the plugin's own dir (`XDG_DATA_HOME` →
   `.../plugin/dcp`), not OpenCode session storage — the DPP-001 read-only
   rule on session history is preserved.
4. **`compress.stateRetentionDays` config** (new key, default 7 days, null
   disables both behaviours). Distinct clamp semantics from
   `stateMaxAgeDays`: 0 and negatives collapse to null (disabled, not "no
   grace period"); fractional values floor. See `lib/config.ts::clampStateRetentionDays`.

Side-index file (4th option in the original report) is intentionally deferred
— YAGNI until ~10k+ files in a single dir.

**Test:** `tests/bug-092-fork-candidate-scan-mtime-filter.test.ts` — 8 test
cases covering mtime filter (positive / null / 0), log collapse (summary
present, per-file dropping absent), sweep on save (deletion, throttle,
null early-return), and the `clampNullOrNonNeg` boundary contract for
`stateRetentionDays`.

**Severity rationale:** No correctness hole — dropped files were correctly
excluded before title matching. Pure scalability and log-hygiene defect that
became user-visible after ~months of accumulation. Architect-verified Low.

## Problem

Every fork-init candidate scan (`findCandidateParents`) parses **every** state file in the DCP storage dir, and nothing ever deletes state files. Cost is O(total files) per forked-session init, unbounded over time. `compress.stateMaxAgeDays` gates _loading_ only — expired files stay on disk and are still parsed.

## Symptom / observed evidence

On the developer machine (2026-08-09, two-fork test):

- ~900 `fork candidate scan: dropping pre-bump file` debug lines per fork session-init (~1.3s wall time: 15:44:21.796 → 15:44:23.105).
- Dump consists almost entirely of accumulated test-session state files (`manual-mode-*`, `session-target-*`, `ses_590_*`, `ses_message_*`, `ses_range_*`, `ses_tool_*`, `ses_compacting_*`, `ses_fade_*`, `ses_netcompact_*`, `ses_recovery_*`, `ses_compression_notifications_*`, ...), all pre-v4 (`droppedVersion=2`/`3` or unversioned).
- Zero functional impact: dropped files are correctly excluded before title matching; v4 files survive and inherit correctly (verified: 1/1 then 2/2 blocks, monotonic refs intact).

## Root cause

1. `findCandidateParents` (`lib/state/inherit.ts:345`) — Pass 1 does `readdir` + `JSON.parse` on every `{sessionId}.json` in the storage dir before the schema gate rejects non-v4 files. No narrowing pre-filter exists (no prefix filter, no mtime filter, no index).
2. Nothing ever deletes DCP state files: the only `rm` in `lib/` is plugin self-update (`lib/update.ts:69`). `stateMaxAgeDays` is load-time only — it logs `Dropping persisted session state: age ... exceeds stateMaxAgeDays` (`lib/state/persistence.ts:345`) and treats the file as absent, but the file remains on disk and is re-parsed by every later scan.
3. Normal usage adds ~1 file per session, so the scan cost and log volume grow linearly with session count forever.

## Impact

- Per-fork-init latency and debug-log volume grow without bound (first message of each _newly forked_ session; non-forked sessions and re-opened forks never scan — `persisted === null` branch, `lib/state/state.ts:246/254`).
- SDK title-refresh pass (Pass 1.5) scales with the number of _v4_ (real) sessions — fine today, the parse+log cost is the dominant term.

## Reproduction

1. Accumulate 500+ state files in the DCP storage dir (any mix of pre-v4 test files).
2. Fork a session with an existing compressed block; observe ~1 file-parse + 1 debug line per file in the daily log on the fork's first transform.

## Related

- **BUG-089**: `known_issues/fixed/BUG-089-fork-state-inheritance-protocol-layer.md` — the fork-inheritance feature that surfaced this defect (scan was YAGNI'd per plan §7 risk table).
- **BUG-090**: `known_issues/fixed/BUG-090-persistence-fork-suffix-strip-breaks-multi-gen.md` — sibling fix in the same round; persistence-side fork-suffix handling.
- **BUG-091**: `known_issues/fixed/BUG-091-rekeyed-boundary-refs-preserve-m-NNNN-bN.md` — sibling fix in the same round; boundary-ref guard in `rekeyBlocksToFork`.
- **BUG-088**: `known_issues/fixed/BUG-088-load-all-session-stats-double-count.md` — sibling fix in the same round; fork-copy stats double-count.
- **`compress.stateMaxAgeDays`**: load-time gate that BUG-092 builds on. Distinct from `stateRetentionDays`: load gate (one-shot at load) vs sweep/scan gate (continuous, deletes from disk). Default `null` for both keeps legacy behaviour.
- **`sweepExpiredStateFiles`**: new helper at `lib/state/persistence.ts:96-156`. Operates only on the plugin's own dir; DPP-001 read-only rule on OpenCode session storage is preserved.
- **Test**: `tests/bug-092-fork-candidate-scan-mtime-filter.test.ts` — 8 cases covering all four surface areas.
