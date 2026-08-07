# BUG-035: System-prompt handler bypasses host permission check on first injection of a session

## Summary
`lib/hooks.ts:84-91` resolves `effectivePermission` by checking `state.sessionId === input.sessionID`. On the very first transform of a session, `state.sessionId` is still `null` (or the previous session's id), so the predicate falls through to `config.compress.permission` — the raw user config that has NOT been reconciled against the host's `opencode.json` rules. `syncCompressPermissionState` only runs from `experimental.chat.messages.transform` and `command.execute.before`, after the system prompt is already injected. Result: if the host has `*:deny`, the very first system prompt of the session still injects DCP instructions because the host check is bypassed.

## Location
- `lib/hooks.ts:84-91`

## Current vs Expected Behavior
**Current**: First-injection bypass via `state.sessionId !== input.sessionID`.
**Expected**: Call `syncCompressPermissionState(state, config, hostPermissions, [])` (or a no-message variant) at the top of the handler before the gate.

## Impact
- **Severity**: Medium (DPP-010 partial violation; first-injection side-effect)
- Runtime: the very first system prompt of the session injects DCP even when effective host permission is `"deny"`.
- User-observable: model sees DCP instructions on the first turn despite host deny.

## Reproduction
1. Set host `opencode.json` to `{"permission": {"*": "deny"}}`.
2. Start a new session.
3. Inspect the very first system prompt — DCP instructions present.

## Suggested Fix
Defense-in-depth at `lib/hooks.ts` + `index.ts`:
```ts
// lib/hooks.ts — add hostPermissions param to createSystemPromptHandler
import { resolveEffectiveCompressPermission, type HostPermissionSnapshot } from "./host-permissions"

const effectivePermission =
    input.sessionID && state.sessionId === input.sessionID
        ? compressPermission(state, config)
        // ponytail: no agent in system-transform input; global host rules only.
        // Agent-scoped denies land on the next messages.transform.
        : resolveEffectiveCompressPermission(config.compress.permission, hostPermissions)
```
Plus wire `hostPermissions` at `index.ts:57-62`.

## Status
Open

## Cross-references
- Source investigator: OpenCode integration + permissions
- Source finding ID: HOOK-PERM-2
- Validator verdict: ✅ CONFIRMED
- Doc anchor: `docs/DESIGN_PRINCIPLES.md` DPP-010, `docs/features/OPENCODE_INTEGRATION.md` Permissions

## Architect Review (2026-08-07)
- **Verdict**: PARTIAL (stated repro is REFUTED; a narrower gap is real)
- **Severity**: **changed Medium → Low**. Headline scenario is already handled; only a narrow agent-scoped first-turn case remains, and it self-corrects on the next transform.
- **Critique of report's fix**: worse — it does not compile and does not fix the gap. `syncCompressPermissionState(state, config, hostPermissions, output.system)` passes `string[]` where `WithParts[]` is required. Even if coerced, `getLastUserMessage(output.system)` yields no `activeAgent`. The system-transform `input` (`{ sessionID?, model }`) carries no agent — agent case is unfixable at this hook by design.
- **Bonus**: the headline scenario (host `{"permission": {"*": "deny"}}` → DCP injected in first system prompt) does NOT reproduce. The handler returns at line 89-91. Residual valid sub-claim: per-agent rules (`hostPermissions.agents[...]`) are resolved only in `messages.transform`, not at system-transform time.