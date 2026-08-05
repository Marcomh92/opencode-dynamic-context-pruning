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
- **Current Version:** **3.1.17** (M1+M2+M3+M4+M5 all landed; plan §8 complete minus M6 CI)
- **Working Branch:** `fork/dcp-3.1.15-m1` (still on the M1 branch; one cumulative release per the plan's 3.1.15 / 3.1.16 / 3.1.17 versioning)

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

## Build Verification (Current)
- **Last Build Date:** 2026-08-05 (after M5)
- **Build Status:** SUCCESS
- **Build Output:**
  - `dist/index.js` ~717 KB (was 272 KB upstream — increased because M1 bundles `@opencode-ai/plugin`)
  - `dist/index.js.map` ~1.32 MB
  - Target: ES2022
  - Bundler: tsup v8.5.1
- **Typecheck:** `bun run typecheck` clean (no output)

## Test Results (Current)
- **Test Execution Date:** 2026-08-05 (after M5 + reviewer cleanups)
- **Test Status:** ALL PASSED
- **Test Counts:**
  - tests: 147 (was 87 upstream; +60 new across M2/M3/M4/M5)
  - pass: 147
  - fail: 0
  - skipped: 0
- **Test Duration:** ~2.2 s
- **Test Files (21 total):**
  - Upstream (14): `compress-message`, `compress-range-placeholders`, `compress-range`, `compression-groups`, `compression-targets`, `hooks-permission`, `host-permissions`, `message-ids`, `message-priority`, `message-utils`, `prompts`, `token-counting`, `token-usage`, `update`
  - New for fork (7): `compress-protocol` (M2, 21 cases), `desktop-notifications` (M5, 5 cases), `protected-patterns` (M3, 10 cases), `state-schema-version` (M2, 9 cases), `subagent-cache` (M4, 4 cases — reduced from 8 after removing the dead `olderWinsWrite` tests), `synthetic-compress-burn` (M2, 5 cases), `system-prompt-handler` (M5, 6 cases)

## Milestone Status
| Milestone | Status | Version | Issues Fixed | Effort |
|---|---|---|---|---|
| M1 — silent-load fixes | DONE | 3.1.15 | #575, #585 | XS |
| M3 — path correctness | DONE | 3.1.15 (shipped in 3.1.16 bundle) | #592, tui.tsx Bun-gating | XS |
| M2 — compress safety + v2 protocol | DONE | 3.1.16 | #590, #573 | XS+M |
| M4 — subagent cache | DONE | 3.1.16 | #595 | M |
| M5 — UX polish | DONE | 3.1.17 | #579, #581, #588, recoveryForced surface | S+XS |
| M6 — CI expansion | SKIPPED | — | (not applicable to local-only fork) | M |

## Open Concerns / Caveats
- **`DCP_LOCAL_FORK` env var:** the M1 auto-update guard reads this env var but no code in the fork sets it. The user must set it manually if they want the auto-update guard to actively skip the npm probe. Currently the guard is defensive — the probe would fail silently anyway because there's no upstream registry in a local install. Not blocking.
- **`subAgentResultCache` is intentionally cold.** After reviewer feedback, the `olderWinsWrite` helper was removed (had no production call site — the legacy fetch-on-miss path was the source of the round-overwrite bug and has been removed in M4). The cache scaffolding (composite key, `CachedSubAgentResult` value type, `buildSubAgentCacheKey` helper) is preserved as a defensive shell for a future safe write-on-completion path; a `ponytail:` comment in `lib/state/types.ts` documents this design.
- **Dead helpers removed:** `getSubAgentId` and `buildSubagentResultText` in `lib/subagents/subagent-results.ts` were deleted after the review (they had no remaining callers). Only `mergeSubagentResult` remains in that file (still used by both cache-HIT paths).
- **`recoveryFadeCounter` field was added beyond M2's spec** to make the fade-window streak trackable across sessions. Backward-compatible load (defaults to 0 if missing).
- **Plan §6.1 design deviation — silent net-compaction refusal instead of thrown error:** the implementation uses silent counter + auto-disable (`recoveryForced` after `maxContextLimitRecovery` consecutive non-compacting compresses) rather than the thrown `__DCP_REFUSE_NONCOMPACTING_BLOCK__` error described in the plan. The model loses the `compress` tool after the threshold — no immediate "this commit was rejected" signal, just eventual tool disappearance. Model-friendly trade-off; a future revision could add the thrown-error variant if needed.
- **`dispatchToast` finally-block safety:** the queue is cleared in the `finally` block, not just on the success path. Prevents a rejected first `showToast` from leaving merged messages queued into the next burst.
- **`tests/desktop-notifications.test.ts` rewrite:** the M5 implementer's first pass used `setTimeout`-based debouncing that broke the existing toast-call test contracts (asserting `toastCalls.length === 1` after `await tool.execute(...)`). The dispatcher was rewritten to fire-immediately-on-first-call with merged follow-ups for same-tick bursts — this preserves both the existing test contracts AND the plan §6.6 coalescing invariant.
- **`tests/subagent-cache.test.ts` cold-cache test is the architect-required load-bearing test** for #595. The cold-cache path is what the user actually hits; warm-cache-only tests would prove nothing.

## Post-Sync Verification
(populated after each `git fetch upstream && git merge upstream/master`)
