# STATE_PERSISTENCE

Persisted session state, the storage path, the schema gate, and the age gate. The plugin owns its on-disk sidecars under XDG data; the on-disk state is a cache, not a source of truth.

## Storage path

`$XDG_DATA_HOME/opencode/storage/plugin/dcp/{sessionId}.json`. When `XDG_DATA_HOME` is unset, falls back to `~/.local/share/opencode/storage/plugin/dcp/`. The directory is resolved per call (not at module import) so per-test `XDG_DATA_HOME` mutations are honored.

## Schema gate

`FORK_SCHEMA_VERSION = 3` in `lib/state/types.ts`. `loadSessionState` drops files whose `forkSchemaVersion` does not match (including `undefined`) and returns `null`. There is no migration path (`DPP-004`).

The v3 bump is defensive: the `subAgentResultCache` value type changed from `string` to `CachedSubAgentResult`. The cache is not persisted, so on-disk shape has not actually changed; the bump is documentation of the runtime invariant.

## Age gate

`loadSessionState(sessionId, logger, maxAgeDays: number | null = null)`:

- `null` disables the gate.
- `maxAgeDays >= 0` with a parseable `lastUpdated` drops the file when `Date.now() − parsed > maxAgeDays`.
- A malformed `lastUpdated` skips the comparison. A malformed timestamp never silently invalidates a fresh session.

`loadManualModeSetting` / `saveManualModeSetting` pass `null`; the manual-mode flag is age-insensitive.

## Structural validation

Required fields: `prune.tools` (object), `prune.messages` (object), `nudges` (object), `stats` (object). Missing → return `null` with `warn`. Anchors are filtered to string, deduped, and malformed entries are logged with counts.

## Save contract

| Step | Source |
|---|---|
| `flushPruneStats` before `JSON.stringify` | `lib/state/persistence.ts:121` |
| Monotonic merge against existing file: `max(totalPruneTokens)` | `lib/state/persistence.ts:167-182` |
| `coalesceSaveSessionState` is the default; `saveSessionState` is the strong save-on-await path | `lib/state/persistence.ts:193-227` |

A residual cross-process race is acknowledged in the source: TUI and Desktop sidecars in two processes are not coordinated. The in-process coalescer + monotonic merge handle the common case.

## Persisted vs in-memory

| Field | Persisted? | Notes |
|---|---|---|
| `manualMode`, `userForced`, `recoveryForced`, `nonCompactingRunCount`, `recoveryFadeCounter` | yes | |
| `forkSchemaVersion` | yes | gate value |
| `prune.tools`, `prune.messages` | yes | block graph and tool-replacement map |
| `nudges.*` | yes | anchor lists |
| `stats` | yes | totals; `pruneTokenCounter` is flushed before save |
| `sessionName`, `lastUpdated` | yes | |
| `subAgentResultCache` | no | rebuildable; see `DPP-018` |
| `diagnostic` | no | fire counts, prefix hash, last fire timestamp |
| `messageIds`, `toolParameters`, `modelContextLimit`, `systemPromptTokens`, `compressionTiming`, `pendingManualTrigger`, `currentTurn`, `lastCompaction` | no | request-local |

On load, `recoveryForced` and the streak counters are **intentionally not restored from v1** state files. This is the v1→v2 boundary; new code must not assume they survive session reload.

## v2 protocol fields on `SessionState`

| Field | Set by | Cleared by |
|---|---|---|
| `userForced` | `/dcp manual on`; successful manual compress | `/dcp manual off`; successful manual compress |
| `recoveryForced` | after `maxContextLimitRecovery` consecutive non-compacting runs | session restart; after `recoveryFadeWindow` consecutive successful manual compresses |
| `manualMode` | derived cache from `userForced` and `recoveryForced` | derived only; updated by `effectiveManualMode` |

Autonomous compresses never clear `userForced`. `/dcp manual off` never clears `recoveryForced`. These rules are in `INV-8` of `docs/features/COMPRESSION.md`.

## Compaction handling

- `isMessageCompacted`: a message is compacted if `time.created < state.lastCompaction` or has an active compression entry.
- `findLastCompactionTimestamp` scans backward for `role === "assistant" && summary === true`.
- `resetOnCompaction` clears `toolParameters`, `prune.tools`, `prune.messages`, `messageIds`, `nudges`. After reset, `checkSession` fire-and-forgets `saveSessionState`.

## Tool cache

`syncToolCache` (`lib/state/tool-cache.ts`) skips compacted messages, increments `turnCounter` on `step-start`, caches tool parts with `state.input` + `state.status` + `state.error` + turn + `tokenCount`. Honors `turnProtection.enabled` and `turnProtection.turns`. `trimToolParametersCache` is FIFO with `MAX_TOOL_CACHE_SIZE = 1000`.

## M2.5c follow-up: `syncPruneToolsFromActiveBlocks`

Bug fix post-M2.5c: `/dcp decompress N` deactivated blocks but `state.prune.tools` retained the IDs, so the next `prune()` replaced the just-restored tool outputs with placeholders. The helper rebuilds `prune.tools` from active blocks' `directToolIds` and wipes sweep-marked entries. The ponytail comment names the ceiling (O(|active blocks| + |prune.tools|)).

## Public surface

`lib/state/index.ts` re-exports all five modules. Callers never construct `PersistedSessionState` directly except in `lib/commands/stats.ts` (read-only via `loadAllSessionStats`).
