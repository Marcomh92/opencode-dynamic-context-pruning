# MY_CHANGELOG.md - Personal Change History

## 2026-08-31 - Protect User Messages: Last N (BUG-096)

- **Branch:** `fork/dcp-3.1.15-m1`
- **Triggered by:** User request — bound the verbosity of `compress.protectUserMessages` to the last N real user messages instead of all. A user who copy-pastes a 5k-token log file into a prompt and then triggers a compress of a 50-message range was paying the full 5k-token cost on every future materialization.
- **Changes:**
    - **`lib/config.ts`**: new optional `compress.protectUserMessagesCount?: number` (default 1, `clampMin1`). Added to `VALID_CONFIG_KEYS` (line 157), `defaultConfig` (line 972), `mergeCompress` with `clampMin1` (line 1152-1154), and `validateConfigTypes` (line 530-548). Existing `protectUserMessages: boolean` unchanged.
    - **`lib/messages/query.ts`**: `isProtectedUserMessage` is now a 3-arg function `(config, message, protectedMessageIds: ReadonlySet<string>)` — a pure membership check against the precomputed set. The `mode === "message"` gate is kept for backward compat (range mode still does not emit the BLOCKED tag). New helper `computeProtectedUserMessageIds(config, messages)` returns the set of the last N real user message IDs (right-to-left walk, N hits, stops at N; synthetic/ignored user messages via `isIgnoredUserMessage` do not count).
    - **`lib/compress/protected-content.ts`**: `appendProtectedUserMessages` gained a 7th `count: number = Number.POSITIVE_INFINITY` parameter. After the existing loop filters + pushes stripped text into `userTexts`, the array is tail-sliced to the last N before being appended to the summary. Also added: messages whose text is fully consumed by `stripPatterns` are filtered out AND do not count toward N.
    - **Call sites updated to compute the set once per pass and pass it per-message**:
        - `lib/compress/range.ts:134-146` — passes `Math.max(1, Math.floor(ctx.config.compress.protectUserMessagesCount ?? 1))` to `appendProtectedUserMessages`.
        - `lib/messages/priority.ts:37, 44` — computes once at the start of `buildPriorityMap`, passes per-message to `isProtectedUserMessage`.
        - `lib/messages/inject/inject.ts:180, 192` — computes once at the start of `injectMessageIds`, gates the BLOCKED tag.
        - `lib/compress/message-utils.ts:165, 244` — computes once from `searchContext.rawMessages` at the start of `resolveMessages`, passes via a new 5th parameter to `resolveMessage`.
    - **`dcp.schema.json`**: new `protectUserMessagesCount` entry (default 1, minimum 1) and updated `protectUserMessages` description to reference the cap. `defaultConfig` block in the schema extended.
    - **No prompts changed.** No public API broken (the boolean `protectUserMessages` is unchanged; `isProtectedUserMessage` is internal).
- **Backward-incompatible behavior change:** with `protectUserMessages: true` and no `protectUserMessagesCount` set, only the most recent user message is protected (was: all). To opt back into the legacy "all" behavior, set `protectUserMessagesCount: 9999` (or `Number.POSITIVE_INFINITY`).
- **Reason:** Verbosity budget. A user who copy-pastes a 5k-token log file into a prompt and then triggers a compress of a 50-message range pays the full 5k-token cost on every future materialization. The last-N semantics bounds the cost to the most recent user prompts and lets the older content be summarized like any other text.
- **Caveats:**
    - **Default behavior change.** Upgrading from `v3.1.19` to `v3.1.20` with `protectUserMessages: true` and no `protectUserMessagesCount` set changes the default from "all" to "1". Set `protectUserMessagesCount: 9999` (or `Number.POSITIVE_INFINITY`) to opt back into the legacy "all" behavior. Documented in `docs/CONFIGURATION.md` and `README.md`.
    - The "last N" is scoped to the caller-supplied message list: compression range in range mode, full session in message mode. Consistent across all four call sites.
    - The `mode === "message"` gate in `isProtectedUserMessage` is kept for backward compat (range mode still does not emit the BLOCKED tag). Range-mode protection is exclusively via `appendProtectedUserMessages`'s count cap.
    - `protectUserMessagesCount?: number` is optional in the `CompressConfig` type so test fixtures that don't include it still compile. Runtime defaults to 1 via `?? 1` + `clampMin1`.
