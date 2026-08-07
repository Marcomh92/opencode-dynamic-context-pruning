# BUG-037: `isSubAgentSession` SDK call has no timeout/AbortSignal

## Summary
`isSubAgentSession` calls `client.session.get({ path: { id: sessionID } })` with no `AbortSignal` or timeout. If the host is unresponsive or the SDK hangs, `ensureSessionInitialized` (and therefore every `messages.transform` for that session) blocks indefinitely, freezing the transform hook. The error path returns `false` (treats unreachable as primary), which means a hung call is silently treated as "not a subagent" — but the hang itself is the user-visible bug.

## Location
- `lib/state/utils.ts:54-61`

## Current vs Expected Behavior
**Current**: Unbounded `await client.session.get(...)`.
**Expected**: Wrap with `AbortController` + `setTimeout` (e.g. 2s) and surface a `logger.warn` on abort; on abort return `false` so the session is treated as primary.

## Impact
- **Severity**: Medium (transform freeze on host hang)
- Runtime: a hung SDK call freezes every transform for that session.
- User-observable: session becomes unresponsive.

## Reproduction
Hard to reproduce reliably; depends on host responsiveness.

## Suggested Fix
At `lib/state/utils.ts`:
```ts
export async function isSubAgentSession(client: any, sessionID: string): Promise<boolean> {
    try {
        // ponytail: 2s native timeout — an unresponsive host must not freeze the
        // transform hook. Abort falls through to the existing error path (primary).
        const result = await client.session.get({
            path: { id: sessionID },
            signal: AbortSignal.timeout(2000),
        })
        return !!result.data?.parentID
    } catch {
        return false
    }
}
```
Verified: `Config extends Omit<RequestInit, "body"|"headers"|"method">` (`gen/client/types.gen.d.ts:6`) and `client.gen.js:41-44` spreads `{...opts}` into `new Request(url, ...)`, so `signal` reaches the wire.

## Status
Open

## Cross-references
- Source investigator: OpenCode integration + permissions
- Source finding ID: SUBAGENT-TIMEOUT-5
- Validator verdict: ✅ CONFIRMED
- Doc anchor: `docs/features/OPENCODE_INTEGRATION.md` Subagent and internal-agent gates

## Architect Review (2026-08-07)
- **Verdict**: CONFIRMED
- **Severity**: kept Medium
- **Correct Fix**: smaller than the report's; `AbortSignal.timeout()` is native, one line, self-cleaning.
- **Critique of report's fix**: worse — calls `clearTimeout(timeout)` only on the success path; on throw the timer leaks and holds an open handle. `AbortSignal.timeout()` is the correct native primitive.
- **Bonus**: function has no `logger` parameter; adding one changes the signature and all call sites for no user benefit.