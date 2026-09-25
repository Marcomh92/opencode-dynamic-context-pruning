# BUG-098: Iteration nudge is appended to the agent's own assistant message, so the model treats it as past self-quoted text instead of a directive

## FIXED 2026-09-23

The architect picked the **Synthetic user-message injection** path from §Suggested Fix. The assistant-role branch of `injectAnchoredNudge` (`lib/messages/inject/utils.ts:213-264`) now inserts a synthetic user message at `messages[index + 1]` instead of appending the nudge to the assistant's prior text part. `createSyntheticUserMessage` (`lib/messages/utils.ts:18-70`) gained an optional 4th parameter `flagTextPartAsSynthetic: boolean = false`; the nudge site passes `true` so the synthetic text part carries `synthetic: true` and `isIgnoredUserMessage` (`lib/messages/query.ts:54`) skips it — without the flag, each nudge would reset `countMessagesAfterIndex` (iteration counter) and become the "last user message" for `protectUserMessages` last-N protection. The user-role branch is byte-identical. Idempotency moved from `endsWith` to an adjacent-message-id match against a deterministic seed `dcp_nudge:<nudgeType>:<anchorId>`; `applyRangeModeAnchoredNudge` / `applyMessageModeAnchoredNudge` now thread `nudgeType` and iterate `collectAnchoredMessages` results sorted by descending index so an insert at `index + 1` does not shift the indices of anchors still to be visited. No schema bump, no `FORK_SCHEMA_VERSION` change, compression-summary call site at `lib/messages/prune.ts:225` byte-identical (defaults the new 4th arg to false). Tests: 7 new in `tests/message-priority.test.ts` (range-mode assistant-anchored synthetic insert, multiple-text-parts single synthetic, `isIgnoredUserMessage` skip, `countMessagesAfterIndex` skip, user-anchor regression lock, no `mNNNN` tag / no priority-map entry, turn-nudge dual-mode), 1 new in `tests/synthetic-user-message-stability.test.ts` (nudge-seed byte-stability across re-fires), plus 2 previously-failing tests rewritten in `tests/message-priority.test.ts`. 604/604 tests pass, typecheck clean. New invariants `INV-P14` / `INV-P15` in `docs/features/PRUNING.md`; new design principle `DPP-019` in `docs/DESIGN_PRINCIPLES.md`.

## Summary

`injectCompressNudges` injects the iteration nudge by appending its text to the last text part of the most recent assistant message, joined by `\n\n`. There is no role boundary, no `<system>` envelope, no new user turn. The agent therefore parses the directive as ambient context, often ignores it, and never develops a signal that the tail is something to act on. The user-visible symptom: the soft nudge (and `context-limit-nudge` hard warning) accumulate at the end of the agent's own prior replies and the agent continues to iterate on the active thread instead of calling `compress`.

## Location

- `lib/prompts/iteration-nudge.ts:1-7` — `ITERATION_NUDGE` source text.
- `lib/messages/inject/inject.ts:34, 50-51, 133-139` — anchor selection: `lastMessage = findLastNonIgnoredMessage(messages)`; in the iteration path `lastMessage.message.info.id` is added to `state.nudges.iterationNudgeAnchors` whenever `messagesSinceUser >= iterationNudgeThreshold`.
- `lib/messages/inject/utils.ts:211-247` — `injectAnchoredNudge` dispatches on `message.info.role`. For `assistant`, when a text part exists, it calls `appendToTextPart(part, nudgeText)`.
- `lib/messages/utils.ts:106-129` — `appendToTextPart` mutates the part in place:
    ```ts
    const baseText = part.text.replace(/\n*$/, "")
    part.text = baseText.length > 0 ? `${baseText}\n\n${normalizedInjection}` : normalizedInjection
    ```
- `lib/messages/utils.ts:122-124` — exact-tail idempotency (`endsWith`) prevents re-append but does not change the nature of the injection: once any tail nudges sit at the end of the assistant's prior reply, every subsequent transform sees them as part of `lastMessage`'s own text.

