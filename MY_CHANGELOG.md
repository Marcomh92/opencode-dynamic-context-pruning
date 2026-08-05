# MY_CHANGELOG.md - Personal Change History

## Format
Each entry must include:
- Date
- Branch
- Summary of changes
- Reason for changes
- Files modified

---

## 2026-08-05 - M5 Complete: UX Polish (v3.1.17)
- **Branch:** `fork/dcp-3.1.15-m1`
- **Changes:**
  - **#579 desktop notification crash:** Added `dispatchToast(client, title, message)` helper in `lib/ui/notification.ts` that fires the first toast immediately and coalesces same-tick bursts into a merged follow-up. Resolves `effectiveNotificationType` runtime via `typeof Bun === "undefined"` (desktop sidecar) → forces `pruneNotificationType: "toast"`. TUI keeps the existing notification modes (off/minimal/detailed).
  - **#581 system-prompt detection:** Replaced `output.system.join("\n").includes(...)` in `lib/hooks.ts` with a stricter `output.system.every(prompt => INTERNAL_AGENT_SIGNATURES.some(sig => prompt.includes(sig)))` check via new `isInternalAgentSystem` helper.
  - **#588 `/dcp` slash command registration:** Registered the `dcp` command in `index.ts:103-106` alongside `dcp-compress`, so desktop users get panel access via slash command.
  - **`recoveryForced` in `/dcp stats`:** Extended `lib/commands/stats.ts` `formatStatsMessage` to accept `recoveryForced: boolean` and `nonCompactingRunCount: number`, surfacing a "Recovery state" section.
  - Version bumped 3.1.16 → 3.1.17.
  - New test files: `tests/desktop-notifications.test.ts` (5 cases), `tests/system-prompt-handler.test.ts` (6 cases).
- **Reason:** M5 is the UX-polish milestone in the plan. These four changes close all the user-facing bugs that don't require architectural changes.
- **Files:** `lib/ui/notification.ts`, `lib/hooks.ts`, `lib/commands/stats.ts`, `index.ts`, `package.json`, `tests/desktop-notifications.test.ts` (new), `tests/system-prompt-handler.test.ts` (new)

## 2026-08-05 - M4 Complete: Subagent Cache Correctness (v3.1.16)
- **Branch:** `fork/dcp-3.1.15-m1`
- **Changes:**
  - **#595 subagent cache poisoning:** Added `CachedSubAgentResult` interface and changed `SessionState.subAgentResultCache` to `Map<string, CachedSubAgentResult>`. Cache key is now composite `${subAgentSessionId}::${callID}`. New helpers `buildSubAgentCacheKey` and `olderWinsWrite` in `lib/subagents/cache-key.ts`.
  - **Load-bearing fallback:** On cache MISS, both `injectExtendedSubAgentResults` and `appendProtectedTools` (in `lib/compress/protected-content.ts`) now use the part's own `state.output` as-is — they no longer fetch the current subagent session state, which was the bug source.
  - **forkSchemaVersion bump 2 → 3** because the cache shape changed. Old sessions are dropped cleanly on load.
  - Removed dead `fetchSubAgentMessages` helper (no longer needed after the fetch-on-miss path was deleted).
  - Version bumped 3.1.15 → 3.1.16.
  - New test file: `tests/subagent-cache.test.ts` (4 cases: cold-cache fallback in inject, cold-cache fallback in protected-content, cache HIT, composite-key collision isolation). Cold-cache test is the load-bearing test per architect review.
- **Reason:** M4 fixes the nested-task() result-overwrite bug where 3-round subagent chains showed all ancestor `<task_result>`s as the deepest round's text. The fallback to `state.output` is the load-bearing correctness change; the cache is a defensive scaffolding (composite key + `CachedSubAgentResult` value type) for a future safe write-on-completion path. The legacy `olderWinsWrite` helper was removed after review found it had no production call site.
- **Files:** `lib/state/types.ts`, `lib/state/state.ts`, `lib/messages/inject/subagent-results.ts`, `lib/compress/protected-content.ts`, `lib/config.ts`, `dcp.schema.json`, `lib/subagents/cache-key.ts` (new), `package.json`, `tests/subagent-cache.test.ts` (new)

