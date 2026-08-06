# Project Context Preservation — Feature Proposal

> **⚠️ SUPERSEDED (2026-08-06):** The user deviated from this elaborate design and shipped a simpler alternative. The full config-key + module + conditional-clause architecture described below was NOT implemented. Instead, a condensed ~95-word preservation instruction was baked directly into both compress prompts (`lib/prompts/compress-message.ts:44-52`, `lib/prompts/compress-range.ts:61-69`). See `MY_CHANGELOG.md` 2026-08-06 entry for details. This document is preserved as the rejected design alternative; the shipped prompt text is in the prompt files.

---

**Status:** Draft. Implementation plan TBD.
**Target version:** Fork `3.1.18`.
**Branch:** `fork/dcp-3.1.18-pcp` (when implementation starts).
**Independence:** This is a **separate, standalone feature**. It does not depend on `compress.looseCompressionPatterns` and can be implemented (and is useful) without it. The two compose cleanly when both are enabled.

---

## What

A new section appended to the compress tool's description that instructs the agent to apply loss-aware compression rules to **project-context knowledge** it has gathered during the session. The feature is purely description-based: no plugin-side detection, no structural manipulation, no synthetic headers. The agent does the classification using its own dispatch memory.

Two clauses are appended:

1. **Conditional clause** — included only when `compress.protectedSummarySources` is non-empty. Names the configured context-gathering skills and frames their outputs as non-reproducible.
2. **Generic clause** — always included when the feature is enabled. Broader instruction: preserve *any* knowledge the agent has gathered about the project, regardless of how it was obtained (file reads, subagent dispatches, exploration).

## Why

A typical project-context-gathering phase produces three categories of high-value content that the current compress path mishandles:

1. **Subagent summaries** from investigator dispatches (`task()` calls during discovery). Non-reproducible — re-dispatching consumes fresh tokens and tool calls.
2. **Plan and architecture docs** read during discovery. Reproducible from disk, but re-reading costs context the model has already paid.
3. **Background knowledge** the agent accumulated by reading source files, schemas, config files. Same as #2 but ad-hoc — no formal "this was project context" boundary.

The current compress prompt has no special handling for any of these. They get summarized with the same rules as everything else, which loses ordered step lists, file paths, config key names, and architecture decisions.

This feature adds the missing description context. The agent already has the dispatch memory to know what counts as project context; the description just tells it how to compress that content.

## How (high-level)

> **Model identity.** Summarization is performed by the **current agent model** (kimi in your setup) — not a separate LLM call. The plugin never invokes an LLM itself; the agent sees the description + the messages to compress, writes the summary as part of its `compress` tool call, and the plugin persists it (see `lib/compress/message.ts:114` — `plan.entry.summary` is agent-written, not plugin-generated). This means the agent has **full session context** when classifying content as project-context: it remembers what skills it loaded, what `task()` calls it dispatched, what file reads served discovery vs implementation. No plumbing required.

> **Static description, config-restart-required.** The compress tool's description is built **once at plugin registration** in `createCompressMessageTool(ctx)` (`lib/compress/message.ts:45-50`) and `createCompressRangeTool(ctx)` (`lib/compress/range.ts:63`), not per-compress-call. The project-context clauses are baked into the description at startup. The agent reads the description once when it considers whether to call the tool. **Changing `compress.preserveProjectContext` or `compress.protectedSummarySources` requires restarting OpenCode for the new clauses to take effect.** Follow the `MESSAGE_FORMAT_EXTENSION` precedent (`lib/prompts/extensions/tool.ts`) for appending to the description.

> **Standing per-request token cost.** When enabled, the project-context clauses are **present in every request's tool description** (not per-compress-call). The combined cost of the conditional + generic clauses is ~250 tokens, which is ~0.11% of the 220k `maxContextLimit` — negligible.

### Behavior contract

When `compress.preserveProjectContext !== false`:

1. The plugin reads `compress.protectedSummarySources: string[]` from config.
2. If the array is non-empty, the **conditional clause** is appended to the description (with the skill names interpolated).
3. The **generic clause** is always appended (unless the master toggle disables the whole feature).
4. The agent receives the augmented description. It classifies each message in the compressed range as project-context or normal. For project-context messages, it applies the three-tier rules below. For normal messages, it applies the existing compression rules.
5. The plugin persists whatever summary the agent wrote. No post-processing, no detection, no structural changes.

