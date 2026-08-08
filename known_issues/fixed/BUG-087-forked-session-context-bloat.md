# BUG-087: forked session can balloon context via blind re-compression

**Status:** Fixed 2026-08-07
**Severity:** Medium
**Component:** lib/compress/pipeline.ts, lib/messages/prune.ts, lib/hooks.ts, lib/state/utils.ts

## Problem

When user compresses a range in session A, then forks A → B, B's `SessionState` is reset to empty. B's model sees raw m1..m20 + new content with no signal that A had prior compression. If B's model decides to compress (or user invokes `/dcp-compress`), AND the new summary is larger than the raw content it replaces (model quality issue, or "compress-pending" was bypassed without genuine compaction), the new block is written to B's `state.prune.messages.blocksById` BEFORE the `maxCompactionRatio` guard runs. The synthetic summary is then injected into B's model-visible output on every subsequent transform, defeating the purpose of forking.

## Steps to reproduce

1. Start session A (sessionId="ses_A"). Accumulate 20 messages with substantial tool output (m1..m20).
2. Invoke `/dcp-compress` on A with range `[m1..m20]`. A now has 1 compression block covering m1..m20. A's transform-time context size is reduced.
3. Use OpenCode's UI fork action: A → B (sessionId="ses_B"). B inherits raw message history.
4. In B, do some new work (m21..m30).
5. Invoke `/dcp-compress` on B with a range that overlaps A's prior compression, e.g., `[m1..m25]` or `[last 25]`.
6. Observe: B's model re-summarizes m1..m20 with no signal that A had already summarized them. If the new summary is larger than the raw content, B's transform-time context size grows larger than A's would have been.

## Root cause

