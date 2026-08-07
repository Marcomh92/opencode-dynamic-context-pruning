# Known Issues Index

This directory tracks known bugs, limitations, and design trade-offs in the `@tarquinen/opencode-dcp` fork. Each entry is a single Markdown file with a stable `BUG-NNN` identifier.

> **Audit completed 2026-08-07.** All 84 reports have been reviewed by small architects (`08-architect-small`). Verdicts, severity adjustments, and merge recommendations have been applied to each file under "## Architect Review". See summary table below.

## Active Issues

| ID | Title | Severity | Status |
|---|---|---|---|
| BUG-001 | validateMonotonicEnd uses lexicographic localeCompare; `b10` < `b9` wrongly flagged | High | Open |
| BUG-002 | savecontext-rate-limit test fails due to ms-resolution filename collision | High | Open |
| BUG-003 | PR CI workflow omits `npm test` | High | Open |
| BUG-004 | **223** files failing `npm run format:check`, blocking all PR merges (was 140) | High | Open |
| BUG-005 | `npm run build` fails on Windows: `clean` script uses `rm -rf dist` | High | Open |
| BUG-006 | DPP-017 cache drift: `state.manualMode` written directly instead of via `effectiveManualMode(state)` | High | Open |
| BUG-007 | `saveManualModeSetting` writes `manualMode` but not `userForced`, leaving persisted JSON inconsistent | High | Open |
| BUG-008 | `isInternalAgentSystem` only in system-prompt handler, missing from message-transform handler | High | Open |
| BUG-009 | No try/catch around `deduplicate` / `purgeErrors` in compress pipeline; any throw aborts the whole compress | High | Open |
| BUG-010 | `compressionTiming.pendingByCallId` leaks entries forever when no matching block exists | High | Open |
| BUG-011 | `state.prune.tools` contains IDs for `question`/`edit`/`write` tools but `pruneToolOutputs` silently skips them | High | Open |
| BUG-012 | Validator says "will be clamped to 1" for 3 keys (not 4); `mergeCompress` / `mergeStrategies` never clamp | High | Open |
| BUG-013 | `config()` hook mutates user `compress.permission` to `"deny"` even when user explicitly allowed; contradicts DPP-010 | High | Open |
| BUG-014 | `autoUpdate` runtime default is `false`; README and JSON schema say `true`; no test pins the contract | **Low-Medium** | Open |
| BUG-015 | `buildSubAgentCacheKey` uses `::` separator vulnerable to collisions | **Low-Medium** | Open |
| BUG-016 | `findOpencodeDir` `while (current !== "/")` is POSIX-only and dead on Windows | High | Open |
| BUG-017 | Bundled nudge files pre-wrap in `<dcp-message-id>`; bundled system.ts does not | High | Open |
| BUG-018 | 5 slash-command handlers have no direct test coverage | High | Open |
| BUG-019 | `clampRatio` / `clampMin1` / `clampNullOrNonNeg` not unit-tested | High | Open |
| BUG-020 | INV-20 `parseBlockRef("b0")` returns null not asserted in any test | High | Open |
| BUG-021 | README.md still claims 10 default protected tools; v2 fork default is `[]` | **Low** | Open |
| BUG-022 | `lib/compress/timing.ts` exports 4 helpers with zero direct test coverage | High | Open |
| BUG-023 | Only 3 test files have PAT-012 audit-trail trailers; many contract-style tests lack them | **Low** | Open |
| BUG-024 | `handleManualToggleCommand` writes `state.manualMode` directly (not via `effectiveManualMode`); root cause of DPP-017 cache cluster | High | Open |
| BUG-025 | m-NNNN refs not reclaimed when blocks are deactivated | Medium | Open |
| BUG-026 | `INTERNAL_AGENT_SIGNATURES` substring-match list is brittle | Medium | Open |
| BUG-027 | `syncToolCache` emits one `logger.info` line per cached tool part; thousands of log writes per fire with debug enabled | Medium | Open |
| BUG-028 | 13-step transform pipeline has no outer try/catch; any thrown error breaks the LLM call mid-session | Medium | Open |
| BUG-029 | `applyPendingManualTrigger` overwrites wrong user message in narrow race window | Medium | Open |
| BUG-030 | `loadManualModeSetting` reads legacy `manualMode` field only, ignoring v2 `userForced` | Medium | Open |
| BUG-031 | `recoveryForced` and streak counters ARE persisted+restored, contradicting v1→v2 boundary | Medium | Open |
| BUG-032 | `handleManualToggleCommand` no-arg branch can clear a pending `manualMode === "compress-pending"` | Medium | Open |
| BUG-033 | `modelMaxLimits` / `modelMinLimits` merge is replace-semantics; project layer adding one model wipes globals | Medium | Open |
| BUG-034 | `saveManualModeSetting` coerces `manualMode` via `!!` to `boolean`; `saveSessionState` uses `=== "active"` | Medium | Open |
| BUG-035 | System-prompt handler bypasses host permission check on first injection of a session (narrower gap than reported) | **Low** | Open |
| BUG-036 | `Logger.getCallerFile` allocates a fresh `Error` stack on every log call | Medium | Open |
| BUG-037 | `isSubAgentSession` SDK call has no timeout/AbortSignal | Medium | Open |
| BUG-038 | `lib/ui/utils.ts` uses `as any` in production code (cast unnecessary; SDK field is declared) | **Low** | Open |
| BUG-039 | INV-10 `wrapCompressedSummary` ↔ `restoreSummary` round-trip not tested; **also hides live production bug** (`restoreSummary` regex leaves opening `<dcp-message-id>` tag) | **High priority (escalated)** | Open |
| BUG-040 | INV-5/6/7/8 covered indirectly but no test references `INV-N` identifiers | **Low** | Open |
| BUG-041 | Multiple source files have no direct test coverage (priority table had 2 false rows) | **Low** | Open |
| BUG-042 | Format drift blocks all PRs until reformatted; needs a meta-PR (companion to BUG-004) | Medium | Open |
| BUG-043 | `stripStaleMetadata` may drop caller metadata on cross-model switches | **Low** | Open |
| BUG-044 | `saveContext` still writes per-fire when debug enabled (test mis-named; tests change-detection not rate-limit) | Low-Medium | Open |
| BUG-045 | Strategies in compress pipeline use possibly stale `state.toolIdList` | Low-Medium | Open |
| BUG-046 | `Logger.lastMinimizedHashBySession` Map grows unbounded across sessions | Low | Open |
| BUG-047 | Sweep command ignores `turnProtection.turns` that `syncToolCache` honors | Low | Open |
| BUG-048 | `buildToolIdList` returns raw IDs without honoring protected tools (consumers re-filter) | Low | Open |
| BUG-049 | `isIgnoredUserMessage` casts `(part as any).ignored` (cast unnecessary) | Low | Open |
| BUG-050 | Multiple writers set `state.manualMode` without `effectiveManualMode`; should consolidate | Low | Open |
| BUG-051 | `state.prune.tools` token count may be stale (value is vestigial; no consumers) | **Nitpick** | Open |
| BUG-052 | `showUpdateToasts` in `VALID_CONFIG_KEYS` but unimplemented (companion to BUG-014) | Low | Open |
| BUG-053 | `loadManualModeSetting`/`saveManualModeSetting` pay schema-gate cost despite passing `null` (user-driven path, not hot) | **Nitpick** | Open |
| BUG-054 | `loadSessionState` runs even for skipped subagent sessions | Low | Open |
| BUG-055 | `docs/CONFIGURATION.md` says "up to three sources" but lists four layers | Low | Open |
| BUG-056 | `docs/CONFIGURATION.md` references `state.maxAgeDays`; actual key is `compress.stateMaxAgeDays` | Low | Open |
| BUG-057 | `STORAGE_DIR` module-level constant is dead code | Low | Open |
| BUG-058 | `findOpencodeDir` POSIX-only check in `lib/config.ts` (companion to BUG-016) | Low | Open |
| BUG-059 | `resetOnCompaction` doesn't clear `pendingManualTrigger` | Low | Open |
| BUG-060 | `compressionTiming.startsByCallId` Map grows on orphaned pending tool calls (report's analysis inaccurate; `running` early-returns before delete) | Low | Open |
| BUG-061 | `applyPendingManualTrigger` runs after `injectMessageIds`, leaving trigger prompt without m-NNNN | Low | Open |
| BUG-062 | `docs/TESTING.md` layout table incomplete vs actual test directory (32 files, not 33) | Low | Open |
| BUG-063 | `tiktoken` listed as a direct dep but unused in source; defensive intent not in PER-002 doc | Low | Open |
| BUG-064 | `logger.info("DCP transform fire")` fires per transform when debug enabled | Nitpick | Open |
| BUG-065 | Synthetic summary dropped with warn when no preceding user message (deactivate block, not fall forward) | Nitpick | Open |
| BUG-066 | `__DCP_MANUAL_TRIGGER_BLOCKED__` throw is unreachable (change return type to `string`) | Nitpick | Open |
| BUG-067 | `BLOCK_PLACEHOLDER_REGEX` matches `(b0)`; INV-20 forbids `b0` | Nitpick | Open |
| BUG-068 | `createDefaultConfig()` writes `dcp.jsonc` to disk unprompted on first run | Nitpick | Open |
| BUG-069 | `Logger.lastMinimizedHashBySession` only clearable via test hook (companion to BUG-046) | Nitpick | Open |
| BUG-070 | `configureClientAuth` reaches into undocumented `client._client` / `client.client` | Nitpick | Open |
| BUG-071 | `startAutoUpdate` swallows network failures silently | Nitpick | Open |
| BUG-072 | `stripPromptComments` doesn't normalize trailing whitespace | Nitpick | Open |
| BUG-073 | 12 `as any` casts in production code (count correct; line citations wrong; missed 4 sites in `lib/config.ts:1085-1096`) | Suggestion | Open |
| BUG-074 | `Message ID alias capacity exceeded` is uncaught throw mid-session (**escalated to Medium**; same cluster as BUG-025/028) | **Medium** | Open |
| BUG-075 | `__DCP_MONOTONIC_VIOLATION__` hint lists all valid IDs, not strictly-greater | Suggestion | Open |
| BUG-076 | Adopt collision-proof length-prefixed separator for `buildSubAgentCacheKey` (upgrade path for BUG-015) | Suggestion | Open |
| BUG-077 | Hash bundled-prompt values for drift detection (drift IS detectable today; log line, not hash) | Suggestion | Open |
| BUG-078 | Add per-session dedup window for identical notifications | Suggestion | Open |
| BUG-079 | Resolve override candidates through `realpathSync` to prevent symlink escape | Suggestion | Open |
| BUG-080 | Cache sidecar JSON in TUI between modal opens (5s TTL) | Suggestion | Open |
| BUG-081 | Document case-sensitivity policy for protected patterns | Suggestion | Open |
| BUG-082 | Add runtime assertion that `INTERNAL_PROMPT_EXTENSIONS` keys disjoint from `PROMPT_KEYS` | Suggestion | Open |
| BUG-083 | Log a warning when `MESSAGE_REF_MAX_INDEX` is approached (one-shot flag) | Suggestion | Open |
| BUG-084 | Validate `protectedTools` entries at config load with regex (`/^\S+$/`, not the report's tighter charset) | Suggestion | Open |

## Severity Legend

- **High:** Compile failure, data loss, or invariant broken.
- **Medium:** Functional gap or test that does not verify the contract.
- **Low-Medium:** Validation bypass or quality regression.
- **Low:** Documentation drift, ergonomics, or DX issue.
- **Nitpick:** Minor; would fix if touching the code anyway.
- **Suggestion:** Future improvement, not a current bug.

## Architect-Verified Severity Adjustments

| Bug | Original | Adjusted | Reason |
|---|---|---|---|
| BUG-014 | High | Low-Medium | Drift is intentional; runtime is correct; `docs/CONFIGURATION.md:41` already documents it |
| BUG-015 | High | Low-Medium | Latent collision only; OpenCode sessionIds/callIDs don't contain `::` in practice |
| BUG-021 | High | Low | Runtime is correct; docs-only drift |
| BUG-023 | High | Low | Doc drift (PAT-012 over-promises trailer coverage) |
| BUG-035 | Medium | Low | Headline scenario is already handled; only narrow agent-scoped gap remains |
| BUG-038 | Low-Medium | Low | No runtime impact; field is SDK-declared |
| BUG-040 | Medium | Low | Comment-only audit hygiene |
| BUG-041 | Medium | Low | After correcting two false rows in priority table |
| BUG-051 | Low | Nitpick | Value is vestigial; no readers exist |
| BUG-053 | Low | Nitpick | User-driven path, not on hot transform path |
| BUG-074 | Suggestion | Medium | Uncaught throw breaks LLM call mid-session; same cluster as BUG-025/028 |
| BUG-039 | Medium | (unchanged) | Round-trip gap; architect hand-traced regex asymmetry: **live production bug** |

## Verified Merge Recommendations

The following reports describe the same root cause or surface. Fix once, mark the rest as duplicate:

| Cluster | Bugs | Common fix |
|---|---|---|
| **Prettier drift** | BUG-004, BUG-042 | Add `.prettierignore` first, then `npx prettier --write .` as one PR |
| **Subagent cache key separator** | BUG-015, BUG-076 | Same fix at `lib/subagents/cache-key.ts:6-8` |
| **`findOpencodeDir` POSIX-only** | BUG-016, BUG-058 | `while (current !== "/")` → `while (true)` in both copies |
| **Manual-mode cache drift** | BUG-006, BUG-024, BUG-050 | Route all writers through `effectiveManualMode(state)` |
| **Manual-mode persistence cluster** | BUG-030, BUG-032, BUG-034 | Pick one persistence shape and use it consistently |
| **Transform pipeline fragility** | BUG-025, BUG-028, BUG-074 | Outer try/catch + sentinel return on capacity |
| **`as any` audit surface** | BUG-038, BUG-049, BUG-073 | Single audit pass; drop casts at `query.ts:53` and `ui/utils.ts:221` |
| **Logger static maps unbounded** | BUG-046, BUG-069 | Same shape; bounded-eviction helper or ponytail ceiling |
| **DPP-012 enforcement gap** | BUG-019, BUG-012 | Close BUG-019 with tests; audit merge sites for BUG-012 |
| **PAT-012 / INV coverage** | BUG-023, BUG-040 | Comment-only; pick one fix (narrow PAT-012 OR expand trailers) |
| **Config-drift cluster** | BUG-014, BUG-052 | Schema/README correction + one shared `tests/config-defaults.test.ts` |

## Closed Issues

| ID | Title | Severity | Status | Date fixed |
|---|---|---|---|---|

_Move files to `fixed/` and add a row here when resolved._

## Won't Fix

| ID | Title | Severity | Status | Date closed |
|---|---|---|---|---|

_Move files to `wont_fix/` and add a row when a limitation is accepted._

---

## How to Use This Directory

1. **Before starting work:** Check if the issue is already documented.
2. **When fixing:** Move the report to `fixed/` and add resolution details; append a row to **Closed Issues** with the date.
3. **When accepting a limitation:** Move the report to `wont_fix/` and add a row to **Won't Fix** with a one-line reason.
4. **When discovering:** Create a new bug report following the template below.

## File Naming

`BUG-NNN-short-kebab-title.md` at the repo root, where `NNN` is the next integer. Move verbatim into `fixed/` or `wont_fix/` when closing.

## Bug Report Template

Each report file should be self-contained and reference source paths, not code snippets. Include:

- **Summary:** One or two lines.
- **Location:** `path/to/file.ts` and line numbers.
- **Current vs Expected Behavior:** What the code does vs what the invariant says.
- **Impact:** Severity, runtime/compile effects, which invariant is affected.
- **Reproduction:** Test name or manual steps; prefer a failing test.
- **Suggested Fix:** Where the change should land.
- **Status:** `Open`, `Fixed <date>`, or `WONTFIX — <reason>`.

Cross-reference identifiers from `docs/DESIGN_PRINCIPLES.md` (`DPP-XXX`), `docs/PATTERNS.md` (`PAT-XXX`), `docs/features/COMPRESSION.md` (`INV-1..20`), and `docs/features/PRUNING.md` (`INV-P1..13`) when the bug violates a documented rule.
