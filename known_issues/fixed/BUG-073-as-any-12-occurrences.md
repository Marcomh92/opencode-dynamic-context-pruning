# BUG-073: 12 `as any` casts in production code

## Summary

12 `as any` occurrences in scope: most are SDK-client typings (`client: any`, `output: { parts: any[] }`). The `index.ts:70` cast bridges the experimental `experimental.chat.messages.transform` API and is documented at `docs/features/OPENCODE_INTEGRATION.md:18`. The internal `as any` in `lib/messages/shape.ts:8-9` and `lib/messages/query.ts:53` are narrow escape hatches for optional SDK fields.

## Location

- `index.ts:70` (documented experimental API seam)
- `lib/hooks.ts:110/162/213/220` (parameter types)
- `lib/messages/shape.ts:8-9` (optional SDK fields)
- `lib/messages/query.ts:53` (the `ignored` cast — see BUG-049)
- `lib/ui/utils.ts:199, 221` (companion to BUG-038)

## Current vs Expected Behavior

**Current**: Casts are intentional escape hatches.
**Expected**: Document the seam casts explicitly; replace narrow casts where possible.

## Impact

- **Severity**: Suggestion (escape hatches work today)
- Runtime: not affected.
- User-observable: none today; future SDK changes are risk.

## Reproduction

```sh
grep -rn "as any" lib/ | wc -l
# ~12 occurrences.
```

## Suggested Fix

No code change required. These are intentional SDK seam casts. The narrow ones in `lib/messages/shape.ts:8-9`, `lib/messages/query.ts:53`, `lib/ui/utils.ts:199/221` access fields the sealed OpenCode SDK type does not advertise (`info`/`parts` on `WithParts`, the `ignored` extension flag on `TextPart`). Removing them requires either owning the type definition or upgrading the SDK; both are out of fork scope.

If a tightening pass is desired, the merge casts in `lib/config.ts:1085-1096` can be cleaned by typing `mergeLayer`'s `data` parameter as `DeepPartial<PluginConfig>`, eliminating the need for `as any`. That is a typing-only improvement, not a bug fix.

## Status

Fixed 2026-08-07

## Resolution

Audit pass: typed `mergeLayer`'s data parameter as `DeepPartial<PluginConfig>` to eliminate the 4 merge casts at `lib/config.ts:1085-1096`.

## Cross-references

- Source investigator: OpenCode integration + permissions
- Source finding ID: AS-ANY-19
- Validator verdict: ⚠️ PARTIAL (limited and intentional; cast inventory slightly inaccurate)
- Doc anchor: `docs/ARCHITECTURE.md:59`, `docs/features/OPENCODE_INTEGRATION.md:18`

## Architect Review (2026-08-07)

- **Verdict**: PARTIAL (count correct; line citations wrong; location list incomplete)
- **Severity**: kept Suggestion
- **Correct Fix**: equivalent in spirit; no required code change.
- **Critique of report's fix**: "Replace narrow casts with discriminated-union narrowed checks" is wrong — `.ignored`, `info`, `parts` aren't discriminated unions in the SDK; they're optional fields on sealed types. A discriminated union narrowing would require defining a DCP-internal extension type and asserting on it, which is over-engineering.
- **Bonus**: line citations for `lib/hooks.ts:110/162/213/220` are wrong — only line 110 is an `as any`-adjacent form (parameter type annotation); lines 162/213/220 are object-literal property values and parameter type annotations, not `as any` casts. Grep confirms zero `as any` in `lib/hooks.ts`. Missed sites: `lib/config.ts:1085/1086/1091/1096` (the merge casts), `lib/token-utils.ts:6`, `lib/tui/commands.ts:4`, `lib/tui/data.ts:16`.
- **Merge**: BUG-038 + BUG-049 + BUG-073 (`as any` audit surface — roll into a single audit pass; document remaining escape hatches in `docs/PATTERNS.md`).
