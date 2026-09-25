# BUG-099 — Compression notification headline shows cumulative summary tokens and lacks `#N` marker

**Status:** FIXED 2026-09-25
**Component:** `lib/ui/notification.ts::sendCompressNotification`
**Config required to reproduce:** `dcp.jsonc` with `"pruneNotification": "detailed"` (or `toast` with chat surface disabled)
**Severity:** Cosmetic — info incorrect but no data loss, no behavioural regression in compression itself.

## Symptom

The `▣ DCP | -X removed, +Y summary` headline shown in the chat (and toast) after each `compress` tool call leaked the **cumulative** summary-token count across all compressions done so far in the session. The `-X removed` value was correctly per-compression, but the `+Y summary` value was the running total. After three compressions with summaries of `46.5K + 1.3K + 0.6K`, the third headline read `+48.5K summary` instead of `+616 summary`.

Additionally, the headline had no identifier for which compress had just run — the `#N` only appeared on the detail line, so users comparing two consecutive notifications had no way to tell at a glance whether they had advanced to the next compress or were looking at a re-render of the prior one.

The detail line `▣ Compression #N -X removed, +Y summary` showed per-compression values, while the headline above it claimed cumulative. The two lines were internally inconsistent.

## Root cause

`lib/ui/notification.ts:349` built the headline as

```ts
const notificationHeader = `▣ DCP | ${formatCompressionMetrics(compressedTokens, totalActiveSummaryTkns)}`
```

`compressedTokens` is the per-notification delta (sum over the `entries` being notified). `totalActiveSummaryTkns` is `getActiveSummaryTokenUsage(state)` — the session-lifetime cumulative counter across every active compression block. Mixing the two in one metrics string is the bug.

The detail line one screen below was built from `(compressedTokens, summaryTokens)` — both per-compression. So the user saw "this compress" on the detail and "everything ever compressed" on the headline, side by side.

The `#N` marker was not added to the headline because the run identifier (`entries[0]?.runId`) was only consulted inside `getCompressionLabel(entries)` for the detail line.

## Fix

`lib/ui/notification.ts::sendCompressNotification` now:

1. Computes `runMarker = runId !== undefined ? \`#${runId} | \` : ""`and embeds it in the headline between`▣ DCP |`and the metrics. The marker is omitted when`runId` is undefined (legacy / non-versioned callers).
2. Uses per-compression `summaryTokens` in the headline's `formatCompressionMetrics` call, matching the per-compression `compressedTokens` already used there.
3. Computes `cumulativeCompressedTokens` by walking `state.prune.messages.activeBlockIds` and summing `block.compressedTokens` for blocks with `block?.active` (mirrors `getActiveSummaryTokenUsage`'s pattern). The detail line now uses `(cumulativeCompressedTokens, totalActiveSummaryTkns)` so it shows session-cumulative compression stats — distinct from the existing `→ Session total: …` line, which includes prune (non-compress) removals too.

Result for the user's three-compression session (current format — detail-line label was later refined to `Compression total`, see [Follow-up refinement](#follow-up-refinement-detail-line-label--footers) below):

| Compress | Headline                                         | Detail line                                           |
| -------- | ------------------------------------------------ | ----------------------------------------------------- |
| #1       | `▣ DCP \| #1 \| -107.9K removed, +46.5K summary` | `▣ Compression total -107.9K removed, +46.5K summary` |
| #2       | `▣ DCP \| #2 \| -66.6K removed, +1.3K summary`   | `▣ Compression total -174.5K removed, +47.8K summary` |
| #3       | `▣ DCP \| #3 \| -25.8K removed, +616 summary`    | `▣ Compression total -200.3K removed, +48.4K summary` |

Cumulative totals in the detail line increase monotonically across compresses, matching the user's mental model of "how much has compression saved in total". The `→ Session total: …` line still reports the broader `totalPruneTokens + pruneTokenCounter` (which can diverge from compression-only totals when prune runs alongside compression).

## Follow-up refinement: detail-line label & footers

After testing the fix the user noted that for a single-compression session the headline `▣ DCP | #1 | -78.9K removed, +2.4K summary` and the detail line `▣ Compression #1 -78.9K removed, +2.4K summary` were internally identical, which made the detail line look redundant. The same was true (and harder to spot) for the per-compression case where the `#N` counter in the headline already conveyed which compress had run. Refined in `lib/ui/notification.ts:sendCompressNotification`:

- Detail line label changed from `Compression #N` to literal **`Compression total`**. The `#N` is now exclusively in the headline.
- The `→ Session total: …` footer was removed entirely — it duplicated the cumulative `Compression total` values above and was sometimes misleading (it included prune removals, not just compress).
- The `→ Compression (~W tokens): summary` footer was renamed to **`→ Summary: summary`**. The estimated token count of the summary was redundant with the `+Y summary` token count in the headline / detail metrics.

The toast-truncation path that replaced the body of the `→ Compression (…)` line with a truncated version was updated to match the new prefix. Two now-unused locals (`summaryTokensStr`, `sessionTotalGross`) were dropped.

## Tests

`tests/notification-header.test.ts` (5 tests):

- Test 1: single-block headline regex tightened to `^▣ DCP \| #7 \| -2\.5K removed, \+3 summary$`.
- Test 2: loose `/-4K removed/` headline assertion replaced with strict equality against `▣ DCP \| #5 \| -4K removed, +6 summary`, locking in the per-compression format and preventing a regression that would leak cumulative summary back.
- Test 4: first/second headline equality strings updated to per-compression summary values; detail-line regex updated to cumulative `-9K removed, +6 summary`.
- Test 5 (new): `runId === undefined` path — asserts the legacy `▣ DCP | -1K removed, +3 summary` headline shape (no `#N |` marker) when the entry's runId is undefined. Casts through `any` to bypass the `runId: number` type and exercise the defensive `entries[0]?.runId` branch.
- Trailing `// Logic Verified:` comment extended to document the new format and the optional `#N` marker.

`tests/compress-message.test.ts:706` and `tests/compress-range.test.ts:354`: regex `/▣ DCP \| -[^,\n]+ removed/` replaced with `/▣ DCP \| (#\d+ \| )?-[^,\n]+ removed/` to accept both the new `#N |` shape and the legacy shape when `runId === undefined`.

Additional lock assertions in `tests/notification-header.test.ts` (this turn's refinement):

- Tests 1, 2, 4 detail-line regex assertions updated from `Compression #N` to `Compression total`.
- Tests 1 and 4 also gained `assert.doesNotMatch(text, /→ Session total:/)` to lock in the removal of that footer.
- `tests/compress-message.test.ts:707`, `tests/compress-range.test.ts:355`, `tests/compression-groups.test.ts:261`: detail-line `Compression #N` assertions updated to `Compression total`, plus negative-lock assertions against regressing back to `Compression #\d+` in any of the toasts.

## Validation

- `npm test` → 605 / 605 pass on the most recent run (one unrelated pre-existing flake in `tests/session-fork.test.ts:514` BUG-089, untouched by this change).
- `npm run typecheck` → clean.
- `npm run format:check` → clean.

## Files changed

- `lib/ui/notification.ts`
- `tests/notification-header.test.ts`
- `tests/compress-message.test.ts`
- `tests/compress-range.test.ts`
- `tests/compression-groups.test.ts` (added in this refinement round; verifies the "increment by tool call" coverage still works via the headline `#N |` marker)
