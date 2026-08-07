# BUG-077: Hash bundled-prompt values for drift detection in `PROMPT_DEFINITIONS`

## Summary
A hash of the bundled values would let the plugin detect bundled-version drift and rebuild the defaults README automatically. Currently the README is regenerated on every `customPrompts` change.

## Location
- `lib/prompts/store.ts:60-109`

## Current vs Expected Behavior
**Current**: Bundled defaults recomputed each `reload()`; README regenerated on `customPrompts` change.
**Expected**: Hash-based drift detection.

## Impact
- **Severity**: Suggestion (improvement)
- Runtime: not affected.
- User-observable: better prompt-version tracking.

## Reproduction
Inspect `lib/prompts/store.ts:60-109`. No hash-based drift detection today.

## Suggested Fix
If the intent is "make drift visible to operators", the minimal correct change is a log line at the write site, not a hash:
```ts
// lib/prompts/store.ts:441 (inside the for-loop, just before writeFileSync)
if (existing !== managedContent) {
    writeFileSync(filePath, managedContent, "utf-8")
    this.logger.info("Wrote default prompt file (drift or first init)", {
        key: definition.key,
        path: filePath,
    })
}
```
Same one-liner at line 458 for the README. Ponytail: log line, not a hash.

## Status
Open

## Cross-references
- Source investigator: prompts + UI + TUI + subagents
- Source finding ID: S-OVERRIDE-FILE-LIST-1
- Validator verdict: ⚠️ PARTIAL (drift is detectable today without a hash; suggestion has merit if log output is desired)
- Doc anchor: `docs/features/PROMPTS.md` Override paths

## Architect Review (2026-08-07)
- **Verdict**: PARTIAL (drift IS detectable today)
- **Severity**: kept Suggestion
- **Correct Fix**: log line, not hash. Hash adds the same visibility at higher cost.
- **Critique of report's fix**: a hash is over-engineering. The byte comparison at lines 441 and 458 already detects drift; the only gap is operator visibility.
- **Bonus**: byte comparison does NOT cover user's *override* files — only the bundled defaults. Override drift is the user's choice and should not be logged. The `existing === managedContent` comparison is byte-equal, not whitespace-normalized — if the bundled source has trailing-whitespace drift (cf. BUG-072), every reload rewrites the file.