## 2026-08-05 - M2 Complete: Compress Safety + v2 Protocol (v3.1.15 → 3.1.16 prep)
- **Branch:** `fork/dcp-3.1.15-m1`
- **Changes:**
  - **#590 manualMode round-trip fix:** Changed `lib/compress/pipeline.ts:88` from truthy check `ctx.state.manualMode ? "active" : false` to strict equality `=== "active"`. Mirror fix in `lib/state/persistence.ts:92`. Stops the `"compress-pending"` state from being persisted as `"active"` after a single `/dcp-compress`.
  - **v2 protocol invariants (per PLAN §6.1-§6.3):**
    - Added `validateMonotonicEnd(prevEnd, newStart, newEnd, state)` in `lib/compress/range-utils.ts` — throws on `newStart ≤ prevEnd` or `newEnd ≤ prevEnd`, with valid-ID list in the error message.
    - Added `validateBoundaryIds(startId, endId, state)` — throws when IDs don't exist in visible message set.
    - Added `validateRangeSanity(startId, endId)` — throws when `startId > endId`.
    - Added `listValidBoundaryIds(state)` and `isBoundaryIdValid(id, state)` helpers for the valid-ID list generation.
    - Net-compaction guard: `summaryTokens ≥ removedTokens × maxCompactionRatio` (default 0.7) — increments `nonCompactingRunCount`, fires `recoveryForced` after `maxContextLimitRecovery` (default 3) consecutive non-compacting runs.
    - `userForced` / `recoveryForced` flag split in `SessionState`; effective manual = `userForced || recoveryForced`. Recovery measurement ignores `compress.summaryBuffer`.
    - `compress.forkSchemaVersion: 3` state invalidation (M2 + M4 were bundled into the same 3.1.16 release, so the field was 3 from first ship): on load, if `forkSchemaVersion !== 3`, drop and log the dropped version.
    - New config keys: `compress.maxCompactionRatio` (0.7), `compress.maxContextLimitRecovery` (3), `compress.recoveryFadeWindow` (5), `compress.forkSchemaVersion` (3), `compress.stateMaxAgeDays` (null).
  - `recoveryFadeCounter` field added beyond the plan's spec to make the fade window trackable across sessions.
  - **Design deviation from plan §6.1**: the plan described net-compaction refusal as a thrown tool-visible error (`__DCP_REFUSE_NONCOMPACTING_BLOCK__`). The implementation uses silent counter + auto-disable instead: when `summaryTokens ≥ removedTokens × maxCompactionRatio`, `nonCompactingRunCount` increments; after `maxContextLimitRecovery` consecutive non-compacting runs, `recoveryForced` is set and the `compress` tool becomes unavailable. This is model-friendly (no new error type to handle) but means the model has no immediate "this commit was rejected" signal — only the eventual disappearance of the tool. Documented as a deliberate deviation; a future revision could add the thrown-error variant if the model benefits from it.
  - New test files: `tests/compress-protocol.test.ts` (21 cases), `tests/state-schema-version.test.ts` (9 cases), `tests/synthetic-compress-burn.test.ts` (5 cases including the deterministic 20-block burn-graph).
