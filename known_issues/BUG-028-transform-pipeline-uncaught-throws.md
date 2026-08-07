# BUG-028: 13-step transform pipeline has no outer try/catch; any thrown error breaks the LLM call mid-session

## Summary
`lib/hooks.ts:177-203` runs the 13-step transform pipeline (`stripHallucinations` → ... → `stripStaleMetadata`) with no outer try/catch. The ONLY try/catch in the handler is for the diagnostic block (lines 147-175). If any pipeline step throws — e.g., `assignMessageRefs` throws `Message ID alias capacity exceeded` (`message-ids.ts:168-171`), or `prune.filterCompressedRanges` throws on a malformed summary, or `logger.saveContext` throws on disk-full — the error propagates up to OpenCode. The downstream `await logger.saveContext(...)` on line 206 is also unguarded.

## Location
- `lib/hooks.ts:177-203`
- `lib/hooks.ts:205-207` (final saveContext unguarded)

## Current vs Expected Behavior
**Current**: 13 unguarded mutation steps + 1 unguarded save.
**Expected**: Wrap the pipeline in try/catch that logs the error and returns the un-transformed messages. Or wrap individual steps (especially `assignMessageRefs`) with their own try/catch.

## Impact
- **Severity**: Medium (DPP-001 + PER-008 implication)
- Runtime: depends on OpenCode's behavior on a thrown hook. The plugin SDK is experimental; the cast `as any` at `index.ts:70` hides the contract.
- User-observable: at best, the LLM call fails with an error visible in the TUI; at worst, the session becomes unresponsive.

## Reproduction
Force a `Message ID alias capacity exceeded` throw at message 9999+. Observe: no graceful degradation.

## Suggested Fix
At `lib/hooks.ts:177-208`, wrap the pipeline and the trailing save:
```ts
try {
    stripHallucinations(output.messages)
    cacheSystemPromptTokens(state, output.messages)
    assignMessageRefs(state, output.messages)
    syncCompressionBlocks(state, logger, output.messages)
    syncToolCache(state, config, logger, output.messages)
    buildToolIdList(state, output.messages)
    prune(state, logger, config, output.messages)
    await injectExtendedSubAgentResults(client, state, logger, output.messages, config.experimental.allowSubAgents)
    const compressionPriorities = buildPriorityMap(config, state, output.messages)
    prompts.reload()
    injectCompressNudges(state, config, logger, output.messages, prompts.getRuntimePrompts(), compressionPriorities)
    injectMessageIds(state, config, output.messages, compressionPriorities)
    applyPendingManualTrigger(state, output.messages, logger)
    stripStaleMetadata(output.messages)

    if (state.sessionId) {
        try {
            await logger.saveContext(state.sessionId, output.messages)
        } catch (err: any) {
            logger.warn("DCP saveContext failed; transform returned anyway", { error: err?.message })
        }
    }
} catch (err: any) {
    logger.warn("DCP transform failed; returning un-transformed messages", { error: err?.message ?? String(err) })
    return
}
```

## Status
Open

## Cross-references
- Source investigator: hooks + messages
- Source finding ID: HOOK-EXCEPTION-1
- Validator verdict: ✅ CONFIRMED
- Doc anchor: `docs/DESIGN_PRINCIPLES.md` DPP-001, `docs/PERFORMANCE.md` PER-008

## Architect Review (2026-08-07)
- **Verdict**: CONFIRMED
- **Severity**: kept Medium (line of defense for BUG-074 capacity throws)
- **Correct Fix**: equivalent; the critical part is logging the failure so users can see what happened, not retrying.
- **Bonus**: this single fix also covers BUG-025 (capacity throw) and BUG-074; BUG-029's narrow silent overwrite.
- **Merge**: BUG-028 + BUG-025 + BUG-074 (transform pipeline fragility cluster).