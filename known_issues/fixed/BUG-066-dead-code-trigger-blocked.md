# BUG-066: `__DCP_MANUAL_TRIGGER_BLOCKED__` throw is unreachable

## Summary

`handleManualTriggerCommand` always returns a non-empty string from `getTriggerPrompt(...)`. The `if (!prompt) throw new Error("__DCP_MANUAL_TRIGGER_BLOCKED__")` branch at `lib/hooks.ts:288-293` can never run. The dead branch may mislead future maintainers about a contract that doesn't exist.

## Location

- `lib/hooks.ts:288-293`

## Current vs Expected Behavior

**Current**: Dead `throw` branch.
**Expected**: Remove the check, or change `handleManualTriggerCommand` return type to `string` (drop the nullable).

## Impact

- **Severity**: Nitpick (dead code)
- Runtime: not affected.
- User-observable: none.

## Reproduction

Inspect `lib/hooks.ts:288-293` and `lib/commands/manual.ts:94-100`. The `prompt` returned is always non-null.

## Suggested Fix

Cleanest fix removes the type lie:

```ts
// lib/commands/manual.ts:94-100
export async function handleManualTriggerCommand(
    ctx: ManualCommandContext,
    tool: "compress",
    userFocus?: string,
): Promise<string> {
    return getTriggerPrompt(tool, ctx.state, ctx.config, userFocus)
}

// lib/hooks.ts:288-293 — remove the `if (!prompt) throw ...` block:
if (subcommand === "compress") {
    const userFocus = subArgs.join(" ").trim()
    const prompt = await handleManualTriggerCommand(commandCtx, "compress", userFocus)
    state.manualMode = "compress-pending"
    state.pendingManualTrigger = { sessionId: input.sessionID, prompt }
    // ...
```

## Status

Fixed 2026-08-07

## Resolution

Changed `handleManualTriggerCommand` return type to `string` at `lib/commands/manual.ts:94-100`; removed dead `__DCP_MANUAL_TRIGGER_BLOCKED__` throw at `lib/hooks.ts:288-293`.

## Cross-references

- Source investigator: compress + v2 fork-protocol
- Source finding ID: DEAD-CODE-EXCEPTION
- Validator verdict: ⚠️ PARTIAL (dead code; low impact)
- Doc anchor: `docs/features/COMPRESSION.md` INV-5

## Architect Review (2026-08-07)

- **Verdict**: CONFIRMED
- **Severity**: kept Nitpick
- **Critique of report's fix**: smaller but leaves the type lie. The more thorough fix changes the return type to `string`, removing a future-maintainer trap.
- **Bonus**: `INV-5` doc anchor cited — verify it's the right invariant before marking "fixed"; if INV-5 is about something else, drop the anchor.
