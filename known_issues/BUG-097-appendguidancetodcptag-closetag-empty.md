# BUG-097: `appendGuidanceToDcpTag` uses an empty `closeTag` string, making the close-tag splice a no-op that depends on a `lastIndexOf("")` quirk

## Summary

`appendGuidanceToDcpTag(nudgeText, guidance)` in `lib/prompts/extensions/nudge.ts:28-43` is designed to splice priority guidance text inside a `<dcp-message-id>` close tag (so the guidance stays inside the same XML tag boundary). The implementation declares `const closeTag = ""` (empty string) — presumably as a placeholder for the intended tag name that was never filled in — and then calls `nudgeText.lastIndexOf(closeTag)`. `String.prototype.lastIndexOf("")` returns `nudgeText.length` for any non-empty `nudgeText`, so the splice degenerates to "append at the end of `nudgeText`" rather than the documented "insert before the close tag".

The bug became visible during the BUG-096 review (2026-08-31) when a non-empty `contextLimitNudge` test fixture ("Base context nudge\n") was meant to validate the priority-nudge injection path, but the actual produced text depended on this quirk:

- With `nudgeText = ""` (empty): `appendGuidanceToDcpTag("", guidance)` returns `"\n\n${guidance}\n"` because `"".lastIndexOf("") === 0`. The priority guidance still gets injected.
- With `nudgeText = "Base context nudge\n"`: `appendGuidanceToDcpTag("Base context nudge\n", guidance)` returns `"Base context nudge\n\n${guidance}\n"` because `"Base context nudge\n".lastIndexOf("") === 19` (= `nudgeText.length`). The guidance gets appended AFTER the original nudge.

Both behaviours happen to "produce something useful" but neither matches the comment's intent ("Insert the priority guidance before the close tag"). Tests that rely on the exact splice point are brittle.

## Location

`lib/prompts/extensions/nudge.ts:28-43`

```ts
export function appendGuidanceToDcpTag(nudgeText: string, guidance: string): string {
    if (!guidance.trim()) {
        return nudgeText
    }

    const closeTag = "" // ← empty string, never the actual </dcp-message-id>
    const closeTagIndex = nudgeText.lastIndexOf(closeTag)

    if (closeTagIndex === -1) {
        return nudgeText
    }

    const beforeClose = nudgeText.slice(0, closeTagIndex).trimEnd()
    const afterClose = nudgeText.slice(closeTagIndex)
    return `${beforeClose}\n\n${guidance}\n${afterClose}`
}
```

## Current vs Expected Behavior

**Current:** `closeTag = ""`. The `lastIndexOf("")` call returns either `0` (for empty `nudgeText`) or `nudgeText.length` (for any non-empty `nudgeText`), producing a splice that is effectively "prepend `\n\n${guidance}\n` if nudgeText is empty; append `\n\n${guidance}\n` if nudgeText is non-empty". The function name and docstring ("Insert the priority guidance before the close tag") are misleading.

**Expected:** Either:

- (Option A) The close tag IS the empty string intentionally and the function name is wrong — rename to `appendGuidanceToDcpTagOrEmpty` and document the actual splice semantics; OR
- (Option B) The close tag should be `</dcp-message-id>` and the function should actually splice before that tag when present in `nudgeText`; OR
- (Option C) The close tag should be the actual close tag, and the production callers (`createBundledRuntimePrompts` in `lib/prompts/store.ts`) should be checked to ensure their templates actually contain the close tag at the end of the nudge text. If the templates don't include the close tag in `nudgeText` at all, then the close-tag splice is a no-op by design and the `closeTag` should be `""` (current behaviour) with the misleading name fixed.

## Impact

- **Severity:** Low. No production user-facing bug. All existing tests pass either because they use empty `contextLimitNudge` (works due to the `lastIndexOf("") === 0` quirk) or they don't depend on the exact splice point.
- **Runtime:** no crash, no invariant broken.
- **User-observable:** none today. The only test that exercised a non-empty `contextLimitNudge` value and asserted on the exact splice point (BUG-096's original Option A test) failed in the test run; the BUG-096 test was rewritten (Option B) to test the priority-map composition directly instead of the injection mechanics.
- **Future risk:** any future test that asserts the priority guidance is positioned at the START of a non-empty `contextLimitNudge` (rather than at the END) will fail. The current behaviour is "append", not "prepend".

## Reproduction

```ts
import { appendGuidanceToDcpTag } from "../lib/prompts/extensions/nudge"

// Current behaviour (closeTag = ""):
appendGuidanceToDcpTag("", "GUIDANCE")
// → "\n\nGUIDANCE\n"  (because "".lastIndexOf("") === 0)

appendGuidanceToDcpTag("Base context nudge\n", "GUIDANCE")
// → "Base context nudge\n\nGUIDANCE\n"  (guidance is APPENDED, not prepended)

// Expected behaviour (closeTag = "</dcp-message-id>"):
appendGuidanceToDcpTag("Base context nudge\n</dcp-message-id>", "GUIDANCE")
// → "Base context nudge\n\nGUIDANCE\n</dcp-message-id>"  (spliced before close tag)
```

## Suggested Fix

Decision required. Three options:

1. **Cheapest: keep current behaviour, fix the misleading name and comment.**
    - Rename `appendGuidanceToDcpTag` → `appendOrPrependGuidance`. Or split into two functions: `prependGuidanceIfEmpty` and `appendGuidance`.
    - Update the function comment to describe the actual splice semantics ("if nudgeText is empty, prepend the guidance; otherwise append it").
    - Tests that need a specific splice point can be written more robustly.
    - No production behaviour change.

2. **Most correct: use the actual close tag.**
    - Change `closeTag = "</dcp-message-id>"`.
    - Update production prompts in `lib/prompts/store.ts:166` (`createBundledRuntimePrompts`) so each nudge prompt template ends with the close tag.
    - Tests that use a non-empty `contextLimitNudge` need to include the close tag in the string.
    - Production behaviour change: priority guidance is now actually inserted inside the tag, which may change how the LLM parses the tag block.

3. **Pragmatic: declare the empty close tag as the intended behaviour and document the quirk.**
    - Replace `const closeTag = ""` with a `ponytail:` comment explaining the close-tag splice is a no-op by design (the close tag isn't part of the nudge text), and the function name is aspirational.
    - Tests continue to work as they do today.

Recommendation: **Option 3** as the ponytail-documented ceiling, with an Option-1-style rename in a follow-up. The current behaviour produces correct LLM output in all production code paths, so the priority is "document the quirk and move on" rather than risk a behavioural change in production.

## Status

Open (tracked 2026-08-31, surfaced by the BUG-096 review).

## Resolution

TBD — pending maintainer decision on options 1/2/3.

## Cross-references

- `lib/prompts/extensions/nudge.ts:28-43`
- `lib/prompts/store.ts:166` (`createBundledRuntimePrompts` — produces the `nudgeText` templates)
- `tests/message-priority.test.ts:427` (BUG-096 test, rewritten as Option B to bypass this quirk)
- `known_issues/fixed/BUG-096-protectusermessages-last-n.md` (the review that surfaced this issue)
