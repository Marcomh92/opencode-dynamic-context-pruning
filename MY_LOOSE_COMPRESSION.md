# Loose Compression Patterns — Feature Proposal

**Status:** Draft. Implementation plan TBD.
**Target version:** Fork `3.1.18` (Option A) or `3.2.0` (Option B).
**Branch:** `fork/dcp-3.1.18-lcp` (when implementation starts).

---

## What

A new config key, `compress.looseCompressionPatterns`, that selects markdown files (plans, docs, reference material) for **loss-aware compression** during `compress` tool calls. Matched files get summarized, but with explicit rules preserving the markdown structural skeleton and biasing the model toward keeping task-relevant content verbatim while aggressively summarizing task-irrelevant sections.

Precedence over existing mechanisms:

- If a file path matches **`compress.looseCompressionPatterns`** AND **`protectedFilePatterns`**, the loose pattern wins (loose compression is applied, full-output-append is NOT).
- If a file path matches **`compress.looseCompressionPatterns`** AND its body contains `<protect>...</protect>` tags AND **`compress.protectTags`** is enabled, the loose pattern still wins (tag regions are summarized along with the rest of the document; no verbatim preservation).

The behavior of `protectedFilePatterns` and `compress.protectTags` for files NOT matched by the loose pattern is unchanged.

## Why

A typical plan or reference doc is 30–80k tokens. The current compress path has two unsatisfactory outcomes for these:

1. **Uncontrolled compression** — the model summarizes the whole document, often losing ordered step lists, explicit constraints, file paths, and section structure. High fidelity loss.
2. **Full protection via `protectedFilePatterns`** — the document is appended verbatim to the summary block. Content survives, but every compress call counts as non-compacting (ratio = 1.0), tripping the v2 `nonCompactingRunCount` → `recoveryForced` path after 3 such compresses.

A middle ground is needed: preserve enough structure and task-relevant content that the model can keep working, but allow real compression so the v2 ratio stays under `maxCompactionRatio`.

## How (high-level)

The feature is structurally identical under both implementation options. The differences are where in the prompt the rules land and how much of the document is pre-processed before the model sees it.

> **Model identity.** Summarization is performed by the **current agent model** (kimi in your setup) — not a separate LLM call. The plugin never invokes an LLM itself; the agent sees the summary prompt + the messages to compress, writes the summary as part of its `compress` tool call, and the plugin persists it (see `lib/compress/message.ts:114` — `plan.entry.summary` is agent-written, not plugin-generated). This means the agent has **full session context** when deciding what to preserve: the original PLAN.md it read, prior compressions, your current user goal. No task-context plumbing is required.

### Behavior contract (shared by both options)

For each tool part inside a compressed range whose `state.input` contains a `filePath` matching a glob in `compress.looseCompressionPatterns`:

