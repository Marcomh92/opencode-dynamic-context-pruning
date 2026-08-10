You've got it — no compression. Here's everything in one go.

## 1. Bug report file — copy-paste ready

Save as `known_issues/BUG-092-fork-candidate-scan-ungoverned-directory-growth.md` (BUG-092 is the next free number after 091):

```markdown
# BUG-092: Fork candidate scan is O(entire state dir) with no bound — log spam + latency grows with months of use

- **Status:** OPEN
- **Date:** 2026-08-09
- **Severity:** Low (correctness unaffected) / Medium (scalability + log hygiene)
- **Affects:** fork-state inheritance (BUG-089 feature), `lib/state/inherit.ts`
- **Related:** BUG-089, BUG-090, BUG-091, ADR-003; plan §7 risk table (`state.scanCandidates` was YAGNI'd)

## Summary

Every fork-init candidate scan (`findCandidateParents`) parses **every** state file in the DCP
storage dir, and nothing ever deletes state files. Cost is O(total files) per forked-session init,
unbounded over time. `compress.stateMaxAgeDays` gates *loading* only — expired files stay on disk
and are still parsed.

## Symptom / observed evidence

On the developer machine (2026-08-09, two-fork test):

- ~900 `fork candidate scan: dropping pre-bump file` debug lines per fork session-init
  (~1.3s wall time: 15:44:21.796 → 15:44:23.105).
- Dump consists almost entirely of accumulated test-session state files
  (`manual-mode-*`, `session-target-*`, `ses_590_*`, `ses_message_*`, `ses_range_*`, `ses_tool_*`,
  `ses_compacting_*`, `ses_fade_*`, `ses_netcompact_*`, `ses_recovery_*`,
  `ses_compression_notifications_*`, ...), all pre-v4 (`droppedVersion=2`/`3` or unversioned).
- Zero functional impact: dropped files are correctly excluded before title matching; v4 files
  survive and inherit correctly (verified: 1/1 then 2/2 blocks, monotonic refs intact).

## Root cause

1. `findCandidateParents` (lib/state/inherit.ts:345) — Pass 1 does `readdir` + `JSON.parse` on
   every `{sessionId}.json` in the storage dir before the schema gate rejects non-v4 files.
   No narrowing pre-filter exists (no prefix filter, no mtime filter, no index).
2. Nothing ever deletes DCP state files: the only `rm` in `lib/` is plugin self-update
   (lib/update.ts:69). `stateMaxAgeDays` is load-time only — it logs
   `Dropping persisted session state: age ... exceeds stateMaxAgeDays` (lib/state/persistence.ts:345)
   and treats the file as absent, but the file remains on disk and is re-parsed by every later scan.
3. Normal usage adds ~1 file per session, so the scan cost and log volume grow linearly with
   session count forever.

## Impact

- Per-fork-init latency and debug-log volume grow without bound (first message of each *newly
  forked* session; non-forked sessions and re-opened forks never scan — `persisted === null`
  branch, lib/state/state.ts:246/254).
- SDK title-refresh pass (Pass 1.5) scales with the number of *v4* (real) sessions — fine today,
  the parse+log cost is the dominant term.

## Proposed fixes (in order of value)

1. **mtime pre-filter (recommended):** stat before parse; skip files older than
   `stateMaxAgeDays` (when configured). Semantically identical — an expired parent can't load
   anyway (`loadSessionState` → null → graceful give-up). Would have skipped ~all 900 files above.
2. **Log hygiene:** collapse the per-file drop line into one summary
   (`fork candidate scan: dropped N pre-bump files`).
3. **Sweep on save:** delete DCP-state files older than `stateMaxAgeDays` (plugin's own dir, not
   OpenCode session storage; the read-only rule targets OpenCode's storage).
4. **Side-index file** written on `saveSessionState` — the plan's YAGNI'd option; revisit only at
   ~10k+ files.

## Acceptance criteria (when fixed)

- Fork-init scan time and log lines independent of total state-dir size (or bounded by
  `stateMaxAgeDays` window).
- No change to inheritance behavior; existing session-fork-inherit tests stay green.

## Reproduction

1. Accumulate 500+ state files in the DCP storage dir (any mix of pre-v4 test files).
2. Fork a session with an existing compressed block; observe ~1 file-parse + 1 debug line per
   file in the daily log on the fork's first transform.
```