The same code path also runs for `turn-nudge` (`lib/prompts/turn-nudge.ts`) and `context-limit-nudge` (`lib/prompts/context-limit-nudge.ts`); all three prompts share the same injection mechanic.

## Current vs Expected Behavior

**Current:** `output.messages` shipped to the LLM contains, as one assistant message:

```
<whatever the agent just said>

You've been iterating for a while after the last user message. ...
```

The tail is the assistant's own words. The model has no signal that it is a directive framed as outbound content. Empirically the agent parses it as "ambient context, can ignore," holds an active investigation thread open, and accumulates more tool output and reasoning while the closed-loop content that should have been compressed stays in the context.

**Expected:** The nudge should arrive where the model reads directives (system-prompt tag, new synthetic user turn, or any other role boundary), so the model's behaviour shifts when the threshold is crossed. The injection should be observable to the agent as "this is a directive from the system" rather than "this is a continuation of my last reply."

## Impact

- **Severity:** High for the feature's stated purpose. The entire iteration/turn/context-limit nudge pipeline is built to push the model toward compressing closed content. Today, the nudges are visible text that the model can ignore indefinitely without consequence. Without a behavior change, the nudge configurability (`iterationNudgeThreshold`, `nudgeFrequency`, etc.) is mostly cosmetic.
- **User-observable:** the agent does not call `compress` even when `iterationNudgeThreshold` is repeatedly tripped. Context accumulates closed-loop content (reviewer reports, prior turns, debug byte-dumps) until a `context-limit-nudge` fires, and even the hard warning may be ignored for the same reason.
- **Runtime:** no crash, no invariant broken. The mutation is in place and idempotent.
- **Why it slipped through:** the original design treats "add a directive to the message stream" as equivalent to "append the directive to the message stream." The agent's role in the conversation is not modeled in the injection — only its text content is.

## Reproduction (synthesized from a real session retrospective)

1. Configure `dcp.jsonc` with default iteration-nudge settings.
2. Run a multi-turn session in which the agent iterates on an active debugging thread.
3. After `iterationNudgeThreshold` messages since the last user message, inspect `output.messages` for the most recent assistant message.
4. The last few lines of that assistant message's first text part contain the iteration-nudge text, concatenated after the assistant's prior reply with a `\n\n` separator.
5. Observe the agent's next turn: the tail does not produce a `compress` tool call. The agent continues to iterate, treating the tail as ambient context.

Agent's own retrospective (paraphrased from a session log): "I got the soft nudge ~6 times during the session. I did not act on any of them. I treated each as 'not yet, still mid-investigation.' Honest assessment: from the third nudge onward, the closed content (4 reviewer reports, 3 implementer reports, synthesis, spec updates) was exactly what the nudge was for, and I ignored it because the directive sat in my own past reply with no role boundary telling me to act."

## Suggested Fix

Three viable designs. Each preserves the user's ability to override the nudge text. Each trades off placement against cache-bust characteristics. Detailed comparison to be produced by the deep-architect review pointed at this bug report.

1. **Synthetic user-message injection.** Insert a new synthetic user message into `output.messages` containing the nudge text. Synthetic user messages are a recognized DCP construct (INV-P2, `lib/messages/utils.ts:33-48`) and are skipped from compression summaries (INV-P7). Pros: clean role boundary, the model reads it as a directive; nudges do not bloat the assistant's previous reply. Cons: every nudge fires a synthetic user-message turn, which inflates `toolIdList` / message count metrics and may shift priority-map output; cache-bust characteristics change.
2. **System-prompt tag injection.** Append the nudge text wrapped in a `<dcp-nudge>...</dcp-nudge>` (or pre-existing `<dcp-context-limit-nudge>` analogue) to the last system message via the `experimental.chat.system.transform` hook (already used for the protected-tools extension; see `docs/features/PROMPTS.md:47-57`). Pros: minimal cache impact (the system prompt is the natural prefix-anchor), directive lands where the system prompt lands, no message-count inflation. Cons: requires extending the system-prompt hook surface; per-feature runtimes may need to forward nudge decisions through `renderSystemPrompt`; the tag must be visible to the LLM but skipped from the user-visible prompt.
3. **Role-respecting append.** Detect when `lastMessage.info.role` is `assistant` and instead of appending the nudge to its text part, push the nudge as the first text part of a NEW assistant message positioned just before the next real user turn. Pros: keeps "nudge lives on an assistant boundary" intact, no synthetic-user-message inflation. Cons: introduces a synthetic-looking assistant message with no tool calls; may confuse downstream priority-map / nudge-anchor logic that assumes message identity is stable.

