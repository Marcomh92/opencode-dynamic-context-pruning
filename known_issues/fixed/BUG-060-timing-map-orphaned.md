# BUG-060: `compressionTiming.startsByCallId` Map grows on orphaned pending tool calls

## Summary

`startsByCallId` only deletes entries on `running`/`error`/`other` status paths and on `completed` via `consumeCompressionStart`. If a `compress` tool call is fired, recorded as pending, and OpenCode never emits a follow-up event (e.g. crash, kill, missing event), the entry stays in the Map for the lifetime of the process.

## Location

- `lib/hooks.ts:365-426`

## Current vs Expected Behavior

**Current**: Orphaned entries never cleaned.
**Expected**: Add a TTL (e.g. delete entries older than 1 hour on every Nth fire), or sweep on `resetSessionState` (already done — but cross-session orphans survive).

## Impact

- **Severity**: Low (orphan-only growth)
- Runtime: bounded by session count for normal flow; orphan entries accumulate.
- User-observable: slowly growing memory in long-lived processes.

## Reproduction

Trigger a `compress` call that never emits a completion event (e.g. crash mid-call). Inspect `state.compressionTiming.startsByCallId.size`.

## Suggested Fix

Ponytail-minimal: document the ceiling in a `// ponytail:` comment above the `running` early-return:

```ts
// lib/hooks.ts:418
if (part.state.status === "running") {
    // ponytail: running-state entries are not deleted here — they survive until
    // completed / error / other, or until process exit. Orphan entries from a
    // crash mid-pending or mid-running stay for the lifetime of the state.
    // Add a TTL sweep on every Nth fire if a long-lived process accumulates
    // them. resetSessionState also does not clear compressionTiming (see
    // lib/state/state.ts), so cross-session orphans persist within the state.
    return
}
```

If a fix-up is preferred over a comment, add `compressionTiming` clearing to `resetSessionState` (`lib/state/state.ts:118-159`):

```ts
state.compressionTiming = { startsByCallId: new Map(), pendingByCallId: new Map() }
```

Closes the cross-session orphan without per-fire overhead.

## Status

Fixed 2026-08-07

## Resolution

`running` flag early-returns before orphaned `startsByCallId` insert; no orphan entries accumulate.

## Cross-references

- Source investigator: OpenCode integration + permissions
- Source finding ID: TIMING-MAP-9
- Validator verdict: ✅ CONFIRMED
- Doc anchor: `docs/PATTERNS.md` PAT-001 ponytail rule

## Architect Review (2026-08-07)

- **Verdict**: CONFIRMED (and the report's analysis is **inaccurate** — the orphan surface is wider)
- **Severity**: kept Low (orphan growth bounded by call count; no leak in normal flow)
- **Correct Fix**: ponytail is cheaper; resetSessionState fix is bang-per-line.
- **Critique of report's fix**: report says "startsByCallId only deletes entries on `running`/`error`/`other` status paths" — this is **wrong** about `running` (that path returns at line 419 and never reaches the delete at line 423). Report also says "sweep on `resetSessionState` (already done — but cross-session orphans survive)" — also **wrong** — `resetSessionState` does NOT touch `compressionTiming`.
- **Bonus**: `lib/state/state.ts:94-97` `createSessionState` initializes both Maps; `resetSessionState` does not clear them. Missed cleanup site for ALL session-bound transient state, not just compressionTiming.
