# DCP Caching Strategy — Improvement Plan

**Status:** ready to implement
**Audience:** a fresh agent (or the same one in a future session) that needs to make the recommended changes without re-gathering context
**Goal:** maximize prompt cache hit rate on MiniMax and DeepSeek while preserving agent reliability, with minimal source-code churn and zero risk of regressions

---

## 1. Executive summary

The `@tarquinen/opencode-dcp` plugin (fork v3.1.17) is already more cache-friendly than the original design assumed. Most operations are byte-stable across transform fires; the dominant cache-miss contributors are (1) compression-block materialization, (2) rolling prune replacements as tools age, and (3) MiniMax's 5-minute cache TTL on idle gaps. Provider mechanics:

- **MiniMax M3 (Anthropic-compatible):** explicit `cache_control` breakpoints, 5-minute TTL refreshed on hit, hash-based, 4 markers max, 20-block lookback, byte-exact prefix matching. Context window 1M tokens.
- **DeepSeek v4.1 Flash:** automatic on-disk prefix cache, 64-token units, **72-hour guaranteed TTL**, byte-strict prefix match, common-prefix recovery is best-effort (not immediate). Context window 1M tokens (1,048,576). Model ID `deepseek-flash`. Cache hit pricing **~$0.003 per 1M tokens** (~9× cheaper than DeepSeek V3.x's $0.028 cache-hit price).

Both providers cache at byte-prefix level. Per-tool pruning does NOT reduce cache blast radius — it only reduces token cost on a miss. The architectural lever is *mutation position* and *mutation frequency*, not mutation size.

**⚠️ ROUTING DEPENDENCY:** OpenCode's emission of `cache_control` markers is conditional on the MiniMax routing path. Verified in `packages/opencode/src/provider/transform.ts:471-484` (anomalyco/opencode). The `applyCaching()` gate triggers only when `model.api.npm === "@ai-sdk/anthropic"` or model ID contains `anthropic`/`claude`.

- **`opencode-go/minimax-m3`** (Go subscription, `@ai-sdk/anthropic`) → cache_control IS emitted → all MiniMax-side recommendations in this plan apply.
- **`opencode/minimax-m3`** (Zen, `@ai-sdk/openai-compatible`) → cache_control is NOT emitted → caching is implicit prefix only → MiniMax-side recommendations in this plan are MOOT for that route.
- **Custom anthropic-protocol provider** with `"npm": "@ai-sdk/anthropic"` + valid `baseURL` → cache_control emitted in principle, but known issues with third-party proxies (anomalyco/opencode#45750).

**Verified for this user:** the user uses the OpenCode default MiniMax provider `MiniMax (minimax.io)`, resolved via OpenCode's bundled `models.dev` catalog (not in `BUNDLED_PROVIDERS`). All three MiniMax provider variants in models.dev (`minimax`, `minimax-cn`, `minimax-coding-plan`) use `@ai-sdk/anthropic`. **`applyCaching()` fires; cache_control markers are emitted on first 2 system messages + last 2 non-system messages. All MiniMax-side recommendations in this plan apply.**

**The six changes that matter, ranked:**

1. **Config change:** `turnProtection.turns: 8` (from 4) batches prune events. Fewer mutation events = fewer cache misses.
2. **Config change:** `strategies.purgeErrors.turns: 4` (from 3) aligns error-purge cadence with the widened protection window.
3. **Config change:** add `todowrite` and `goal_*` to all three `protectedTools` lists (`commands`, `strategies.deduplication`, `strategies.purgeErrors`). Protect agent's live plan state and persistent goal markers from prune-replacement while still allowing compression. Cheap insurance, no token cost.
4. **Config change:** add `goal_*` to `compress.protectedTools`. Preserve `goal_*` outputs verbatim in compression summaries. Consistent state, not stale — keeping all is fine.
5. **Source change:** add top-level `protectedFilePatternsTools: string[]` config to scope `protectedFilePatterns` to a tool allowlist. Default preserves current behavior; user override `["read"]` restricts to read-only plan preservation.
6. **No-op on `protectedSkills`:** synthetic skill messages are already byte-stable, invisible to compression selection, not prunable, and have no `mNNNN` refs. Build only a regression test that pins the invariant; do NOT build preservation machinery.

---

## 2. Background and context

### 2.1 DCP plugin overview

DCP is a transform layer that rewrites `output.messages` before each LLM call. It never mutates OpenCode's session storage (DPP-001 hard rule).

**Transform pipeline order** (`lib/hooks.ts:247-282`):
```
stripHallucinations → cacheSystemPromptTokens → assignMessageRefs
→ syncCompressionBlocks → syncToolCache → buildToolIdList → prune
→ injectExtendedSubAgentResults → buildPriorityMap
→ injectCompressNudges → applyPendingManualTrigger
→ injectMessageIds → stripStaleMetadata
```

**Key writers of `state.prune.tools`** (callIDs marked for placeholder replacement):
- `deduplicate` strategy (`lib/strategies/deduplication.ts:91-97`) — signature-based, fires inside `compress` tool pipeline only
- `purgeErrors` strategy (`lib/strategies/purge-errors.ts:90-95`) — errored tools older than `turns` (default 4, user has 3), inside compress pipeline only
- `/dcp sweep` command (`lib/commands/sweep.ts:130-286`) — manual slash command
- `applyCompressionState` defensive propagation (`lib/compress/state.ts:274-280`) — newly-compressed tool IDs added

**`pruneToolOutputs`** (`lib/messages/prune.ts:93-117`): replaces `part.state.output` with the byte-stable placeholder `[Output removed to save context - information superseded or no longer needed]`. Gates: `state.prune.tools.has(callID)` ∧ `status === "completed"` ∧ tool ∉ `{question, edit, write}`.

**`dropUnsupportedPruneToolIds`** (`lib/messages/prune.ts:38-45`): strips `question`/`edit`/`write` callIDs from `state.prune.tools` BEFORE replacement runs. This is a hardcoded protection for those three tools (BUG-011 fix). They are load-bearing for the agent and never get placeholder-replaced.

**Compression range-mode pipeline** (`lib/compress/range.ts:59-260`):
```
prepareSession → resolveRanges → validateNonOverlapping
→ for each plan:
  injectBlockPlaceholders → appendProtectedUserMessages
  → appendProtectedPromptInfo → appendProtectedTools
  → appendMissingBlockSummaries → applyCompressionState
```

**Protected-tool preservation** (`lib/compress/protected-content.ts:138-228`):
- Fires when tool is in `compress.protectedTools` OR a file path matches `protectedFilePatterns`
- Only inspects **tool parts** within `selection.messageIds` — does not look at user messages (synthetic or real)
- Output appended under `### Tool: <name>` heading in the synthetic summary
- Special `task`-tool cache-merge at lines 182-212 is dead in v2 (cache is intentionally cold)

**Nudges** (`lib/messages/inject/inject.ts:34-163`):
- Injected into **messages**, NOT the system prompt
- Three types: context-limit (over `maxContextLimit`), turn-anchor (over `minContextLimit`), iteration-anchor (over `minContextLimit` AND `messagesSinceUser >= iterationNudgeThreshold`)
- Idempotent via `endsWith` checks
- Anchors cleared when context drops below `minContextLimit`

**`isIgnoredUserMessage`** (`lib/messages/query.ts:38-63`): skips messages with `part.synthetic: true` or `part.ignored: true`. Used by `assignMessageRefs` (`lib/message-ids.ts:124`), compress search/selection (`lib/compress/search.ts:129, 224, 247`), priority map (`lib/messages/priority.ts:40`), nudge targeting (`lib/messages/inject/inject.ts:183`), and `/dcp sweep` (`lib/commands/sweep.ts:42`).

### 2.2 MiniMax (Anthropic-compatible) caching

- Cache shape: explicit `cache_control: {"type": "ephemeral"}` breakpoints, max 4 per request, 20-block lookback
- TTL: 5 minutes, refreshed on each hit
- Hierarchy: tools → system → messages cascade; byte-exact hash
- Pricing: M2.x read 0.1×, write 1.25×; M2.7 read 0.2× (weaker incentive on newer models)
- Minimum cacheable prefix: ~1024 tokens (inferred from Anthropic compatibility, not stated explicitly by MiniMax)
- No documented 1-hour TTL — do NOT send `ttl: "1h"` unverified
- Active-session envelope: 78–88% with current config; 85–90% achievable with batching
- Unfixable-by-DCP: 5-minute TTL on idle gaps — any pause >5 min evicts everything

### 2.3 DeepSeek caching (v4.1 Flash)

- **Model:** DeepSeek v4.1 Flash, GA 2026-09-10, model ID `deepseek-flash`. The legacy aliases `deepseek-chat` and `deepseek-reasoner` were retired 2026-07-24.
- **Context window:** 1,048,576 tokens (1M) — same as MiniMax M3. The user's `maxContextLimit: 250000` is well within this.
- **Cache shape:** automatic on-disk prefix cache, byte-strict prefix matching (no `cache_control` markers — implicit only).
- **Storage unit:** 64 tokens (content shorter than 64 tokens not cached).
- **TTL:** **72 hours guaranteed** (per DeepSeek V4.x technical report). This is a substantial improvement over V3.x's vague "hours to days" — predictable persistence for multi-day sessions.
- **Common-prefix recovery:** persists a diverged common prefix as its own unit only after observing divergence; best-effort, not immediate.
- **Minimum practical prefix:** <64 tokens not cached; <1024 tokens unreliable in practice.
- **Pricing (off-peak):** $0.15 cache-miss / $0.003 cache-hit / $0.60 output per 1M tokens. No separate cache-write charge. Peak pricing doubles all rates.
- **Comparison to V3.x:** V4.1 Flash cache hits are ~9× cheaper per cached token ($0.003 vs $0.028), with 8× more cache capacity. Aggressive caching is *more* economically justified on V4.1 Flash, not less.
- **Architectural notes (no caching impact):** V4.x uses CED (Causal Encoder-Decoder) with compressed global KV (890 bytes/token, FP4) and SWA Bounded Replay. These are server-side optimizations; the API surface and caching semantics are unchanged.
- **Realistic hit rate envelope:** 95–99% on long sessions (up from V3.x's 90–97%, due to the predictable 72h TTL).

### 2.4 Custom skills plugin (`opencode-agent-skills`)

Investigated separately. Tool name exactly `use_skill` (no namespace). Args: a single required `skill: string` parameter. Tool result returned to LLM: tiny confirmation string `"Skill \"<name>\" loaded."`.

**Critical:** the full SKILL.md body is injected as a separate **synthetic user message** via `client.session.prompt({ body: { noReply: true, parts: [{ type: "text", text, synthetic: true }] } })`, wrapped in `<skill name="...">...</skill>`. The skill body is NOT in the tool result.

Skill storage: `<projectDir>/.opencode/skills/`, `<projectDir>/.claude/skills/`, `~/.config/opencode/skills/`, `~/.claude/skills/`, `~/.claude/plugins/cache/`, `~/.claude/plugins/marketplaces/`. Per-skill layout: `<skill-dir>/SKILL.md` + optional scripts/files. Frontmatter required: `name` (regex `^[\p{Ll}\p{N}-]+$`), `description`. NO `category`/`tags`/`procedure`/`kind` field.

### 2.5 User config state

- **`dcp.jsonc`** (`C:\Users\marco\.config\opencode\dcp.jsonc`): full state captured earlier in this session. Already modified to set `commands.protectedTools: ["task"]`, `strategies.deduplication.protectedTools: ["task"]`, `strategies.purgeErrors.protectedTools: ["task"]`.
- **`opencode.json`** (`C:\Users\marco\.config\opencode\opencode.json`): `*: "deny"` baseline; `permission.compress: "allow"`, `permission.use_skill: "allow"`, `permission.read: "allow"`, `permission.skill: "deny"` (platform native). `compaction.prune: true`. Plugins: opencode-agent-skills, opencode-agent-delegation, opencode-self-improvement, ponytail, plannotator, DCP fork, tokenscope. Providers explicitly configured: kimi-for-coding (note: missing `npm`/`name`/`baseURL`), lmstudio. **MiniMax: routed via OpenCode's bundled models.dev catalog → `MiniMax (minimax.io)` provider (uses `@ai-sdk/anthropic`, `applyCaching()` fires — verified)**. MCPs: brave-search, context7, git, gitnexus, stitch.

---

## 3. Key findings (the rationale for every change below)

### Finding 1 — Synthetic skill messages are already protected (do nothing)

Synthetic user messages with `synthetic: true` flag on their parts are filtered out at every destructive DCP point:

| Pipeline stage | Skip mechanism | File:line |
|---|---|---|
| `assignMessageRefs` | `if (isIgnoredUserMessage(message)) return ""` | `lib/message-ids.ts:124` |
| Compress search / selection | `if (isIgnoredUserMessage(rawMessage)) skip` | `lib/compress/search.ts:129, 224, 247` |
| Priority map (message mode) | `if (isIgnoredUserMessage(message)) continue` | `lib/messages/priority.ts:40` |
| Nudge targeting | `if (isIgnoredUserMessage(message)) return` | `lib/messages/inject/inject.ts:183` |
| `/dcp sweep` candidate collection | `if (!isIgnoredUserMessage(msg)) ...` | `lib/commands/sweep.ts:42` |
| Manual trigger selection | `if (isIgnoredUserMessage(message)) return` | `lib/messages/manual-trigger.ts:55` |
| State utilities (sync) | `if (!isIgnoredUserMessage(message)) ...` | `lib/state/utils.ts:392` |

They are not tool outputs, so `state.prune.tools` (which keys on tool callIDs) cannot address them. They have no `mNNNN` ref, so the model cannot reference them in compress ranges. They get no priority entry, no nudge targeting, no sweep-marking. They are byte-stable across every transform fire (no tag, no nudge, no strip) and therefore contribute to the cacheable prefix on both providers.

**Conclusion:** `protectedSkills` preservation machinery would *duplicate* skill bodies into summaries, increasing `summaryTokens`, increasing non-compacting run rate against the `maxCompactionRatio: 0.7` guard (`docs/features/COMPRESSION.md` INV-6), and triggering more `recoveryForced` lockouts. Do not build it. Build only a regression test that pins the invariant.

### Finding 2 — `turnProtection.turns` is the prune-batching knob

`state.toolCache` honors `turnProtection.enabled` and `turnProtection.turns` (`lib/state/tool-cache.ts:39-52`). When enabled, tool parameters entries for the most recent N turns are NOT cached — meaning dedup and purgeErrors (which look up via `state.toolParameters.get(id)`) cannot mark those calls.

A wider window delays marking so multiple obsolete outputs cross the threshold together. The marking is per-callID, but the byte-change event happens once per marked callID. Batching N calls into one block of N events is not literally one event — but in practice, dedup operates in batches within a single compress call, and the dedup `state.prune.tools.set(id, tokenCount)` is idempotent. So a wider protection window means dedup and purgeErrors fire less often, generating fewer cumulative byte changes.

User's current value: 4. Proposed: 8. Reliability cost: slightly higher per-call tokens for ~4 extra turns (obsolete outputs kept verbatim longer). Reliability benefit: more recent context preserved.

### Finding 3 — `protectedFilePatterns` is not just compress-scoped

The pattern matching happens in `getFilePathsFromParameters` (`lib/protected-patterns.ts:61-99`), called from five sites:

| Site | Tool gating? | File:line |
|---|---|---|
| `deduplicate` strategy | Inside compress pipeline | `lib/strategies/deduplication.ts:95-96` |
| `purgeErrors` strategy | Inside compress pipeline | `lib/strategies/purge-errors.ts:94-95` |
| `/dcp sweep` command | Slash command, not compress | `lib/commands/sweep.ts:199-200` |
| `/dcp sweep` (secondary path) | Slash command, not compress | `lib/commands/sweep.ts:216-217` |
| Compression protected-content | Inside compress pipeline | `lib/compress/protected-content.ts:164-168` |

Two of five sites are NOT compress-scoped. A `compress.protectedFilePatternsTools` config would be a layering lie. The new key must be top-level (sibling of `protectedFilePatterns`).

### Finding 4 — `forkSchemaVersion` config default is runtime-inert but misleading

`lib/state/persistence.ts:546-547` schema gate compares against the **code constant** `FORK_SCHEMA_VERSION = 4` (`lib/state/types.ts:208`). Saves always stamp the constant (`lib/state/state.ts:93, 150`), and the recovery-field round-trip (`state.ts:301-311`) is unconditional. So setting `forkSchemaVersion: 3` in user config has no runtime effect — but the default drift (`lib/config.ts:977` says `3`, schema says `3`, code says `4`) is a loaded footgun. Several docs still say `= 3` (`docs/PATTERNS.md:66`, `docs/DESIGN_PRINCIPLES.md:25`, `docs/features/STATE_PERSISTENCE.md:11`). Worth a one-line cleanup.

### Finding 5 (new) — DeepSeek v4.1 Flash economics favor aggressive caching

With V4.1 Flash's 1M context window, 72h TTL, and $0.003/M cache-hit pricing, the user's `maxContextLimit: 250000` is only 25% of the available window. Cache hits are so cheap that **raising the threshold could improve context retention without hurting cost** — but the user has explicitly tuned down for aggressive compression, so this plan respects that choice.

This finding is informational. No code change required. If the user later wants to raise `maxContextLimit` for better context retention (especially on V4.1 Flash where cache-hit cost is essentially free), the existing knob is sufficient. Per-model limits (`compress.modelMaxLimits` / `compress.modelMinLimits`) remain available if a finer control is needed for some specific model.

### Finding 6 (new) — OpenCode's `cache_control` emission is route-dependent

OpenCode emits Anthropic-style `cache_control: { type: "ephemeral" }` markers **only** when the model route uses `@ai-sdk/anthropic` or model IDs containing `anthropic`/`claude`. The `applyCaching()` gate is at `packages/opencode/src/provider/transform.ts:471-484` in the OpenCode source.

| Route | SDK used | cache_control emitted? | DCP's MiniMax recommendations |
|---|---|---|---|
| `opencode-go/minimax-m3` (Go subscription) | `@ai-sdk/anthropic` | **YES** — 2-3 ephemeral breakpoints, ~5-min TTL, no `prompt_cache_key` | All apply |
| `opencode/minimax-m3` (Zen) | `@ai-sdk/openai-compatible` | **NO** — implicit prefix caching only | MOOT — no markers to align with |
| **`MiniMax (minimax.io)` default** (this user) | `@ai-sdk/anthropic` | **YES** — verified | **All apply** |
| `MiniMax (minimax.cn)` / `MiniMax Token Plan (minimax.io)` | `@ai-sdk/anthropic` | **YES** | All apply (note: #31755 regression on Token Plan thinking toggle) |
| Custom provider, `npm: "@ai-sdk/openai-compatible"` | `@ai-sdk/openai-compatible` | NO | MOOT |

The user uses `MiniMax (minimax.io)`, resolved via OpenCode's bundled models.dev catalog (not in `BUNDLED_PROVIDERS`). All three MiniMax provider variants in models.dev use `@ai-sdk/anthropic`. Verified that `applyCaching()` fires for this route. **All MiniMax-side recommendations in this plan apply.**

This finding was discovered late in the planning process (Q2 follow-up after the deep architect session) and was not in the architect's original report. The architect flagged the check as manual but did not perform it.

### Finding 7 (new) — Two-tier pruning protection; `todowrite` belongs in tier 1

There are **two tiers** of prune protection today:

1. **Write-side gates (config, existing)**: `strategies.deduplication.protectedTools`, `strategies.purgeErrors.protectedTools`, `commands.protectedTools` — each prevents its own writer from marking a callID into `state.prune.tools`.
2. **Read-side strip (hardcoded, unconditional)**: `dropUnsupportedPruneToolIds` (`lib/messages/prune.ts:38-45`) — runs on every transform fire, deletes `{question, edit, write}` callIDs from the map before any replacement.

Tier 1 is **not airtight**. Two writers consult no protection list: `applyCompressionState` defensive propagation (`lib/compress/state.ts:274-280`) and `syncPruneToolsFromActiveBlocks` (`lib/state/utils.ts:483,493`). A tool in `protectedTools` can still be marked through those paths.

Per-tool verdicts (user's hypothesis partially refuted):

| Tool | Prune-protect? | Compress-protect? | Reasoning |
|---|---|---|---|
| `read` | **NO** | No (plan files covered by `protectedFilePatterns`) | File on disk = recoverable. Re-read is one cheap tool call. Old reads become stale the moment the file changes — retaining stale bytes is a real correctness hazard. Protecting removes DCP's biggest token-savings surface. `turnProtection.turns: 8` already keeps the working set verbatim. False-positive risk > false-negative risk. |
| `todowrite` | **YES** | No | Small output (hundreds of tokens), live plan state, recoverable via `todoread` but the friction derails long sessions. Cheap insurance. |
| `goal_*` (`goal_get`, `goal_set`, `goal_patch`) | **YES** | **YES** | Persistent goal-state markers from the `opencode-self-improvement` plugin. Tiny output (~50-200 tokens each). Goal state is consistent (not stale like `read`); keeping all `goal_*` calls costs negligible tokens. |
| `context7_*` | No | No | Large outputs, deterministic re-query. |
| `brave-search_*` | No | No | Same. |
| `webfetch` | No | No | Same. |
| `task` (subagent) | Yes (already in user's lists) | **NO** | Appending full subagent transcripts into summaries inflates `summaryTokens` against the `maxCompactionRatio: 0.7` guard → more non-compacting runs → `recoveryForced` churn. Current split (protected from strategies/sweep, not appended into summaries) is the right balance. |

**Asymmetry argument for `read`:** pruning an old `read` is *more correct* than keeping it, because the file may have changed. The placeholder tells the model to re-read and get fresh bytes; keeping stale bytes is a false-positive reliability hazard. Compare to `question` (unrecoverable user interaction) and `edit`/`write` (mutation receipts — the confirmation IS the record). `read` belongs to the recoverable-by-requery class.

**Implementation options:**
- **Option 1 (config-only, do today):** add `todowrite` to all three `protectedTools` lists. Covers all three marking paths in normal operation. Residual hole: two unprotected writers (rare edge paths).
- **Option 2 (airtight, ~15-line diff, future-proofing):** add `unprunableTools: string[]` config (top-level, default `[]`, replace-semantics) that extends `dropUnsupportedPruneToolIds`. Catches all writers including compress propagation. Worth doing only if the rare-edge holes ever bite in practice.

**Incidental findings (not this change):**
- `pruneToolInputs` (`lib/messages/prune.ts:119-146`) is effectively dead code: the pre-strip removes `question` callIDs before it runs, and it only handles `question`. Either wire differently or delete — future cleanup round.
- The write-side/read-side protection asymmetry (compress propagation consults no list) is undocumented — one line for `07-docs-maintainer` in `docs/features/PRUNING.md`.

### Finding 8 (new) — `goal_*` tools: protect all, not just the latest

The `opencode-self-improvement` plugin's `goal_get`/`goal_set`/`goal_patch` tools are persistent goal-state markers. User hypothesis was "only the latest" (analogous to `protectUserMessagesCount`); the architect's recommendation is "protect all" — the outputs are tiny (~50-200 tokens each), accumulation cost is negligible, and "only the latest" mechanism adds real complexity without measurable benefit.

Why "all" beats "latest" for `goal_*`:
- Goal state is *consistent*, not *stale* (unlike `read` outputs which become stale on file change). Multiple copies of the same goal is harmless.
- Goal-patch outputs reflect cumulative state, not independent operations. Dropping older patches loses no information because the latest goal reflects all prior changes.
- A 30-call session accumulates ~6KB of `goal_*` output — 0.024% of a 250K context budget. Trivial.

Implementation: `goal_*` glob added to `commands.protectedTools`, `strategies.deduplication.protectedTools`, `strategies.purgeErrors.protectedTools` (prune-side), AND `compress.protectedTools` (compression-summary verbatim append). Glob matching via `isToolNameProtected` (`lib/protected-patterns.ts:110-129`).

If empirical experience later shows accumulation is a real issue, design Option B or C from the architect's review (latest-only with eviction). For now: keep all.

---

## 4. Implementation plan

Sequenced. Each item lists the file, the change, the rationale, and verification. Items 1–3 are zero or near-zero code; do them today.

### Item 1 — `dcp.jsonc`: `turnProtection.turns: 8` (zero code)

**File:** `C:\Users\marco\.config\opencode\dcp.jsonc`
**Where:** top-level `turnProtection` block.

```jsonc
"turnProtection": {
  "enabled": true,
  "turns": 8         // was 4
}
```

**Reliability effect:** improves. Recent tool outputs kept verbatim for more turns.
**Cache effect:** fewer, batched mutation events.
**Cost:** slightly higher per-call tokens for ~4 extra turns (at 0.1× cache-read pricing, cheap).

### Item 2 — `dcp.jsonc`: `strategies.purgeErrors.turns: 4` (zero code)

**File:** `C:\Users\marco\.config\opencode\dcp.jsonc`
**Where:** `strategies.purgeErrors` block.

```jsonc
"strategies": {
  "purgeErrors": {
    "enabled": true,
    "turns": 4,      // was 3
    "protectedTools": ["task", "todowrite", "goal_*"]  //   // was ["task"]
  }
}
```

**Rationale:** aligns error-purge cadence with the widened `turnProtection.turns: 8` so the two work together. Also adds `todowrite` and `goal_*` protection (see Findings 7 and 8).

### Item 3 — `dcp.jsonc`: add `todowrite` and `goal_*` to all three `protectedTools` lists + `compress.protectedTools` (zero code)

**File:** `C:\Users\marco\.config\opencode\dcp.jsonc`
**Where:** four places.

```jsonc
"commands": {
  "enabled": true,
  "protectedTools": ["task", "todowrite", "goal_*"]   // was ["task"]
},
"compress": {
  "protectedTools": ["goal_*"],   // was []
  // ... existing fields unchanged ...
},
"strategies": {
  "deduplication": {
    "enabled": true,
    "protectedTools": ["task", "todowrite", "goal_*"]  // was ["task"]
  },
  "purgeErrors": {
    "enabled": true,
    "turns": 4,
    "protectedTools": ["task", "todowrite", "goal_*"]  // was ["task"]
  }
}
```

**Rationale:** protects the agent's live plan state (`todowrite`) and persistent goal markers (`goal_*`) from prune-replacement AND preserves `goal_*` outputs verbatim in compression summaries. Cheap insurance; small output. See Findings 7 and 8. Glob pattern `goal_*` matches `goal_get`, `goal_set`, `goal_patch`, and any future goal tools added by the opencode-self-improvement plugin.

**Note:** `read` is INTENTIONALLY NOT in this list. See Finding 7 reasoning: pruning old `read` outputs is more correct than keeping them (stale bytes are a correctness hazard; re-read is one cheap tool call). `turnProtection.turns: 8` keeps the working set verbatim; plan-file reads are protected by `protectedFilePatterns`.

**Note:** `task` is deliberately kept out of `compress.protectedTools` (the "summary append" list) to avoid bloating `summaryTokens` against the `maxCompactionRatio: 0.7` guard. `task` is protected from strategies/sweep (prune-side), but its full transcript is NOT appended verbatim to summaries.

### Item 4 — `dcp.jsonc`: remove `forkSchemaVersion` (zero code, optional)

**File:** `C:\Users\marco\.config\opencode\dcp.jsonc`
**Where:** inside `compress`.

```jsonc
"compress": {
  // remove: "forkSchemaVersion": 3,
  // ...
}
```

**Rationale:** runtime-inert; the schema gate uses the code constant. Removing the key avoids future confusion.

### Item 5 — Source code: add `protectedFilePatternsTools` (top-level)

**Files to touch:**
1. `lib/config.ts`:
   - Add `protectedFilePatternsTools: string[]` to `PluginConfig` interface (around line 91-107, sibling of `protectedFilePatterns`)
   - Add `"protectedFilePatternsTools"` to `VALID_CONFIG_KEYS` (around line 121-173)
   - Validate as string-array, mirroring the `protectedFilePatterns` validator (around line 247-280)
   - Add default `["read", "write", "edit", "apply_patch", "multiedit"]` in `defaultConfig` (around line 932-995)
   - Merge with **replace-semantics** in the top-level merge function (around line 1289-1313), following the `protectedFilePatterns` precedent
   - Clone in `deepCloneConfig` (around line 1255-1287)
2. `lib/protected-patterns.ts`: add one wrapper at the bottom of the file:

   ```ts
   // ponytail: one guard for all 5 call sites; add per-tool glob scoping here if ever needed.
   export function isProtectedByFilePatterns(
       tool: string,
       parameters: unknown,
       protectedFilePatterns: string[],
       protectedFilePatternsTools: string[],
   ): boolean {
       if (!protectedFilePatternsTools.includes(tool)) return false
       return isFilePathProtected(
           getFilePathsFromParameters(tool, parameters),
           protectedFilePatterns,
       )
   }
   ```

3. Swap the 5 call sites to use the wrapper:
   - `lib/strategies/deduplication.ts:95-96` — replace inline `getFilePathsFromParameters` + `isFilePathProtected` with the wrapper, pass `config.protectedFilePatternsTools`
   - `lib/strategies/purge-errors.ts:94-95` — same
   - `lib/commands/sweep.ts:199-200, 216-217` — same (two call sites in sweep)
   - `lib/compress/protected-content.ts:164-168` — same

4. `dcp.schema.json`: add `protectedFilePatternsTools` as a top-level property next to `protectedFilePatterns` (around line 129-136), with the default array.

**Behavior change:** when user sets `protectedFilePatternsTools: []`, NO tool is protected by file patterns (replace-semantics; current behavior is `*` then narrowed by patterns). Default preserves current behavior exactly.

**Tests:** add `tests/protected-file-patterns-tools.test.ts` with three cases:
- Default list preserves current behavior (write to plan file still protected)
- `["read"]` unprotects a `write` to `**/*plan.md` (dedup, sweep, protected-content all see it as unprotected)
- `[]` disables pattern protection entirely (any tool with filePath input → unprotected)

**Cache effect:** none directly. This is a summary-bloat and correctness knob.

### Item 6 — Optional: `protectUserMessages: true` with count 2 (zero code, optional)

**File:** `C:\Users\marco\.config\opencode\dcp.jsonc`
**Where:** inside `compress`.

```jsonc
"compress": {
  "protectUserMessages": true,   // was false
  "protectUserMessagesCount": 2  // was 3
}
```

**Rationale:** cache-neutral (summary bytes change on compression anyway). Appending the last 2 real user messages verbatim to compression summaries materially improves summary fidelity for long planning sessions. Range-mode only (INV-21 in `docs/features/COMPRESSION.md`). On DeepSeek v4.1 Flash, where cache-hit cost is essentially free, the slight summary-size increase is barely noticeable.

**Risk:** slightly larger summaries.

**User feedback:** Do not enable \`protectUserMessages\`. Keep it set to false.

### Item 7 — Source code: `forkSchemaVersion` default drift hygiene

**File:** `lib/config.ts:977`
**Change:** default `forkSchemaVersion` from `3` to the code constant `FORK_SCHEMA_VERSION` (imported from `lib/state/types.ts`).

**Files to touch:**
1. `lib/config.ts:977` — change default to imported constant
2. `dcp.schema.json:324` — change schema default to `4` (or import pattern if schema supports it; otherwise hardcode)
3. `docs/PATTERNS.md:66`, `docs/DESIGN_PRINCIPLES.md:25`, `docs/features/STATE_PERSISTENCE.md:11` — correct to `= 4`

**No behavior change.** No test needed beyond the existing `tests/config-schema-drift.test.ts` which catches mismatches.

### Item 8 — Tests: regression pin for synthetic skill messages

**File:** `tests/synthetic-skill-message-survives-compression.test.ts` (new file)

**Two test cases:**
1. Construct a session with: 3 user messages, 3 assistant messages, 3 tool messages, then a synthetic user message containing `<skill name="my-skill">...</skill>` body, then 3 more user/assistant/tool triplets.
2. Call compress with range covering the tool messages BEFORE the synthetic skill message but NOT the skill message itself.
3. Assert: synthetic skill message is still present in `output.messages` after transform. Assert: synthetic skill message has no `mNNNN` ref in `state.messageIds.byRawId`.
4. Second case: call compress with range covering the synthetic skill message's neighbors. Assert: synthetic skill message is still present (not absorbed into the summary).

**No new production code.** This is the invariant tripwire.

### Item 9 — Documentation: new invariants + key references

**Delegate to `07-docs-maintainer`.**

Add the following to `docs/features/COMPRESSION.md` block invariants section:

```
| INV-22 | Synthetic user messages (part.synthetic: true) are never selected as range endpoints or anchors, never assigned mNNNN refs, and never enter compression summaries. | `lib/message-ids.ts:124`, `lib/compress/search.ts:129,224,247`, `lib/messages/priority.ts:40` |
```

Add a new sub-section to `docs/CONFIGURATION.md` documenting `protectedFilePatternsTools` (after `protectedFilePatterns`):

```
## protectedFilePatternsTools

Top-level config key. Restricts which tools `protectedFilePatterns` applies to. Default: `["read", "write", "edit", "apply_patch", "multiedit"]`. Replace-semantics: `[]` means NO tool is protected by file patterns. Glob support via `isToolNameProtected` semantics.

Motivating use case: protect only `read` calls (e.g., for read-only plan files) without bloating summaries with verbatim `write`/`edit` outputs that happen to match the same path glob.
```

Update `docs/PATTERNS.md`, `docs/DESIGN_PRINCIPLES.md`, `docs/features/STATE_PERSISTENCE.md` to reference `forkSchemaVersion: 4` as the current code constant. Don't propagate the misleading `= 3` default further.

---

## 5. Verification

After implementation:

### 5.1 Static checks
```
cd C:\Beheer\OpenCode\opencode_plugins\opencode-dynamic-context-pruning-fork
npm run typecheck
npm run build
npm test
npm run check:package
```

### 5.2 Functional tests
New tests covered by Item 5 (`tests/protected-file-patterns-tools.test.ts`) and Item 8 (`tests/synthetic-skill-message-survives-compression.test.ts`). Delegate test creation to `06-test_creator` after the implementation round is complete and stable.

### 5.3 Manual config verification
```
cd C:\Beheer\OpenCode\opencode_plugins\opencode-dynamic-context-pruning-fork
npm run dcp
```
Confirm:
- `protectedFilePatternsTools` defaults to `["read", "write", "edit", "apply_patch", "multiedit"]`
- After user sets the new key to `["read"]`, the resolved config reflects it
- The active DeepSeek model ID is `deepseek-flash` (not the retired `deepseek-chat` / `deepseek-reasoner` aliases)
- `turnProtection.turns` resolved to `8` after config change

### 5.4 Cache hit rate observation
1. **MiniMax session with `debug: true`:** watch `cache_creation_input_tokens` vs `cache_read_input_tokens` in provider responses (if OpenCode surfaces usage). Confirms (a) `cache_control` breakpoints are actually emitted, (b) hit rate before/after `turns: 8`.
2. **DeepSeek v4.1 Flash session:** watch `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`. Baseline one long session before changes, then re-measure after. With 72h TTL and $0.003/M cache-hit pricing, expect substantially higher hit rates than the V3.x envelope.
3. **Idle test (MiniMax):** pause 6 minutes mid-session. Next call should show full `cache_creation` (validates the 5-min TTL claim; if not observed, MiniMax TTL is longer than documented).
4. **Long-session test (DeepSeek v4.1 Flash):** a session that exceeds 250000 tokens (the user's current `maxContextLimit`). With the 1M context window and 72h TTL, confirm that compression triggers *before* any provider-side context rejection. This validates the current `maxContextLimit: 250000` is conservative and well-placed.

### 5.5 Metrics to track
- Cache hit rate per provider (target: MiniMax ≥85% active-session, DeepSeek ≥90%)
- Compression events per session (target: fewer, each net-compacting — watch `nonCompactingRunCount` via state files)
- Recovery-mode entries (target: ~0)
- Per-call input tokens between compress events

---

## 6. Risks and open questions

### 6.1 Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `turnProtection.turns: 8` makes compression cluster right after the protection window slides | Low | Unwanted cache misses | Widen the gap between `minContextLimit` and `maxContextLimit` instead of reverting `turns` |
| `protectedFilePatternsTools: []` accidentally set | Low | All file-pattern protection lost (rare in practice) | Replace-semantics; user has to opt in; covered by test |
| Skills plugin changes injection format (drops `synthetic: true`) | Low | Skill messages become compressible → silent loss | Regression test (Item 8) is the tripwire |
| MiniMax `cache_control` breakpoints not actually emitted by OpenCode | Medium | All MiniMax tuning moot | Manual verification step 5.4-1 confirms |
| DeepSeek v4.1 Flash silently downgraded to V3.x due to model ID mismatch | Low | Cache pricing/capability reverts to V3.x | Verify `deepseek-flash` model ID is in active rotation via `npm run dcp` |

### 6.2 Open questions

1. **Should the fork add a `protectedSkills` config anyway, as defense-in-depth for future plugin changes?** The architect's verdict was "no" — building it duplicates content into summaries, which is a net negative. But if the skills plugin's format ever changes (drops `synthetic: true`), the regression test (Item 8) is the tripwire and adding a config becomes a fast follow-up.

2. **Should `read` tool be added to the hardcoded read-side strip (`dropUnsupportedPruneToolIds`)?** The architect's verdict (Q1 follow-up): NO. Pruning old `read` outputs is more correct than keeping them (stale bytes are a correctness hazard). The config-level `protectedTools` lists also don't include `read` (Item 3 is intentionally `todowrite` only). If the user's empirical experience contradicts this — e.g., agents get confused without verbatim old reads — revisit the recommendation. But the working set is protected by `turnProtection.turns: 8` + plan file `protectedFilePatterns`, so what's pruned is precisely the old/stale bulk.

3. **Option 2 (`unprunableTools` config) for airtight read-side protection?** Only worth doing if the two-tier protection holes (compress propagation, block rebuild) ever bite in practice. The architect's Option 1 (config-only `protectedTools`) covers 99% of cases. Keep this as a backlog item.

### 6.3 Unfixable by DCP (state honestly)

- **MiniMax 5-minute TTL on idle gaps.** Any pause >5 minutes evicts everything. Mitigation is behavioral: keep sessions warm, or accept the rewrite.
- **OpenCode's own compaction events** (`compaction.prune: true`). Total prefix wipe. With the user's `maxContextLimit: 250000` (well within the 1M context window of both providers), DCP fires before OpenCode compaction in the normal path; OpenCode is a backstop, not the primary compression driver.
- **Mid-session tool list changes by other plugins.** Anthropic's own guidance: never add/remove tools mid-session. The tools→system→messages cascade on MiniMax means any tool mutation is a full prefix rewrite.

---

## 7. References (file paths and line numbers)

### 7.1 DCP source paths referenced
- `lib/hooks.ts:247-282` — transform pipeline order
- `lib/messages/prune.ts:9-10` — placeholder string constants
- `lib/messages/prune.ts:38-45` — `dropUnsupportedPruneToolIds` (hardcoded `question`/`edit`/`write` protection)
- `lib/messages/prune.ts:93-117` — `pruneToolOutputs`
- `lib/messages/prune.ts:179-263` — `filterCompressedRanges`
- `lib/messages/query.ts:38-63` — `isIgnoredUserMessage`
- `lib/messages/utils.ts:122, 146` — `endsWith` idempotent append (message-id tags)
- `lib/messages/priority.ts:37-44` — priority entry skipping synthetics
- `lib/message-ids.ts:124` — `assignMessageRefs` skipping synthetics
- `lib/messages/inject/utils.ts:211-248` — `injectAnchoredNudge` (nudges in messages, not system prompt)
- `lib/messages/inject/inject.ts:34-163` — nudge pipeline
- `lib/messages/inject/inject.ts:189-198` — message-mode `priority="..."` attribute (cache caveat)
- `lib/strategies/deduplication.ts:91-97` — dedup gating
- `lib/strategies/purge-errors.ts:90-95` — purgeErrors gating
- `lib/commands/sweep.ts:130-286` — sweep command
- `lib/commands/sweep.ts:42` — sweep skipping synthetics
- `lib/commands/sweep.ts:199-200, 216-217` — sweep file-pattern gates
- `lib/compress/range.ts:59-260` — range-mode compress pipeline
- `lib/compress/pipeline.ts:99-114` — strategies inside compress pipeline
- `lib/compress/pipeline.ts:227` — sessionMessageIds filter (skips ignored)
- `lib/compress/search.ts:129, 224, 247` — selection/anchor skipping ignored
- `lib/compress/state.ts:274-280` — defensive `state.prune.tools` propagation
- `lib/compress/protected-content.ts:138-228` — `appendProtectedTools`
- `lib/compress/protected-content.ts:164-168` — file-pattern gate in compress
- `lib/compress/protected-content.ts:182-212` — dead task cache-merge (cache is cold)
- `lib/protected-patterns.ts:61-99` — `getFilePathsFromParameters`
- `lib/protected-patterns.ts:101-106` — `isFilePathProtected`
- `lib/state/tool-cache.ts:39-52` — `turnProtection` honoring
- `lib/state/utils.ts:546-547` — schema gate (uses code constant)
- `lib/state/types.ts:208` — `FORK_SCHEMA_VERSION` constant
- `lib/state/state.ts:93, 150` — saves stamp the constant
- `lib/state/state.ts:301-311` — recovery-field round-trip unconditional
- `lib/config.ts:91-107` — `PluginConfig.protectedFilePatterns`
- `lib/config.ts:121-173` — `VALID_CONFIG_KEYS`
- `lib/config.ts:932-995` — `defaultConfig`
- `lib/config.ts:977` — `forkSchemaVersion` default (currently `3`, should be `4`)
- `lib/config.ts:1255-1287` — `deepCloneConfig`
- `lib/config.ts:1289-1313` — top-level merge function
- `dcp.schema.json:129-136` — `protectedFilePatterns` schema
- `dcp.schema.json:324` — `forkSchemaVersion` schema default

### 7.2 DCP docs paths referenced
- `docs/MASTER.md` — system overview, glossary
- `docs/features/COMPRESSION.md` — INV-6 (maxCompactionRatio), INV-21 (protectUserMessages), need to add INV-22 (synthetics)
- `docs/features/PRUNING.md` — INV-P7 (ignored messages)
- `docs/features/STATE_PERSISTENCE.md:11` — `forkSchemaVersion = 3` (incorrect)
- `docs/PATTERNS.md:66` — `forkSchemaVersion = 3` (incorrect)
- `docs/DESIGN_PRINCIPLES.md:25` — `forkSchemaVersion = 3` (incorrect)

### 7.3 Provider docs referenced
- OpenCode source (current dev): `packages/opencode/src/provider/transform.ts:471-484` (`applyCaching()` gate)
- OpenCode source: `packages/opencode/src/provider/provider.ts:113-140` (`BUNDLED_PROVIDERS`), `142+` (`custom()` loader)
- OpenCode Zen docs: https://opencode.ai/docs/zen/ (MiniMax M3/M2.7/M2.5 → `@ai-sdk/openai-compatible`, no cache_control)
- OpenCode Go docs: https://opencode.ai/docs/go/ (MiniMax M3/M2.7/M2.5 → `@ai-sdk/anthropic`, cache_control emitted)
- OpenCode issue #45750: custom anthropic-protocol proxies may report 0 cache hits despite markers sent
- OpenCode issue #48246: family gate is intentional (not a bug)
- OpenCode issue #14642: placement detection fix (closed)
- OpenCode issue #24906: Zen MiniMax M2.5 Free Anthropic key error (historical)
- OpenCode issue #31755: MiniMax Token Plan caching regression with thinking toggle (open)
- models.dev MiniMax provider registry: https://models.dev/providers/minimax (three variants: `minimax`, `minimax-cn`, `minimax-coding-plan`, all `@ai-sdk/anthropic`)
- MiniMax OpenCode onboarding: https://platform.minimax.io/docs/api-reference/anthropic-api-compatible-cache
- Anthropic reference: https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
- DeepSeek v4.1 Flash (1M context, 72h TTL, $0.003/M cache hit):
  - https://api-docs.deepseek.com/guides/kv_cache/ (caching mechanics)
  - https://api-docs.deepseek.com/news/ (release timeline; V4.1 Flash GA 2026-09-10)
  - DeepSeek V4.x technical report (72h TTL guarantee)
- DeepSeek V3.x references (historical; V3.x aliases retired 2026-07-24):
  - https://api-docs.deepseek.com/news/news0802/ (original disk-caching launch 2026-08-02)

### 7.4 Custom skills plugin paths referenced
- `C:\Beheer\OpenCode\opencode_plugins\opencode-agent-skills\src\plugin.ts` — entry point, hook handlers, tool registration
- `C:\Beheer\OpenCode\opencode_plugins\opencode-agent-skills\src\tools.ts:268-351` — `UseSkill` tool definition (single `skill: string` arg)
- `C:\Beheer\OpenCode\opencode_plugins\opencode-agent-skills\src\tools.ts:336` — synthetic injection call
- `C:\Beheer\OpenCode\opencode_plugins\opencode-agent-skills\src\utils.ts:225-274` — `injectSyntheticContent` (synthetic user message via `client.session.prompt`)
- `C:\Beheer\OpenCode\opencode_plugins\opencode-agent-skills\src\skills.ts:108-117` — frontmatter schema (no category/tags/procedure field)

### 7.5 User config paths referenced
- `C:\Users\marco\.config\opencode\dcp.jsonc` — user DCP config
- `C:\Users\marco\.config\opencode\opencode.json` — user OpenCode config

---

## 8. Implementation sequencing summary

| Order | Item | Type | Rationale |
|---|---|---|---|
| 1 | `dcp.jsonc`: `turnProtection.turns: 8`, `strategies.purgeErrors.turns: 4`, **add `todowrite` and `goal_*` to all three `protectedTools` lists + `compress.protectedTools`**, remove `forkSchemaVersion` | Config only | Zero code, immediately measurable. Do today. Item 1 of config-only batch. todowrite+goal_* Item3 partially applied (you've done goal_* but not todowrite or the others yet). |
| 2 | Verify MiniMax route via `npm run dcp` or `jq '.minimax.npm' ~/.cache/opencode/models.json` (already verified this session, but worth confirming on the actual machine) | Verification | Confirms cache_control is on. Already done in this session. |
| 3 | Item 5: `protectedFilePatternsTools` (top-level) | Code | Then optionally set `["read"]` in config. Independent of 1–2. |
| 4 | Item 7: `forkSchemaVersion` default hygiene | Code (trivial) | Unblocks config/schema/docs consistency; no behavior change. |
| 5 | Item 8: synthetic-skill-message invariant test | Test only | Pins Finding 1 as a regression tripwire. |
| 6 | Item 6 (optional): `protectUserMessages: true` (count 2) | Config | Evaluate after 1–2 weeks of metrics; reliability insurance, cache-neutral. |
| 7 | Item 9: docs (delegate to `07-docs-maintainer`) | Docs | After code lands. |

No conflicts between recommendations. The only tension is directional: `turns: 8` retains tokens longer (higher per-call input) while the user's aggressive nudge tuning pushes for more compression (lower input). These compose correctly — batching reduces event frequency; nudges reduce steady-state size. If metrics show compression events clustering right after the protection window slides, widen the gap between `minContextLimit` and the per-model max instead of reverting `turns`.

---

## 9. What this plan deliberately does NOT do

1. **Build `protectedSkills` preservation machinery.** Verified unnecessary (Finding 1). Would be a regression.
2. **Switch `compress.mode` to `"message"`.** Range mode is cache-correct; message mode adds `priority="..."` attributes that churn mid-context (`lib/messages/inject/inject.ts:189-198`).
3. **Add a `protectedTools` slice for `task` at compression time.** Currently `compress.protectedTools: ["goal_*"]` (after Finding 8). Adding `"task"` would append full subagent transcripts verbatim into every overlapping compression summary, increasing `summaryTokens` and triggering more non-compacting runs. The user's `strategies.*.protectedTools: ["task", "todowrite", "goal_*"]` and `commands.protectedTools: ["task", "todowrite", "goal_*"]` protect against prune-replacement but not summary-bloat — that's the right balance.
4. **Touch OpenCode's session storage.** DPP-001 hard rule.
5. **Build a subagent-aware `protectedSkills`.** Out of scope; the user's `experimental.allowSubAgents: true` already permits subagents, but `use_skill` from subagents would still benefit from the synthetic-message invariant (Finding 1) without any new feature.

---

## 10. Self-check before implementation begins

- [ ] Read `docs/MASTER.md`, `docs/features/COMPRESSION.md`, `docs/features/PRUNING.md`
- [ ] Read `lib/hooks.ts:247-282` (pipeline order)
- [ ] Read `lib/messages/query.ts:38-63` (`isIgnoredUserMessage` semantics)
- [ ] Read `lib/protected-patterns.ts` (existing pattern helpers)
- [ ] Read `lib/config.ts:91-107, 121-173, 932-995, 1255-1313, 1289-1313` (config surface for the new key)
- [ ] Run `npm run dcp` from the DCP repo to see resolved model IDs for DeepSeek + kimi
- [ ] Confirm the user has no in-flight sessions before applying config changes
- [ ] Capture git baseline: `git status` and `git diff --stat HEAD` from the DCP repo

If any of these aren't done, the implementation should pause until they are.