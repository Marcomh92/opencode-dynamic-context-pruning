# MY_README.md - Personal Fork Documentation

## Fork Information
- **Original Repository:** https://github.com/Opencode-DCP/opencode-dynamic-context-pruning
- **Fork URL:** https://github.com/Marcomh92/opencode-dynamic-context-pruning
- **Upstream Remote:** `upstream` -> https://github.com/Opencode-DCP/opencode-dynamic-context-pruning.git
- **Origin Remote:** `origin` -> https://github.com/Marcomh92/opencode-dynamic-context-pruning.git
- **Fork Date:** 2026-08-05
- **Local Path:** `C:\Beheer\OpenCode\opencode_plugins\opencode-dynamic-context-pruning-fork` (relocated 2026-08-05 from initial `C:\Users\marco\.config\opencode_plugins\opencode-dynamic-context-pruning-fork` to match the user's existing plugin-dir convention)
- **Fork Reason:** Local-only fork to fix 9 known upstream bugs (#592, #579, #573, #590, #588, #585, #575, #581, #595) and add a v2 reliable autonomous compress protocol. NOT published to npm; loaded via `file://` directory entry in `opencode.json`.
- **Starting Version:** 3.1.14 (upstream HEAD at fork time)
- **Current Version:** **3.1.19** (M1+M2+M3+M4+M5+M2.5+M2.5b+M2.5c+M2.5d all landed; plan §8 complete minus M6 CI)
- **Working Branch:** `fork/dcp-3.1.15-m1` (still on the M1 branch; one cumulative release per the plan's 3.1.15 / 3.1.16 / 3.1.17 / 3.1.18 versioning)

## Compilation Instructions
- **Build System Detected:** TypeScript via `tsup` (single ESM entry), `tsc --emitDeclarationOnly` for types
- **Prerequisites:**
  - Bun >= 1.3.14 (tested with 1.3.14)
  - Node runtime for tests (Bun spawns Node internally for `node --import tsx --test`)
- **Install Command:** `bun install` (run once after cloning; subsequent builds reuse `node_modules/`)
- **Build Command:** `bun run build`
  - Cleans `dist/`, runs `tsup` (produces `dist/index.js` + sourcemap), then `tsc --emitDeclarationOnly` for `dist/index.d.ts`
- **Test Command:** `bun run test`
  - Spawns `node --import tsx --test tests/*.test.ts`
- **Format / Lint:** `bun run format:check` (Prettier); `bun run typecheck` (tsc --noEmit)
- **Package Verify:** `bun run verify:package` runs after build to confirm package shape

## Development Notes

### Distribution (Local-Only, No npm Publish)
This fork is **not** published to npm. It is loaded by OpenCode via a `file://` directory entry in `opencode.json` (already registered — see `~/.config/opencode/opencode.json` line 585):
```json
{
  "plugin": [
    "file:///C:/Beheer/OpenCode/opencode_plugins/opencode-dynamic-context-pruning-fork"
  ]
}
```
The user's existing convention (see `opencode.json` lines 570-572 for `opencode-agent-skills`, `opencode-agent-delegation`, `opencode-self-improvement`) places local plugins under `C:/Beheer/OpenCode/opencode_plugins/`. The DCP entry sits between `@plannotator/opencode` and `@ramtinj95/opencode-tokenscope` (line 585), so tokenscope measures final-size post-DCP, and context-logger (disabled) was the original "first" in the recommended order.
- **Why directory, not file:** Multi-file plugin with relative imports; OpenCode auto-discovery does NOT recurse into subdirectories (`{plugin,plugins}/*.{ts,js}` is shallow). Directory entry is the only reliable path.
- **Symlinks/hard links break relative imports** (GitHub issue #11001). Do NOT link to this directory; clone/copy it.
- **NPM-plugin dedup is buggy** (GitHub issue #7427). When a plugin is listed in `opencode.json` both as an npm package and as a `file://` directory, both may load simultaneously. **The upstream npm entry (`@tarquinen/opencode-dcp`) is NOT installed** in the user's environment, so this is moot for the initial install.
- **Auto-update is inert under local install** (M1 fix: `lib/update.ts` early-returns when `process.env.DCP_LOCAL_FORK === "1"`). Set this env var in the OpenCode plugin entrypoint environment to skip the network probe. The user's `opencode.json` does NOT set this env var; the guard is defensive (the upstream registry lookup would fail silently anyway).

### Path Handling (Windows + POSIX)
- M3 fixed `lib/protected-patterns.ts:1-3` from `replaceAll("\\\\", "/")` (two-char `\\` literal, no-op on Windows) to `replaceAll("\\", "/")` (single-char `\`). Verified by `tests/protected-patterns.test.ts` (10 cases covering POSIX + Windows + mixed-separator paths). On POSIX this is still a no-op for typical paths (no `\` in real POSIX paths).
- `tui.tsx` defers all `@opentui/core`-dependent imports to dynamic `await import(...)` inside the `tui` function body, gated on `typeof Bun !== "undefined"`. Avoids the silent-load failure on OpenCode Desktop's Node sidecar.

### Plugin Permissions under Strict Policy
- The user's `opencode.json` uses `"*": "deny"` for all tools.
- `lib/host-permissions.ts:compressDisabledByOpencode` detects `"*": "deny"` baseline and the plugin sets `config.compress.permission = "deny"` (does NOT silently inject `allow`).
- To enable compress under the strict policy, the user must add `"compress": "allow"` to their `permission` block in `opencode.json` explicitly, OR set `dcp.jsonc` `compress.permission: "allow"` and accept that the fork will inject it.
- Subagent runs inside this plugin inherit the user's `subagent_depth: 2` cap.

### Coexistence
- Order in `opencode.json` matters for plugin load order. The current sequence is: `opencode-agent-skills` → `opencode-agent-delegation` → `opencode-self-improvement` → `opencode-planner@latest` → `@dietrichgebert/ponytail` → `@plannotator/opencode` → **DCP fork** (this entry, line 585) → `@ramtinj95/opencode-tokenscope`.
- DCP's `experimental.chat.messages.transform` runs before tokenscope measures final size, which is what the user wants.
- This fork does NOT touch `context-logger.ts.disabled` or `@ramtinj95/opencode-tokenscope`.

### `@anthropic-ai/tokenizer` and `tiktoken`
- M1 added `"tiktoken": "^1.0.10"` as a direct dependency (was previously transitive under `@anthropic-ai/tokenizer@^0.0.4` and was skipped by Bun's lockfile in some environments).

### v2 Protocol New Config Keys (M2)
Five new `compress.*` keys added to `dcp.jsonc` schema (all optional, all have safe defaults):
- `compress.maxCompactionRatio` (number 0<x≤1, default 0.7) — refuse compress commits where summary tokens ≥ removed tokens × this ratio.
- `compress.maxContextLimitRecovery` (number ≥1, default 3) — consecutive non-compacting compresses before auto-disabling autonomous compress via `recoveryForced`.
- `compress.recoveryFadeWindow` (number ≥1, default 5) — consecutive good manual compresses required to clear `recoveryForced`.
- `compress.forkSchemaVersion` (number, default 3) — persisted state shape version. Mismatched state is dropped on load.
- `compress.stateMaxAgeDays` (number | null, default null) — optional paranoia wall-clock window for state invalidation. `null` = no expiry across versions.

New `recoveryForced` flag in `/dcp stats` output surfaces when autonomous compress was auto-disabled (between "Compression" and "All-time" sections).

### Subagent Cache (`#595` fix, M4)
- Cache key is now composite `${subAgentSessionId}::${callID}` (was just `callID`). Older-wins write semantic via `olderWinsWrite` helper.
- On cache MISS, the loader falls back to the message part's own original `state.output` (the load-bearing correctness change). It no longer fetches the current subagent session state, which was the source of the round-overwrite bug.

## Logging & State Locations

The fork reads from / writes to several distinct paths. All are resolved at call-time from `XDG_*` env vars, never hard-coded.

### Environment variable resolution (this fork)

| Variable | Standard fallback | This user's actual value |
|---|---|---|
| `XDG_DATA_HOME` | `~/.local/share` | `D:\marco\AppData` |
| `XDG_CONFIG_HOME` | `~/.config` | `C:\Users\marco\.config` (still default) |

The `.config` paths therefore live on `C:` while the bulk state lives on `D:`. Mismatch is normal for a Windows user with a custom data dir.

### 1. Per-session state (`lib/state/persistence.ts`)

**Path:** `${XDG_DATA_HOME}/opencode/storage/plugin/dcp/{sessionId}.json`
**This user:** `D:\marco\AppData\opencode\storage\plugin\dcp\`
**Standard fallback:** `~/.local/share/opencode/storage/plugin/dcp/`

- One JSON file per OpenCode session. Filename is the session ID (`session-1.json` for synthetic test data, `ses_02de6e10effe...json` for real sessions).
- Schema-version gate at `lib/state/persistence.ts:233-242` drops mismatched state on load (logs `forkSchemaVersion mismatch`).
- Wall-clock gate at `lib/state/persistence.ts:247-263` drops state older than `compress.stateMaxAgeDays` (null = disabled).
- PII surface: log line `Loaded session state from disk` records the sessionId; subsequent transforms fire `logger.saveContext` to the context dir (see §3).

**v2 protocol fields present in every persisted file:**
```
manualMode             // legacy boolean, derived cache
userForced             // user via /dcp-compress
recoveryForced         // auto-disabled after maxContextLimitRecovery non-compacting runs
nonCompactingRunCount  // current streak toward recoveryForced
recoveryFadeCounter    // good-manual streak toward clearing recoveryForced
forkSchemaVersion      // 3 (mismatch = drop)
prune.tools            // Record<toolCallId, runId>
prune.messages.blocksById
prune.messages.activeBlockIds []
prune.messages.activeByAnchorMessageId {}
nudges.contextLimitAnchors / turnNudgeAnchors / iterationNudgeAnchors
stats.pruneTokenCounter / totalPruneTokens
lastUpdated            // ISO timestamp
```

### 2. Per-event telemetry (same dir, fork-internal)

These are written alongside the session file by the persist-on-event hooks. Not core state — they are observability breadcrumbs. **Safe to delete while debugging; do not edit while OpenCode is running** (the next event overwrites them).

| Pattern | Written by | Size | Purpose |
|---|---|---|---|
| `manual-mode-{ts}-{hash}.json` | `/dcp-compress` slash command | ~575 B | Snapshot of `SessionState` at trigger time. `userForced: true` confirms the trigger fired. |
| `session-target-{pid}-{ts}.json` | `applyCompressionState` | ~1468 B | Per-compress per-PID snapshot. Carries the new active block + `effectiveMessageIds`. |
| `ses_message_ids_after_compaction_{ts}.json` | `assignMessageIds` post-compress | ~604 B | The full message-ID map after the compress ran. |
| `ses_*.json` (variants: `compacting`, `compression_notifications`, `fade`, `recovery`, `netcompact`, `range_compress_batch`, `message_compress_*`, `subagent_compress`, etc.) | individual event hooks | varies | One per category of compression event. Use to reconstruct the burn history. |
| `ses_{sessionId}.json` | OpenCode host (not the fork) | 100s of KB | The real session diff. NOT a fork artifact — this is OpenCode's own per-session context log. |

M2.5b-thinned: the `ses_*` family is instrumentation-only; the v2 protocol decisions live in `session-{id}.json` and the `manual-mode`/`session-target` snapshots.

### 3. Logger (`lib/logger.ts`)

**Base path:** `${XDG_CONFIG_HOME}/opencode/logs/dcp/`
**This user:** `C:\Users\marco\.config\opencode\logs\dcp\`
**Standard fallback:** `~/.config/opencode/logs/dcp/`

| Subpath | Format | Purpose |
|---|---|---|
| `daily/{YYYY-MM-DD}.log` | one-line TSV-ish: `ISO LEVEL component: msg | key=val` | Append-only daily log. `component` is the calling source file (resolved via `Error.prepareStackTrace` at `lib/logger.ts:47-68`). |
| `context/{sessionId}/{ISO-with-dashes}.json` | pretty-printed JSON | **PII dump** of every message after the transform hook. `saveContext` at `lib/logger.ts:209-225` writes the full message text / reasoning / tool IO with `minimizeForDebug` (line 126-207) stripping IDs / metadata first. No opt-out. Local-only so no AGPL §13 issue. |

The logger is silent by default; `lib/config.ts` constructs it with `enabled: config.debugLogging ?? false`. To enable:

```jsonc
// ~/.config/opencode/dcp.jsonc
{
  "debugLogging": true
}
```

Logger write errors are silently swallowed (`catch {}` at `lib/logger.ts:88, 224`). A missing logs dir with `enabled: true` means writes failed — check `~/.config/opencode/logs/dcp/` parent exists and is writable.

### 4. Fork user config (`dcp.jsonc`)

**Path:** `${XDG_CONFIG_HOME}/opencode/dcp.jsonc`
**This user:** `C:\Users\marco\.config\opencode\dcp.jsonc`

Currently empty (just `$schema` pointer). All keys optional with safe defaults. The 5 v2 protocol keys are documented under `v2 Protocol New Config Keys (M2)` below.

### 5. OpenCode plugin registration (`opencode.json`)

**Path:** `${XDG_CONFIG_HOME}/opencode/opencode.json`
**This user:** `C:\Users\marco\.config\opencode\opencode.json`

- Line 585: `"file:///C:/Beheer/OpenCode/opencode_plugins/opencode-dynamic-context-pruning-fork"` — the fork plugin entry. Directory entry is required (multi-file plugin; OpenCode's auto-discovery does not recurse subdirs).
- Line 11: `"compress": "allow"` — required for `/dcp-compress` to be functional under the user's strict `"*": "deny"` baseline.
- Line 570-572: skill / planner / delegation plugin entries (pre-existing).
- Line 585: between `@plannotator/opencode` and `@ramtinj95/opencode-tokenscope` — load order matters; tokenscope measures final size post-DCP.

To verify the plugin is loaded:
```powershell
Get-Content $env:USERPROFILE\.config\opencode\opencode.json | Select-Object -Skip 583 -First 3
```

### 6. Local plugin directory (`~/.config/opencode/plugins/`)

**Path:** `${XDG_CONFIG_HOME}/opencode/plugins/`
**This user:** `C:\Users\marco\.config\opencode\plugins\`

Currently contains only `context-logger.ts.disabled` (pre-existing, the user's local-disabled plugin). The fork does NOT load via this directory — it loads via the `file://` entry in `opencode.json` instead. The `plugins/` dir is for OpenCode's flat auto-discovery of `.ts`/`.js` files at root level.

### 7. Auto-update temp dirs (now inert after M2.5b)

**Path:** `${LOCALAPPDATA}/Temp/dcp-update-*/`
**This user:** `C:\Users\marco\AppData\Local\Temp\dcp-update-*\`

After M2.5b, `defaultConfig.autoUpdate = false` so these temp dirs are **never created**. Leftover dirs from pre-M2.5b runs are harmless. Safe to delete:

```powershell
Get-ChildItem $env:LOCALAPPDATA\Temp\dcp-update-* -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force
```

### 8. Test artifact temp dirs (only during `bun run test`)

**Path:** `${LOCALAPPDATA}/Temp/opencode-dcp-{name}-tests-{pid}/opencode/storage/plugin/dcp/`
**This user:** `C:\Users\marco\AppData\Local\Temp\opencode-dcp-*-tests-*\opencode\storage\plugin\dcp\`

Each test gets its own isolated `XDG_DATA_HOME` via `os.tmpdir()` + per-test subdir. Cleanup is the test runner's responsibility. Stale dirs accumulate if the runner crashes mid-test. Safe to delete:

```powershell
Get-ChildItem $env:LOCALAPPDATA\Temp\opencode-dcp-*-tests-* -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force
```

### 9. Quick debug commands

```powershell
# Where is the fork writing state right now?
gci env:XDG_DATA_HOME, XDG_CONFIG_HOME
Resolve-Path "${env:XDG_DATA_HOME}\opencode\storage\plugin\dcp"

# Show the latest session state (v2 fields)
Get-ChildItem "${env:XDG_DATA_HOME}\opencode\storage\plugin\dcp\*.json" |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1 |
  ForEach-Object { Get-Content $_.FullName | Select-String -Pattern "forkSchemaVersion|userForced|recoveryForced|nonCompactingRunCount" }

# Tail today's log
Get-Content (Join-Path $env:USERPROFILE ".config\opencode\logs\dcp\daily\$((Get-Date).ToString('yyyy-MM-dd')).log") -Tail 50 -ErrorAction SilentlyContinue

# Count PII-dumped context files per session
Get-ChildItem "${env:USERPROFILE}\.config\opencode\logs\dcp\context" -Directory -ErrorAction SilentlyContinue |
  ForEach-Object { "{0}: {1} files" -f $_.Name, (Get-ChildItem $_.FullName -File).Count }

# Confirm fork is registered
(Select-String -Path "${env:USERPROFILE}\.config\opencode\opencode.json" -Pattern "opencode-dynamic-context-pruning").Line

# Count distinct compress events from telemetry
(Get-ChildItem "${env:XDG_DATA_HOME}\opencode\storage\plugin\dcp\manual-mode-*.json" -ErrorAction SilentlyContinue).Count
```

### 10. Directory layout summary

```
${XDG_CONFIG_HOME}/opencode/                          ← C:\Users\marco\.config\opencode\
├── opencode.json                                     ← plugin registration (line 585)
├── dcp.jsonc                                         ← fork user config (3 lines, empty)
├── plugins/                                          ← local plugin auto-discovery
│   └── context-logger.ts.disabled                    ← user's pre-existing disabled plugin
└── logs/dcp/                                         ← logger destination
    ├── daily/{YYYY-MM-DD}.log                        ← daily append-only log
    └── context/{sessionId}/{ISO-ts}.json             ← PII dump, no opt-out

${XDG_DATA_HOME}/opencode/storage/plugin/dcp/         ← D:\marco\AppData\opencode\storage\plugin\dcp\
├── {sessionId}.json                                  ← persisted SessionState (v2 fields)
├── manual-mode-{ts}-{hash}.json                      ← per-trigger snapshot
├── session-target-{pid}-{ts}.json                    ← per-compress per-PID snapshot
├── ses_*_*.json                                      ← per-event telemetry
└── ses_{realSessionId}.json                          ← OpenCode host diff (not a fork artifact)

${LOCALAPPDATA}/Temp/                                 ← C:\Users\marco\AppData\Local\Temp\
├── dcp-update-*/                                     ← inert after M2.5b (autoUpdate:false)
└── opencode-dcp-*-tests-*/                           ← only during `bun run test`
```

## Build Verification (Current)
- **Last Build Date:** 2026-08-05 (after M2.5b)
- **Build Status:** SUCCESS
- **Build Output:**
  - `dist/index.js` 722.17 KB (was 272 KB upstream — increased because M1 bundles `@opencode-ai/plugin`)
  - `dist/index.js.map` 1.33 MB
  - Target: ES2022
  - Bundler: tsup v8.5.1
- **Typecheck:** `bun run typecheck` clean (no output)
- **Bootstrap note:** OpenCode loads `dist/index.js` via `package.json:main`. After ANY source edit, run `bun run build` before restarting OpenCode — the running process will silently use the stale dist if you skip the rebuild.

## Test Results (Current)
- **Test Execution Date:** 2026-08-05 (after M2.5d)
- **Test Status:** ALL PASSED
- **Test Counts:**
  - tests: 195 (was 87 upstream; +108 new across M2 / M2.5 / M2.5b / M3 / M4 / M5 / M2.5c / M2.5d; -2 validateRangeSanity tests removed in M2.5b)
  - pass: 195
  - fail: 0
  - skipped: 0
- **Test Duration:** ~2.6 s
- **Test Files (24 total):**
  - Upstream (14): `compress-message`, `compress-range-placeholders`, `compress-range`, `compression-groups`, `compression-targets`, `hooks-permission`, `host-permissions`, `message-ids`, `message-priority`, `message-utils`, `prompts`, `token-counting`, `token-usage`, `update`
  - **M2 / M2.5 (new)** — v2 protocol + schema/version + synthetic burn: `compress-protocol` (19 cases after removing 2 in M2.5b), `state-schema-version` (9), `synthetic-compress-burn` (5)
  - **M2.5 (new)** — hardware bootstrap: `validator-wiring` (8 cases), `state-max-age` (5 cases)
  - **M3 (new)** — Windows path: `protected-patterns` (10)
  - **M4 (new)** — subagent cache: `subagent-cache` (9 cases: 4 cold-cache / HIT / composite-key + 5 `olderWinsWrite` reference helper)
  - **M5 (new)** — UX polish: `desktop-notifications` (7 cases), `system-prompt-handler` (5 cases)
  - **M2.5c (new)** — context-stats + cache-friendliness: `notification-header` (4), `stats-race` (7), `prune-tools-propagation` (3), `savecontext-rate-limit` (4), `synthetic-user-message-stability` (5), `append-idempotency` (4), `coalesce-save-session` (2) — +29
  - **M2.5d (new)** — decompress/recompress prune.tools consistency: `decompress-prune-tools-cleanup` (5) — +5

## Milestone Status
| Milestone | Status | Version | Issues Fixed | Effort |
|---|---|---|---|---|
| M1 — silent-load fixes | DONE | 3.1.15 | #575, #585 | XS |
| M3 — path correctness | DONE | 3.1.15 (shipped in 3.1.16 bundle) | #592, tui.tsx Bun-gating | XS |
| M2 — compress safety + v2 protocol | DONE | 3.1.16 | #590, #573 | XS+M |
| M4 — subagent cache | DONE | 3.1.16 | #595 | M |
| M5 — UX polish | DONE | 3.1.17 | #579, #581, #588, recoveryForced surface | S+XS |
| M2.5 — review findings | DONE | 3.1.17 | v2 validator wiring, stateMaxAgeDays runtime, numeric sort, olderWinsWrite ref | S |
| M2.5b — architect polish | DONE | 3.1.17 | autoUpdate default false, dispatchToast drain loop, schema accuracy, dead-code reversal, warning-log | S |
| M2.5c — context-stats & cache-friendliness | DONE | 3.1.18 | per-compress delta headline, stats race + double-flush fix, prune.tools propagation, saveContext change-detection, synthetic summary byte-stability + append idempotency + save coalescing | S |
| M2.5d — decompress/recompress prune.tools consistency | DONE | 3.1.19 | BUG-M1: `/dcp decompress` silently undoing user restoration; new `syncPruneToolsFromActiveBlocks` helper wired into both decompress and recompress; recompress had a latent bug exposed by the fix (wasn't re-populating prune.tools on reactivate) | XS |
| M6 — CI expansion | SKIPPED | — | (not applicable to local-only fork) | M |

## Open Concerns / Caveats
- **`defaultConfig.autoUpdate: false` (M2.5b):** the fork now defaults to no auto-update probing. The `DCP_LOCAL_FORK=1` env-var guard in `lib/update.ts` is now defensive (the network probe never fires by default). If the user ever installs via npm, they can flip the default in `dcp.jsonc`.
- **`subAgentResultCache` is intentionally cold.** The cache scaffolding (composite key, `CachedSubAgentResult` value type, `buildSubAgentCacheKey` + `olderWinsWrite` reference helpers) is preserved as a defensive shell for a future safe write-on-completion path; a `ponytail:` comment in `lib/state/types.ts` documents this design. The cold-cache test in `tests/subagent-cache.test.ts` is the load-bearing correctness check.
- **Plan §6.1 design deviation — silent net-compaction refusal instead of thrown error:** the implementation uses silent counter + auto-disable (`recoveryForced` after `maxContextLimitRecovery` consecutive non-compacting compresses) rather than the thrown `__DCP_REFUSE_NONCOMPACTING_BLOCK__` error described in the plan. The schema `description` (M2.5b) now accurately reflects this. The model loses the `compress` tool after the threshold — no immediate "this commit was rejected" signal, just eventual tool disappearance. Model-friendly trade-off; a future revision could add the thrown-error variant if needed.
- **`dispatchToast` drain-loop (M2.5b):** fires the first toast immediately, then drains `pendingMergedMessages` across multiple iterations until empty. `.catch` silently swallows rejected `showToast` calls. The `finally` block clears `pendingMergedMessages` defensively even on rejection (mid-await arrivals during a rejected toast are dropped — acceptable trade-off vs. an unbounded leak). Module-level `ponytail:` comment documents the per-process scope.
- **4 ungated `showToast` call sites** outside the §6.6 architecture: `lib/config.ts:750-761`, `lib/config.ts:1095-1107`, `lib/update.ts:32-41` (moot once autoUpdate:false), `lib/compress/pipeline.ts:160-171` (recovery-forced warning). All work today across both runtimes but should be routed through `dispatchToast` in a future cleanup pass.
- **Dead code: `sendUnifiedNotification` in `notification.ts:165-207`** has zero callers in the fork. Defer to a future deletion pass.
- **PII surface:** `logger.saveContext` dumps full message text/reasoning/tool IO to `~/.config/opencode/logs/dcp/context/<sessionId>/` with no opt-out and no redaction. Local-only so no AGPL §13 issue, but worth a config flag in a future cleanup pass.
- **Tests typecheck gap:** `tsconfig.json` excludes `tests/` from `tsc --noEmit`, so test-file type drift is invisible to `bun run typecheck`. Tests still pass via `node --import tsx --test`, but the heterogeneous boundary is a hair-thin safety net.
- **Project Context Preservation prompt addition (2026-08-06):** `lib/prompts/compress-message.ts:44-52` and `lib/prompts/compress-range.ts:61-69` now carry a `PROJECT CONTEXT PRESERVATION` section (~95 words, identical text in both files). Instructs the agent to apply loss-aware compression to project-context knowledge it has gathered (headers, file paths, signatures, config keys, code identifiers preserved verbatim; tiered rules for general/task-relevant/task-irrelevant content). **No off-switch** — only `experimental.customPrompts` user overrides can replace the bundled text. **`compress.protectedTools: ["task", …]` overlap risk:** `task` outputs are already verbatim-appended by `appendProtectedTools` (`lib/compress/protected-content.ts:139-184`); the new prompt text now also asks the agent to preserve that knowledge, which can stack to inflated `summaryTokens` and trip the v2 `recoveryForced` path. **Mitigation if summaries bloat:** explicitly drop `"task"` from `compress.protectedTools` in `dcp.jsonc`. Monitor `/dcp stats` for recoveryForced regressions.

## Post-Sync Verification
(populated after each `git fetch upstream && git merge upstream/master`)
