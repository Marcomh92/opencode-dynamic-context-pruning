# BUG-095: `compress.stripPatterns` runs in the transform pipeline and strips synthetic blocks from the LLM-bound context, not just the compression summary

## Summary

`compress.stripPatterns` was introduced (commit `61b3f1a5`, 2026-08-14) to strip synthetic blocks like `<available-skills>...</available-skills>` from the protected-text section of compression summaries. It is wired into the transform hook pipeline at step 2 in `lib/hooks.ts:248-254`, where it mutates `part.text` / completed `state.output` **in place** on the `output.messages` array. Because that same array is forwarded to the model on every LLM call, the agent loses the block in normal conversation too — the synthetic injection is invisible to the LLM that is supposed to be reasoning about it.

## Location

- `lib/hooks.ts:254` — `stripPatterns(output.messages, config.compress.stripPatterns)` inside the 13-step transform pipeline
- `lib/messages/strip-patterns.ts:40-81` — `stripPatterns(messages, patterns)` mutates `part.text` for text parts and `part.state.output` for completed tool parts in place
- `lib/compress/protected-content.ts:12-50` (`appendProtectedUserMessages`) and `52-104` (`appendProtectedPromptInfo`) — the two compression-summary builders where the strip should actually run, and currently do not
- `lib/compress/range.ts:134-148` and `lib/compress/message.ts:110-116` — compress tool call sites that would need to forward `ctx.config.compress.stripPatterns` to those builders
- `docs/features/PRUNING.md:7-22` (pipeline table) and `:60` (INV-P7 note), `docs/features/OPENCODE_INTEGRATION.md:63`, `docs/CONFIGURATION.md:44`, `docs/PATTERNS.md:31`, `docs/PERFORMANCE.md:12` — all assert the current wrong scope

## Current vs Expected Behavior

**Before:** `stripPatterns` runs as pipeline step 2 in `lib/hooks.ts:254` and mutates `part.text` / `part.state.output` on the in-flight `output.messages` array. The LLM never sees the synthetic block.

**Expected:** `compress.stripPatterns` applies **only** to the verbatim user-message dump that the compress tools append to compression summaries (`appendProtectedUserMessages`, `appendProtectedPromptInfo` in `lib/compress/protected-content.ts`). The agent keeps the block in its live context, and only the protected section of a compression summary is sanitized.

The intent was documented in `docs/features/OPENCODE_INTEGRATION.md:63` ("Content-level strip") but the implementation chose the wrong hook — pipeline step 2 (LLM-bound context) instead of the protected-text builders (compression-summary-only).

## Impact

- **Severity:** Medium. Functional regression: the synthetic block is invisible to the agent during normal conversation. The user-visible symptom is that the agent behaves as if `<available-skills>` / `<available-subagents>` injections do not exist when they should inform its reasoning about available capabilities.
- **Runtime:** no crash, no invariant broken. The mutation is in place and idempotent; only the visibility scope is wrong.
- **User-observable:** the agent ignores synthetic-block content it was supposed to consume (e.g. ignores the available skills list, ignores available subagents) when `compress.stripPatterns` is configured with the corresponding tag.
- **Why it slipped through:** the original design assumed the LLM never needed to see the block — the strip was positioned as a defensive layer that "guarantees the synthetic block never reaches the model context — and therefore cannot reach a compression summary via any other path" (`docs/features/OPENCODE_INTEGRATION.md:63`). That assumption is wrong: the LLM needs the block to reason about available skills/subagents. The strip should sanitize the protected-text section of compression summaries only.

## Reproduction

1. Add `compress.stripPatterns: ["<available-skills>"]` to `dcp.jsonc` and activate a third-party plugin that injects `<available-skills>...</available-skills>` as a user message (e.g. `opencode-agent-skills`).
2. Trigger a turn where the agent would normally invoke one of the listed skills (e.g. ask the agent to use a skill the injection advertised).
3. The agent does not see the skill in its context and responds as if it did not exist.
4. Same outcome occurs for any non-synthetic user message containing a `<name>...</name>` block matched by the configured pattern — the LLM sees the message with the block stripped.

## Suggested Fix

Take `stripPatterns` out of the transform pipeline and call a new single-string helper from the two compression-summary builders that own the verbatim user-message dump.

1. Add a new `stripText(text: string, patterns: readonly string[]): string` export to `lib/messages/strip-patterns.ts` next to the existing `compileStripPattern`. It compiles the patterns once and applies each compiled regex to the input string. Returns the input unchanged when `patterns` is empty.
2. Add a `stripPatterns: readonly string[] = []` parameter to `appendProtectedUserMessages` and `appendProtectedPromptInfo` in `lib/compress/protected-content.ts`. Apply `stripText(part.text, stripPatterns)` before pushing the user text into `userTexts`, and apply `stripText` to each `extractProtectedPromptInfo(part.text)` result before pushing into `protectedTexts`.
3. Forward `ctx.config.compress.stripPatterns` from the compress tool call sites: `lib/compress/range.ts:134-148` (both helpers) and `lib/compress/message.ts:110-116` (`appendProtectedPromptInfo` only — message mode does not call `appendProtectedUserMessages`).
4. Remove `stripPatterns` from the transform pipeline:
    - Drop the import in `lib/hooks.ts` (top-of-file `import { ... } from "./messages"`).
    - Remove the call at `lib/hooks.ts:254` along with the explanatory comment.
5. Keep the existing in-place `stripPatterns(messages, patterns)` function and its 14-test contract in `tests/strip-patterns.test.ts` for now (the test pins the `compileStripPattern` regex shape). Mark it with a `ponytail:` ceiling comment naming it as dead-at-runtime after the BUG-095 fix; delete it once `stripText` has direct regex-shape coverage.
6. Update the docs to describe the new scope:
    - `docs/features/PRUNING.md`: drop step 2 from the pipeline table (pipeline is now 12 steps); rewrite the INV-P7 paragraph to describe the protected-section injection as the strip's only call site.
    - `docs/features/OPENCODE_INTEGRATION.md:63`: rewrite the content-level-strip bullet.
    - `docs/CONFIGURATION.md:44`: rewrite the "Strip patterns" location paragraph.
    - `docs/PATTERNS.md:31`: drop the `stripPatterns` line from the in-place-mutation list.
    - `docs/PERFORMANCE.md:12`: move stripPatterns off the hot transform path; cost is paid only when a compress tool actually runs.
    - `lib/messages/strip-patterns.ts`: rewrite the function's doc comment to describe the new call sites.

## Status

Open

## Resolution

_Filled in once the fix lands._

## Cross-references

- `docs/features/PRUNING.md` INV-P7 — `isIgnoredUserMessage` is the canonical skip gate; BUG-094 fixes the flag-level exclude for fully-synthetic messages. BUG-095 handles the residual inline-block case via the protected-section sanitization.
- BUG-094 — `isIgnoredUserMessage` does not recognise `part.synthetic`. Fixed 2026-08-13. BUG-095 is orthogonal: it handles the case where the message itself is non-synthetic but contains an inline synthetic-shaped block (e.g. `<available-skills>...</available-skills>` inside a real user message).
- `lib/messages/strip-patterns.ts:40-81` — the function whose scope is wrong; after the fix it is dead at runtime but kept for its 14-test contract on `compileStripPattern`.
- Commit `61b3f1a5` (2026-08-14) "feat: add stripPatterns configuration for message processing" — introduced the config key and the pipeline call; BUG-095 is the regression introduced by that change.
