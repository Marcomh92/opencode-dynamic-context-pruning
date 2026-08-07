# BUG-015: `buildSubAgentCacheKey` uses `::` separator vulnerable to collisions

## Summary
`buildSubAgentCacheKey` joins `${subAgentSessionId}::${callID}` with an unescaped `::`. If either input contains `::`, two distinct `(sessionId, callID)` triples produce the same string. `("a::b", "c")` and `("a", "b::c")` both yield `"a::b::c"`. PAT-002 holds (single source of truth), but the join itself is the weak link.

## Location
- `lib/subagents/cache-key.ts:6-8`

## Current vs Expected Behavior
**Current**: `${subAgentSessionId}::${callID}` — fixed string separator.
**Expected**: Length-prefixed encoding `${a.length}\x00${a}\x00${b}` or a non-printable separator.

## Impact
- **Severity**: High (PAT-002 source-of-truth honored, but the join itself is a weak link)
- Runtime: cache miss when one entry shadows another. Subagent result extension goes to the wrong session.
- User-observable: rare; depends on whether sessionIds or callIDs can contain `::`.

## Reproduction
`buildSubAgentCacheKey("a::b", "c")` and `buildSubAgentCacheKey("a", "b::c")` both return `"a::b::c"`. `Map.set` would overwrite one entry with the other.

## Suggested Fix
Use `\x1F` (ASCII Unit Separator) — simpler than length-prefixed encoding:
```ts
export function buildSubAgentCacheKey(subAgentSessionId: string, callID: string): string {
    // ponytail: \x1F is ASCII Unit Separator — safe in any context that
    // accepts printable text. Upgrade to length-prefixed encoding only if
    // sessionIds or callIDs can themselves contain \x1F.
    return `${subAgentSessionId}\x1F${callID}`
}
```
Tests `tests/subagent-cache.test.ts:276, 362` and callers `subagent-results.ts:53`, `protected-content.ts:172` need the new format.

## Status
Open

## Cross-references
- Source investigator: prompts + UI + TUI + subagents
- Source finding ID: H-SUBAGENT-KEY-COLLIDE-1
- Validator verdict: ✅ CONFIRMED
- Doc anchor: `docs/ARCHITECTURE.md` Cross-cutting contracts → Subagent cache key, `docs/PATTERNS.md` PAT-002

## Architect Review (2026-08-07)
- **Verdict**: CONFIRMED
- **Severity**: **changed High → Low-Medium**. Collision depends on whether sessionIds/callIDs can contain `::` — OpenCode's sessionId is `ses-*` (UUID-derived) and callIDs are nanoid, neither contains `::` in practice. Latent and theoretical, not active. Worth fixing for hygiene, not urgent.
- **Correct Fix**: `\x1F` separator is shorter than length-prefixed and matches the report's secondary suggestion. Equivalent semantically.
- **Critique of report's fix**: length-prefix is correct but heavier than needed.
- **Bonus**: trivial 3-line collision test added to `tests/subagent-cache.test.ts`. Same fix as BUG-076 (upgrade path) — close BUG-015 as "fixed by BUG-076" once BUG-076 lands.
- **Merge**: BUG-015 + BUG-076 (same fix at same file:line).