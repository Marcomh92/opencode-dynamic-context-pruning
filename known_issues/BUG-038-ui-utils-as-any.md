# BUG-038: `lib/ui/utils.ts` uses `as any` in production code

## Summary
`lib/ui/utils.ts:199` (`const info = msg.info as any`) and `lib/ui/utils.ts:221` (`if (part.type === "text" && !(part as any).ignored)`) live outside `tests/`. The second one is reachable in production. Tightening the type to discriminate `Part` is possible; the `ignored` field is documented on text parts.

## Location
- `lib/ui/utils.ts:199`
- `lib/ui/utils.ts:221`

## Current vs Expected Behavior
**Current**: `as any` casts in production utility code.
**Expected**: Replace with discriminated-union narrowed checks (`in` or a `isIgnoredPart` type guard).

## Impact
- **Severity**: Low-Medium (type safety regression in production)
- Runtime: not affected directly.
- User-observable: silent failures if OpenCode renames `ignored` → `noReply` or moves it to `part.metadata`.

## Reproduction
Inspect `lib/ui/utils.ts:199, 221`.

## Suggested Fix
Both casts at `lib/ui/utils.ts` are unnecessary — drop them:
```ts
// lib/ui/utils.ts:199 area
- const info = msg.info as any
- const input = info?.tokens?.input || 0
- const cacheRead = info?.tokens?.cache?.read || 0
- const cacheWrite = info?.tokens?.cache?.write || 0
+ const input = msg.info.tokens.input || 0
+ const cacheRead = msg.info.tokens.cache.read || 0
+ const cacheWrite = msg.info.tokens.cache.write || 0

// lib/ui/utils.ts:221 area
- if (part.type === "text" && !(part as any).ignored) {
+ if (part.type === "text" && !part.ignored) {
```
After `if (msg.info.role !== "assistant") continue`, TS narrows to `AssistantMessage`, which has `tokens.input` and `tokens.cache.{read,write}`. `TextPart.ignored?: boolean` is a declared SDK field.

## Status
Open

## Cross-references
- Source investigator: tests + CI + format + deps
- Source finding ID: TYPE-SAFETY-1
- Validator verdict: ✅ CONFIRMED
- Doc anchor: `docs/DESIGN_PRINCIPLES.md` DPP-014

## Architect Review (2026-08-07)
- **Verdict**: PARTIAL (both casts are unnecessary; the proposed fix over-engineers)
- **Severity**: **changed Low-Medium → Low**. No runtime impact; the field is SDK-declared.
- **Critique of report's fix**: worse — unnecessary machinery. The proposed `isIgnoredTextPart` guard retains an internal `(part as TextPart)` cast and only addresses line 221, leaving line 199 unfixed.
- **Bonus**: the identical cast exists at `lib/messages/query.ts:53` (companion to BUG-049) — same one-token fix. Also: the cited anchor DPP-014 is "Notification writes are isolated", not type-safety. DCP-014 is wrong; should be DPP-007 or similar.
- **Merge**: BUG-038 + BUG-049 (`as any` cast removal; together with BUG-073's third instance).