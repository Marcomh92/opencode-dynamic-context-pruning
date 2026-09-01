# BUG-096: `compress.protectUserMessages` protects all user messages verbatim; the user wants only the last N to be protected

## Summary

`compress.protectUserMessages: true` causes every real user message in the compression range to be appended verbatim to the compression summary. A user who copy-pastes a 10k-token log file into a prompt and then triggers a compress of a 50-message range pays the full 10k-token cost on every future materialization, forever — the verbatim dump dominates the protected section. The user's request is to replace the "all" semantics with "last N", where N is a new config key, so the verbosity budget is bounded to the most recent user prompts.

## Location

- `lib/messages/query.ts:65-76` — `isProtectedUserMessage(config, message)` was a per-message boolean check; it returned true for any real user message when `protectUserMessages: true`. Needs to be replaced with a per-message membership check against a precomputed set of "the last N real user messages" (`computeProtectedUserMessageIds`).
- `lib/compress/protected-content.ts:13-52` — `appendProtectedUserMessages(summary, selection, searchContext, state, enabled, stripPatterns)` iterates every message in the range and pushes the stripped text into `userTexts`; the whole array is appended verbatim. Needs a `count` cap.
- `lib/config.ts:38` — `CompressConfig.protectUserMessages: boolean` — needs a companion `protectUserMessagesCount?: number`.
- `lib/compress/range.ts:134-141` — only range-mode call site of `appendProtectedUserMessages`; needs to forward the new count from the config.
- `lib/messages/priority.ts:35`, `lib/messages/inject/inject.ts:184`, `lib/compress/message-utils.ts:232` — three call sites of `isProtectedUserMessage` that need to compute the protected set first and then pass it.
- `dcp.schema.json:251` — schema entry for `protectUserMessages`; needs a new `protectUserMessagesCount` entry.

## Current vs Expected Behavior

**Before:** `protectUserMessages: true` protects every real user message in the range (range mode verbatim dump) and every real user message in the session (message mode BLOCKED tag, priority map exclusion).

**Expected:** `protectUserMessages: true` protects only the last N real user messages, where N is `compress.protectUserMessagesCount` (default 1, clamped to >= 1). The "last N" is taken from the caller-supplied message list:

- range mode summary builder: `selection.messageIds` (the compression range)
- message mode priority map and BLOCKED tag: the full session message list passed to `buildPriorityMap` / `injectMessageIds`
- message mode `resolveMessage` (rejects individual compress attempts): the full session via `searchContext.rawMessages`

User messages that are currently filtered out (synthetic, `part.ignored`) do not count toward N. Messages whose text is fully consumed by `compress.stripPatterns` also do not count toward N — but **only in range mode**. In message mode, `stripPatterns` is not consulted by the priority map / BLOCKED tag path because no verbatim text is rendered; a stripped-emptied user message still receives the BLOCKED tag if it falls within the last N. See `docs/CONFIGURATION.md` "Last-N user message protection" for the full mode asymmetry.

## Impact

- **Severity:** Low-Medium. User-visible only when `compress.protectUserMessages: true` AND a user message in the range is large (e.g. copy-pasted log file). The protected section of the compression summary would dominate the summary's token budget, defeating the purpose of compression.
- **Runtime:** no crash, no invariant broken. Only the protected-section content size changes.
- **User-observable:** with the fix, a `protectUserMessages: true` user with a 10k-token log paste gets only the most recent N user messages in the protected section, not all of them. Older log pastes are summarized like any other content.
- **Default behavior change:** upgrading from v3.1.19 to v3.1.20 with `protectUserMessages: true` and no `protectUserMessagesCount` set changes the default from "all" to "1". This is a deliberate behavior change requested by the user. Set `protectUserMessagesCount: 9999` to opt back into the legacy "all" behavior.

## Reproduction

1. Enable `compress.protectUserMessages: true` in `dcp.jsonc`.
2. In the same session, send 5 user messages: the first is a 5k-token log paste, the next four are short follow-ups.
3. Trigger a `compress` tool call with a range that covers all 5 user messages.
4. Inspect the summary's "The following user messages were sent in this conversation verbatim:" section — it contains all 5 messages (the 5k-token log paste is the bulk).

## Suggested Fix