### Three-tier rules (what the agent is told to do)

For messages classified as containing project-context knowledge:

- **Preserve section headers, file paths, function/method signatures, and config keys verbatim.**
- **Preserve code identifiers verbatim.**
- **Light prose compression is allowed** where meaning is unambiguous.
- **Heavily summarize only sections clearly irrelevant to the current active task** — a 1–3 line summary of the section's topic and focus.
- **If you cannot determine whether a message contains project context**, apply normal compression rules.

### Prompt text (exact wording)

This is what gets appended to the tool description at registration:

```markdown
PROJECT CONTEXT PRESERVATION

[Conditional — included only if compress.protectedSummarySources is non-empty:]
If you've previously loaded one of the following context-gathering skills: <list>.
Gathered project-context (such as doc reads and outputs from subagents) under
those skills are non-reproducible (re-dispatching consumes fresh tokens and
tool calls).

[Generic — always included when the feature is enabled:]
More generally, preserve any knowledge YOU have gathered about the project
itself — how it works, what it does, its architecture, conventions, config
keys, schema, build system, and runtime behavior. This includes knowledge
you obtained from:
- Reading project files (READMEs, architecture docs, plans, config files,
  schema definitions, source code you investigated for context).
- Subagent dispatches (any task() result that summarizes project state,
  architecture, or conventions).

These are subject to the same rules:

- Preserve section headers, file paths, function/method signatures, and
  config keys verbatim.
- Preserve code identifiers verbatim.
- Light prose compression is allowed where meaning is unambiguous.
- Heavily summarize only sections clearly irrelevant to the current
  active task — a 1-3 line summary of the section's topic and focus.
- If you cannot determine whether a message contains project context,
  apply normal compression rules.
```

`<list>` is interpolated as a comma-separated string of the configured skill names.

### Config shape

```jsonc
{
    "compress": {
        "preserveProjectContext": true,
        "protectedSummarySources": [
            "project-context-lite",
            "project-context-router"
        ]
    }
}
```

- **`compress.preserveProjectContext: boolean`** (default `true`) — master toggle. `false` = feature disabled, no description text added. For users who never load context-gathering skills or who find the prompt overhead unacceptable.
- **`compress.protectedSummarySources: string[]`** (default `["project-context-lite", "project-context-router"]`) — skill names whose dispatch context is explicitly named in the conditional clause. Empty array `[]` = conditional clause omitted, generic clause still applies.

---

## ⚠️ Important: interaction with default `compress.protectedTools`

`lib/config.ts:97` defines:

```ts
const COMPRESS_DEFAULT_PROTECTED_TOOLS = ["task", "skill", "todowrite", "todoread"]
```

This means **subagent (`task`) outputs are already verbatim-appended to every covering summary** by `appendProtectedTools` (`lib/compress/protected-content.ts:139-184`). When PCP is enabled with its default config, the agent receives BOTH instructions:

