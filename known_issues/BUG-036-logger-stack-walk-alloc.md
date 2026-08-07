# BUG-036: `Logger.getCallerFile` allocates a fresh `Error` stack on every log call

## Summary
Every public logger method calls `getCallerFile(2)`, which constructs a new `Error`, swaps `Error.prepareStackTrace` globally for the duration of the call, walks the stack, then restores the original prepare function. With debug enabled and the transform firing many times per second, this is the dominant allocation cost of the diagnostic hot path. The enabled check is inside `write`, AFTER caller discovery — so the work runs even when logging is disabled.

## Location
- `lib/logger.ts:55-76` (`getCallerFile`)
- `lib/logger.ts:99-142` (info/debug/warn/error callers)

## Current vs Expected Behavior
**Current**: Per-call `Error` allocation + global `prepareStackTrace` swap.
**Expected**: Cache the caller file per call site, or skip the stack walk entirely and use `new Error().stack?.match(/\S+\.ts/)` once per process.

## Impact
- **Severity**: Medium (hot-path alloc cost when debug enabled)
- Runtime: alloc pressure on the transform hook.
- User-observable: slower debug-mode sessions.

## Reproduction
Enable debug, run a long session, profile the heap. Observe: `Logger.getCallerFile` dominates.

## Suggested Fix
Two fixes in `lib/logger.ts`:
1. Apply to all four methods (`info`/`debug`/`warn`/`error`):
   ```ts
   info(message: string, data?: any) {
       if (!this.enabled) return
       const component = this.getCallerFile(2)
       return this.write("INFO", component, message, data)
   }
   ```
2. **Separate latent-bug fix** — `lib/logger.ts:56-76` restores `Error.prepareStackTrace` at line 61 but NOT in a `finally`. If `err.stack` getter throws, the custom `prepareStackTrace` leaks process-globally:
   ```ts
   const originalPrepareStackTrace = Error.prepareStackTrace
   try {
       Error.prepareStackTrace = (_, stack) => stack
       const stack = new Error().stack as unknown as NodeJS.CallSite[]
       // ...loop...
   } catch {
       return "unknown"
   } finally {
       Error.prepareStackTrace = originalPrepareStackTrace
   }
   ```

## Status
Open

## Cross-references
- Source investigator: OpenCode integration + permissions
- Source finding ID: LOG-STACK-4
- Validator verdict: ✅ CONFIRMED
- Doc anchor: `docs/PERFORMANCE.md` PER-008 budgets

## Architect Review (2026-08-07)
- **Verdict**: CONFIRMED (and understated)
- **Severity**: kept Medium. The cited anchor is weak though — `docs/PERFORMANCE.md:71` (PER-008) explicitly states "No published budget" for `messages.transform`.
- **Correct Fix**: move enabled check up; plus add `finally` for `prepareStackTrace` restore.
- **Critique of report's fix**: the primary suggestion is correct and minimal. The "cache the caller file at module load" alternative is **wrong** — caller varies per call site; a module-load snapshot would mislabel every component.
- **Bonus**: the waste occurs in default (debug off) configuration, not only when debug enabled (report understates). Note: return type widens to `Promise<void> | undefined`; verified no caller does `await logger.info(...)`, safe.