# Loose Compression Patterns — Feature Proposal

**Status:** Draft. Implementation plan TBD.
**Target version:** Fork `3.1.18` (Option A only — Option B deferred).
**Branch:** `fork/dcp-3.1.18-lcp` (when implementation starts).

---

## What

A new config key, `compress.looseCompressionPatterns`, that selects markdown files (plans, docs, reference material) for **loss-aware compression** during `compress` tool calls. Matched files get summarized, but with explicit rules preserving the markdown structural skeleton and biasing the model toward keeping task-relevant content verbatim while aggressively summarizing task-irrelevant sections.

Precedence over existing mechanisms:

- If a file path matches **`compress.looseCompressionPatterns`** AND **`protectedFilePatterns`**, the loose pattern wins (loose compression is applied, full-output-append is NOT — enforced via plugin-side suppression in `lib/compress/protected-content.ts`).
- The behavior of `compress.protectTags` for files NOT matched by the loose pattern is unchanged.

(`protectedFilePatterns` is a **top-level** config key, not under `compress.*`. See `dcp.schema.json:123-130` and `lib/config.ts:74`. The new loose-compression key lives under `compress.*` — this asymmetry is by design, not a bug.)

## Why

A typical plan or reference doc is 30–80k tokens. The current compress path has two unsatisfactory outcomes for these:

1. **Uncontrolled compression** — the model summarizes the whole document, often losing ordered step lists, explicit constraints, file paths, and section structure. High fidelity loss.
2. **Full protection via `protectedFilePatterns`** — the document is appended verbatim to the summary block. Content survives, but every compress call counts as non-compacting (ratio = 1.0), tripping the v2 `nonCompactingRunCount` → `recoveryForced` path after 3 such compresses.

A middle ground is needed: preserve enough structure and task-relevant content that the model can keep working, but allow real compression so the v2 ratio stays under `maxCompactionRatio`.

## How (high-level)

The feature extends the compress tool's description string with a "Loose Compression" section listing all configured patterns + per-pattern instructions. The agent sees this section when it considers calling the tool and applies the per-pattern rules to file reads it identifies.

> **Model identity.** Summarization is performed by the **current agent model** (kimi in your setup) — not a separate LLM call. The plugin never invokes an LLM itself; the agent sees the summary prompt + the messages to compress, writes the summary as part of its `compress` tool call, and the plugin persists it (see `lib/compress/message.ts:114` — `plan.entry.summary` is agent-written, not plugin-generated). This means the agent has **full session context** when deciding what to preserve: the original PLAN.md it read, prior compressions, your current user goal. No task-context plumbing is required.

> **Static prompt, config-restart-required.** The compress tool's description is built **once at plugin registration** in `createCompressMessageTool(ctx)` (`lib/compress/message.ts:45-50`) and `createCompressRangeTool(ctx)` (`lib/compress/range.ts:63`), not per-compress-call. Loose-compression instructions are baked into the description at startup. The agent reads the description once when it considers whether to call the tool. **Changing `compress.looseCompressionPatterns` requires restarting OpenCode for the new instructions to take effect.** Follow the `MESSAGE_FORMAT_EXTENSION` precedent (`lib/prompts/extensions/tool.ts`) for appending to the description.

### Behavior contract

1. **Plugin-side matching (synthetic header only).** For each tool part in the compressed range whose `state.input` contains a `filePath` matching a glob in `compress.looseCompressionPatterns`, the plugin records the matched paths and (after the agent returns the summary) prepends a single header line listing them.
2. **Agent-side matching (loss-aware compression).** The agent reads the "Loose Compression" section of the description and applies per-pattern instructions to file reads it identifies in the compressed range.
3. **Synthetic header injected** at the top of the summary block:
    ```
    Loose-compressed: <path1.md>, <path2.md>. These files were loss-aware-compressed; consider re-reading if a heavily-summarized section is needed.
    ```
    One header per compress call (not per file). If multiple files matched, they're listed comma-separated. The header is appended by the plugin after the model returns the summary; the model does not write it.
4. **Plugin-side precedence enforcement.** Loose-matched tool parts are excluded from `appendProtectedTools`'s full-output-append path (`lib/compress/protected-content.ts:106-196`) at the `isToolProtected` gate (`:130-137`). This guarantees loose compression wins over `protectedFilePatterns` — the agent doesn't see the file content verbatim-appended on top of its own summary.

### Config shape

```jsonc
{
    "compress": {
        "looseCompressionPatterns": {
            "**/plans/**/*.md": "Preserve all step numbers and their ordering. Preserve explicit constraints and prerequisites. Compress explanatory prose.",
            "**/docs/**/*.md": "Preserve API signatures, config key names, and code identifiers. Compress introductory prose; preserve everything after the first heading.",
        },
    },
}
```

- Object form (pattern → instruction string) is preferred over a string array of patterns. The instruction string is appended to the description, giving per-pattern guidance.
- Schema: `additionalProperties: { type: "string" }` (pattern-validated stricter typing is optional).
- Default: `{}` (empty — no loose compression applied; existing behavior preserved everywhere).
- **Config-key recursion warning:** the object value requires a `modelMaxLimits`-style special case in `getConfigKeyPaths` (`lib/config.ts:157`) so user pattern keys are not flagged as "Unknown key" warnings. See "Implementation sketch" step 1 for details.

