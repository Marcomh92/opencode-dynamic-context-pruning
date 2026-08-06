# Project Context Preservation — Feature Proposal

**Status:** Draft. Implementation plan TBD.
**Target version:** Fork `3.1.18`.
**Branch:** `fork/dcp-3.1.18-pcp` (when implementation starts).
**Independence:** This is a **separate, standalone feature**. It does not depend on `compress.looseCompressionPatterns` and can be implemented (and is useful) without it. The two compose cleanly when both are enabled.

---

## What

A new section appended to the compress tool's summary prompt that instructs the agent to apply loss-aware compression rules to **project-context knowledge** it has gathered during the session. The feature is purely prompt-based: no plugin-side detection, no structural manipulation, no synthetic headers. The agent does the classification using its own dispatch memory.

Two clauses are appended to the prompt:

1. **Conditional clause** — included only when `compress.protectedSummarySources` is non-empty. Names the configured context-gathering skills and frames their outputs as non-reproducible.
2. **Generic clause** — always included when the feature is enabled. Broader instruction: preserve *any* knowledge the agent has gathered about the project, regardless of how it was obtained (file reads, subagent dispatches, exploration).

## Why

A typical project-context-gathering phase produces three categories of high-value content that the current compress path mishandles:

1. **Subagent summaries** from investigator dispatches (`task()` calls during discovery). Non-reproducible — re-dispatching consumes fresh tokens and tool calls.
2. **Plan and architecture docs** read during discovery. Reproducible from disk, but re-reading costs context the model has already paid.
3. **Background knowledge** the agent accumulated by reading source files, schemas, config files. Same as #2 but ad-hoc — no formal "this was project context" boundary.

The current compress prompt has no special handling for any of these. They get summarized with the same rules as everything else, which loses ordered step lists, file paths, config key names, and architecture decisions.

This feature adds the missing prompt context. The agent already has the dispatch memory to know what counts as project context; the prompt just tells it how to compress that content.

## How (high-level)

> **Model identity.** Summarization is performed by the **current agent model** (kimi in your setup) — not a separate LLM call. The plugin never invokes an LLM itself; the agent sees the summary prompt + the messages to compress, writes the summary as part of its `compress` tool call, and the plugin persists it (see `lib/compress/message.ts:114` — `plan.entry.summary` is agent-written, not plugin-generated). This means the agent has **full session context** when classifying content as project-context: it remembers what skills it loaded, what `task()` calls it dispatched, what file reads served discovery vs implementation. No plumbing required.

### Behavior contract

When the compress tool runs and `compress.preserveProjectContext !== false`:

1. The plugin reads `compress.protectedSummarySources: string[]` from config.
2. If the array is non-empty, the **conditional clause** is appended to the summary prompt (with the skill names interpolated).
3. The **generic clause** is always appended (unless the master toggle disables the whole feature).
4. The agent receives the augmented prompt. It classifies each message in the compressed range as project-context or normal. For project-context messages, it applies the three-tier rules below. For normal messages, it applies the existing compression rules.
5. The plugin persists whatever summary the agent wrote. No post-processing, no detection, no structural changes.

### Three-tier rules (what the agent is told to do)

For messages classified as containing project-context knowledge:

- **Preserve section headers, file paths, function/method signatures, and config keys verbatim.**
- **Preserve code identifiers verbatim.**
- **Light prose compression is allowed** where meaning is unambiguous.
- **Heavily summarize only sections clearly irrelevant to the current active task** — a 1–3 line summary of the section's topic and focus.
- **If you cannot determine whether a message contains project context**, apply normal compression rules.

### Prompt text (exact wording)

This is what gets appended to both `lib/prompts/compress-message.ts` and `lib/prompts/compress-range.ts`:

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

- **`compress.preserveProjectContext: boolean`** (default `true`) — master toggle. `false` = feature disabled, no prompt text added. For users who never load context-gathering skills or who find the prompt overhead unacceptable.
- **`compress.protectedSummarySources: string[]`** (default `["project-context-lite", "project-context-router"]`) — skill names whose dispatch context is explicitly named in the conditional clause. Empty array `[]` = conditional clause omitted, generic clause still applies.
- Both keys are merged into the existing `compress.*` block in `dcp.schema.json` and `lib/config.ts`.

