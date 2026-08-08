# ADR 002: Compression state is session-scoped by design

**Status:** Accepted
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

## Related

- `known_issues/BUG-087-forked-session-context-bloat.md` — the bug this ADR responds to
- `lib/compress/pipeline.ts:157-208` — the recovery protocol (general-case mitigation)
- `lib/state/persistence.ts:78-80` — per-session state isolation (load-bearing invariant)
- `lib/state/utils.ts:54-65` — `isSubAgentSession` (the only existing fork-detection, limited to task-spawned subagents)
- `tests/session-fork.test.ts` — characterization tests for the fork detection, UX warning, and system-prompt hint