1. **Structural skeleton is preserved.** All `#` / `##` / `###` headers, fenced code blocks (` ``` `), table headers + row dividers, and ordered list item numbers are kept in the summary output.
2. **Three-tier content rules applied by the model:**
   - **General information** (background, references, side-notes): preserved mostly verbatim; light compression allowed.
   - **Sections relevant to the active task**: preserved mostly verbatim.
   - **Sections irrelevant to the active task**: heavily compressed — a 1–3 line summary explaining the section's topic and focus, no verbatim content.
3. **Synthetic header injected at the top** of the compressed file content in the summary block:
   ```
   Compressed summary of `<path/to/file.md>`. Some sections may have been heavily summarized. Re-read those sections if needed.
   ```
   `<path/to/file.md>` is the actual file path. The synthetic line is appended by the plugin after the model returns the summary; the model does not write it.

### Config shape

```jsonc
{
    "compress": {
        "looseCompressionPatterns": {
            "**/plans/**/*.md": "Preserve all step numbers and their ordering. Preserve explicit constraints and prerequisites. Compress explanatory prose.",
            "**/docs/**/*.md":    "Preserve API signatures, config key names, and code identifiers. Compress introductory prose; preserve everything after the first heading."
        }
    }
}
```

- Object form (pattern → instruction string) is preferred over a string array of patterns. The instruction string is appended to the summary prompt, giving per-pattern guidance. A string array of plain globs (no instructions) is acceptable but loses the biasing value.
- Schema: `additionalProperties: { type: "string" }` (or pattern-validated if stricter typing is wanted).
- Default: `{}` (empty — no loose compression applied; existing behavior preserved everywhere).

---

## Option A — Prompt-injection

**Approach:** The plugin appends per-pattern instructions to the summary prompt. The model sees the original document content AND the additional rules, and decides what to keep, summarize, or remove.

**Key code anchors:**

| Anchor | What it is |
|---|---|
| `lib/prompts/compress-message.ts:1-43` | Static summary prompt for message-mode compress |
| `lib/prompts/compress-range.ts` | Sibling prompt for range-mode compress (read full file before editing) |
| `lib/compress/message.ts:113` | Where the prompt is passed to the model (`summaryWithPromptInfo`) |
| `lib/compress/range.ts:60` | Same for range mode |
| `lib/compress/protected-content.ts:128-137` | Where file-pattern matching currently gates `protectedFilePatterns` (mirror this) |
| `lib/protected-patterns.ts:61-99` | `getFilePathsFromParameters` — extracts paths from tool input |
| `lib/protected-patterns.ts:101-106` | `isFilePathProtected` — glob match |
| `lib/config.ts:111-147` | Existing pattern for adding a new compress.* key (clone) |
| `dcp.schema.json:131-302` | Existing compress.* schema block (clone entry) |

**Implementation sketch:**

1. New config key + schema entry + merge helper (~25 lines).
2. New module `lib/compress/loose-instructions.ts` exporting `buildLooseCompressionPrompt(parts, patterns): string`. Iterates tool parts in the compressed range, matches `filePath` against patterns via existing `isFilePathProtected`, returns the joined instructions. ~40 lines.
3. Inject the returned string into the summary prompt in both `message.ts:113` and `range.ts:60`. ~10 lines.
4. Synthetic-line injection: append after the model returns its summary, in the same code path that currently appends protected outputs. ~10 lines.
5. Tests: pattern match (single + multi), no-match, empty config, precedence over `protectedFilePatterns` / `protectTags`. ~80 lines.

**Total estimate:** ~150 lines. Fork bumps to **3.1.18** (patch).

**Trade-offs:**
- ✓ Cheap. Few new code paths.
- ✓ Reuses existing prompt infrastructure.
- ✓ Per-pattern instruction lets users tune behavior to document type.
- ✗ Model-compliance dependent. The model can still decide to drop content the rules said to keep. In practice compliance is high (~90%) when rules are specific.
- ✗ No deterministic structure preservation — the structural skeleton rule relies on the model respecting markdown conventions. A misbehaving model could paraphrase headers.

---

## Option B — Structural preservation

**Approach:** Before the model sees the document, the plugin extracts the markdown structural skeleton (headers, fenced code blocks, table headers/rows, ordered list numbers) and replaces prose with `[STRUCTURE_PRESERVED]` placeholders. The model receives a marked-up document containing structure-only regions and prose-only regions. Its summary must preserve the structure regions verbatim and summarize the prose regions.

**Key code anchors (in addition to Option A's):**

| Anchor | What it is |
|---|---|
| `lib/protected-patterns.ts:1-129` (full file) | Existing patterns module — good template for a sibling module |
| New file `lib/compress/markdown-structure.ts` | Structure extractor (to be created) |
| New file `lib/compress/loose-compression.ts` | Glue between extractor + prompt builder (to be created) |

**Implementation sketch:**

1. **Same as Option A** for config key, schema, synthetic-line injection.
2. New module `lib/compress/markdown-structure.ts`:
   - `extractStructure(text): { preserved: string, summarizable: string, sectionMap: Record<sectionId, sectionTitle> }` — ~100-150 lines.
   - Uses regex-based detection for `^#{1,6} ` headers, `^``` ` fenced code blocks, `^\|.*\|` table rows, `^\d+\.` ordered list items.
   - Returns a marked-up version of the document where preserved regions are tagged with sentinel lines the prompt can reference, and summarizable regions are stripped of their structure.
3. New module `lib/compress/loose-compression.ts`:
   - `applyLooseCompression(text, patterns): { preserved: string, summarizable: string, instructions: string }` — ~80-100 lines.
   - Calls the extractor, builds per-pattern instructions, returns both halves for the prompt builder.
4. Modified `lib/compress/message.ts:113` and `range.ts:60` — pass the marked-up content to the model, with prompt text describing the sentinel convention.
5. Synthetic-line injection: same as Option A.
6. Tests: structure extraction (headers, code, tables, lists), fallback for non-markdown content, no-match path, precedence. ~150 lines.

**Total estimate:** ~400-500 lines. Fork bumps to **3.2.0** (minor — prompt format changes).

**Trade-offs:**
- ✓ Deterministic structure preservation — headers, code blocks, table headers, list numbers are guaranteed to survive in the summary.
- ✓ Better fits the three-tier content rules — the structure extractor can mark section boundaries, giving the model reliable "this is section X, decide its tier" signals.
- ✓ The synthetic header line and "re-read if needed" guidance become fully reliable (not model-dependent).
- ✗ Fragile on non-markdown content. A `.txt` file or a `cat` of binary-ish output has no structure to extract; needs a graceful "no structure found → fall back to Option A behavior" path.
- ✗ Heavier. ~3× the line count of Option A.

---

## Where to start (next steps)

Before either option can be implemented, these open questions need resolution:

1. **Pattern instruction wording** — should the schema validate that instructions are non-empty strings, or allow empty (pattern-only, no instruction)? Recommendation: non-empty, model biasing is the whole point.
2. **Synthetic line format** — exact wording, placement (top of summary block vs top of each file's section), localization. The proposed wording above is a draft; final wording decided at implementation time.
3. **Precedence semantics under conflict** — if a file is in `looseCompressionPatterns` AND `protectedTools` (a tool-name glob, not file pattern), who wins? Recommendation: `protectedTools` wins for tool-name level (e.g., user said "never summarize `mcp_*` outputs"), `looseCompressionPatterns` wins for file-pattern level. Document the resolution order in MY_README.
4. **Logging** — should compress calls that applied loose compression emit a debug log line identifying which files matched? Recommendation: yes, gated on `debug: true`.
5. **Per-pattern vs global rules** — should we allow a single instruction that applies to ALL matched files (no per-pattern customization)? Recommendation: optional. If `looseCompressionPatterns: { "**/*.md": "preserve structure, summarize prose" }` (single key), apply globally. If multiple keys, per-pattern. The current object form already supports both.

---

## Verification recipe (after implementation)

1. **Unit:** schema validates new key; config merge handles empty + populated; precedence rules produce expected routing.
2. **Integration:** create a fixture `read` of a markdown plan file with 3 sections (general, task-relevant, task-irrelevant); trigger compress on a range that includes it; assert (a) summary contains all section headers, (b) task-irrelevant section is ≤3 lines, (c) synthetic header line is prepended.
3. **Regression:** ensure all 165 existing tests still pass; no v2 protocol invariants broken; `recoveryForced` no longer triggered by loose-compressed files at default `maxCompactionRatio: 0.7`.
4. **Smoke:** restart OpenCode, run `/dcp-compress` against a session containing a known plan file, observe summary text in TUI.

---

## File / module inventory (post-implementation, fork 3.1.18 or 3.2.0)

| File | Status | Purpose |
|---|---|---|
| `lib/compress/loose-instructions.ts` | NEW (Option A only) | Build per-pattern prompt instructions |
| `lib/compress/markdown-structure.ts` | NEW (Option B only) | Extract markdown structural skeleton |
| `lib/compress/loose-compression.ts` | NEW (Option B only) | Glue: extractor + prompt builder |
| `lib/compress/message.ts` | MODIFIED | Inject loose instructions into summary prompt |
| `lib/compress/range.ts` | MODIFIED | Same |
| `lib/compress/protected-content.ts` | MODIFIED | Synthetic header line injection after summary |
| `lib/config.ts` | MODIFIED | New key + merge + validation |
| `dcp.schema.json` | MODIFIED | New entry |
| `tests/loose-compression.test.ts` | NEW | Unit + integration tests |
| `MY_README.md` | MODIFIED | New section: "Loose Compression Patterns" |
| `MY_CHANGELOG.md` | MODIFIED | New entry for 3.1.18 or 3.2.0 |
| `LOOSE_COMPRESSION_PROPOSAL.md` (this file) | MOVED to `docs/` | Final design doc |

---

## Related features

- **`MY_PROJECT_CONTEXT_PRESERVATION.md`** — a complementary, **independent** feature that uses the agent's own dispatch memory (rather than file-glob matching) to preserve project-context knowledge during compression. Project context preservation handles semantic preservation (subagent outputs + plans/docs read during discovery); loose compression handles deterministic structural preservation (file-glob-keyed, markdown skeleton extraction under Option B). The two features compose: both can be active at once without conflict.