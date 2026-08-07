# DESIGN_PRINCIPLES

Hard rules and rationale. The plugin's behavior is the conjunction of these rules. Every change must be checked against this list; if a rule blocks a change, change the rule first and explain why.

## DPP-001 — Read-only on session history

Pruning is a transform of `output.messages` applied inside the `experimental.chat.messages.transform` hook before each LLM call. The plugin never writes to OpenCode's session storage.

**Rationale.** Session history is the user's source of truth. A bug in the transform must not corrupt past turns. Chat notifications are the only intentional side-effect; see `lib/ui/notification.ts`.

## DPP-002 — Canonical history is the validation source

The `compress` tool refetches raw session messages via `client.session.messages()`. It does not trust already-transformed context to decide whether a `startId` / `endId` is valid or to derive token counts.

**Rationale.** Transformed messages carry synthetic summaries and rewrites. Trusting them would let a stale summary validate itself.

## DPP-003 — One current-session state per process

`SessionState` is not a map of all sessions. Session switches reset the in-memory state and reload from the sidecar. Unloaded sessions queue event durations only.

**Rationale.** Per-session state can grow without bound. A single resident state keeps the working set bounded; persistence covers cross-session durability.

## DPP-004 — Persisted state is version-gated, not migrated

`FORK_SCHEMA_VERSION = 3` in `lib/state/types.ts`. Files whose `forkSchemaVersion` does not match are dropped on load. There is no migration path.

**Rationale.** Migration code is dead code on a forward path and dangerous on a backward path. A clean drop is honest about the boundary.

## DPP-005 — Compression blocks are current-refs and strictly forward

Compress requires that:

- every `startId` / `endId` is either a visible `mNNNN` ref or an active `bN` block;
- ranges in one batch do not overlap;
- the next `startId` and `endId` are both strictly greater than the most recent active block's `endId`.

A violation throws `__DCP_MONOTONIC_VIOLATION__` with a `validNextIds` hint. The first compress in a session is exempt because there is no previous anchor.

**Rationale.** A backward or overlapping anchor would let the model re-compress or shuffle content the user has already seen.

## DPP-006 — Compress is the only writer of `state.prune.messages` in bulk

`applyCompressionState` in `lib/compress/state.ts` is the single mutator for new blocks. `syncCompressionBlocks` is the only bulk reconciliation path. Other modules must go through one of these.

**Rationale.** A single writer keeps block IDs monotonic and the deactivation invariants consistent. Adding side-effects means adding them to this function.

## DPP-007 — User's `protectedTools: []` means nothing protected

`protectedTools` is replaced per layer, not merged. An explicit `[]` is the user's choice and wins over any default.

**Rationale.** Defaults surprise. Replace-semantics lets the user opt out without overriding each entry by name.

## DPP-008 — Skip subagent sessions unless explicitly allowed

`experimental.allowSubAgents = true` is required to apply DCP to a subagent session. The system and message hooks both honor the gate.

**Rationale.** Subagent sessions are nested contexts. Pruning them changes the result the parent sees, which is not what the user asked for.

## DPP-009 — Skip internal OpenCode agents

Title generators, summarizers, and similar internal agents are detected by `isInternalAgentSystem` in `lib/hooks.ts` and skipped.

**Rationale.** DCP's instructions and transforms are not meaningful for agents that produce their own metadata. Injecting them leaks tool names into agent prompts.

## DPP-010 — Host `*:deny` is the floor; user `allow` is the ceiling

OpenCode's `opencode.json` permission system is the source of truth for what is allowed. If the host sets `*:deny`, the plugin forces `compress.permission = "deny"` and omits `compress` from `experimental.primary_tools`. A later user `allow` in `dcp.jsonc` re-enables it.

**Rationale.** The host's permission policy is broader than the plugin. The plugin narrows it; it must not widen it.

## DPP-011 — Cache-aware pruning has a cost

Pruning invalidates the prompt-cache prefix from the prune point forward. The README records ~85% cache hit rate with DCP versus ~90% without.

**Rationale.** Pruning is not "free" token savings. Documentation and benchmarks must not claim a zero-cache cost.

## DPP-012 — Fork-protocol fields are clamped, not rejected

`maxCompactionRatio`, `maxContextLimitRecovery`, `recoveryFadeWindow`, `stateMaxAgeDays` are clamped to safe ranges. Bad values fall back rather than fail.

**Rationale.** A misconfigured user should still get a working plugin. A failed config should not prevent OpenCode from running.

## DPP-013 — The agent supplies summaries; the plugin validates them

`compress` tool arguments carry the agent's summary text. The plugin does not call a second LLM to summarize. It validates refs, range semantics, and the net-compaction guard.

**Rationale.** A second LLM call would add latency and token cost, and would not necessarily match the agent's intent. The agent that saw the content is the right summarizer.

## DPP-014 — Notification writes are isolated

Chat notifications append an ignored record to the session via `client.session.prompt({ noReply: true, parts: [{ ignored: true, ... }] })`. Toast and off modes do not. The record is ignored by the transform.

**Rationale.** The record is needed for the OpenCode UI to display the toast in-session. Treating it as ignored keeps it out of the model context.

## DPP-015 — Prompt extensions are not user-overridable

Format schemas for compress tool inputs (`RANGE_FORMAT_EXTENSION`, `MESSAGE_FORMAT_EXTENSION`) and runtime-computed extensions (manual / subagent / protected-tools / nudge guidance) are excluded from the override set. Only the six `PROMPT_KEYS` in `lib/prompts/store.ts` are user-editable.

**Rationale.** The schemas are bound to the tool's input validation. Letting a user change them while the code does not would create silent breakage.

## DPP-016 — `compress-pending` is a transient only

The `manualMode === "compress-pending"` flag exists solely to allow a `/dcp-compress` slash command to bypass the manual-mode gate. The single writer is the slash-command handler.

**Rationale.** A second writer would silently disable the gate. The flag is documented in `lib/compress/pipeline.ts:58-69`.

## DPP-017 — `state.manualMode` is a derived cache

`userForced` and `recoveryForced` are the source of truth. The cached `manualMode` is updated by `effectiveManualMode` and refreshed on every state change. New code must read `effectiveManualMode`, not the cached field.

**Rationale.** A cached field can drift; the derived reader cannot.

## DPP-018 — `subAgentResultCache` is intentionally cold

The cache scaffolding exists; the production write site does not (M4 deleted the fetch-on-miss path). The HIT path is exercised only when an entry was previously written.

**Rationale.** The fetch-on-miss path was the source of a round-overwrite bug. The safer fallback is `part.state.output`.
