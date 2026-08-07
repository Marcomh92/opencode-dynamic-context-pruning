# BUG-070: `configureClientAuth` reaches into undocumented `client._client` / `client.client`

## Summary
`auth.ts` documents neither purpose nor contract. The interceptor probes `client._client || client.client`, which is an undocumented SDK surface; if the OpenCode SDK renames or restructures this property, the auth header silently stops being attached. The plugin would then make unauthenticated requests against a password-protected server in secure mode.

## Location
- `lib/auth.ts:24-33`

## Current vs Expected Behavior
**Current**: Probes `client._client || client.client`.
**Expected**: Add a contract comment; or move auth to a typed SDK function if available.

## Impact
- **Severity**: Nitpick (compatibility risk)
- Runtime: not affected today.
- User-observable: silent failure if SDK changes.

## Reproduction
Inspect `lib/auth.ts:24-33`.

## Suggested Fix
Add the contract comment AND a debug log when the interceptor can't be installed:
```ts
// lib/auth.ts:22-34
// secure-mode contract: depends on the OpenCode SDK exposing either
// `client._client` or `client.client` with an `interceptors.request`
// axios-style API. Both names have been observed in the SDK at different
// versions. Failure mode is silent — verify by header inspection on startup
// or with: `curl -H 'Authorization: Basic ...' http://server/health`.
const innerClient = client._client || client.client
if (innerClient?.interceptors?.request) {
    innerClient.interceptors.request.use((request: Request) => {
        if (!request.headers.has("Authorization")) {
            request.headers.set("Authorization", authHeader)
        }
        return request
    })
} else {
    // ponytail: best-effort — secure mode without the expected SDK shape
    // means unauthenticated requests; one debug line is cheaper than
    // silently broken auth.
    console.debug("[dcp] configureClientAuth: no interceptable client found")
}
```

## Status
Open

## Cross-references
- Source investigator: OpenCode integration + permissions
- Source finding ID: AUTH-INNER-16
- Validator verdict: ✅ CONFIRMED
- Doc anchor: None

## Architect Review (2026-08-07)
- **Verdict**: CONFIRMED
- **Severity**: kept Nitpick (compatibility risk, not current bug)
- **Correct Fix**: comment-only is correct minimum; the debug line is a small upgrade that turns silent into visible.
- **Bonus**: `lib/auth.ts` is undocumented in `docs/` — worth a one-liner in `docs/features/OPENCODE_INTEGRATION.md` describing the secure-mode contract.