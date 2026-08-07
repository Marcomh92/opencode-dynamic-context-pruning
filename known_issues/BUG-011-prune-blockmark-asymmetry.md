# BUG-011: `state.prune.tools` contains IDs for `question`/`edit`/`write` tools but `pruneToolOutputs` silently skips them

## Summary
Compress blocks add ALL effectiveToolIds to `state.prune.tools` (`lib/compress/state.ts:267-273`), but `pruneToolOutputs` (`lib/messages/prune.ts:90-92`) explicitly skips `question`/`edit`/`write` tools with `continue`. Result: `state.prune.tools.has(callID)` returns `true` for tools whose outputs are never replaced. The token count is counted in `stats.totalPruneTokens`, but no actual replacement happens. Sweep-marked `edit`/`write`/`question` tools stay un-pruned while a sweep-marked `bash` tool gets pruned — inconsistent.

## Location
- `lib/messages/prune.ts:73-156` (reader)
- `lib/compress/state.ts:267-273` (writer)
- `lib/commands/sweep.ts` (also writes to `state.prune.tools`)

## Current vs Expected Behavior
**Current**: All effectiveToolIds go into `state.prune.tools`. The reader silently skips three tool names. False-positive token savings are recorded; downstream code (`context.ts:152`, `inject/subagent-results.ts:41`, `prune.ts:43`) trusts `.has()` and may miscount.
**Expected**: Either skip `question`/`edit`/`write` when adding to `state.prune.tools`, OR document the silent-skip explicitly in `docs/features/PRUNING.md` "Prune behavior" table.

## Impact
- **Severity**: High (false-positive token savings + inconsistent state)
- Runtime: token stats undercount actual visible context; sweep behavior is non-uniform across tool types.
- User-observable: `/dcp stats` may report pruned tokens that were never actually pruned.

## Reproduction
Run a session with a `write` tool call inside a compressed range. Inspect `state.prune.tools` (contains the ID) and inspect the actual `output.messages` after `prune` (the `write` output is NOT replaced).

## Suggested Fix
Option A (preferred): In `lib/compress/state.ts:267-273` and `lib/commands/sweep.ts:226-228`, filter out `question`/`edit`/`write` IDs before adding to `state.prune.tools`. Extract the filter set into a named constant:
```ts
const PRUNED_OUTPUTS_UNSUPPORTED = new Set(["question", "edit", "write"])
```

## Status
Open

## Cross-references
- Source investigator: hooks + messages
- Source finding ID: PRUNE-BLOCKMARK-1
- Validator verdict: ✅ CONFIRMED
- Doc anchor: `docs/features/PRUNING.md` Prune behavior table

## Architect Review (2026-08-07)
- **Verdict**: CONFIRMED
- **Severity**: kept High (false-positive savings + inconsistent sweep behavior)
- **Correct Fix**: Option A — filter at writer sites with the named constant. Option B (documenting the skip) is the wrong default — false-positive stats are user-visible.
- **Bonus**: `pruneFullTool` at `lib/messages/prune.ts:27-71` is dead code (commented out at line 21). Either delete it (BUG-066) or wire it in to give `edit`/`write` a real prune path.