1. **State isolation is correct, but creates a model-blindness problem.** `lib/state/state.ts:121-167` (`resetSessionState`) correctly wipes A's state from B on session change. `lib/state/persistence.ts:78-80` correctly namespaces state files by `{sessionId}.json`. So state integrity is preserved. But this means B's model has no awareness of A's prior compression.
2. **Monotonic check is bypassed on first compress.** `lib/compress/range.ts:86-92` and `lib/compress/message.ts:83-89` skip `validateMonotonicEnd` when `prevAnchorEnd === ""` (which is always true for B's first compress). This is correct for state integrity but means B can compress overlapping ranges without constraint.
3. **`applyCompressionState` runs unconditionally before the bloat guard.** `lib/compress/state.ts` writes the new block first; `maxCompactionRatio` (`lib/compress/pipeline.ts:157-208`) only triggers `recoveryForced` after 3 bad runs. The block is in state from turn 1 of the bad compress. _(Note: the guard runs AFTER `applyCompressionState` by design — see "Architectural context" below — and is a feedback loop, not a gate. See "Fix paths" #3 for why reordering is rejected.)_
4. **No fork detection in the SDK layer.** OpenCode SDK does NOT expose a fork-pointer. `parentID` is `null` for UI-forked sessions. The only in-band signal is the title pattern `/^(.+) \(fork #\d+\)$/`, which user can rename.

## Impact

- **Token cost**: B redundantly summarizes content A already compressed. For a 20-message compressed range, this is the LLM cost of summarizing 20 messages a second time.
- **Context size balloon**: if B's model produces a summary larger than A's prior summary (e.g., because the raw messages get re-processed and produce verbose output), B's transform-time context size grows.
- **Cache invalidation**: B's prompt cache starts fresh anyway, so no extra cache cost — but LLM cost remains.
- **UX surprise**: user forks A expecting "try a different approach from the same point"; they don't expect to pay full re-compression cost for the shared history.
- **No tests** cover this scenario (verified by grepping `tests/` for `fork`, `parentSessionId`, `inherit`).

## Architectural context

The composition vulnerability arises because B is maximally exposed: fresh state means `nonCompactingRunCount = 0` AND `prevAnchorEnd === ""` AND `recoveryForced = false` simultaneously (`lib/state/state.ts:121-167`). Three independent safety mechanisms all reset at exactly the moment B re-encounters A's already-paid-for content. No single mechanism is buggy; the composition is the vulnerability.

Note: this bloat is NOT fork-specific. A first bad compress in ANY session writes a non-compacting block that stays in state until recovery accumulates (`lib/compress/pipeline.ts:162-164`). Fork B is just the likely case because of model blindness. A fork-scoped fix overclaims; the general-case mitigation is the existing recovery protocol.

## Fix paths (priority order, from smallest diff to largest)

### Recommended: Paths 1 + 5 + 2 (ship together)

1. **UX hint via title-regex detection helper** (smallest diff, 2-3h):
    - Add `detectParentSessionFromTitle(sessionTitle: string): { isForked: boolean; parentTitle?: string; forkNumber?: number }` in `lib/state/utils.ts`. Returns true for titles matching `/^(.+) \(fork #(\d+)\)$/`. Mirrors the upstream OpenCode server's `getForkedTitle` regex.
    - In `ensureSessionInitialized` (or wherever session-load events surface), if helper returns `isForked`, emit a one-line log warning: "DCP: forked session detected — prior compression blocks from parent session are not inherited. Consider deleting this session's state file if you want to start fresh."
    - Pure UX, no protocol change.

2. **System-prompt hint** (increment on Path 1, +2h):
    - In `createSystemPromptHandler`, if `detectParentSessionFromTitle` returned `isForked`, append a one-line inheritance hint to the system prompt: "Note: this session was forked from another session whose prior compression blocks are not visible. The model should avoid re-compressing content it has not itself seen in raw form."
    - Reuses Path 1's detector — no separate detection logic.
    - The model itself chooses not to re-compress. Doesn't fix dedup/monotonic bypass, but addresses user-visible symptom.

3. **Test coverage in `tests/session-fork.test.ts`** (4-6h, ship alongside Path 1):
    - See "Test coverage" section below.

### Rejected paths

3. **Bloat guard reorder — REJECTED (architecturally impossible + protocol violation)**:
    - **Impossibility**: `compressedTokens` is produced BY `applyCompressionState` itself (`lib/compress/state.ts:257`). A naive reorder is architecturally impossible because the guard's input is the mutation's output. A true pre-guard would require a dry-run token estimate from `selection.messageTokenById` — that is a redesign, not a reorder.
    - **Protocol violation**: the v2 fork protocol's net-compaction check is deliberately a feedback loop (§6.1/§6.2 — count bad runs, force manual mode), not a gate. Converting it to a refusal changes semantics for ALL sessions: legitimate user-requested non-compacting compresses (cleanup intent) would be blocked. ADR-level protocol change with no evidence justifying it.
    - The existing recovery counter already bounds the damage at 3 runs.

4. **State inheritance via SDK workaround — REJECTED (even if upstream lands `forkedFrom`)**:
    - The plugin learns about B at B's _first transform_, not at fork time. It could only copy A's _current_ state, not A's state at fork time.
    - If A compresses more after the fork, B inherits blocks whose anchor/end IDs constrain B's monotonic validation (`lib/compress/range.ts:86-102`) and reference messages B may handle differently.
    - Sound inheritance requires a fork-point watermark (message count at fork) that even `forkedFrom` doesn't provide.
    - Risk/benefit firmly negative. Do not promise state inheritance on top of an upstream ask.

## Upstream strategy

**Recommended: ship the title-regex workaround now AND file a scoped upstream issue for a detection signal only.**

The workaround (Paths 1+2) is cheap, self-contained, and degrades gracefully (renamed fork title means no hint — same as today). Waiting for upstream leaves users paying redundant summarization costs indefinitely.

The upstream issue should be scoped to **detection signal only**:

- Request: `forkedFrom` field on `Session` (and ideally a fork-point message watermark).
- Do NOT promise state inheritance on top of it — as detailed above, inheritance is unsound without a watermark.

**Design constraint to apply now**: hide detection behind a single helper (`detectParentSessionFromTitle` or similar) so the signal source is replaceable. When upstream lands `forkedFrom`, swap the regex for the real field behind the same interface.

## Naming

The codebase uses `forkSchemaVersion` for THIS plugin's fork from upstream DCP. Adding fork-related concepts for OpenCode session forks creates naming confusion.

- **Do not rename `forkSchemaVersion`** — it is load-bearing across `dcp.schema.json`, `lib/config.ts`, `lib/state/types.ts`, `lib/state/persistence.ts`, and the docs. Renaming is pure churn with regression risk.
- **Disambiguate by giving the OpenCode concept its own vocabulary**: use "session lineage" / "parent session" in identifiers (e.g., `detectParentSessionFromTitle`, `parentSessionHint`). Reserve "fork" for the repo/protocol.
- **In prose**: always say "OpenCode session fork" vs. "the fork" (repo) — never bare "fork" for the OpenCode concept.
- **One-line glossary addition to `docs/MASTER.md`**: "Session fork (OpenCode) — a UI-forked OpenCode session; unrelated to the repo fork / fork protocol."

## ADR note

Record the rejection of Paths 3 and 4 in `docs/DECISIONS/`. Suggested title: "ADR-NNN: Compression state is session-scoped by design". Body: capture the rejection rationale so the next person who rediscovers this doesn't re-litigate it.

## Test coverage

For `tests/session-fork.test.ts` (one-file-per-concern convention):

- **Core scenario**: A compresses `[m1..m20]` → simulate fork (fresh state, same raw messages) → B compresses overlapping `[m1..m25]` → assert B's `blocksById` is valid, no cross-session leakage, B's state file independent.
- **Monotonic bypass characterization**: B's first compress with `prevAnchorEnd === ""` accepts an overlapping range (`range.ts:95-102`) — pin this as intended behavior so a future "fix" doesn't silently change it.
- **Non-compacting first run**: B's compress where `summaryTokens >= removedTokens * maxCompactionRatio` → block IS applied (documenting current gate-less behavior) AND `nonCompactingRunCount === 1`.
- **Recovery independence**: A has `recoveryForced = true`; B (forked) starts with all counters at zero.
- **Title detector unit tests** (with Path 1): matches `"X (fork #2)"`, rejects plain titles, rejects user-renamed titles gracefully, handles missing title.
- **Mid-compress fork**: A has `compress-pending` / in-flight timing entries; B initializes clean — no leakage.
- **Multi-generation A→B→C**: each generation fully isolated; C's compress doesn't interact with A's or B's state files.

Estimated effort: 4-6 hours (detector tests ~1h of that, landing with Path 1).

## Effort estimate

| Path                                         | Effort                       |
| -------------------------------------------- | ---------------------------- |
| Path 1 (UX hint + detection helper)          | 2-3h                         |
| Path 5 (tests)                               | 4-6h (1h for detector tests) |
| Path 2 (system-prompt hint, shares detector) | +2h                          |
| ADR note                                     | 1h                           |
| Glossary addition to docs/MASTER.md          | 0.5h                         |
| **Total**                                    | **~8-11h**                   |

## Related

- BUG-086 (compression-timing queue race) — orthogonal.
- BUG-002 (saveContext rate limit) — orthogonal.
- BUG-031 (recoveryForced persistence removal, G13) — recovery protocol partially mitigates but doesn't prevent the bloat.
- Upstream OpenCode SDK: does not expose a fork-pointer field.
- `lib/state/persistence.ts:78-80` — per-session state isolation (correctly prevents cross-session contamination).
- `lib/state/utils.ts:54-65` — current `isSubAgentSession` only catches task-spawned subagents via `parentID`.

## Resolution

Fixed in commit implementing Phase B (UX warning + system-prompt hint).

- `lib/state/utils.ts` — added `detectParentSessionFromTitle` exported helper. Pure regex match against `/^(.+) \(fork #\d+\)$/`. Graceful on undefined/null/empty/malformed titles.
- `lib/hooks.ts::createSystemPromptHandler` — appends a fork-inheritance hint to the system prompt when the session title matches the fork pattern.
- `lib/hooks.ts::createChatMessageTransformHandler` — emits a one-shot UX warning via `logger.info` on session transition when a fork is detected. Bounded SDK roundtrip (`client.session.get` with `AbortSignal.timeout(2000)`).
- Detection behind a replaceable interface so the regex can be swapped for upstream `forkedFrom` when OpenCode SDK exposes one.

Mitigation is at the **signal layer**, not the protocol layer. Protocol-layer fixes (maxCompactionRatio guard reorder, cross-session state inheritance) were explicitly rejected per `docs/DECISIONS/002-compression-state-is-session-scoped.md`.

Characterization tests in `tests/session-fork.test.ts` (8 tests) pin the intended behaviors: `prevAnchorEnd === ""` bypass on first compress is INTENTIONAL; non-compacting block is applied before guard; recovery state does not propagate across forks; A→B→C file isolation holds.

Test results: 441/441 pass.