1. "Preserve task outputs verbatim" (implicit, via the verbatim-append path)
2. "Preserve project-context knowledge" (explicit, via this feature's clauses)

These don't conflict — both push toward preservation — but the **summary block can become significantly inflated** by stacked verbatim appends + agent's preservation-biased summary. The v2 `maxCompactionRatio` guard sees the inflated `summaryTokens` and may count the compress as non-compacting, eventually triggering `recoveryForced`.

**Recommended config when PCP is enabled:**

```jsonc
{
    "compress": {
        "protectedTools": ["skill", "todowrite", "todoread"],   // remove "task"
        "preserveProjectContext": true,
        "protectedSummarySources": ["project-context-lite", "project-context-router"]
    }
}
```

With `"task"` removed from `protectedTools`, the plugin no longer verbatim-appends task outputs. The agent's project-context-aware summary handles preservation instead. The two layers (verbatim-append + description-preservation) no longer stack, and the ratio guard sees a more reasonable `summaryTokens`.

This recommendation should be surfaced in the plugin's startup log when both features are active, and in `MY_README.md`.

---

## Relationship to other features

Project context preservation is **independent** of loose compression but composes cleanly with it:

| Feature | Detection signal | Mechanism | Determinism |
|---|---|---|---|
| **This feature** (project context preservation) | Skill names + agent dispatch memory | Description injection (static, registration-time) | ~90% model compliance |
| `compress.looseCompressionPatterns` | File globs (`**/*.md`) | Description injection (static) + plugin-side suppression | 100% file match; compression itself is model-dependent |
| `protectedFilePatterns` | File globs | Full-output append to summary block | 100% (but ratio = 1.0, trips non-compacting) |
| `compress.protectTags` | `<protect>...</protect>` markup (user-role messages only) | Tag-region verbatim preservation | 100% |

**Precedence:** none defined between this feature and loose compression — they target different detection signals (skill-name vs file-glob). A message that came from a `task()` dispatch is classified by this feature; a message that came from a `read` of a matched file is classified by loose compression. Both descriptions can apply to different messages in the same compress call without conflict.

**Interaction with `protectedFilePatterns` / `protectTags`:** none in the description path. Those are verbatim-preservation mechanisms fired by `appendProtectedTools` / `appendProtectedPromptInfo`, which read from different inputs and don't compose with description-level instructions. The practical composition is the stacking risk described in the section above — not a precedence conflict, but a token-bloat risk.

---

## Code anchors

| Anchor | What it is |
|---|---|
| `lib/prompts/compress-message.ts:1-43` | Static summary prompt (description source) |
| `lib/prompts/compress-range.ts` | Sibling prompt for range-mode compress |
| `lib/compress/message.ts:50` | Tool description construction (registration-time) — the injection point |
| `lib/compress/range.ts:63` | Same for range mode |
| `lib/prompts/extensions/tool.ts` | `MESSAGE_FORMAT_EXTENSION` — append-precedent for tool descriptions |
| `lib/config.ts:97` | `COMPRESS_DEFAULT_PROTECTED_TOOLS = ["task", "skill", "todowrite", "todoread"]` — informs the overlap warning |
| `lib/compress/protected-content.ts:106-196` | `appendProtectedTools` — overlap site (not modified by this feature) |
| `lib/config.ts:120-139, 356-643, 787-805, 948-982, 1054-1059` | Full 6-site pattern for adding a compress.* key |
| `dcp.schema.json:131-302` | Existing compress.* schema block (clone entry) |

### Implementation sketch

1. New config keys (`preserveProjectContext: boolean`, `protectedSummarySources: string[]`) — schema entry + merge helper + validation. ~30 lines.
2. New module `lib/compress/project-context-prompt.ts` exporting `buildProjectContextDescription(config): { conditional: string, generic: string }`. The conditional is empty string when `protectedSummarySources.length === 0`. Both are empty strings when `preserveProjectContext === false`. ~30 lines.
3. Modify `lib/compress/message.ts:50` and `range.ts:63`:
   ```ts
   const projectContext = buildProjectContextDescription(ctx.config)
   description: runtimePrompts.compressMessage
                + MESSAGE_FORMAT_EXTENSION
                + projectContext.conditional
                + projectContext.generic
   ```
   ~5 lines.
4. Tests:
   - `buildProjectContextDescription` returns expected strings for: empty sources, single source, multiple sources, master toggle off.
   - integration: construct a `ToolContext` with the new config, call `createCompressMessageTool`, assert the registered tool **description** contains the expected skill names + verbatim-preservation language.
   - ~80 lines
5. Documentation: `MY_README.md` new section + `MY_CHANGELOG.md` entry + the `protectedTools` overlap recommendation surfaced in startup log when both features are active.

**Total estimate:** ~150 lines. Fork bumps to **3.1.18** (patch).

**Trade-offs:**
- ✓ Cheap. ~150 lines, no structural changes, no new modules beyond the prompt builder.
- ✓ Self-contained. Doesn't depend on loose compression or any other in-flight feature.
- ✓ Model-judged classification handles the "I decided on my own" case without explicit detection logic.
- ✓ Composes cleanly with loose compression — both can be active without conflict.
- ✗ Model-compliance dependent (~90% in practice). The agent can still drop content the rules said to keep.
- ✗ No deterministic verification — there's no plugin-side test that proves "the agent preserved X". Only that the description text was registered correctly.
- ✗ Description-only — no markdown structure preservation, no synthetic header line, no plugin-side file classification.
- ✗ **Stacking risk** with default `compress.protectedTools: ["task", …]` — see the section above. Documented config guidance required.

---

## Where to start (next steps)

Before implementation, these open questions need resolution:

1. **Default value for `protectedSummarySources`.** Hardcode to `["project-context-lite", "project-context-router"]`. **RESOLVED** — matches user's environment, zero-config required.
2. **Skill-name matching semantics.** Exact match (`=== "project-context-lite"`), not prefix-based. **RESOLVED.** Avoids accidental matches.
3. **Description placement.** Append at the very end of the description, after `MESSAGE_FORMAT_EXTENSION`. Plugin-controlled. **RESOLVED.**
4. **Debug logging.** Emit a `logger.debug` line at registration confirming the clauses were built and listing configured skill names. Symmetric with loose compression. **RESOLVED** yes.
5. **Schema validation.** No pattern validation on skill names for v1. **RESOLVED.** Add if users hit typos in practice.
6. **`/dcp stats` surfacing.** Show whether PCP is active and which skills are configured. **RESOLVED** yes — one line in stats output.
7. **`compress.protectedTools` overlap guidance.** When PCP is enabled, recommend removing `"task"` from `protectedTools` (see section above). Surface as a one-time startup log warning, not a hard error. **RESOLVED.**
8. **`experimental.customPrompts` interaction.** When a user overrides `compress-message.md`, the appended clauses land AFTER the override. Plugin-controlled, mirror `MESSAGE_FORMAT_EXTENSION`. **RESOLVED.** Document in MY_README.

---

## Verification recipe (after implementation)

1. **Unit:** `buildProjectContextDescription` returns expected conditional / generic strings for: empty sources, single source, multiple sources, master toggle off.
2. **Schema:** `dcp.jsonc` validates with `preserveProjectContext: false`, `protectedSummarySources: []`, `protectedSummarySources: ["x", "y"]`.
3. **Integration:** construct a `ToolContext` with the new config, call `createCompressMessageTool` (or `createCompressRangeTool`), assert the **registered tool description** (not the runtime prompt — the description IS what the agent sees) contains the expected skill names + verbatim-preservation language.
4. **Overlap warning:** with `preserveProjectContext: true` AND `compress.protectedTools` containing `"task"` (the default), assert a startup log line recommends removing `"task"`.
5. **Regression:** all 165 existing tests still pass; no v2 protocol invariants broken; `recoveryForced` semantics unchanged.
6. **Smoke (post-restart):** restart OpenCode, run `/dcp-compress` against a session that has both subagent-investigator output and file reads; observe the summary text in TUI. With `debug: true`, confirm the PCP registration log line fires.

---

## File / module inventory (post-implementation, fork 3.1.18)

| File | Status | Purpose |
|---|---|---|
| `lib/compress/project-context-prompt.ts` | NEW | `buildProjectContextDescription(config)` helper |
| `lib/compress/message.ts` | MODIFIED | Append PCP clauses to description at `:50` |
| `lib/compress/range.ts` | MODIFIED | Same |
| `lib/config.ts` | MODIFIED | New keys + merge + validation |
| `dcp.schema.json` | MODIFIED | New entries |
| `tests/project-context-preservation.test.ts` | NEW | Unit + integration tests |
| `lib/commands/stats.ts` | MODIFIED | Surface feature state in `/dcp stats` |
| `lib/index.ts` (or `lib/hooks.ts`) | MODIFIED | Startup log warning when PCP + default `protectedTools` overlap |
| `MY_README.md` | MODIFIED | New section: "Project Context Preservation" |
| `MY_CHANGELOG.md` | MODIFIED | New entry for 3.1.18 |
| `MY_PROJECT_CONTEXT_PRESERVATION.md` (this file) | MOVED to `docs/` | Final design doc |

---

## Related features

- **`MY_LOOSE_COMPRESSION.md`** — a complementary, **independent** feature that uses file-glob matching (rather than agent dispatch memory) to apply loss-aware compression. Loose compression handles deterministic structural preservation (file-glob-keyed, with optional markdown skeleton extraction under a deferred Option B). Project context preservation handles semantic preservation (subagent outputs + plans/docs read during discovery). The two compose cleanly when both are enabled — they target different detection signals and apply to different messages in the same compress call.