- **Reason:** M2 is the central behaviour-changing milestone — resolves the 738K summary-burn signature (#573) and the manualMode lock-out (#590). The harness bootstrap is included so the new invariants are testable.
- **Files:** `lib/state/types.ts`, `lib/state/state.ts`, `lib/state/persistence.ts`, `lib/compress/pipeline.ts`, `lib/compress/range-utils.ts`, `lib/compress/range.ts`, `lib/compress/message.ts`, `lib/compress/protected-content.ts`, `lib/config.ts`, `dcp.schema.json`, `lib/commands/manual.ts`, `lib/tui/data.ts`, `package.json`, `tests/compress-protocol.test.ts` (new), `tests/state-schema-version.test.ts` (new), `tests/synthetic-compress-burn.test.ts` (new)

## 2026-08-05 - M3 Complete: Path Correctness (v3.1.15)
- **Branch:** `fork/dcp-3.1.15-m1`
- **Changes:**
  - **#592 Windows path normalization:** Fixed `lib/protected-patterns.ts:1-3` `normalizePath` from `replaceAll("\\\\", "/")` (two-char `\\` literal, no-op on Windows) to `replaceAll("\\", "/")` (single-char `\`, matches real Windows paths). The `\\\\` source-code literal was the bug.
  - **TUI module Bun-gating:** Converted `tui.tsx` static imports of `./lib/tui/commands`, `./lib/tui/data`, `./lib/tui/modals` to dynamic `await import(...)` inside the `tui` function body, gated on `typeof Bun !== "undefined"`. Prevents the `@opentui/core` silent-load on the OpenCode Desktop Node sidecar (same failure family as #585).
  - Added `declare const Bun: { version?: string } | undefined;` in `tui.tsx` to satisfy `tsc --noEmit` without installing `@types/bun`.
  - New test file: `tests/protected-patterns.test.ts` (10 cases covering POSIX + Windows + mixed-separator path fixtures).
- **Reason:** M3 lifts the only Windows-blocking caveat before M2 tests can rely on `protectedFilePatterns` working on Win. Also hardens the TUI load path on desktop.
- **Files:** `lib/protected-patterns.ts`, `tui.tsx`, `tests/protected-patterns.test.ts` (new)

## 2026-08-05 - M1 Complete: Silent-Load Fixes (v3.1.14 → 3.1.15)
- **Branch:** `fork/dcp-3.1.15-m1`
- **Changes:**
  - **#575 tiktoken direct dep:** Added `"tiktoken": "^1.0.10"` to `dependencies` in `package.json` (was previously a transitive of `@anthropic-ai/tokenizer`, often skipped by Bun's lockfile).
  - **#585 `@opencode-ai/plugin` runtime import:** Added `"@opencode-ai/plugin"` to `noExternal` in `tsup.config.ts`. Mirrors the existing `jsonc-parser` bundling pattern. OpenCode's plugin cache does not promote peer deps into the runtime cache; bundling fixes this without an extra npm install.
  - **`startAutoUpdate` guard:** Added an early-return in `lib/update.ts` gated on `process.env.DCP_LOCAL_FORK === "1"`. Under a local `file://` install, the npm registry lookup in `lib/update.ts` is inert; the guard makes that explicit and skips the network probe (no error / no log noise). The user sets `DCP_LOCAL_FORK=1` in the OpenCode plugin entrypoint environment.
  - Version bumped 3.1.14 → 3.1.15.
- **Reason:** M1 is silent-load fixes only — no behaviour change. Safe to ship immediately as 3.1.15. Both #575 and #585 manifest as the plugin loading but doing nothing; without these fixes the rest of the plan is moot.
- **Files:** `package.json`, `tsup.config.ts`, `lib/update.ts`

## 2026-08-05 - Relocated Fork to Standard Plugin Directory
- **Branch:** `fork/dcp-3.1.15-m1`
- **Changes:**
  - Moved fork from `C:\Users\marco\.config\opencode_plugins\opencode-dynamic-context-pruning-fork` to `C:\Beheer\OpenCode\opencode_plugins\opencode-dynamic-context-pruning-fork`
  - Same-volume rename; `.git/`, `node_modules/`, `dist/` carried over intact (no reinstall or rebuild needed)
  - Verified post-move: `node_modules/` present, `dist/` present, `MY_README.md` + `MY_CHANGELOG.md` present, `.git/` present (remotes intact)
- **Reason:** The user's existing local-plugin convention places file:// plugins under `C:/Beheer/OpenCode/opencode_plugins/` (see `opencode.json` lines 570-572). The initial location under `~/.config/opencode_plugins/` broke that convention and was incorrect.
- **Files:** none (filesystem-level relocation only)

## 2026-08-05 - Initial Fork
- **Branch:** `fork/dcp-3.1.15-m1` (cut from `upstream/master` @ v3.1.14)
- **Changes:**
  - Cloned `https://github.com/Marcomh92/opencode-dynamic-context-pruning.git` (initially to `C:\Users\marco\.config\opencode_plugins\opencode-dynamic-context-pruning-fork`; relocated same day to `C:\Beheer\OpenCode\opencode_plugins\opencode-dynamic-context-pruning-fork` -- see entry above)
  - Added `upstream` remote pointing at `https://github.com/Opencode-DCP/opencode-dynamic-context-pruning.git`
  - Created feature branch `fork/dcp-3.1.15-m1` off `upstream/master`
  - Verified baseline: `bun install` OK (163 packages, 3.30 s), `bun run build` OK (`dist/index.js` 272.22 KB, sourcemap 585.25 KB), `bun run test` OK (87/87 pass, 1.91 s)
  - Authored `MY_README.md` and `MY_CHANGELOG.md` (this file)
- **Reason:** Establish a local-only fork of the OpenCode DCP plugin to:
  1. Fix 9 known upstream bugs (#592, #579, #573, #590, #588, #585, #575, #581, #595)
  2. Add a v2 reliable autonomous compress protocol
  3. Adapt for the user's Win 11 / OpenCode 1.18.9 / Bun / kimi-for-coding environment
  4. Preserve distribution via `file://` directory entry (no npm publish; AGPL network clause not triggered)
- **Files:** `MY_README.md` (new), `MY_CHANGELOG.md` (new)