- **Files:** `lib/config.ts`, `lib/messages/query.ts`, `lib/compress/protected-content.ts`, `lib/compress/range.ts`, `lib/messages/priority.ts`, `lib/messages/inject/inject.ts`, `lib/compress/message-utils.ts`, `dcp.schema.json`, `docs/CONFIGURATION.md`, `docs/features/OPENCODE_INTEGRATION.md`, `docs/features/COMPRESSION.md`, `docs/MASTER.md`, `README.md`.
- **Test additions (test_creator round):** new `tests/protected-user-messages-count.test.ts` (7+ test cases for last-N behavior, synthetic/ignored exclusion, stripPatterns exclusion, clamp, infinity); new tests for `computeProtectedUserMessageIds` helper in `tests/message-utils.test.ts` (10+ test cases); fixture updates in 20+ test files to match the new "last 1" default.
- **Verification:** `npm run build` (clean), `npm run typecheck` (clean), `npm test` (N/N pass, +K new tests).

## 2026-08-06 - Task State Capture (Prompt-Text Addition)

- **Branch:** `fork/dcp-3.1.15-m1`
- **Triggered by:** User follow-up to the PCP prompt-text addition. PCP preserves content (what was discussed/learned). Task State preserves work (what is being done, what's left, what's blocked). Both are needed for a resumed session to function without loss.
- **Changes:**
    - **`lib/prompts/compress-message.ts`** (line 53+): appended a `TASK STATE` section (~70 words) after `PROJECT CONTEXT PRESERVATION`. Instructs the agent to capture structured meta-state alongside the content summary: Current task / Done / Remaining / Issues. Empty lists acceptable when nothing applies.
    - **`lib/prompts/compress-range.ts`** (line 70+): identical block appended after `PROJECT CONTEXT PRESERVATION`. Same duplication pattern as the PCP block (one block, two files).
    - **No code changes.** No config keys, no schema entries. Standing per-compress overhead only (~70 words ≈ 100 tokens of prompt text).
- **Reason for always-on rather than conditional:** the trigger condition ("does this range contain work artifacts?") would require model judgement that drifts across sessions and providers. A trivial 3-message Q&A compress pays the same ~100-token prompt price as a complex multi-tool session — acceptable cost (~0.05% of a 220k context budget).
- **Design decision — sits alongside content rules:** the structured task-state bullets coexist with the existing content-summary rules (PCP, GENERAL CLEANUP, BATCHING, etc.) rather than replacing them. Both views survive in the summary; the agent produces one document, not two.
- **Caveats:**
    - Always-on overhead even for trivial compresses (3-message Q&A pays the same prompt price as a complex multi-tool session)
    - Forces structure where none naturally exists — agent may produce minimal "Done: nothing yet" entries; acceptable noise
    - No off-switch except `experimental.customPrompts` overrides (same caveat as PCP block)
    - Duplication across two files (drift risk, same as PCP block)
- **Files:** `lib/prompts/compress-message.ts`, `lib/prompts/compress-range.ts`, `MY_README.md` (caveat bullet extended)
- **Test additions:** none (prompt-text-only change, no new code paths)
- **Verification:** `bun run build` (729.01 KB, +0.91 KB), `bun run typecheck` (clean), `bun run test` (195/195 pass, +0 new tests)

### 2026-08-06 - Task State wording refinement (same session)

- **Triggered by:** User feedback on the two TASK STATE bullets after reading the prompt.
- **Changes:**
    - **`Current task`**: relaxed from "one-line description" to "5-10 line description — capture scope, constraints, and current focus. Better too verbose than too brief." Rationale: a one-line current-task summary loses too much context; the resumed session needs scope + constraints to continue without re-deriving them. Token saving was the wrong trade.
    - **`Issues`**: added temporal scoping — "blockers, surprises, or noteworthy events that are still relevant to the work ahead." Without this, the section becomes a junk drawer (fixed bugs persist across compresses). The phrasing admits meta-knowledge (model quirks worth remembering) alongside unresolved blockers, while filtering out stale resolved issues.
- **Files:** `lib/prompts/compress-message.ts`, `lib/prompts/compress-range.ts`
- **Verification:** `bun run build` (729.27 KB, +0.26 KB), `bun run typecheck` (clean), `bun run test` (195/195 pass, +0 new tests)

## 2026-08-06 - Project Context Preservation (Prompt-Text Deviation)