### Where the prompt is injected

The augmented prompt is constructed lazily at compress-tool-call time:

```
base prompt (lib/prompts/compress-message.ts or compress-range.ts)
+ (if compress.preserveProjectContext) project-context-conditional-clause
+ (if compress.preserveProjectContext) project-context-generic-clause
```

The conditional clause is only added when `protectedSummarySources.length > 0`. The generic clause is always added when the feature is enabled. **Net token cost when both are included: ~250 tokens per compress call** (negligible against the 220k cap).

---

## Relationship to other features

Project context preservation is **independent** of loose compression but composes cleanly with it:

| Feature | Detection signal | Mechanism | Determinism |
|---|---|---|---|
| **This feature** (project context preservation) | Skill names + agent dispatch memory | Prompt injection | ~90% model compliance |
| `compress.looseCompressionPatterns` | File globs (`**/*.md`) | Prompt injection + optional structural extraction | 100% file match; structure preservation is model-dependent under Option A, deterministic under Option B |
| `protectedFilePatterns` | File globs | Full-output append to summary block | 100% (but ratio = 1.0, trips non-compacting) |
| `compress.protectTags` | `<protect>...</protect>` markup | Tag-region verbatim preservation | 100% |

**Precedence:** none defined between this feature and loose compression — they target different detection signals (skill-name vs file-glob). A message that came from a `task()` dispatch is classified by this feature; a message that came from a `read` of a matched file is classified by loose compression. Both instructions can apply to different messages in the same compress call without conflict.

**No interaction with `protectedFilePatterns` or `protectTags`:** those are verbatim-preservation mechanisms, not loss-aware compression. They fire at different code paths (`lib/compress/protected-content.ts:128-185`) and don't read or modify the summary prompt.

---

## Code anchors

| Anchor | What it is |
|---|---|
| `lib/prompts/compress-message.ts:1-43` | Static summary prompt for message-mode compress |
| `lib/prompts/compress-range.ts` | Sibling prompt for range-mode compress |
| `lib/compress/message.ts:113` | Where prompt is passed to the model — same injection point as loose compression |
| `lib/compress/range.ts:60` | Same for range mode |
| `lib/config.ts:111-147` | Existing pattern for adding a new compress.* key (clone) |
| `dcp.schema.json:131-302` | Existing compress.* schema block (clone entry) |

### Implementation sketch

1. New config keys (`preserveProjectContext: boolean`, `protectedSummarySources: string[]`) — schema entry + merge helper + validation (~30 lines).
2. New module `lib/compress/project-context-prompt.ts` exporting `buildProjectContextPrompt(config): { conditional: string, generic: string }`. The conditional is empty string when `protectedSummarySources.length === 0`. ~30 lines.
3. Modify `lib/compress/message.ts:113` and `range.ts:60` — concatenate `buildProjectContextPrompt(config).conditional + .generic` to the summary prompt. ~5 lines.
4. Tests:
   - prompt builder: empty sources → conditional is `""`, generic is present
   - prompt builder: non-empty sources → conditional lists skills
   - prompt builder: `preserveProjectContext: false` → both clauses are `""`
   - integration: prompt string contains expected skill names + verbatim-preservation language
   - ~80 lines
5. Documentation: `MY_README.md` new section + `MY_CHANGELOG.md` entry.

**Total estimate:** ~150 lines. Fork bumps to **3.1.18** (patch).

**Trade-offs:**
- ✓ Cheap. ~150 lines, no structural changes, no new modules beyond the prompt builder.
- ✓ Self-contained. Doesn't depend on loose compression or any other in-flight feature.
- ✓ Model-judged classification handles the "I decided on my own" case without explicit detection logic.
- ✓ Composes cleanly with loose compression — both can be active without conflict.
- ✗ Model-compliance dependent (~90% in practice). The agent can still drop content the rules said to keep.
- ✗ No deterministic verification — there's no plugin-side test that proves "the agent preserved X". Only that the prompt text was injected correctly.
- ✗ Prompt-only — no markdown structure preservation, no synthetic header line, no plugin-side file classification.

