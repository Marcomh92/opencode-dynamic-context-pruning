# PATTERNS

Conventions used across the codebase. The "why" matters more than the "what" — the patterns below are how the codebase documents deliberate trade-offs.

## PAT-001 — Ponytail comments

`// ponytail: ...` marks a deliberate simplification. The comment names the ceiling and the upgrade path. Treat it as part of the spec; do not silently "fix" it.

Format: a short statement of the ceiling, then a one-line "Add when ..." clause. Examples:

- `lib/state/persistence.ts:63-67` — single-process storage resolution; add `flock` / `LockFileEx` when cross-process parity matters.
- `lib/state/types.ts:135-139` — `subAgentResultCache` is intentionally cold; add a write-on-completion path when the round-overwrite bug is solved.
- `lib/compress/pipeline.ts:127` — `manualMode` tri-state cache; collapse `"compress-pending"` only if a second writer is added and reviewed.

**Why.** The codebase favors honest ceilings over speculative completeness. Removing a ponytail comment is a behavior change.

## PAT-002 — Single-writer rules

| Surface                    | Single writer                                                                |
| -------------------------- | ---------------------------------------------------------------------------- |
| New compression blocks     | `applyCompressionState` (`lib/compress/state.ts`)                            |
| Bulk block reconciliation  | `syncCompressionBlocks` (`lib/messages/sync.ts`)                             |
| Session persistence        | `saveSessionState` / `coalesceSaveSessionState` (`lib/state/persistence.ts`) |
| Subagent cache key         | `buildSubAgentCacheKey` (`lib/subagents/cache-key.ts`)                       |
| Manual-mode transient flag | `/dcp-compress` slash command handler                                        |

**Why.** Multiple writers that mutate the same shape converge to one canonical set of invariants. When adding side-effects, route them through the existing writer.

## PAT-003 — In-place mutation for message arrays

`prune`, `filterMessagesInPlace`, `stripHallucinations`, and `stripStaleMetadata` mutate the input array's length in place. Callers must accept array identity change.

**Why.** A new array would mean a new identity, and downstream code keys off identity. In-place is the contract.

## PAT-004 — Exact-tail append idempotency

`appendToTextPart` and `appendToToolPart` use `endsWith()` to suppress re-append. Earlier occurrences are deliberately re-appended.

**Why.** Cache-busting risk from non-tail re-append is the smaller cost compared to duplicate text in the model context. See `tests/append-idempotency.test.ts:68-78` (issue #463).

## PAT-005 — Soft issues vs hard errors

| Tool                          | Behavior on bad arg                                                    |
| ----------------------------- | ---------------------------------------------------------------------- |
| `compress` range mode         | Throws hard `Error`. Range mode is all-or-nothing.                     |
| `compress` message mode       | Returns `SoftIssue` list and skips the bad message.                    |
| Subagent cache miss           | No-op; falls back to `part.state.output`.                              |
| `__DCP_MONOTONIC_VIOLATION__` | Thrown with a `validNextIds` hint; the agent can branch on the prefix. |

**Why.** Range mode is contract-bound; message mode is per-item best-effort. The agent should know when a contract fails.

## PAT-006 — Numeric-aware sort for boundary IDs

`lib/compress/range-utils.ts:32` uses `localeCompare(..., undefined, { numeric: true })` so `b1 < b2 < b10`. Default sort would be lexicographic and would produce `b1, b10, b2`.

**Why.** IDs are positive integers. Numeric sort is the only correct sort.

## PAT-007 — `compress-pending` is local to `/dcp-compress`

The `manualMode === "compress-pending"` flag is written only by the slash-command handler and read only by `prepareSession` (`lib/compress/pipeline.ts:58-69`).

**Why.** Adding a second writer silently disables the manual-mode gate. The flag's comment is the spec.

## PAT-008 — Schema-version gate on persistence

`FORK_SCHEMA_VERSION = 3` in `lib/state/types.ts`. Any persisted state with a mismatched or missing `forkSchemaVersion` is dropped on load.

**Why.** Migration code is a liability. A clean drop is honest about the boundary. Bump the version when the on-disk shape changes; the comment block names the prior bump's reason.

## PAT-009 — Coalesced save is the default

`coalesceSaveSessionState` is fire-and-forget. Direct `saveSessionState` is the strong save-on-await path.

**Why.** Two writers in one process racing on the same file is the common case. The coalescer makes it O(1) writes per microtask. The cross-process race is acknowledged and not closed.

## PAT-010 — One-file-per-concern tests

`tests/*.test.ts` matches the directory layout: one file per source concern. No `tests/fixtures/` or `tests/helpers/` directory; inline builders only.

**Why.** A test file is the spec for a concern. Inline fixtures keep the spec readable without a global helper contract.

## PAT-011 — XDG sandbox for filesystem tests

Filesystem-touching tests redirect `XDG_DATA_HOME` / `XDG_CONFIG_HOME` into per-pid temp dirs before tests run. `process.pid` is in the path to avoid collisions across parallel shells.

**Why.** Tests must not touch the host filesystem. The pattern is the convention; see `tests/coalesce-save-session.test.ts:10-17` and the seven other files using it.

## PAT-012 — Audit-trail trailer for contract tests

Tests that verify a contract close with a four-line audit trail:

```
// Logic Verified: ...
// Bugs Documented: ...
// Fakes Updated: ...
// Review Status: ...
```

**Mandatory for every test file under `tests/`.** The last four non-blank lines of every `tests/*.test.ts` must match the canonical token order above. The contract is enforced by `tests/test-audit-trailers.test.ts` (self-excluded); a missing or reordered trailer fails the suite. See `tests/compress-message.test.ts:891-894` for a current example.

**Why.** The trailer is the static audit trail that lets reviewers see what each test claimed to verify without re-deriving the rationale from the code. Treating it as part of the spec is what makes the audit enforceable.

## PAT-013 — Issue numbers in test names

Regressions name the GitHub issue in the test description: `"finalizeSession #590: ..."`. The pattern is the convention.

**Why.** Triage without re-deriving the rationale from the code.

## PAT-014 — `jsonc-parser` CJS UMD entry

`jsonc-parser` is imported via its CJS UMD entry, not its deep ESM path. The top-of-file comment in `lib/config.ts` explains why. Do not "fix" this.

**Why.** Node 24 + tsx in test mode cannot surface named exports from the deep ESM path. The workaround is a hard rule.

## PAT-015 — `applyCompressionState` as the v2 side-effect funnel

All side-effects of a new compression block — deactivation, `byMessageId` updates, stats flush, tool propagation — live in `applyCompressionState`. New side-effects go in this function.

**Why.** A new side-effect is a behavior change. Concentrating them in one function keeps the contract auditable.