### Three-tier rules (what the agent is told)

The "Loose Compression" section of the description instructs the agent:

- **Preserve section headers, file paths, function/method signatures, and config keys verbatim** in summaries of matched files.
- **Preserve code identifiers verbatim.**
- **Light prose compression is allowed** where meaning is unambiguous.
- **Heavily summarize only sections clearly irrelevant to the current active task** — a 1–3 line summary of the section's topic and focus.
- **If you cannot determine whether a tool output came from a matched file**, apply normal compression rules.

---

## Option A — Static description embedding

**Approach:** A `lib/compress/loose-instructions.ts` module reads `compress.looseCompressionPatterns` at registration and formats a "Loose Compression" section listing all patterns + instructions. This is appended to the tool description at `lib/compress/message.ts:50` and `lib/compress/range.ts:63` via the `MESSAGE_FORMAT_EXTENSION` pattern.

**Key code anchors:**

| Anchor                                                        | What it is                                                                           |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `lib/prompts/compress-message.ts:1-43`                        | Static summary prompt (description source)                                           |
| `lib/prompts/compress-range.ts`                               | Sibling prompt for range-mode compress                                               |
| `lib/compress/message.ts:50`                                  | Tool description construction (registration-time) — the injection point              |
| `lib/compress/range.ts:63`                                    | Same for range mode                                                                  |
| `lib/prompts/extensions/tool.ts`                              | `MESSAGE_FORMAT_EXTENSION` — append-precedent for tool descriptions                  |
| `lib/compress/protected-content.ts:106-196`                   | `appendProtectedTools` — needs suppression gate at `:130-137`                        |
| `lib/protected-patterns.ts:61-99`                             | `getFilePathsFromParameters` — extracts paths from tool input                        |
| `lib/protected-patterns.ts:101-106`                           | `isFilePathProtected` — glob match                                                   |
| `lib/config.ts:120-139, 356-643, 787-805, 948-982, 1054-1059` | Full 6-site pattern for adding a compress.\* key                                     |
| `lib/config.ts:157`                                           | `getConfigKeyPaths` special-case precedent (`modelMaxLimits`) for object-valued keys |
| `dcp.schema.json:131-302`                                     | Existing compress.\* schema block (clone entry)                                      |

**Implementation sketch:**

