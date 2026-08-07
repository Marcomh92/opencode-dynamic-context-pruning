# BUG-076: Adopt collision-proof length-prefixed separator for `buildSubAgentCacheKey`

## Summary
Upgrade path for BUG-015. Replace `${a}::${b}` with `${a.length}\x00${a}\x00${b.length}\x00${b}` (length-prefixed encoding). The cache is intentionally cold; future write sites will rely on the key being collision-free.

## Location
- `lib/subagents/cache-key.ts:6-8`

## Current vs Expected Behavior
**Current**: `${subAgentSessionId}::${callID}` (collision-prone — see BUG-015).
**Expected**: Length-prefixed encoding.

## Impact
- **Severity**: Suggestion (upgrade path)
- Runtime: closes BUG-015 collision surface.
- User-observable: same as BUG-015.

## Reproduction
Same as BUG-015.

## Suggested Fix
```ts
// lib/subagents/cache-key.ts:6-8
export function buildSubAgentCacheKey(subAgentSessionId: string, callID: string): string {
    // ponytail: NUL-delimited + length-prefixed; inputs are UUID-shaped session IDs and SDK
    // callIDs, neither contains NUL, so no further escaping needed. Single source of truth (PAT-002).
    return `${subAgentSessionId.length}\x00${subAgentSessionId}\x00${callID.length}\x00${callID}`
}
```
Plus update `tests/subagent-cache.test.ts:276, 362` and the two callers (`lib/messages/inject/subagent-results.ts:53`, `lib/compress/protected-content.ts:172`) to assert the new format.

## Status
Open

## Cross-references
- Source investigator: prompts + UI + TUI + subagents
- Source finding ID: S-SUBAGENT-KEY-SEPARATOR-1 (upgrade path for BUG-015)
- Validator verdict: ✅ CONFIRMED
- Doc anchor: `docs/ARCHITECTURE.md` Subagent cache key

## Architect Review (2026-08-07)
- **Verdict**: CONFIRMED
- **Severity**: kept Suggestion (cache is intentionally cold; no production caller relies on collision-free behavior today)
- **Correct Fix**: equivalent; the report's snippet is correct.
- **Bonus**: BUG-015 (High) and BUG-076 (Suggestion) describe the **same fix at the same file:line**. Recommend closing BUG-015 as "fixed by BUG-076" once BUG-076 lands. Do not duplicate the change.
- **Merge**: BUG-015 + BUG-076 (same fix at same file:line).