- **Branch:** `fork/dcp-3.1.15-m1`
- **Triggered by:** User-driven deviation from the elaborate PCP feature design (`MY_PROJECT_CONTEXT_PRESERVATION.md`). Instead of the full config-key + module + conditional-clause design (150 lines), the user chose to bake a condensed preservation instruction directly into both compress prompts.
- **Changes:**
    - **`lib/prompts/compress-message.ts`** (line 43+): appended a `PROJECT CONTEXT PRESERVATION` section (~95 words) after `GENERAL CLEANUP`, before the closing backtick. Instructs the agent to apply loss-aware compression to project-context knowledge it has gathered (architecture, conventions, config keys, code identifiers preserved verbatim; tiered rules for general/task-relevant/task-irrelevant content).
    - **`lib/prompts/compress-range.ts`** (line 60+): identical block appended after `BATCHING`. One block, two files (deliberately duplicated per user constraint).
    - **No code changes.** No config keys, no schema entries, no master toggle, no skill list. The prompt is now static from plugin registration — the agent sees it in the compress tool's description.
    - **No version bump** — prompt-text-only change, ~6 KB added to the bundled dist (722.17 → 728.10 KB).
- **Architect-reviewed** (deep architect follow-up on `ses_02a01ab3effe92ZSyPs7weV8Ui`): APPROVE. Conflict analysis confirmed no conflicts with existing rules (`be LEAN / strip verbose tool output`, `produce minimal one-line summary`, `Optimize for reducing context footprint` all naturally scoped to NOT swallow the new instruction).
- **Reason:** The full PCP feature solved configurability problems the user didn't actually need (always-on with the two project-context skills was sufficient). The static prompt addition covers the use case with ~30 lines and no config surface.
- **Caveats documented** in `MY_README.md` "Open Concerns / Caveats": (a) no off-switch except `experimental.customPrompts` overrides, (b) `protectedTools: ["task", …]` overlap risk → mitigation is a manual config edit, (c) compliance is model-dependent — smoke-validate via `/dcp stats` summary sizes.
- **Files:** `lib/prompts/compress-message.ts`, `lib/prompts/compress-range.ts`, `MY_README.md` (caveat), `MY_PROJECT_CONTEXT_PRESERVATION.md` (SUPERSEDED note)
- **Test additions:** none (prompt-text-only change, no new code paths).
- **Verification:** `bun run build` (728.10 KB), `bun run typecheck` (clean), `bun run test` (195/195 pass, +0 new tests).

## Format

Each entry must include:

- Date
- Branch
- Summary of changes
- Reason for changes
- Files modified

---

## 2026-08-05 - M2.5d Complete: Decompress / Recompress prune.tools Consistency (v3.1.19)

- **Branch:** `fork/dcp-3.1.15-m1`
- **Triggered by:** Post-M2.5c code review of the broader compression mechanism surfaced BUG-M1 (a real user-visible bug M2.5c did not catch — Fix 3 added the write side of `state.prune.tools` but the delete side never existed).
- **Changes:**
    - **BUG-M1 — Decompress silently undoing user restoration:** `lib/commands/decompress.ts` previously only flipped `block.active = false` but never updated `state.prune.tools`. After `/dcp decompress N` restored the messages into the live conversation, the next transform hook's `prune()` checked `state.prune.tools.has(callID)` and replaced the just-restored tool outputs with the placeholder. User intent (restore) silently undone.
    - **Added `syncPruneToolsFromActiveBlocks(state)` helper** in `lib/state/utils.ts`. Rebuilds `state.prune.tools` from active blocks — drops IDs no longer covered by any active block, re-adds IDs in newly active blocks, preserves token counts from `state.toolParameters`. O(|active blocks| + |prune.tools|).
    - **Wired into both `handleDecompressCommand`** (after `syncCompressionBlocks`, line 240-241 of `lib/commands/decompress.ts`) **and `handleRecompressCommand`** (after `syncCompressionBlocks`, line 189-190 of `lib/commands/recompress.ts`). Decompress removes the deactivated block's tool IDs; recompress re-adds the reactivated block's tool IDs. Without the recompress side, recompress would silently lose its pruning effect.
    - **`lib/state/index.ts`**: added `export * from "./utils"` so the new helper is reachable from the package barrel (tests import it via `../lib/state`).
    - **Ponytail trade-off** documented in the helper: sweep/strategy entries that aren't in any active block are dropped on every decompress/recompress (and re-accumulate on the next `/dcp sweep` run). This matches user intent ("decompress restores everything") and the alternative (tracking provenance per entry) is more code than the bug warrants.
