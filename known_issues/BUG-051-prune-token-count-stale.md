# BUG-051: `state.prune.tools` token count may be stale

## Summary
`applyCompressionState` writes `state.prune.tools.set(toolId, state.toolParameters.get(toolId)?.tokenCount ?? 0)` at `lib/compress/state.ts:267-273`. `prune.tools` is then used as a Set (`.has`) by `pruneToolOutputs` etc. — value is rarely read. `trimToolParametersCache` can evict the `toolParameters` entry, so later `syncPruneToolsFromActiveBlocks` rebuilds with `tokenCount=0`. The value is only consumed by TUI display paths. No recovery-counter impact, but the displayed count is approximate.

## Location
- `lib/compress/state.ts:267-273`

## Current vs Expected Behavior
**Current**: Token count frozen at first write.
**Expected**: Document as a ponytail ceiling, or recompute on read.

## Impact
- **Severity**: Low (display path only)
- Runtime: not affected.
- User-observable: TUI may show stale token counts.

## Reproduction
Compress, then evict the `toolParameters` entry, then read TUI display.

## Suggested Fix
No code change needed. The `state.prune.tools` tokenCount value is vestigial — `git grep "prune.tools.get\|prune.tools.values"` returns ZERO matches in `lib/`. The Map is used as a Set (`.has()` and `.keys()`) by `pruneToolOutputs`. Two options:
1. **Document as a ponytail ceiling** (ponytail answer):
   ```ts
   // ponytail: state.prune.tools values are vestigial — callers use .has() / .keys().
   // The tokenCount snapshot is for future TUI/debug use; recompute on read
   // if you need a fresh number (tokenCount can be evicted by trimToolParametersCache).
   ```
2. **Drop the value** and use `Set<string>` instead of `Map<string, number>`. Larger refactor; not justified today.

## Status
Open

## Cross-references
- Source investigator: compress + v2 fork-protocol
- Source finding ID: PRUNE-TOKEN-COUNT
- Validator verdict: ✅ CONFIRMED
- Doc anchor: `docs/features/COMPRESSION.md` Block invariants INV-15 (placeholder regex), `docs/PATTERNS.md` PAT-001 ponytail

## Architect Review (2026-08-07)
- **Verdict**: PARTIAL — value is essentially dead data
- **Severity**: **changed Low → Nitpick**. TokenCount writes are wasted CPU but never affect correctness. The "TUI displays stale token counts" claim has no evidence (no consumer exists today).
- **Critique of report's fix**: "Document as a ponytail ceiling" is correct and minimal. Report's claim that TUI display paths consume the value is unverified — no readers exist.
- **Bonus**: same pattern at `lib/state/utils.ts:380`, `lib/commands/sweep.ts:228`, `lib/strategies/deduplication.ts:90`, `lib/strategies/purge-errors.ts:82`. If you decide to remove, that's 5 sites.