1. New config key + schema entry + merge helper (~30 lines, including the `getConfigKeyPaths` special case so user pattern keys aren't flagged as unknown).
2. New module `lib/compress/loose-instructions.ts` exporting `buildLooseCompressionDescription(config): string`. Reads `compress.looseCompressionPatterns`, formats all patterns + instructions into a description appendix. Returns empty string if no patterns configured. ~30 lines.
3. Append the returned string to the tool description in both `message.ts:50` and `range.ts:63`:
    ```ts
    description: runtimePrompts.compressMessage +
        MESSAGE_FORMAT_EXTENSION +
        buildLooseCompressionDescription(ctx.config)
    ```
    ~5 lines.
4. Plugin-side precedence suppression: in `lib/compress/protected-content.ts:130-137`, add a second gate that excludes parts matching `compress.looseCompressionPatterns` from `isToolProtected = true`. This prevents `appendProtectedTools` from appending the full output on top of the agent's loose-compressed summary. ~15 lines.
5. Plugin-side synthetic header: in the same compress tool paths (`message.ts` post-hoc, `range.ts` post-hoc), collect matched paths from `plan.selection` and prepend one header line listing them. ~25 lines.
6. Tests: pattern match (single + multi), no-match, empty config, precedence over `protectedFilePatterns` (assert `appendProtectedTools` is NOT called with loose-matched parts), synthetic header content, description content (assert registered tool description contains expected pattern strings). ~100 lines.

**Total estimate:** ~200 lines. Fork bumps to **3.1.18** (patch).

**Trade-offs:**

- ✓ Cheap. Few new code paths.
- ✓ Reuses existing `MESSAGE_FORMAT_EXTENSION` precedent.
- ✓ Per-pattern instruction lets users tune behavior to document type.
- ✓ Plugin-side suppression guarantees precedence over `protectedFilePatterns` (no model-dependent resolution).
- ✗ Model-compliance dependent for the actual loss-aware compression — the agent decides what to keep/summarize. In practice compliance is high (~90%) when rules are specific.
- ✗ Config changes require restart (static description).
- ✗ The "cannot determine whether a tool output came from a matched file" clause is a real escape hatch — if the agent misidentifies, normal compression applies.

---

## Option B — Structural skeleton preservation (DEFERRED)

The originally-proposed Option B ("plugin extracts markdown structural skeleton before the model sees the document") is **not implementable as written** — the only pre-model injection point is the static description (already used by Option A), and the per-tool-part chat-transform hook (`createChatMessageTransformHandler` in `lib/hooks.ts:108-173`) would mutate every matched document in the live context during normal work, which is a far bigger and riskier feature than described.

A post-hoc variant — extract the skeleton after the agent returns its summary and append it to the summary block — would mirror `appendProtectedTools` (`lib/compress/protected-content.ts:106-196`) but **deterministically inflates `summaryTokens`** by the skeleton size, which interacts badly with the v2 `maxCompactionRatio` guard: a skeleton that is a large fraction of the original document triggers non-compacting runs and the `recoveryForced` path that this feature is meant to _avoid_.

**Decision:** Option B is **deferred** to a future major version (3.2.0+) where it can be designed against an actual mechanism. Option A at 3.1.18 is the ship target.

---

## Where to start (next steps)

Before implementation, these open questions need resolution:

1. **Pattern instruction wording** — schema should require non-empty instruction strings (the instruction IS the feature; empty instructions provide no biasing value). **RESOLVED.** Pattern-validated stricter typing optional.
2. **Synthetic header format** — single per-summary line listing matched paths, plugin-injected. **RESOLVED** (see Behavior contract item 3).
3. **`protectedTools` vs loose precedence** — `protectedTools` (tool-name glob) wins at the tool level; loose wins at the file-pattern level. Matches `lib/compress/protected-content.ts:130-137` gate order. **RESOLVED.**
4. **Debug logging** — emit a `logger.debug` line per compress call identifying matched paths + whether synthetic header was injected. Precedent: `lib/compress/pipeline.ts:152-159` warn pattern. **RESOLVED** yes.
5. **Per-pattern vs global rules** — object form supports both. Single-key object applies globally; multi-key object applies per-pattern. **RESOLVED** — no code needed.
6. **`experimental.customPrompts` interaction** — when a user overrides `compress-message.md`, the appended `MESSAGE_FORMAT_EXTENSION` and `buildLooseCompressionDescription` land AFTER the override. Plugin-controlled. **RESOLVED.** Document this in MY_README.
7. **Interaction with default `compress.protectedTools: ["task", …]`** — `task` outputs are already verbatim-appended by default. Loose compression's file-pattern matching does not conflict (no `filePath` in `task` inputs), but if a user adds `mcp_*` to `protectedTools` AND a `mcp_*` tool reads a matched file, both protections apply. Plugin-side suppression handles this. **RESOLVED.**

---

## Verification recipe (after implementation)

1. **Unit:** schema validates the new key; config merge handles empty + populated; `buildLooseCompressionDescription` returns expected strings for empty, single-key, multi-key configs; `getConfigKeyPaths` does NOT warn on user pattern keys.
2. **Integration:** construct a `ToolContext` with `compress.looseCompressionPatterns` set; call `createCompressMessageTool(ctx)`; assert the registered tool **description** contains the expected pattern strings (NOT the runtime prompt — the description IS what the agent sees).
3. **Precedence:** with `looseCompressionPatterns` AND `protectedFilePatterns` both set to match the same path, trigger a compress call; assert `appendProtectedTools` is NOT called with the matching part (`lib/compress/protected-content.ts:106-196` skip path).
4. **Synthetic header:** trigger a compress call with matched paths; assert the resulting summary block (or notification) starts with the `Loose-compressed: <paths>` header line.
5. **Regression:** all 165 existing tests still pass; no v2 protocol invariants broken; `recoveryForced` semantics unchanged.
6. **Smoke (post-restart):** restart OpenCode (config change), run `/dcp-compress` against a session containing a known plan file; observe the synthetic header + summary text in TUI.

---

## File / module inventory (post-implementation, fork 3.1.18)

| File                                  | Status           | Purpose                                                                |
| ------------------------------------- | ---------------- | ---------------------------------------------------------------------- |
| `lib/compress/loose-instructions.ts`  | NEW              | `buildLooseCompressionDescription(config)` helper                      |
| `lib/compress/message.ts`             | MODIFIED         | Append loose description at `:50`; prepend synthetic header post-hoc   |
| `lib/compress/range.ts`               | MODIFIED         | Same                                                                   |
| `lib/compress/protected-content.ts`   | MODIFIED         | Precedence suppression at `:130-137`; exclusion of loose-matched parts |
| `lib/config.ts`                       | MODIFIED         | New key + merge + validation + `getConfigKeyPaths` special case        |
| `dcp.schema.json`                     | MODIFIED         | New entry                                                              |
| `tests/loose-compression.test.ts`     | NEW              | Unit + integration tests                                               |
| `MY_README.md`                        | MODIFIED         | New section: "Loose Compression Patterns"                              |
| `MY_CHANGELOG.md`                     | MODIFIED         | New entry for 3.1.18                                                   |
| `MY_LOOSE_COMPRESSION.md` (this file) | MOVED to `docs/` | Final design doc                                                       |

---

## Related features

- **`MY_PROJECT_CONTEXT_PRESERVATION.md`** — a complementary, **independent** feature that uses the agent's own dispatch memory (rather than file-glob matching) to preserve project-context knowledge during compression. Project context preservation handles semantic preservation (subagent outputs + plans/docs read during discovery); loose compression handles deterministic structural preservation (file-glob-keyed). The two compose: both can be active at once without conflict — they target different detection signals and apply to different messages in the same compress call.
