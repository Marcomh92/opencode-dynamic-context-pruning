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
- **Working Branch:** `fork/dcp-3.1.15-m1`

## Compilation Instructions
- **Build System Detected:** TypeScript via `tsup` (single ESM entry), `tsc --emitDeclarationOnly` for types
- **Prerequisites:**
  - Bun >= 1.3.14 (tested with 1.3.14)
  - Node runtime for tests (Bun spawns Node internally for `node --import tsx --test`)
- **Install Command:** `bun install`
- **Build Command:** `bun run build`
  - Cleans `dist/`, runs `tsup` (produces `dist/index.js` + sourcemap), then `tsc --emitDeclarationOnly` for `dist/index.d.ts`
- **Test Command:** `bun run test`
  - Spawns `node --import tsx --test tests/*.test.ts`
- **Format / Lint:** `bun run format:check` (Prettier); `bun run typecheck` (tsc --noEmit)
- **Package Verify:** `bun run verify:package` runs after build to confirm package shape

## Development Notes

### Distribution (Local-Only, No npm Publish)
This fork is **not** published to npm. It is loaded by OpenCode via a `file://` directory entry in `opencode.json`:
```json
{
  "plugin": [
    "file:///C:/Beheer/OpenCode/opencode_plugins/opencode-dynamic-context-pruning-fork"
  ]
}
```
The user's existing convention (see `opencode.json` lines 570-572 for `opencode-agent-skills`, `opencode-agent-delegation`, `opencode-self-improvement`) places local plugins under `C:/Beheer/OpenCode/opencode_plugins/`.
- **Why directory, not file:** Multi-file plugin with relative imports; OpenCode auto-discovery does NOT recurse into subdirectories (`{plugin,plugins}/*.{ts,js}` is shallow). Directory entry is the only reliable path (GitHub issue about plugin loading behaviour).
- **Symlinks/hard links break relative imports** (GitHub issue #11001). Do NOT link to this directory; clone/copy it.
- **NPM-plugin dedup is buggy** (GitHub issue #7427). When a plugin is listed in `opencode.json` both as an npm package and as a `file://` directory, both may load simultaneously. **Remove the upstream npm entry** (`@tarquinen/opencode-dcp@latest`) when registering the fork.
- **Auto-update is inert under local install** -- no upstream registry to query, so `autoUpdate: true` does nothing. M1 cleanup may delete or guard `lib/update.ts`.

### Path Handling (Windows + POSIX)
- Patched and developed on Windows; verified on POSIX where possible.
- `protectedFilePatterns` glob matching uses `replaceAll("\\", "/")` (upstream bug #592: was `replaceAll("\\\\", "/")` which matched nothing on either platform). On POSIX this is still a no-op for typical paths (no `\` in real POSIX paths) -- cross-platform coverage verified in `tests/protected-patterns.test.ts` (see PLAN.md §12 item 5).

### Plugin Permissions under Strict Policy
- The user's `opencode.json` uses `"*": "deny"` for all tools.
- This plugin does NOT silently inject `permission.compress` allow rules. If the user wants compress enabled, they must add it explicitly.
- Subagent runs inside this plugin inherit the user's `subagent_depth: 2` cap.

### Coexistence
- Order in `opencode.json` matters for plugin load order. The recommended sequence is: `context-logger.ts.disabled` -> DCP fork -> `@ramtinj95/opencode-tokenscope`.
- This fork does NOT touch `context-logger.ts.disabled` or `@ramtinj95/opencode-tokenscope`.

### `@anthropic-ai/tokenizer` and `tiktoken`
- Upstream declares `@anthropic-ai/tokenizer@^0.0.4` as a dependency.
- `tiktoken` is a transitive of that package, but Bun's lockfile and the way `@anthropic-ai/tokenizer` declares it as `optional` means the native binding is sometimes skipped at install time.
- The upstream test suite does NOT exercise the actual tokenizer at runtime, so the failure is silent.
- M1 fixes this by adding `tiktoken` as a direct dependency.

## Build Verification
- **Initial Build Date:** 2026-08-05
- **Build Status:** SUCCESS
- **Build Output:**
  - `dist/index.js` 272.22 KB
  - `dist/index.js.map` 585.25 KB
  - Target: ES2022
  - Bundler: tsup v8.5.1
- **Notes:** Build succeeded cleanly with no warnings or errors. The `noExternal: ["jsonc-parser"]` bundler rule already exists in upstream; M1 will extend this list to include `@opencode-ai/plugin` (bug #585).

## Test Results (Original Project)
- **Test Execution Date:** 2026-08-05
- **Test Status:** ALL PASSED
- **Test Counts:**
  - tests: 87
  - pass: 87
  - fail: 0
  - cancelled: 0
  - skipped: 0
  - todo: 0
  - suites: 0
- **Test Duration:** 1905.87 ms (1.91 s)
- **Notes:**
  - These results were observed on the ORIGINAL unmodified project before any fork changes.
  - Test runner: `node --import tsx --test tests/*.test.ts` (Bun-spawned).
  - All upstream tests pass; baseline established.
  - **Caveat:** tests cover logic but do NOT exercise the actual `tiktoken` tokenizer at runtime. Bug #575 (missing direct `tiktoken` dependency) is invisible to this test suite and will be addressed in M1.

## M1 Plan (Current Branch: `fork/dcp-3.1.15-m1`)
M1 = config-shape fix only; version bump to **3.1.15**. No behaviour changes.

| Step | File | Change |
|---|---|---|
| 1 | `package.json` | Add `tiktoken` to `dependencies` (bug #575) |
| 2 | `tsup.config.ts` | Add `"@opencode-ai/plugin"` to `noExternal` (bug #585) |
| 3 | `lib/update.ts` (or call site) | Guard against missing auto-update channel under local install |
| 4 | `index.ts` | Bump plugin version to `3.1.15` |
| 5 | `dcp.schema.json` | Add new optional v2-protocol config keys (see PLAN.md §6) |
| 6 | `tests/protected-patterns.test.ts` (new) | POSIX + Windows path coverage (see PLAN.md §12 item 5) |
| 7 | `README.md` (fork) | Add fork-specific notes pointing to MY_README.md and PLAN.md |

After M1 ships: branch becomes `fork/dcp-3.1.16-m2-m4` (behaviour-changing patches). M5 (v2 protocol integration), M6 (CI expansion). Full plan: `C:\Users\marco\.agent_workspace\plans\opencode-improvement\dcp-context-pruning\PLAN.md` §8.

## Post-Sync Verification
(populated after each `git fetch upstream && git merge upstream/master`)