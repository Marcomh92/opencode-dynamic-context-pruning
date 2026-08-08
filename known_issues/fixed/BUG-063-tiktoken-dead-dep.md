# BUG-063: `tiktoken` listed as a direct dep but unused in source; defensive intent not in PER-002 doc

## Summary

`package.json:65` lists `"tiktoken": "^1.0.10"` as a direct dependency. Confirmed (PER-002): no `.ts` source imports it. `MY_CHANGELOG.md:184` records that M1 added it because it was previously a transitive of `@anthropic-ai/tokenizer` and was skipped by Bun's lockfile. The `PERFORMANCE.md` note stops short of explaining why the direct dep is kept.

## Location

- `package.json:65`
- `lib/token-utils.ts:4-6, 72`
- `docs/PERFORMANCE.md:33`
- `MY_CHANGELOG.md:184`

## Current vs Expected Behavior

**Current**: Direct dep is intentional defensive; rationale is in changelog, not in PER-002 doc.
**Expected**: Document the defensive intent in `PERFORMANCE.md`, or remove the dep and accept the Bun-lockfile risk.

## Impact

- **Severity**: Low (defensive dep, not actually broken)
- Runtime: not affected.
- User-observable: a maintainer pruning dead deps would delete `tiktoken` and re-introduce the Bun-locked-out failure mode.

## Reproduction

```sh
grep -r "tiktoken" lib/ tests/ index.ts tui.tsx
# No matches.
```

## Suggested Fix

At `docs/PERFORMANCE.md:33`, append a one-line rationale pointing at the changelog:

```
Token counting uses `@anthropic-ai/tokenizer` with a character-count fallback in `lib/token-utils.ts`.
`tiktoken` is installed in `package.json` but no source import uses it.
**Kept as a direct dep (not a transitive) to prevent Bun's lockfile from skipping it** — see `MY_CHANGELOG.md` M1 entry, issue #575.
```

## Status

Fixed 2026-08-07

## Cross-references

- Source investigator: tests + CI + format + deps
- Source finding ID: DEP-USED-1
- Validator verdict: ⚠️ PARTIAL (intentional defensive dep, not actually broken)
- Doc anchor: `docs/PERFORMANCE.md` PER-002

## Architect Review (2026-08-07)

- **Verdict**: CONFIRMED
- **Severity**: kept Low (not a runtime bug; defensive intent just isn't documented in the perf doc)
- **Bonus**: `lib/token-utils.ts:74` — the `try/catch` around `anthropicCountTokens` swallows real failures. If `@anthropic-ai/tokenizer` ever throws (e.g. on a non-ASCII-heavy string), the fallback `Math.round(text.length / 4)` is naive. The `tiktoken` defensive dep could plausibly become active if `@anthropic-ai/tokenizer` proves unstable. `package.json:62` — `@anthropic-ai/tokenizer: ^0.0.4` is also pinned loosely; if that ever gets a major bump that drops `countTokens`, the plugin would crash to the fallback path silently.

## Resolution

`tiktoken` dep removed from `package.json`; no source imports.
