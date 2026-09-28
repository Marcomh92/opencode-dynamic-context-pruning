# MY_UPSTREAM_V2_ADOPTION_PLAN.md — Upstream V2 Migration Adoption Plan

## Header

- **Date:** 2026-09-28
- **Author:** OpenCode agent (Marco)
- **Branch (target):** `fork/dcp-3.1.15-m1` (cumulative branch per the M1 plan) — but a new dedicated `fork/dcp-3.2.0-v2` branch is recommended for V2 work to keep the V1 branch shippable
- **Fork version (current):** 3.1.19 (V1-only)
- **Upstream version (target):** 3.2.0 (V1 + V2 parallel, 11,457 insertions / 1,436 deletions across 84 files since v3.1.14)
- **Upstream clone used for diffing:** `C:\Beheer\OpenCode\opencode_plugins\opencode-dynamic-context-pruning\`
- **Fork clone target of the patches:** `C:\Beheer\OpenCode\opencode_plugins\opencode-dynamic-context-pruning-fork-v2\`
- **Status:** PLAN. No code changes have been made yet.

## What this plan covers

Upstream v3.2.0 ships a parallel V2 implementation alongside V1. The V2 work is contained and **architecturally additive** — every V2-aware function takes a `format: IdFormat = "xml"` parameter and V1 paths produce byte-identical text. This plan documents the V2 surface, evaluates each V2 feature against the fork's needs, and provides a phase-by-phase migration path for the cases where adoption is justified.

## What this plan does NOT cover

- The V1-only bug fixes (#555, #556, `allowTrailingCommas`, dep updates) — see `MY_UPSTREAM_V1_BACKPORT_PLAN.md`
- The OpenTUI version pin changes (`77d800b8`) — fork's V1-only pin is correct
- The OpenCode plugin peer-dep bump to `>=1.18.29` — that is part of the V2 SDK contract and is bundled in §5 of this plan

---

## V2 architecture overview

### What is V2?

V2 is a parallel set of contracts the OpenCode host exposes to plugins, distinct from the V1 contracts. V2 changes:

1. **Message ID format** — V1 uses XML tags like ``; V2 uses compact markers like `@4@`, `@b1@`, `@blocked@`, optionally suffixed with `[high]`/`[medium]`/`[low]` for priority. The compact form is more cache-friendly and easier to read in long conversations.
2. **Tool parameters** — V1's `read`/`write`/`edit` tools use `filePath`; V2 uses `path`. V2 introduces a single `execute` tool that wraps multiple sub-calls in `metadata.toolCalls` (V2 "Code Mode").
3. **Subagent dispatch** — V1 has `task`; V2 also has `subagent` (and may dispatch one or the other).
4. **Plugin entry shape** — V1 plugins export `default: Plugin` (a function); V2 plugins export `{ id, setup, server }` so the host can call `setup` before `server` to negotiate the V2 contract.
5. **Server SDK** — V2 splits the SDK into `@opencode-ai/sdk/v2` (which the fork already imports in `lib/messages/utils.ts:6` — the import was a forward-compat preparation).

### How V2 is isolated from V1

Every V2-aware function takes `format: IdFormat = "xml"`, where:

```ts
export type IdFormat = "xml" | "compact"
```

The default is `"xml"`, so V1-only callers see byte-identical behavior. The only call site that threads `state.idFormat` is `injectMessageIds` (via `formatMessageIdTag`), which gets its value from the `state.idFormat` field that the V2 host sets in the session-state hydration step. V1 hosts never set this field, so it defaults to `"xml"`, and the existing `injectMessageIds` path produces the same XML output it always did.

The V2 server adapter lives in a separate `lib/v2/` directory (4 files, 723 LOC). The V1 entry point (`index.ts` → `server: Plugin`) and the V2 entry point (`lib/v2/index.ts` → `setup`) are independent. The `index.ts` export shape at v3.2.0 is:

```ts
export default { id: "opencode-dcp", setup, server }
```

A V1 host ignores the `setup` key and calls `server` as before. A V2 host ignores the function-default and uses the object shape with `setup` for V2 negotiation.

### The `IdFormat` thread

| Site | v3.1.14 | v3.2.0 |
|---|---|---|
| `formatMessageRef(index, format)` | `string` (no format) | `string` + `format: IdFormat = "xml"` |
| `formatBlockRef(blockId, format)` | `string` (no format) | `string` + `format: IdFormat = "xml"` |
| `parseMessageRef(ref, format)` | `number \| null` (no format) | `number \| null` + `format: IdFormat = "xml"` |
| `parseBlockRef(ref, format)` | `number \| null` (no format) | `number \| null` + `format: IdFormat = "xml"` |
| `formatMessageIdTag(ref, attrs, format)` | `string` (no format) | `string` + `format: IdFormat = "xml"` |
| `replaceBlockIdsWithBlocked(text, format)` | `string` (no format) | `string` + `format: IdFormat = "xml"` |
| `stripHallucinationsFromString(text, format)` | `string` (no format) | `string` + `format: IdFormat = "xml"` |
| `stripHallucinations(messages, format)` | `void` (no format) | `void` + `format: IdFormat = "xml"` |
| `parseBlockPlaceholders(summary, format)` | `ParsedBlockPlaceholder[]` (no format) | `ParsedBlockPlaceholder[]` + `format: IdFormat = "xml"` |
| `appendMissingBlockSummaries(..., format)` | `InjectedSummaryResult` (no format) | `InjectedSummaryResult` + `format: IdFormat = "xml"` |
| `createCompressMessageTool` | `buildSchema()` | `buildSchema(format)` |
| `createCompressRangeTool` | `buildSchema()` | `buildSchema(format)` |
| `wrapCompressedSummary(blockId, summary)` | takes 2 args | takes 3 args: `(blockId, summary, format)` |
| `PromptStore` constructor | `constructor(logger, workingDir, customPromptsEnabled?)` | adds `idFormat: IdFormat = "xml"` as 4th arg |

In every case, the V1 default is preserved. A V1-only fork that adopts V2 gets a no-op refactor.

### The V2-only surface (no V1 equivalent)

| File | LOC | Purpose |
|---|---|---|
| `lib/v2/index.ts` | 371 | V2 plugin entry; hydrates `state.idFormat` from the V2 host and calls V1 code with that flag |
| `lib/v2/messages.ts` | 237 | V2 message-shape adapters (V2 SDK types → internal `WithParts`) |
| `lib/v2/rpc.ts` | 48 | V2 RPC contract helpers |
| `lib/v2/theme.ts` | 67 | V2 dialog theme resolver |
| `lib/v2/tui.tsx` | 115 | V2 TUI panel (the V2 equivalent of the fork's `tui.tsx`) |
| `scripts/sandbox.mjs` | 246 | Dual-version DCP sandbox for end-to-end testing (dev-only, not in published package) |
| `scripts/sandbox/{Dockerfile,auth.mjs,run.mjs}` | 294 | Sandbox plumbing |
| `tests/lab/{Dockerfile,api.mjs,auth.mjs,inspect.mjs,live.mjs,mock.mjs,process.mjs,run.mjs,ui.py}` | 1,403 | Test infrastructure (Python UI driver + Node mocks) |
| `tests/logger/{*.ts,*.mjs,package.json,tsconfig.json,server.js}` | 1,538 | Separate test workspace (`tests/logger`) that captures request logs across both V1 and V2 |
| `tests/{compaction-nudges,finalize-session,v2-ids,v2-messages,v2-protection}.test.ts` | 717 | V2-specific test cases |
| `server.js` | 1 | New V2 server entry shim |
| `lib/v2/tui.tsx` import in `tui.tsx` | (handled in tui.tsx) | Routes to V1 or V2 TUI based on host detection |

**Total V2-only surface: ~5,037 LOC.** The vast majority of it is test infrastructure (`tests/logger/`, `tests/lab/`) and the dual-version sandbox (`scripts/sandbox*`). The actual production code that the V2 server uses is in `lib/v2/` — ~838 LOC.

---

## Decision matrix

| V2 feature | File(s) | V1-only fork value | Adopt? |
|---|---|---|---|
| **`IdFormat` type + thread through existing functions** | `lib/message-ids.ts` (8 functions threaded), `lib/messages/utils.ts` (3 functions), `lib/messages/inject/inject.ts` (1 call), `lib/messages/inject/subagent-results.ts` (3 calls), `lib/prompts/store.ts` (PromptStore ctor), `lib/prompts/system.ts` (function export), `lib/prompts/compress-{message,range}.ts` (function exports), `lib/prompts/extensions/tool.ts` (function exports), `lib/compress/{message,range}.ts` (schema builders), `lib/compress/range-utils.ts` (3 functions), `lib/compress/protected-content.ts` (wrapCompressedSummary), `state.idFormat` field | **Low** — V1 callers default to `"xml"` and produce byte-identical output. The refactor itself is mechanical but touches ~15 files. | **NO** unless adopting V2. Pure no-op for V1. |
| **`isToolProtected` V2 metadata-aware helper** | `lib/protected-patterns.ts:138-160` (new), `lib/strategies/deduplication.ts:50-58` (use it), `lib/strategies/purge-errors.ts:52-60` (use it), `lib/commands/sweep.ts:175-191, 196-201` (use it) | **None** — the fork's local `isProtectedByFilePatterns` (`lib/protected-patterns.ts:114-122`) is the V1-equivalent consolidation. The V2 addition is `metadata.toolCalls` recursion for the `execute` tool. | **NO** — fork's helper is correct for V1. |
| **V2 file-tool `path` vs V1 `filePath`** | `lib/protected-patterns.ts:99-103` (new branch) | **None** — V1 `read`/`write`/`edit` continue to use `filePath`. | **NO** — V1-only fork. |
| **V2 subagent tool recognition (`subagent` alongside `task`)** | `lib/messages/inject/subagent-results.ts:34` | **None** — V1 host emits `task`; the V2 host may emit `subagent`. | **NO** — V1-only fork. |
| **V2 server adapter (`lib/v2/`)** | `lib/v2/{index,messages,rpc,theme,tui}.{ts,tsx}` (838 LOC) | **None** unless the user has a V2-host use case. | **NO** unless explicitly required. |
| **Dual-version sandbox (`scripts/sandbox*`)** | 5 files, 558 LOC, plus Dockerfile | **None** for production. Useful for the user's dev workflow if they want to validate against both V1 and V2 hosts locally. | **OPTIONAL** — dev-only, no runtime impact. |
| **`tests/logger` workspace** | `tests/logger/` (1,538 LOC including a separate `package.json` + `tsconfig.json`) | **None** for production. Useful if the user wants to add sandbox-validated V1+V2 parity tests. | **OPTIONAL** — test-only. |
| **OpenCode plugin peer-dep bump to `>=1.18.29`** | `package.json:60, 71` | **None** for V1 — the fork M1 bundles `@opencode-ai/plugin` via `tsup.config.ts` `noExternal`, so the runtime contract is frozen. The peer is only checked at install time. | **NO** — the bump is required only for the V2 host. V1 hosts run the same `>=1.4.3` plugin fine. |
| **`setup` export alongside `server`** | `index.ts:137` | **None** for V1 hosts. V1 hosts call the function default (`server: Plugin`) and ignore `setup`. | **NO** — V2-only host needs this. |

**Top-line decision: do NOT adopt V2 in the V1 branch.** The fork's V1 path is correct and complete. The V2 work is a self-contained parallel surface that adds no V1 value.

**Recommended branch strategy:**

- Keep V1 work on `fork/dcp-3.1.15-m1` (current). Land items from `MY_UPSTREAM_V1_BACKPORT_PLAN.md` here.
- If/when V2 adoption is needed, create a fresh `fork/dcp-3.2.0-v2` branch and pull the V2 surface as a single big-bang commit. See §6 for the merge mechanics.

---

## §6. Full V2 migration (if/when the user opts in)

This section is the "big-bang" V2 adoption path. The user should only walk through it if there is a concrete V2-host use case (a target user on the new OpenCode V2 host, or a fork consumer that needs the V2 server adapter).

### §6.1 Prerequisites

- A new dedicated branch: `git -C "C:\Beheer\OpenCode\opencode_plugins\opencode-dynamic-context-pruning-fork-v2" checkout -b fork/dcp-3.2.0-v2` from the latest `fork/dcp-3.1.15-m1` HEAD.
- The OpenCode V2 host available for smoke testing (a V2-capable OpenCode build, not the 1.18.9 V1-only build the user currently runs).
- The V1 backport commits landed first (see `MY_UPSTREAM_V1_BACKPORT_PLAN.md`). Order matters: V1 fixes must be in `fork/dcp-3.1.15-m1` before V2 is added on top, otherwise the merge diff is entangled.

### §6.2 The merge mechanics

V2 is best adopted as a single "pull V2" commit that brings in the V2-only files and the `IdFormat` thread, applied on top of a `fork/dcp-3.1.15-m1` HEAD that already has the V1 backport. The shape of the commit is:

1. **Add new files (V2-only).** Cherry-pick or copy from upstream:
   - `lib/v2/{index,messages,rpc,theme,tui}.{ts,tsx}`
   - `scripts/sandbox.mjs` (optional — can be deferred)
   - `scripts/sandbox/{Dockerfile,auth.mjs,run.mjs}` (optional)
   - `server.js`
   - `tests/v2-{ids,messages,protection}.test.ts` (and `tests/{compaction-nudges,finalize-session}.test.ts`)

2. **Thread `IdFormat` through the 15 existing files.** This is the highest-volume change. Each touched function gains an optional `format: IdFormat = "xml"` parameter, and each call site either:
   - Stays unchanged (V1 default `"xml"`), OR
   - Threads `ctx.state.idFormat` (the runtime V2-aware path).

   The two patterns upstream uses:
   - **For format-aware helpers** (`formatMessageRef`, `formatBlockRef`, `formatMessageIdTag`, `replaceBlockIdsWithBlocked`, `stripHallucinationsFromString`, `stripHallucinations`, `parseMessageRef`, `parseBlockRef`, `parseBoundaryId`, `parseBlockPlaceholders`, `appendMissingBlockSummaries`): add a trailing `format: IdFormat = "xml"` parameter; the body branches on it. The XML branch is byte-identical to the v3.1.14 body.
   - **For call sites that consume the format** (`createCompressMessageTool`, `createCompressRangeTool`, `injectMessageIds`, `injectExtendedSubAgentResults`, `wrapCompressedSummary`, `PromptStore` ctor): pass `ctx.state.idFormat` (or the equivalent).

3. **Convert prompt exports from `const` to `function(format)`.** `lib/prompts/system.ts` `SYSTEM` → `systemPrompt(format)`, `lib/prompts/compress-message.ts` `COMPRESS_MESSAGE` → `messagePrompt(format)`, `lib/prompts/compress-range.ts` `COMPRESS_RANGE` → `rangePrompt(format)`. The default-`"xml"` call produces the same string as the v3.1.14 const. The two compress prompts (the ones the fork has custom-prompt text appended to) need careful review — see §6.5.

4. **Wire `setup` in `index.ts`.** Replace `export default server` with `export default { id: "opencode-dcp", setup, server }` where `setup` is imported from `lib/v2`. V1 hosts ignore the object shape and call `server`; V2 hosts call `setup` first.

5. **Bump the OpenCode plugin peer-dep to `>=1.18.29`.** This is a hard V2 host requirement. V1 hosts are unaffected because the fork bundles the plugin via `noExternal` in `tsup.config.ts`.

6. **Update `package.json`:**
   - Add `"workspaces": ["tests/logger"]` (only if adopting the logger workspace)
   - Update `scripts.test` to `node --import tsx --test tests/*.test.ts && npm test --workspace=tests/logger`
   - Update `scripts.typecheck` to `tsc --noEmit && npm run typecheck --workspace=tests/logger`
   - Add `"sandbox": "node scripts/sandbox.mjs"` to scripts
   - Add `"server.js"` to the `files` array
   - Add `@opentui/core` and `@opentui/solid` to `dependencies` (moved from `peerDependencies`; upstream v3.2.0 has them as runtime deps)

7. **Update `.github/workflows/pr-checks.yml` (if applicable) and `scripts/verify-package.mjs`** to include the new files. The fork is local-only and the user does NOT have a CI workflow in `.github/` (verify by listing; the fork's `MY_README.md` documents M6 as SKIPPED), so this is a no-op for the fork.

### §6.3 Per-file diff pointers

The exact upstream diffs are recoverable via:

```bash
git -C "C:\Beheer\OpenCode\opencode_plugins\opencode-dynamic-context-pruning" diff v3.1.14..v3.2.0 -- <file>
```

| File | Strategy |
|---|---|
| `lib/message-ids.ts` | Pull verbatim. The `IdFormat` thread is mechanical and the V1 default preserves behavior. |
| `lib/messages/utils.ts` | Pull verbatim. The 3 functions gain a `format` param; the XML branch is unchanged. |
| `lib/messages/inject/inject.ts` | Pull verbatim. `formatMessageIdTag` gets the format threaded in; default is XML. |
| `lib/messages/inject/subagent-results.ts` | Pull verbatim. The `["task", "subagent"]` check is a strict superset of the V1 `task` check. |
| `lib/protected-patterns.ts` | Pull verbatim. The fork's `isProtectedByFilePatterns` helper can be deleted (the upstream `isToolProtected` is a V1+V2 superset). |
| `lib/strategies/deduplication.ts`, `purge-errors.ts` | Pull verbatim. The 5-line `isToolProtected` consolidation is identical to the fork's manual `isToolNameProtected + isProtectedByFilePatterns` chain. |
| `lib/commands/sweep.ts` | Pull verbatim. Same consolidation story. |
| `lib/commands/decompress.ts`, `recompress.ts` | Pull verbatim. The `parseBlockRef(..., "compact")` fallback is additive. |
| `lib/prompts/system.ts`, `compress-message.ts`, `compress-range.ts` | **NEEDS FORK-SPECIFIC REVIEW** — see §6.5. |
| `lib/prompts/store.ts` | Pull verbatim. |
| `lib/prompts/extensions/tool.ts` | Pull verbatim (the `MESSAGE_FORMAT_EXTENSION` / `RANGE_FORMAT_EXTENSION` consts become `messageFormat` / `rangeFormat` functions). |
| `lib/compress/{message,range,range-utils,protected-content}.ts` | Pull verbatim. |
| `lib/compress/pipeline.ts` | **No change** upstream for V2. The fork's v2 protocol (`userForced` / `recoveryForced` / `effectiveManualMode`) is preserved. |
| `lib/hooks.ts` | **No change** upstream. The fork's `isInternalAgentSystem` is a strict superset and is preserved. |
| `index.ts` | Pull verbatim. `export default { id: "opencode-dcp", setup, server }` replaces `export default server`. |
| `lib/v2/*` | Add new files (5 files). Pull verbatim from upstream v3.2.0. |
| `server.js` | Add new file. Pull verbatim. |
| `package.json` | Pull the `dependencies` / `devDependencies` / `peerDependencies` / `workspaces` / `scripts` / `files` deltas. **Do not pull the `repository` / `bugs` / `homepage` deltas** — the fork's `package.json:50-55` has user-specific metadata. |
| `dcp.schema.json` | Pull the `allowTrailingCommas` delta (also in `MY_UPSTREAM_V1_BACKPORT_PLAN.md`). |
| `tests/*.test.ts` | Pull all new V2 tests + the V1 backport tests (5 new files: `compaction-nudges`, `finalize-session`, `v2-ids`, `v2-messages`, `v2-protection`). |
| `tests/lab/*` | Optional. The user can skip if they don't need the Python UI driver for sandbox testing. |
| `tests/logger/*` | Optional. The user can skip if they don't need the cross-version parity test infrastructure. |
| `scripts/sandbox*` | Optional. The user can skip if they don't need local dual-version testing. |
| `.github/workflows/{pr-checks,publish}.yml` | The fork has no `.github/` workflows (M6 SKIPPED per `MY_README.md`); skip. |
| `CONTRIBUTING.md`, `README.md` | **Do not pull verbatim** — the fork has its own `MY_README.md` with user-specific content. The upstream `README.md` and `CONTRIBUTING.md` have been substantially updated for V2 (V2 installation, sandbox instructions, contributor guidance) and a future agent should evaluate them case-by-case, not bulk-pull. |

### §6.4 New config keys / schema entries

The upstream `dcp.schema.json` diff between v3.1.14 and v3.2.0 is **one line** (the `allowTrailingCommas` flag). No new config keys, no new properties. The V2 work does not introduce new user-facing config; the V2 behavior is selected by the host (V1 vs V2 OpenCode build), not by a dcp.jsonc flag.

The V2 host passes the format via the V2 contract; the plugin reads `state.idFormat` from there. No user action required.

### §6.5 Fork-specific prompt review (the only manual-merge hot spot)

The fork has appended the following to `lib/prompts/compress-message.ts` and `lib/prompts/compress-range.ts` (per `MY_CHANGELOG.md`):

- `PROJECT CONTEXT PRESERVATION` (~95 words, 2026-08-06)
- `TASK STATE` (~70 words, 2026-08-06, refined same day)

These are appended to the **end** of the v3.1.14 prompt text. When the upstream refactor converts the prompts to `messagePrompt(format)` / `rangePrompt(format)` functions, the body becomes a template literal that branches on `format === "compact"`. The fork's append must move INSIDE the function body (so the V1-XML branch and the V2-compact branch both carry the PCP + TASK STATE additions).

**Pattern to apply** (illustrative for `lib/prompts/compress-message.ts`):

```ts
import type { IdFormat } from "../message-ids"

const PCP_BLOCK = `
PROJECT CONTEXT PRESERVATION
You have gathered project-context knowledge...
`

const TASK_STATE_BLOCK = `
TASK STATE
Capture structured meta-state alongside the content summary:
- Current task: 5-10 line description of scope, constraints, and current focus...
- Done: bullet list of completed subtasks...
- Remaining: bullet list of what still has to happen...
- Issues: bullet list of blockers or noteworthy events...
`

export function messagePrompt(format: IdFormat = "xml"): string {
    const compact = format === "compact"
    const message = compact ? "@4@" : "mNNNN"
    return `Collapse selected individual messages in the conversation into detailed summaries.

THE SUMMARY
... (full v3.2.0 prompt text) ...
${PCP_BLOCK}
${TASK_STATE_BLOCK}
`
}

export const COMPRESS_MESSAGE = messagePrompt()
```

The same pattern applies to `lib/prompts/compress-range.ts`. The BLOCK constants are file-local (not exported) so the V1 and V2 branches both pick them up automatically.

**No behavioral change for V1**: the v3.1.14 const + append equals the v3.2.0 function with `format = "xml"` and the same append.

### §6.6 The `compress.maxCompactionRatio` etc. interaction

The fork's v2 protocol (M2) added five config keys: `compress.maxCompactionRatio`, `compress.maxContextLimitRecovery`, `compress.recoveryFadeWindow`, `compress.forkSchemaVersion`, `compress.stateMaxAgeDays`. Upstream v3.2.0 did **not** touch any of these — the upstream `dcp.schema.json` diff is one line. The fork's v2 protocol is preserved as-is during the V2 adoption. The two layers are orthogonal.

### §6.7 Verification

```bash
cd "C:\Beheer\OpenCode\opencode_plugins\opencode-dynamic-context-pruning-fork-v2"

# 1. Typecheck — must remain clean. The IdFormat thread touches 15+ files;
#    any missed call site will surface here.
bun run typecheck

# 2. V1 regression test — all 195+ existing tests must pass.
bun run test -- tests/*.test.ts

# 3. V2-specific tests — the 5 new files (compaction-nudges, finalize-session,
#    v2-ids, v2-messages, v2-protection) must pass.
bun run test -- tests/v2-*.test.ts tests/compaction-nudges.test.ts tests/finalize-session.test.ts

# 4. Build — dist/ output must include both V1 and V2 entry points.
bun run build
ls -la dist/
# Expect: index.js (V1) + v2/ (V2) + server.js (V2 server shim)

# 5. Optional: V2 host smoke test. The user must have a V2-capable OpenCode
#    build (not the 1.18.9 V1 build they currently run). Once available:
#    1. Install the V2 build of OpenCode.
#    2. Update opencode.json to point at the new build.
#    3. Run a session that exercises both /dcp-compress and /dcp commands.
#    4. Inspect ${XDG_DATA_HOME}/opencode/storage/plugin/dcp/<sessionId>.json
#       and confirm state.idFormat is "compact" (proves the V2 path is active).
```

### §6.8 Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| A call site in the fork's M1–M2.5d code uses a format-aware helper but the upstream thread missed it | MEDIUM | The V1 default `"xml"` means a missed site silently produces XML output. The `state.idFormat` field is set by the V2 host; if it stays `"xml"`, the V2 host treats the session as V1. Run the full test suite (item 2) to catch any threading bug. |
| The fork's PCP / TASK STATE appends are lost during the prompt refactor | MEDIUM | §6.5 covers this. The appends must move INSIDE the function body, not stay as file-level appends. Manual review of `lib/prompts/compress-{message,range}.ts` is required. |
| The peer-dep bump to `>=1.18.29` breaks the user's V1 OpenCode 1.18.9 install | LOW | The fork bundles via `tsup.config.ts noExternal`, so the runtime contract is frozen. The peer is only checked by `npm install`. The user's V1 install runs regardless. |
| The V2 SDK type imports (`@opencode-ai/sdk/v2`) collide with the fork's existing V1 import in `lib/messages/utils.ts:6` | LOW | The fork already imports `UserMessage` from `@opencode-ai/sdk/v2` — that import was a forward-compat preparation. Pulling the V2 work is a strict superset. |
| `workspaces: ["tests/logger"]` breaks `bun install` if the user is using Bun | LOW | Bun 1.3.x supports npm workspaces as of 1.3.0. If the user is on an older Bun, they may need to upgrade. Confirm with `bun --version` before pulling. |
| The V2 sandbox (`scripts/sandbox.mjs`) requires Docker locally, which the user may not have | MEDIUM | The sandbox is dev-only and not in the `files` array. It is not part of the published plugin. Skip it (and the `tests/lab/` infrastructure) if Docker is not available. |

### §6.9 Backward compatibility

The V2 adoption is **strictly backward compatible** for V1 hosts. The V1 plugin entry point is preserved (the `server` key on the default export). V1 messages continue to use the XML format. The `IdFormat` thread's V1 default is `"xml"`. The user's V1 OpenCode 1.18.9 install sees no behavior change.

For V2 hosts, the plugin activates the V2 path via `state.idFormat = "compact"`, which is set by the V2 host during session hydration. The V2 path is opt-in by host, not by user.

---

## §7. Decision: skip V2 in the V1 branch

The V1 branch (`fork/dcp-3.1.15-m1`) should **not** adopt V2. The V2 work is:

- 838 LOC of production code in `lib/v2/` (relevant only to V2 hosts)
- 5,037 LOC total including test infrastructure and sandbox (most of it dev-only)
- 15+ files threaded with `IdFormat` (mechanical but voluminous)
- A peer-dep bump that has no V1 benefit

The V1-only user (the user the fork is built for) gains nothing from this work. The V2 path is a separate capability that should be adopted **only when the user has a concrete V2 host use case**. Until then, the V1 branch is shippable as-is, plus the V1 backport items from `MY_UPSTREAM_V1_BACKPORT_PLAN.md`.

When the V2 adoption does happen, it should be:

- On a fresh `fork/dcp-3.2.0-v2` branch (do not entangle with `fork/dcp-3.1.15-m1`)
- With V1 backport commits already in `fork/dcp-3.1.15-m1` (so the V2 branch can rebase cleanly)
- In a single "pull V2" commit, with §6.5 (the prompt-append review) as the only manual-merge hot spot

## §8. Open question for the user

Before any V2 work begins, the user should answer:

1. **Is there a target user on the V2 OpenCode host?** If yes, the V2 adoption is justified. If no, defer indefinitely.
2. **Is the V2 host's SDK stable enough to bind to?** The V2 contract is in active development at OpenCode (per upstream's rapid `v3.2.0-beta0`, `v3.2.1-beta0`, etc. releases post-v3.2.0). Adopting V2 now means accepting that the next upstream beta may shift the contract.
3. **Does the user want the dual-version sandbox for their own dev workflow?** If yes, include `scripts/sandbox*` and `tests/lab/`. If no, skip them — they are dev-only and add no production value.

If the answer to (1) is "no" and (2) is "no", the V2 plan stays on the shelf. The V1 backport plan is the next concrete step.

## §9. Effort estimate (if/when V2 is adopted)

- New files: 5 (`lib/v2/*`) + 1 (`server.js`) + optional 14 (`scripts/sandbox*`, `tests/lab/*`, `tests/logger/*`) = 6 to 20 files
- Modified files: ~15 (the `IdFormat` thread)
- Test additions: 5 new files (~30 test cases for V2)
- Manual review: 2 fork-specific prompt files (the PCP / TASK STATE appends)
- Build / test verification: ~1 hour
- V2 host smoke test: ~1 hour if a V2 host is available, otherwise deferred
- End-to-end: ~4-6 hours for a developer who already has the fork environment loaded, V2 host available, and Docker (for the sandbox) installed.
