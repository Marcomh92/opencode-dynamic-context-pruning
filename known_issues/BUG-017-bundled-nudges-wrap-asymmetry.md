# BUG-017: Bundled nudge files pre-wrap in the dcp-message-id tag; bundled system.ts does not

## Summary
Three bundled nudge files (`lib/prompts/context-limit-nudge.ts:1`, `lib/prompts/turn-nudge.ts:1`, `lib/prompts/iteration-nudge.ts:1`) are pre-wrapped in the dcp-message-id tag. The bundled `lib/prompts/system.ts:1-33` opens with raw text and does not reference the tag in its body. When `experimental.customPrompts` is disabled, `reload()` returns raw values verbatim, so the nudges already contain the wrapper but the system prompt does not. `wrapRuntimePromptContent` does not normalize on the disabled path, which means the tag is not appended for the system prompt.

## Location
- `lib/prompts/context-limit-nudge.ts:1`
- `lib/prompts/turn-nudge.ts:1`
- `lib/prompts/iteration-nudge.ts:1`
- `lib/prompts/system.ts:1-33`
- `lib/prompts/extensions/nudge.ts:33` (wraps at runtime)
- `lib/prompts/store.ts:267` (appends wrapper)

## Current vs Expected Behavior
**Current**: Three nudges are pre-wrapped; system prompt is not. The runtime wrapping logic is split between source files and the runtime extensions, with no single source of truth.
**Expected**: Pick one convention (wrap at runtime OR pre-wrap in source) and apply it consistently.

## Impact
- **Severity**: High (prompt source-of-truth divergence)
- Runtime: nudges may render with double wrappers or unwrapped trailing text, depending on the path taken.
- User-observable: visible formatting inconsistency in model prompt context.

## Reproduction
Edit `dcp.jsonc` to `"experimental": { "customPrompts": false }`. Inspect the actual `runtimePrompts.get("system")` vs `runtimePrompts.get("context-limit-nudge")` — only nudges have the wrapper.

## Suggested Fix
Either:
- Wrap nudges at runtime in `lib/prompts/extensions/nudge.ts` (remove pre-wrap from source files).
- Or, drop the runtime wrap and pre-wrap all six `PROMPT_KEYS` source files.

## Status
Open

## Cross-references
- Source investigator: prompts + UI + TUI + subagents
- Source finding ID: H-OVERRIDE-BUNDLE-ASYMMETRY-1
- Validator verdict: ✅ CONFIRMED
- Doc anchor: `docs/features/PROMPTS.md` System-prompt composition, `wrapRuntimePromptContent`

## Architect Review (2026-08-07)
- **Verdict**: PARTIAL (the pre-wrap asymmetry is CONFIRMED; the architect's REFUTED sub-claim is that `lib/prompts/system.ts:6` contains a literal tag — the file does not, the literal tag was in the report's summary text only)
- **Severity**: kept High (prompt source-of-truth divergence)
- **Correct Fix**: equivalent to report.
- **Bonus**: original title line was malformed (summary text concatenated into the title). Fixed 2026-08-07.