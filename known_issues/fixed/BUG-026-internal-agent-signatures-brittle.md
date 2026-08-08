# BUG-026: `INTERNAL_AGENT_SIGNATURES` substring-match list is brittle

## Summary

`isInternalAgentSystem` requires every system prompt to contain one of four hardcoded substrings. OpenCode's internal agents are versioned; any reword in the prompt silently bypasses the gate. A user prompt that happens to contain "You are a title generator" would also be misclassified.

## Location

- `lib/hooks.ts:43-58`

## Current vs Expected Behavior

**Current**: Fixed substring list; no version-sensitivity or fallback.
**Expected**: Either extend the signature list with locale variants, pattern-match with a regex, or check the agent name (if OpenCode exposes one in the input) instead of the system prompt.

## Impact

- **Severity**: Medium (DPP-009 robustness)
- Runtime: depends on whether the model's version pin keeps the signature strings.
- User-observable: an OpenCode upgrade that rewords its internal-agent prompts would silently leak DCP transforms into title generators.

## Reproduction

Inspect `lib/hooks.ts:43-58`. The list is hardcoded; any drift in upstream OpenCode bypasses the check.

## Suggested Fix

Extend the signature list with one or two drift candidates and add a `logger.debug` when no signature matches:

```ts
const INTERNAL_AGENT_SIGNATURES = [
    "You are a title generator",
    "You are a helpful AI assistant tasked with summarizing conversations",
    "You are an anchored context summarization assistant for coding sessions",
    "Summarize what was done in this conversation",
    // ponytail: Add new upstream signatures here as OpenCode drifts.
]
```

Plus, in `isInternalAgentSystem`, when no signature matches, `logger.debug("System prompt did not match any internal-agent signature", { length: prompt.length, preview: prompt.slice(0, 80) })`. OpenCode's `input.agent` is not exposed in the SDK; agent-name check is not feasible today.

## Status

Fixed 2026-08-07

## Resolution

Extended `INTERNAL_AGENT_SIGNATURES` with drift candidates and added `logger.debug` on no-match at `lib/hooks.ts:43-58`.

## Cross-references

- Source investigator: hooks + messages
- Source finding ID: HOOK-INTERNALAGENT-2 (companion: BUG-008)
- Validator verdict: ✅ CONFIRMED
- Doc anchor: `docs/DESIGN_PRINCIPLES.md` DPP-009

## Architect Review (2026-08-07)

- **Verdict**: CONFIRMED
- **Severity**: kept Medium (DPP-009 robustness invariant)
- **Correct Fix**: extend the signature list (option 2) and add a debug log; the `some`/agent-name alternatives are not feasible today (`every` is intentional, `input.agent` not exposed).
- **Critique of report's fix**: the first suggested fix (`some` instead of `every`) is correctly flagged as wrong by the report itself.
- **Bonus**: compare to BUG-019 (`clampers` untested) — neither gate has a regression test.