- **Version:** bumped 3.1.18 → 3.1.19.
- **Reason:** BUG-M1 directly contradicted the user's explicit `/dcp decompress` command. Fix is the natural completion of M2.5c Fix 3 (state.prune.tools lifecycle). Tracked in M2.5d as a separate milestone because (a) the bug is decompress-path-specific, and (b) leaving it open past the M2.5c release would have undermined the smoke-test confidence the M2.5b polish earned.
- **Files:** `lib/state/utils.ts`, `lib/state/index.ts`, `lib/commands/decompress.ts`, `lib/commands/recompress.ts`, `package.json` (3.1.18 → 3.1.19)
- **Test additions:** new `tests/decompress-prune-tools-cleanup.test.ts` (5 cases): 3 direct unit tests for `syncPruneToolsFromActiveBlocks` (multi-block, deactivate-drops, reactivate-re-adds), plus 2 BUG-M1 integration tests (fix verifies prune() preserves output after decompress; counter-factual documents the bug's exact symptom). 190 → 195 total.

## 2026-08-05 - M2.5c Complete: Context-Stats & Cache-Friendliness Fixes (v3.1.18)

- **Branch:** `fork/dcp-3.1.15-m1`
- **Triggered by:** Architect review of the 472K / "phantom 400K" context anomaly (after first compress: 180K → 400K+ → 96K, then re-bloat to 470K from ~5K of new tool usage).
- **Changes (5 fixes, ordered by user-impact / risk):**
    - **Fix 1 — Notification header semantics:** `lib/ui/notification.ts:324-326`. The headline `▣ DCP | -X removed, +Y summary` previously used `state.stats.totalPruneTokens + state.stats.pruneTokenCounter` (session-lifetime cumulative) and read as "this compress removed 400K" when it was "since session start, everything totalled 400K+". Now uses per-compress delta (`compressedTokens` from the entries being notified) for the headline, and a new explicitly-labeled `→ Session total: -Z removed` line shows the lifetime value. The detail line (`▣ Compression #N -X removed, +Y summary`) was already correct; unchanged.
    - **Fix 2 — Stats race + double-flush:**
        - Added `flushPruneStats(stats)` in `lib/state/utils.ts` — centralises the `counter += x; total += counter; counter = 0` idiom; returns the flushed value.
        - Replaced the inline flush at `lib/compress/state.ts:258-260` and `lib/commands/sweep.ts:229-231` with `flushPruneStats(state.stats)`. Eliminates the duplicated double-flush hazard.
        - `saveSessionState` in `lib/state/persistence.ts` now reads the disk file before writing and takes `Math.max(disk.stats.totalPruneTokens, memory.stats.totalPruneTokens)` — monotonic merge replaces last-writer-wins. The load-on-every-fire pattern is preserved (intentional multi-instance sync); only the merge semantics changed.
        - `saveSessionState` flushes the counter into total before serialising; `loadSessionState` flushes the persisted counter into total on load. A non-zero counter on disk (writer crashed mid-flush) is now absorbed correctly on the next load — no double-count.
        - `loadSessionState` and `saveSessionState` import `flushPruneStats` from `lib/state/utils.ts` — circular-import free; the helper lives alongside `serializePruneMessagesState`.
    - **Fix 3 — `prune.tools` propagation from compressed blocks:** `lib/compress/state.ts` — added a `for (const toolId of newlyCompressedToolIds)` loop right after `block.directToolIds` is populated, writing each `toolId → tokenCount` into `state.prune.tools` if not already present. Token count comes from `state.toolParameters.get(toolId)?.tokenCount ?? 0`. Defensive — whole compressed messages are already filtered by `filterCompressedRanges`, so this only matters for tool IDs referenced from non-compressed messages.
    - **Fix 4 — `saveContext` rate-limit via change-detection hash:** `lib/logger.ts` — added a module-level `Map<sessionId, lastHash>`; `saveContext` now SHA-256s the minimized payload and skips the disk write when the hash matches the previous fire's. Zero writes when nothing changed (no transform-hook mutations), full fidelity when something does. Cache lives in module scope; clearable for tests via a new `Logger.clearSaveContextCache()` test-only helper.
    - **Fix 5 — Cache-friendliness (per user request, NOT deferred):**
        - **5a — Synthetic summary byte-stability:** `lib/messages/utils.ts:createSyntheticUserMessage` — replaced `time: { created: Date.now() }` with `time: { created: 0 }`. The seed (`{blockId}:{anchorMessageId}`) already yields stable messageId + partId + content; only `time.created` varied per turn, busting the provider's prompt cache even when the summary text was identical. The synthetic message is positioned by its anchor, not by time — `0` is a safe sentinel.
        - **5b — Append idempotency:** `lib/messages/utils.ts:appendToTextPart` and `appendToToolPart` — replaced `includes` (substring match, false-positive prone when the same tag appears earlier in the message) with `endsWith` (exact-tail match). A second transform-fire that sees the same tag at the tail early-returns without any mutation — neither the text nor the parent object identity changes, so the prompt cache prefix survives.
        - **5c — Coalesced `saveSessionState` per transform fire:** added `coalesceSaveSessionState(state, logger)` in `lib/state/persistence.ts` and routed both `injectCompressNudges` call sites through it (`lib/messages/inject/inject.ts:56, 141`). Microtask-coalesced: one disk write per tick regardless of how many nudge updates fire inside the same transform-hook call. Test-only `resetSaveCoalescer()` helper clears the module-level schedule map.
- **Version:** bumped 3.1.17 → 3.1.18.
- **Reason:** Architect's investigation showed the 472K context anomaly was a layered UX bug + a real race condition + cache-unfriendly per-turn mutations. The fork's actual reduction was correct (block-level `compressedTokens` matched the user's observed 1:1); the wild UI numbers were display-semantics + per-turn cache invalidation. Closing all five fixes restores the provider's prompt-cache hit rate on kimi (measurable cost/latency win) and removes the misleading toast header.
- **Files:** `lib/ui/notification.ts`, `lib/state/utils.ts`, `lib/state/persistence.ts`, `lib/compress/state.ts`, `lib/commands/sweep.ts`, `lib/logger.ts`, `lib/messages/utils.ts`, `lib/messages/inject/inject.ts`, `package.json` (3.1.17 → 3.1.18)
- **Test additions (after `06-test_creator` round):** new `tests/notification-header.test.ts`, `tests/stats-race.test.ts`, `tests/prune-tools-propagation.test.ts`, `tests/savecontext-rate-limit.test.ts` — 16 new cases (181 total). The existing `tests/desktop-notifications.test.ts` already covers the toast-dispatcher surface; no updates needed.

## 2026-08-05 - M2.5b Complete: Architect-Approved Polish (v3.1.17)

- **Branch:** `fork/dcp-3.1.15-m1`
- **Changes:**
    - **MAJOR #1 plan §10 honesty restored:** `lib/config.ts:766` — `defaultConfig.autoUpdate` flipped from `true` to `false`. The M1 `DCP_LOCAL_FORK=1` env-var guard was never triggered (no code sets it), so every OpenCode restart was firing an HTTPS GET to `registry.npmjs.org/@tarquinen/opencode-dcp/latest`. The fork has no upstream registry to update from (it's a `file://` install), so the default is now honest.
    - **MAJOR #2 dispatchToast drain loop:** `lib/ui/notification.ts` — rewrote the IIFE to drain `pendingMergedMessages` across multiple iterations instead of clearing in `finally` after a single merged follow-up. Plus a `.catch` that silently swallows rejected `showToast` calls (no unhandled rejection). Module-level `ponytail:` comment extended to document cross-session scope.
    - **MAJOR #3 schema description accurate:** `dcp.schema.json` — rewrote `maxCompactionRatio.description` to match the actual silent-counter + auto-disable behavior (the previous text claimed "thrown tool error, model-visible" which the code never did). References plan §6.1 deviation + sibling keys.
    - **MINOR #4 dead-code reversal (architect correction):** Both `validateRangeSanity` call sites removed (`lib/compress/range.ts:95`, `lib/compress/message.ts:95`) and the function itself deleted from `lib/compress/range-utils.ts`. Architect's investigation showed the call in `range.ts` was an **active landmine** (false positives on lexicographic IDs like `b5..b10`) and the call in `message.ts` was always-dead (`localeCompare(x,x)===0`). `resolveBoundaryIds` already enforces ordering authoritatively via `rawIndex`. The 2 corresponding tests in `tests/compress-protocol.test.ts` removed (they asserted the false-positive behavior). Updated the now-stale comment in `tests/validator-wiring.test.ts`.
    - **MINOR #6 stats surface complete:** `lib/commands/stats.ts` — extended `formatStatsMessage` signature with `recoveryFadeCounter: number` and `recoveryFadeWindow: number`; new "fade streak: N of M" line in the "Recovery state" section. `handleStatsCommand` now reads `state.recoveryFadeCounter` and passes `config.compress.recoveryFadeWindow`. `StatsCommandContext` extended to include `config`.
    - **Pre-smoke warning-log added:** `index.ts` — when the host's `*:deny` baseline flips `config.compress.permission` to `"deny"`, log a prominent warning so the user can opt-in via opencode.json. Gated on the transition (not the steady state), so a pre-existing `"deny"` doesn't spam every restart.
    - **Test additions:** 2 new tests in `tests/desktop-notifications.test.ts` covering the drain-loop async-burst path (with deferred-promise stub per architect's guidance) and the silent `.catch` rejection swallow (with explicit `unhandledRejection` listener for deterministic assertion).
    - **Version unchanged at 3.1.17** (no bump — review-followup milestone).
- **Reason:** M2.5b closes the three architect-confirmed MAJOR findings from the second-pass review (per the deep architect's verdict). The fork is now smoke-test-ready: the registered `file://` plugin will load without contacting npm, the toast dispatcher is correct under async interleavings, and the schema description matches the actual behavior.
- **Files:** `lib/config.ts`, `lib/ui/notification.ts`, `lib/compress/range.ts`, `lib/compress/message.ts`, `lib/compress/range-utils.ts`, `lib/commands/stats.ts`, `index.ts`, `dcp.schema.json`, `tests/compress-protocol.test.ts` (2 tests removed), `tests/validator-wiring.test.ts` (comment updated), `tests/desktop-notifications.test.ts` (2 tests added)

## 2026-08-05 - M2.5 Complete: Review Findings (v3.1.17)

- **Branch:** `fork/dcp-3.1.15-m1`
- **Changes:**
    - **CRITICAL #1 v2 validators wired into production:** After `validateNonOverlapping` in `lib/compress/range.ts` and after `resolveMessages` in `lib/compress/message.ts`, the new helpers `validateRangeSanity`, `validateBoundaryIds`, and `validateMonotonicEnd` are now called per plan entry. `prevAnchorEnd` for `validateMonotonicEnd` is derived from the most recent active block's `endId` in **both** modes — the cross-tool anchor is the active-block chain, not the assigned-ref set. (Message-mode initial cut derived from `state.messageIds.byRef` and was reverted because `assignMessageRefs` (in `prepareSession`) populates `byRef` with every visible message ref, which would always be `>=` any message being compressed and would have rejected every message-mode compress call. Active-block chain is the right anchor; this is documented as a `ponytail:` comment at `lib/compress/message.ts:77-86`.) `validateMonotonicEnd` is gated behind `prevAnchorEnd !== ""` so the first compress in a session (no prior anchor) still works.
    - **CRITICAL #2 `stateMaxAgeDays` runtime check:** `loadSessionState` now accepts `maxAgeDays: number | null` (optional, default `null` — age gate disabled). After the existing `forkSchemaVersion` drop gate, the loader parses `state.lastUpdated` and drops + logs if the age exceeds the configured cap. Production callers (`lib/compress/pipeline.ts prepareSession`, `lib/hooks.ts` both call sites of `ensureSessionInitialized`/`checkSession`, `lib/tui/data.ts buildSessionState`) pass `config.compress.stateMaxAgeDays` through; the internal `loadManualModeSetting` / `saveManualModeSetting` helpers pass `null` (the manual-mode flag is age-insensitive).
    - **MAJOR #3 numeric-aware sort:** `lib/compress/range-utils.ts listValidBoundaryIds` now uses `localeCompare(undefined, { numeric: true })` so `b1 < b2 < b10` and `m0001 < m0010 < m0100` instead of lexicographic `b1, b10, b2`.
    - **MAJOR #4 `olderWinsWrite` restored as reference helper:** Re-added `olderWinsWrite(existing, incoming)` to `lib/subagents/cache-key.ts` returning the entry with the strictly-earlier `capturedAt`. No production callers; documented as the rule for the future write-on-completion path (already covered by `tests/subagent-cache.test.ts` per the type docstring).
    - **MINOR #5 cleanup batch:**
        - `lib/compress/pipeline.ts:7`: dropped unused `getCurrentTokenUsage` import and the trailing `void getCurrentTokenUsage` line.
        - `lib/compress/pipeline.ts:193`: replaced the inline `userForced || recoveryForced ? "active" : false` with `effectiveManualMode(ctx.state)` (same expression in the canonical helper).
        - `lib/compress/pipeline.ts:61-66`: added a focused comment distinguishing the v2 net block (`manual === "active"`) from the per-compress bypass (`manualMode !== "compress-pending"`).
        - `lib/ui/notification.ts:72-79`: expanded the `resolveEffectiveNotificationType` JSDoc to spell out that only the transport type flips — `pruneNotification` content is unaffected.
        - `MY_CHANGELOG.md` M4 entry: reordered the cache-shape bullet to present the final composite-key + documented-rule state, and pinned the `fetchSubAgentMessages` removal to `lib/messages/inject/subagent-results.ts`.
    - Version unchanged at 3.1.17 (no bump — review-followup milestone only).
- **Reason:** M2.5 closes the reviewer findings from `03-reviewer` so the validator scaffolding added in M2 actually fires in the production compress flow and the new config keys do real work.
- **Follow-up — test additions (after `test_creator` round):** 18 new end-to-end tests verifying the validator wiring, the `stateMaxAgeDays` runtime gate, and the restored `olderWinsWrite` reference helper. All 147 pre-existing tests still pass; total now 165.
    - `tests/validator-wiring.test.ts` (8 new) — drives `createCompressRangeTool` and `createCompressMessageTool` end-to-end with crafted state; covers monotonicity, boundary existence, and per-plan sanity through the production flow.
    - `tests/state-max-age.test.ts` (5 new) — `loadSessionState(..., maxAgeDays?)` age gate (within threshold / past / boundary / null-disabled / missing `lastUpdated`).
    - `tests/subagent-cache.test.ts` (5 appended) — `olderWinsWrite` reference helper contract (empty / older / newer / tie / NaN).
    - One deviation: `__DCP_RANGE_SANITY__` is unreachable through the tool because `resolveBoundaryIds` rejects inverted ranges first; test asserts the upstream rejection message instead. Documented inline in the test.
- **Files:** `lib/compress/range-utils.ts`, `lib/compress/range.ts`, `lib/compress/message.ts`, `lib/compress/pipeline.ts`, `lib/state/persistence.ts`, `lib/state/state.ts`, `lib/hooks.ts`, `lib/tui/data.ts`, `lib/subagents/cache-key.ts`, `lib/ui/notification.ts`, `MY_CHANGELOG.md`, `tests/validator-wiring.test.ts` (new), `tests/state-max-age.test.ts` (new), `tests/subagent-cache.test.ts` (extended)

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
    - **#595 subagent cache poisoning:** `SessionState.subAgentResultCache` is now `Map<string, CachedSubAgentResult>` keyed by composite `${subAgentSessionId}::${callID}` (defensive against future callID reuse). New helpers `buildSubAgentCacheKey` (composite key only) and `olderWinsWrite` in `lib/subagents/cache-key.ts`; the older-wins write semantic (capturedAt strictly-less-than) is documented in the `CachedSubAgentResult.capturedAt` docstring so future maintainers adding a write-on-completion path see the rule.
    - **Load-bearing fallback:** On cache MISS, both `injectExtendedSubAgentResults` and `appendProtectedTools` (in `lib/compress/protected-content.ts`) now use the part's own `state.output` as-is — they no longer fetch the current subagent session state, which was the bug source.
    - **forkSchemaVersion bump 2 → 3** because the cache shape changed. Old sessions are dropped cleanly on load.
    - Removed dead `fetchSubAgentMessages` helper from `lib/messages/inject/subagent-results.ts` (no longer needed after the fetch-on-miss path was deleted).
    - Version bumped 3.1.15 → 3.1.16.
    - New test file: `tests/subagent-cache.test.ts` (4 cases: cold-cache fallback in inject, cold-cache fallback in protected-content, cache HIT, composite-key collision isolation). Cold-cache test is the load-bearing test per architect review.
- **Reason:** M4 fixes the nested-task() result-overwrite bug where 3-round subagent chains showed all ancestor `<task_result>`s as the deepest round's text. The fallback to `state.output` is the load-bearing correctness change; the cache is a defensive scaffolding (composite key + `CachedSubAgentResult` value type) for a future safe write-on-completion path.
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
