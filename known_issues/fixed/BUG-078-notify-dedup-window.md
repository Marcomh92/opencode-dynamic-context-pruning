# BUG-078: Add per-session dedup window for identical notifications

## Summary

A session that triggers compress on every turn will toast the same text repeatedly. Add a 1-second dedup window with a `+N suppressed` counter.

## Location

- `lib/ui/notification.ts:91-123`

## Current vs Expected Behavior

**Current**: The in-flight flag coalesces same-tick bursts, but sequential awaited calls each fire a new toast regardless of content.
**Expected**: Per-session dedup window.

## Impact

- **Severity**: Suggestion (UX)
- Runtime: not affected.
- User-observable: same toast doesn't repeat within 1s.

## Reproduction

Trigger compress 10 times in 2 seconds; observe 10 toasts.

## Suggested Fix

Ponytail: module-level last-dispatch record. `lib/ui/notification.ts`:

```ts
let lastDispatchKey = ""
let lastDispatchAt = 0
let suppressedCount = 0
const TOAST_DEDUP_WINDOW_MS = 1000

// at the top of dispatchToast (line 91):
const key = `${title}|${message}`
const now = Date.now()
if (key === lastDispatchKey && now - lastDispatchAt < TOAST_DEDUP_WINDOW_MS) {
    suppressedCount++
    return
}
lastDispatchKey = key
lastDispatchAt = now
```

And surface `suppressedCount` via the existing `pendingMergedMessages` merge loop:

```ts
// inside the while-loop at line 105:
const merged =
    pendingMergedMessages.join("\n") +
    (suppressedCount > 0 ? `\n\n(${suppressedCount} suppressed)` : "")
pendingMergedMessages = []
suppressedCount = 0
```

## Status

Fixed 2026-08-07

## Resolution

Added 1-second dedup window with `+N suppressed` counter at `lib/ui/notification.ts:91-123`; key includes title + message body.

## Cross-references

- Source investigator: prompts + UI + TUI + subagents
- Source finding ID: S-NOTIFY-DEDUP-1
- Validator verdict: ✅ CONFIRMED
- Doc anchor: `docs/features/OPENCODE_INTEGRATION.md` Notifications

## Architect Review (2026-08-07)

- **Verdict**: CONFIRMED
- **Severity**: kept Suggestion (UX nit)
- **Correct Fix**: equivalent; critical missing detail in the report — dedup key must include the `message` body, not just `title` (all callers use the constant title `"DCP: Compress Notification"`). The "+N suppressed" counter needs a concrete landing site; piggybacking on the existing merge loop is the minimal diff.
- **Bonus**: 3 callers feed `dispatchToast`: `sendUnifiedNotification` (line 210), `sendCompressNotification` (line 385), and indirectly. Dedup applies uniformly.