Decision required. Maintainer / architect should pick one (or a hybrid) before implementation.

## Status

FIXED 2026-09-23 (tracked 2026-09-23, surfaced via user-reported agent retrospective and direct code audit of `lib/messages/inject/utils.ts:211-247` + `lib/messages/utils.ts:106-129`).

## Resolution

Landed the **Synthetic user-message injection** design from §Suggested Fix (option 1). Assistant-anchored nudges now ride a synthetic user message inserted at `messages[index + 1]`; the role boundary is what makes the directive readable. User-anchored nudges stay on `appendToLastTextPart`. The synthetic text part carries `synthetic: true` (new 4th arg to `createSyntheticUserMessage`) so `isIgnoredUserMessage` skips it — iteration counters and `protectUserMessages` last-N lookups are unaffected. Idempotency is via adjacent-message-id match against deterministic seed `dcp_nudge:<nudgeType>:<anchorId>`. See top of file for the full change list.

## Cross-references

- `lib/prompts/iteration-nudge.ts:1-7` — `ITERATION_NUDGE` source.
- `lib/prompts/turn-nudge.ts:1-11` — `TURN_NUDGE` source (same injection mechanic).
- `lib/prompts/context-limit-nudge.ts` — `CONTEXT_LIMIT_NUDGE` source (same injection mechanic).
- `lib/messages/inject/inject.ts:34, 50-51, 107, 119-146` — anchor selection logic (unchanged by the fix).
- `lib/messages/inject/utils.ts:213-264` — `injectAnchoredNudge` role dispatch (rewritten: assistant branch inserts synthetic user message at `index + 1`).
- `lib/messages/inject/utils.ts:306-351` — `applyRangeModeAnchoredNudge` / `applyMessageModeAnchoredNudge` now thread `nudgeType` and iterate descending-index.
- `lib/messages/utils.ts:18-70` — `createSyntheticUserMessage` with the new optional 4th arg `flagTextPartAsSynthetic`.
- `lib/messages/utils.ts:114-137` — `appendToTextPart` (`\n\n` join + `endsWith` idempotency) now used only by `injectMessageIds` and the user-anchor nudge path; the assistant-anchor nudge path no longer reaches it.
- `lib/messages/query.ts:38-63` — `isIgnoredUserMessage` (the gate that respects the new `synthetic: true` flag).
- `lib/messages/prune.ts:225` — compression-summary synthetic call site, byte-identical (defaults 4th arg to false).
- `tests/message-priority.test.ts` — 7 new tests + 2 rewritten under `BUG-098:` prefix.
- `tests/synthetic-user-message-stability.test.ts` — 1 new test pinning nudge-seed byte-stability.
- `docs/features/PRUNING.md:41-59` — INV-P14 (assistant-anchored synthetic delivery) and INV-P15 (deterministic-seed idempotency + reverse-index iteration) added; INV-P2 updated with the optional 4th arg; INV-P12 line numbers refreshed.
- `docs/DESIGN_PRINCIPLES.md:117-125` — new DPP-019 codifying "plugin directives ride the user role; assistant text is never directive-bearing".
- `docs/MASTER.md` glossary — new "Synthetic user message" entry distinguishes origin-(a) compression summary from origin-(b) nudge and states the flag rule.
