# BUG-047: Sweep command ignores `turnProtection.turns` that `syncToolCache` honors

## Summary
`syncToolCache` (`lib/state/tool-cache.ts:39-52`) honors `config.turnProtection.enabled` and skips caching tools within `turnProtection.turns` of the current turn. The SWEEP command at `lib/commands/sweep.ts:171-189` only filters by `isToolNameProtected` and `isFilePathProtected` — NOT by turn protection. So a tool that was never cached (because it was turn-protected at cache time) can still be sweep-marked by name. The protection is "no prune in transform" (because `state.toolParameters.get(id)` returns undefined) but sweep marks the ID in `state.prune.tools` directly. The next transform's `pruneToolOutputs` would still replace the tool's output with the placeholder, and the token accounting via `getTotalToolTokens` returns 0 for unknown IDs (under-counted).

## Location
- `lib/state/tool-cache.ts:39-52` (honors turn protection)
- `lib/commands/sweep.ts:171-189` (ignores turn protection)

## Current vs Expected Behavior
**Current**: Sweep ignores `turnProtection.turns`.
**Expected**: Apply the turn-protection check in sweep filter.

## Impact
- **Severity**: Low (inconsistency with `syncToolCache`)
- Runtime: a turn-protected tool can be sweep-marked.
- User-observable: false-positive token savings; protected-by-turn tools get pruned anyway.

## Reproduction
1. Set `turnProtection.enabled: true, turnProtection.turns: 2`.
2. Run a tool, immediately run `/dcp sweep`.
3. Inspect `state.prune.tools` — the protected-by-turn tool is marked.

## Suggested Fix
At `lib/commands/sweep.ts:172-190`, add the same `turnProtection` check inside the filter. Hoist the turn-protection computation once:
```ts
const turnProtectionEnabled = config.turnProtection.enabled
const turnProtectionTurns = config.turnProtection.turns

const newToolIds = toolIdsToSweep.filter((id) => {
    if (state.prune.tools.has(id)) return false
    const entry = state.toolParameters.get(id)
    if (!entry) {
        // If turnProtection is active, toolParameters lacks the entry because
        // syncToolCache skipped it. Honor the same gate as syncToolCache.
        if (turnProtectionEnabled && turnProtectionTurns > 0) {
            // ponytail: conservative — skip when we have no metadata + turnProtection active.
            return false
        }
        return true
    }
    // ... existing protectedTool / protectedFilePath checks
})
```
Note: sweep currently doesn't track per-tool turn numbers in `toolIdList`. Strict port requires extending `buildToolIdList` to record `turn` per id; the conservative `return false` above is safe but over-restrictive.

## Status
Open

## Cross-references
- Source investigator: hooks + messages
- Source finding ID: CONFIG-TURNPROTECT-1
- Validator verdict: ✅ CONFIRMED
- Doc anchor: `docs/features/STATE_PERSISTENCE.md` Tool cache section, `docs/CONFIGURATION.md`

## Architect Review (2026-08-07)
- **Verdict**: CONFIRMED
- **Severity**: kept Low (false-positive token savings + under-counted display; not a correctness break)
- **Correct Fix**: equivalent in spirit; the report's `state.currentTurn - entry.turn < ...` only works if `entry` exists. For turn-protected tools, the entry was never added — bug has two failure modes. The conservative fix handles both.
- **Critique of report's fix**: report only handles one failure mode; conservative fix above handles both with `return false` on missing entry + turnProtection active.
- **Bonus**: BUG-048's documentation gap could include this turn-protection contract to avoid future drift.