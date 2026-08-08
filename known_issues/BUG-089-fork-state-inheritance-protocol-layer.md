# BUG-089: fork state inheritance protocol layer (residual from BUG-087)

**Status:** Open (protocol-layer remainder)
**Severity:** Medium
**Component:** lib/hooks.ts (system prompt hint + UX warning), lib/state/state.ts (fork detection), lib/compress/state.ts (compression block shape)

## Problem

This is the **protocol-layer remainder of BUG-087** after the UX-only mitigation shipped on 2026-08-07. BUG-087 fixed the user-visible bloat by adding a system-prompt hint and UX warning for detected forks. That mitigation was incomplete: it tells the model "blocks are not visible" without actually copying the blocks, and the hint is removed in the upcoming fork-inheritance feature (per user direction 2026-08-08). This bug tracks the protocol-layer work — the actual mechanism that carries compression state across forks.

User intent (2026-08-08): "When a session is forked, I would expect its compression to also carry over. Because otherwise the new fork will suddenly have an uncompressed session and explode in context size."

Without this work, the fork-bloat symptom from BUG-087 returns on every fork once the BUG-087 mitigation is reverted.

## Root cause

`ensureSessionInitialized` (`lib/state/state.ts:169-229`) correctly isolates state per `sessionId` (file `{sessionId}.json` per `lib/state/persistence.ts:78-80`). When OpenCode forks A → B, B inherits raw messages from A but starts with empty `SessionState`. B's model sees raw uncompressed history and operates on it — context balloons.

The UX mitigation (BUG-087) told the model "blocks are not visible" — but the model has no signal of WHY (and once the inheritance feature lands, the hint becomes actively wrong when blocks ARE visible). The right fix is to actually copy the state.

The implementation has been scoped into a plan: `docs/plans/fork-state-inheritance.md`. That plan documents the design (timestamp-anchored predicate, always-pick fallback chain, default-on `experimental.inheritOnFork`) and lists the work required.

## Steps to reproduce (pre-fix, after BUG-087 mitigation reverts)

1. Session A accumulates 20 messages with substantial tool output.
2. Compress A — A's state records the compression block.
3. Use OpenCode's UI fork action: A → B.
4. In B, do some new work (m21..m30).
5. Observe: B sees raw m1..m20 + raw m21..m30. No compression blocks from A.
6. B's transform-time context size balloons back to the uncompressed size.

## Impact

- **Context size**: B's model sees the full uncompressed history. For a 20-message compressed range, this is roughly the LLM cost of the entire range on every transform.
- **Token cost**: B redundantly processes content A already compressed.
- **UX surprise**: User forks A expecting "try a different approach from the same point"; they don't expect to pay full re-compression cost for the shared history.
- **No correctness hole**: state integrity is preserved (correct per-session isolation).

## Fix path

See `docs/plans/fork-state-inheritance.md` for the full design. Highlights:

- Always-attempt inheritance (default `experimental.inheritOnFork: true`, opt-OUT for strict isolation).
- Always-pick fallback chain (single candidate → longest exact timestamp prefix → recency by mtime → graceful give-up only when zero candidates).
- Timestamp-anchored predicate (message IDs are regenerated on fork; only `time.created` survives).
- New fields on `CompressionBlock`: `startTime`, `endTime`, `effectiveTimeMs`, `directTimeMs`, `anchorTime`, `compressTime` — with schema bump.
- `mergeInheritedBlocks` canonical third writer in `lib/compress/state.ts`.
- System-prompt hint removed; UX warning rewired to report inheritance outcome.

Estimated effort: ~1,290 lines across ~15 files (per plan §5).

## Related

- **BUG-087**: `known_issues/fixed/BUG-087-forked-session-context-bloat.md` — initial UX-only mitigation, fixed 2026-08-07. This bug is the protocol-layer remainder.
- **BUG-088**: `known_issues/BUG-088-load-all-session-stats-double-count.md` — latent stats aggregation bug exposed when fork inheritance copies `stats.totalPruneTokens`. Recommended fix: Option B (split `sessionOwnPruneTokens` vs `inheritedPruneTokens`).
- **Plan**: `docs/plans/fork-state-inheritance.md` — full design with critical gate (SQLite probe for message-ID preservation, completed 2026-08-08).
- **ADR-003** (pending): supersedes ADR-002 in part, records schema bump + always-pick chain + default-on + hint-removal rationale.
- **`lib/state/state.ts:169-229`**: integration point inside `ensureSessionInitialized`.
- **`lib/compress/state.ts`**: canonical writer; `mergeInheritedBlocks` will live here.