---

## Where to start (next steps)

Before implementation, these open questions need resolution:

1. **Default value for `protectedSummarySources`.** Hardcode to `["project-context-lite", "project-context-router"]` (matches user's environment) or leave empty `[]` (forces explicit opt-in)? Recommendation: hardcode to the two named skills. Users with different skills edit the config. Net effect for the user: zero config required.
2. **Skill-name matching semantics.** Should the comparison be exact (`=== "project-context-lite"`) or prefix-based (`startsWith("project-context-")`)? Recommendation: exact match. Users with related skills list each one explicitly. Avoids accidental matches.
3. **Prompt placement.** Where in the base prompt should the project-context section be inserted? At the very end (after `BATCHING` / `GENERAL CLEANUP`) or higher up (before the summary rules)? Recommendation: at the end. Late placement means the agent reads the existing rules first, then gets the project-context override. Less likely to conflict with existing rule statements.
4. **Logging.** Should compress calls that fired project-context preservation emit a debug log line? Recommendation: yes, gated on `debug: true`, identifying which skill names were configured. Symmetric with loose compression's recommendation.
5. **Schema validation.** Should `protectedSummarySources` items be validated against the format `^[a-z0-9-]+$` (matching OpenCode skill naming convention)? Recommendation: optional. Pattern validation is cheap and catches typos but adds schema strictness. Skip for v1; add if users hit typos in practice.
6. **Interaction with `/dcp stats` command.** Should the stats output show whether project-context preservation is active and which skills are configured? Recommendation: yes, one line. Symmetric with how `recoveryFadeCounter` / `recoveryFadeWindow` are surfaced.

---

## Verification recipe (after implementation)

1. **Unit:** `buildProjectContextPrompt` returns expected conditional / generic strings for: empty sources, single source, multiple sources, master toggle off.
2. **Schema:** `dcp.jsonc` validates with `preserveProjectContext: false`, `protectedSummarySources: []`, `protectedSummarySources: ["x", "y"]`.
3. **Integration:** construct a `ToolContext` with the new config, call `createCompressMessageTool` (or `createCompressRangeTool`), assert the tool's system prompt contains the expected skill names + verbatim-preservation language. (The `ctx.prompts` mock should verify the prompt string.)
4. **Regression:** all 165 existing tests still pass; no v2 protocol invariants broken; `recoveryForced` semantics unchanged.
5. **Smoke:** restart OpenCode, run `/dcp-compress` against a session that has both subagent-investigator output and file reads; observe the summary text in TUI. With `debug: true`, confirm the project-context preservation log line fires.

---

## File / module inventory (post-implementation, fork 3.1.18)

| File | Status | Purpose |
|---|---|---|
| `lib/compress/project-context-prompt.ts` | NEW | `buildProjectContextPrompt(config)` helper |
| `lib/compress/message.ts` | MODIFIED | Inject project-context clauses into summary prompt |
| `lib/compress/range.ts` | MODIFIED | Same |
| `lib/config.ts` | MODIFIED | New keys + merge + validation |
| `dcp.schema.json` | MODIFIED | New entries |
| `tests/project-context-preservation.test.ts` | NEW | Unit + integration tests |
| `lib/commands/stats.ts` | MODIFIED | Surface feature state in `/dcp stats` (if Q6 resolved yes) |
| `MY_README.md` | MODIFIED | New section: "Project Context Preservation" |
| `MY_CHANGELOG.md` | MODIFIED | New entry for 3.1.18 |
| `MY_PROJECT_CONTEXT_PRESERVATION.md` (this file) | MOVED to `docs/` | Final design doc |

---

## Related features

- **`MY_LOOSE_COMPRESSION.md`** — a complementary, **independent** feature that uses file-glob matching (rather than agent dispatch memory) to apply loss-aware compression. Loose compression handles deterministic structural preservation (file-glob-keyed, markdown skeleton extraction under Option B). Project context preservation handles semantic preservation (subagent outputs + plans/docs read during discovery). The two compose cleanly when both are enabled — they target different detection signals and apply to different messages in the same compress call.