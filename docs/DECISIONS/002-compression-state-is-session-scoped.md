# ADR 002: Compression state is session-scoped by design

**Status:** Superseded in part by ADR-003 (2026-08-08).
**Date:** 2026-08-07

## Context

When an OpenCode session is forked (via the UI fork action), the new session B starts with an empty `SessionState`. Prior compression blocks from the parent session A are not inherited. Investigation showed that B's model has no awareness of A's prior compression, which can result in blind re-compression and potential context bloat (see `known_issues/BUG-087-forked-session-context-bloat.md`).

Two fix paths were proposed:

### Path A: Reorder the `maxCompactionRatio` guard

Move the guard to run BEFORE `applyCompressionState` so non-compacting blocks are refused at write time.

### Path B: Cross-session state inheritance

When session B is detected as a fork of A, copy A's `prune.messages` and `prune.tools` into B.

## Decision

Both paths are **rejected**.

### Path A is rejected because:

1. **Architecturally impossible without refactor**: `compressedTokens` is produced BY `applyCompressionState` itself (`lib/compress/state.ts:257`). The guard's input is the mutation's output. A naive reorder is impossible; a true pre-guard requires a dry-run token estimate from `selection.messageTokenById` — that is a redesign, not a reorder.
2. **Protocol violation**: the v2 fork protocol's net-compaction check is deliberately a feedback loop (`lib/compress/pipeline.ts:157-208` — count bad runs, force manual mode), not a gate. Converting it to a refusal changes semantics for ALL sessions: legitimate user-requested non-compacting compresses (cleanup intent) would be blocked. This is an ADR-level protocol change with no evidence justifying it.
3. The existing recovery counter already bounds the damage at 3 runs.

### Path B is rejected because:

1. **Inheritance unsoundness**: The plugin learns about B at B's _first transform_, not at fork time. It could only copy A's _current_ state, not A's state at fork time.
2. **Race with continued work in A**: If A compresses more after the fork, B inherits blocks whose anchor/end IDs constrain B's monotonic validation (`lib/compress/range.ts:86-102`) and reference messages B may handle differently.
3. **Watermark requirement**: Sound inheritance requires a fork-point watermark (message count at fork) that even an upstream `forkedFrom` field doesn't provide.
4. **Risk/benefit negative**: state-coupling across sessions is a hard-rule violation risk. Per-session isolation by `{sessionId}.json` (`lib/state/persistence.ts:78-80`) is a load-bearing invariant.

## Consequence

Mitigation is at the **signal layer**, not the protocol layer:

- **Detection helper** (`detectParentSessionFromTitle` in `lib/state/utils.ts`) uses the upstream OpenCode server's `getForkedTitle` regex pattern. Designed behind a replaceable interface so the regex can be swapped for an upstream `forkedFrom` field when OpenCode SDK exposes one.
- **UX hint** logs a warning at session-init time when a fork is detected.
- **System-prompt hint** appends an inheritance note so the model itself can choose not to re-compress.
- **Composition vulnerability** (3 safety mechanisms all reset on fork: `nonCompactingRunCount = 0`, `prevAnchorEnd === ""`, `recoveryForced = false`) is acknowledged as a design tradeoff. The recovery protocol is the general-case mitigation for non-compacting blocks; fork B is just the likely case due to model blindness, not a fork-specific issue.

## Naming

The codebase uses `forkSchemaVersion` for THIS plugin's fork from upstream DCP. Adding fork-related concepts for OpenCode session forks creates naming confusion.

- `forkSchemaVersion` is preserved (load-bearing across config, state, persistence, docs).
- OpenCode session forks use the vocabulary "session lineage" / "parent session" in identifiers.
- A glossary entry in `docs/MASTER.md` disambiguates the two concepts.

## Superseded sections

ADR-003 (2026-08-08) overrides the following in this ADR:

- **Path B rejection (lines 30-36)** — Cross-session state inheritance is now ACCEPTED, gated on `experimental.inheritOnFork` (default true). Implementation: timestamp-anchored predicate + always-pick fallback chain + schema bump to v4. See `docs/DECISIONS/003-fork-state-inheritance.md`.
- **"Per-session isolation as load-bearing invariant" claim** — Per-session FILE boundary is preserved (`{sessionId}.json` namespacing unchanged); inheritance copies selected fields via the third sanctioned writer `mergeInheritedBlocks` in `lib/compress/state.ts`. The "isolation" claim is relaxed: state crosses session boundaries on the fork path; per-session file isolation is still load-bearing for non-fork sessions.

The rest of ADR-002 holds: detection helper (`detectParentSessionFromTitle`), the load-bearing per-session file isolation for normal sessions, the recovery protocol as general-case mitigation. The system-prompt hint and UX warning mentioned in this ADR were removed in ADR-003; `tests/session-fork.test.ts` was rewritten for always-pick semantics.

## Related

- `docs/DECISIONS/003-fork-state-inheritance.md` — supersedes the Path B rejection.
- `docs/features/SESSION_FORK.md` — user-facing behavior of fork inheritance.
- `known_issues/fixed/BUG-089-fork-state-inheritance-protocol-layer.md` — the bug ADR-003 closes.
- `lib/compress/pipeline.ts:157-208` — the recovery protocol (general-case mitigation).
- `lib/state/persistence.ts:78-80` — per-session state isolation (load-bearing invariant).
- `lib/state/utils.ts:54-65` — `isSubAgentSession` (the only existing fork-detection, limited to task-spawned subagents).
- `tests/session-fork.test.ts` and `tests/session-fork-inherit.test.ts` — characterization tests for the fork detection and inheritance orchestrator.