1. Add a new config key `compress.protectUserMessagesCount: number` to `CompressConfig`. Default 1. Validate `>= 1` and clamp to 1 in `clampMin1`. Add to `VALID_CONFIG_KEYS`, `defaultConfig`, `mergeCompress` (with `clampMin1`), and `dcp.schema.json` (with `minimum: 1`).
2. Add a helper `computeProtectedUserMessageIds(config, messages): Set<string>` in `lib/messages/query.ts`. Returns the set of message IDs that correspond to the last N real user messages in `messages`. Empty set when `protectUserMessages` is false. The walk is right-to-left, stops at N hits. Synthetic/ignored user messages (per `isIgnoredUserMessage`) are skipped and do not count.
3. Change `isProtectedUserMessage` to take a third required parameter `protectedMessageIds: ReadonlySet<string>`. The function is now a pure membership check. Keep the `mode === "message"` gate for backward compat (range mode still does not emit the BLOCKED tag — protection in range mode is the verbatim dump only).
4. Change `appendProtectedUserMessages` to take a `count: number` parameter (default `Number.POSITIVE_INFINITY` to keep the legacy "all" behaviour for direct callers in tests). After collecting `userTexts`, slice the last N. Also add a check that the stripped text is non-empty before pushing to `userTexts` — messages whose content is fully consumed by `stripPatterns` are filtered out AND do not count toward N.
5. Update the four call sites:
    - `lib/compress/range.ts`: pass `Math.max(1, Math.floor(ctx.config.compress.protectUserMessagesCount ?? 1))` as the count.
    - `lib/messages/priority.ts`: compute the set from the full `messages` array at the start of `buildPriorityMap`, pass it per-message.
    - `lib/messages/inject/inject.ts`: compute the set from the full `messages` array at the start of `injectMessageIds`, pass it per-message.
    - `lib/compress/message-utils.ts`: compute the set from `searchContext.rawMessages` at the start of `resolveMessages`, pass it down to `resolveMessage` via a new parameter.
6. Update tests:
    - `tests/message-priority.test.ts` line 422 test ("message-mode nudges exclude protected user messages from priority guidance") — the assertion expects `m0002` (the second-to-last user message) in the high-priority list. With the new semantics, `m0002` is the last user message and is protected; the non-protected user message is `m0001`. Update the assertion.
    - `tests/protected-user-messages-strip.test.ts` — add a new test block for the `count` parameter.
    - `tests/compress-message.test.ts` line 502 test ("compress message mode skips protected user messages") — the test expects both `BLOCKED` and `m0001` to be skipped. With the new semantics, only the last user message is skipped. Update to set `protectUserMessagesCount` to match the test's intent.
    - `tests/compress-message.test.ts` and other message-mode tests that set `protectUserMessages: true` may need `protectUserMessagesCount` adjustments to match the test's expectations.
7. Update docs:
    - `docs/CONFIGURATION.md`: add `protectUserMessagesCount` to the runtime defaults table.
    - `docs/features/OPENCODE_INTEGRATION.md`: update the `protectUserMessages` description to mention the new count cap.
    - `README.md`: update the example config to include the new key.
    - `dcp.schema.json`: add the new key entry.

## Status

Fixed 2026-08-31

## Resolution

Implemented in commit (this branch). All five call sites updated. Test fixtures updated via `06-test_creator`. Docs updated via `07-docs-maintainer`.

Key design decisions:

- Default `protectUserMessagesCount: 1` — protects only the most recent user message when `protectUserMessages: true`. This is the requested semantics ("the last N, not all").
- `count >= userTexts.length` in the slice means "no cap applies" — preserves the legacy "all" behaviour when count >= available messages.
- `Number.POSITIVE_INFINITY` is a valid "all" sentinel (the `result.size < Infinity` guard in `computeProtectedUserMessageIds` and the `!Number.isFinite(count)` guard in the slice both handle it).
- The mode check in `isProtectedUserMessage` is kept (`config.compress.mode !== "message"`) so the BLOCKED tag in range mode remains unchanged. Range-mode protection is exclusively via `appendProtectedUserMessages`'s count cap.
- `protectUserMessagesCount?: number` (optional in the `CompressConfig` type) so test fixtures that don't include it still compile. Runtime defaults to 1 via `?? 1` + `clampMin1`.

## Cross-references

- `docs/CONFIGURATION.md` — runtime defaults table (add `protectUserMessagesCount`)
- `docs/features/OPENCODE_INTEGRATION.md:62` — BUG-094 flag-level exclude; BUG-096 is orthogonal (changes the scope of protection, not the skip gate)
- `docs/features/PRUNING.md` INV-P7 — `isIgnoredUserMessage` is the canonical skip gate; BUG-096 does not change it
- `lib/messages/query.ts:65-76` — `isProtectedUserMessage` signature changed from `(config, message)` to `(config, message, protectedMessageIds: ReadonlySet<string>)`
- `lib/compress/protected-content.ts:13-52` — `appendProtectedUserMessages` signature changed; new `count` param + stripped-empty check
- `lib/config.ts:38` — `CompressConfig` now has optional `protectUserMessagesCount?: number`
- BUG-094 — synthetic user messages excluded from protection; BUG-096 builds on top
