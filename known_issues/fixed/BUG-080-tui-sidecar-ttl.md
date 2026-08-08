# BUG-080: Cache sidecar JSON in TUI between modal opens (5s TTL)

## Summary

Each `loadSessionData` call (`lib/tui/data.ts:36-92`) re-reads XDG_DATA state. For a panel that opens/closes several times in a session, a 5-second TTL cache would avoid the disk I/O.

## Location

- `lib/tui/data.ts:36-92`

## Current vs Expected Behavior

**Current**: Disk read on every TUI mount.
**Expected**: 5-second TTL cache.

## Impact

- **Severity**: Suggestion (UX/perf)
- Runtime: not affected.
- User-observable: faster modal open/close.

## Reproduction

Open and close the TUI panel rapidly; observe repeated disk reads.

## Suggested Fix

Ponytail: module-level Map. `lib/tui/data.ts`:

```ts
const sidecarCache = new Map<
    string,
    {
        data: Awaited<ReturnType<typeof buildSessionData>> | undefined
        expiresAt: number
    }
>()
const SIDECAR_TTL_MS = 5000

// inside loadSessionData (line 86), after the activeSessionID check:
const cached = sidecarCache.get(sessionID)
if (cached && cached.expiresAt > Date.now()) return cached.data

const messages = sessionMessages(api, sessionID)
const state = await buildSessionState(sessionID, messages, config)
const data = { state, messages }
sidecarCache.set(sessionID, { data, expiresAt: Date.now() + SIDECAR_TTL_MS })
return data
```

No eviction needed — bounded by # active sessions.

## Status

Fixed 2026-08-07

## Resolution

Added 5-second TTL cache for `state` only at `lib/tui/data.ts:36-92`; `messages` recomputed every call.

## Cross-references

- Source investigator: prompts + UI + TUI + subagents
- Source finding ID: S-TUI-SIDECAR-CACHE-1
- Validator verdict: ✅ CONFIRMED
- Doc anchor: `docs/features/OPENCODE_INTEGRATION.md` TUI entrypoint

## Architect Review (2026-08-07)

- **Verdict**: CONFIRMED
- **Severity**: kept Suggestion (UX/perf)
- **Critique of report's fix**: missing detail — the cache should store the post-`buildSessionState` result (state + messages), not just session state.
- **Bonus**: if the plugin ever exposes a state-mutating user action in the TUI, the cache must be invalidated on that action. No such action exists today. The `messages` field in the cached value is `WithParts[]` (host state) and changes on every assistant turn; if cache returns stale `messages`, TUI panel shows outdated content. Cache only `state`; recompute `messages` on every call.
