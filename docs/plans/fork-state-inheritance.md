# Plan: Inherit Compression State Across OpenCode Session Forks

**Status:** Revised per user feedback 2026-08-08 + critical gate result (SQLite probe). Always-pick fallback chain + timestamp-anchored predicate. Awaiting deep-architect review.
**Author:** build agent, 2026-08-08
**Related:** BUG-087 (initial UX-only mitigation, fixed); BUG-088 (latent stats double-count, filed 2026-08-08 — see §4.5 and §9); BUG-089 (the gap this plan closes — previously referenced as BUG-088, renumbered); ADR-002 (initial per-session isolation); ADR-003 (this plan's new ADR for fork inheritance + schema bump)

---

## 1. Background

The `@tarquinen/opencode-dcp` plugin replaces obsolete tool outputs in conversation context with high-fidelity summaries before LLM calls. When OpenCode's UI forks session A → B, the plugin's per-session `SessionState` resets for B (correct for isolation), but B inherits A's _raw_ messages verbatim with new IDs. **Any compression blocks A had produced are invisible to B**, so B sees the full uncompressed history. If A had compressed 100 messages into 1 summary, B sees 100 raw messages and explodes.

The earlier BUG-087 fix added UX hints only — a system-prompt hint and a one-shot log warning. Those don't prevent the explosion; they only make the model aware. **This plan implements real state inheritance** so B actually inherits A's compression blocks.

---

## 2. Problem Statement

When OpenCode forks session A → B (UI action):

- B's `SessionState` is empty (correct isolation).
- B inherits raw messages from A verbatim.
- B's model has no signal that A had prior compression.
- If B's model re-compresses (or user invokes `/dcp-compress`), it operates on raw content — possibly producing a worse summary than A's.
- Token cost: redundant summarization of already-summarized content.
- Context size: B's transform-time context may balloon larger than A's was.

**Goal:** When B is loaded for the first time, copy A's state into B's state (per the user's one-to-one-copy intent: as close to a one-to-one copy as possible, except for transient per-fire / per-session / request-local fields). The inherited compression blocks appear in B's transform output on the very first turn.

The user explicitly rejected the initial conservative exclusions (§4.6 in the prior revision). Recovery state, lifecycle counters, prune.tools, messageIds, stats, lastCompaction, currentTurn, and deactivatedByBlockId should all be copied. Only fields that are truly transient, per-fire, or B's own values are excluded.

---

## 3. Verified Constraints (from SQLite probe + research)

A general subagent ran on 2026-08-08 with bash + write permission against the user's local OpenCode instance (`C:\Users\marco\.local\share\opencode\opencode.db`, SQLite, 5.9 GB).

### 3.1 `parentID` is dead for UI forks

```
session table schema has parent_id column with index session_parent_idx (nullable).
Tested against 4 sessions created by repeatedly forking "Test ping reply":
  A (depth 0): parent_id = NULL
  B (depth 1, fork #1): parent_id = NULL
  C1 (depth 2a, fork #2): parent_id = NULL
  C2 (depth 2b, fork #2): parent_id = NULL
```

**Conclusion:** OpenCode does not populate `parent_id` on UI forks. The schema exists but is unused. Therefore:

- Event-hook approaches that look for `info.parentID` are dead on arrival.
- SDK queries via `client.session.get(...).data?.parentID` return `undefined` for UI forks.
- The `isSubAgentSession` helper (`lib/state/utils.ts:55-65`) works only for `task`-spawned subagents.

> Note: `EventSessionCreated` does exist in the SDK (`node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts:493-498`), so a `session.created` event _is_ fired. But its `info.parentID` is NULL for UI forks, so subscribing to the event buys us nothing the title-regex doesn't already give us.

### 3.2 Title scan is ambiguous at depth ≥ 2

User's empirical data:

```
B  = ... "Test ping reply (fork #1)"   (one candidate parent for any fork #2)
C1 = ... "Test ping reply (fork #2)"   (fork of B)
C2 = ... "Test ping reply (fork #2)"   (also fork of B; same title as C1)
```

Two siblings at the same fork depth share the same `(fork #N)` suffix. When the next fork (D, "fork #3") is created, the parent title "Test ping reply (fork #2)" has two candidates. Recency heuristics are unreliable here.

### 3.3 Forks can happen at arbitrary `messageID`

`SessionForkData.body.messageID?` (`node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts:2037-2048`) proves forks can be created at any message in the parent's history — not just the parent's tail. This means:

- The "last-copied message" is not necessarily the parent's last message. It's the message at the fork point.
- If the fork point lies inside the prefix shared by multiple sibling candidates, those siblings have _identical_ `time.created` at the fork-point message. Single-message timestamp compare cannot disambiguate.
- The correct rule is: the multiset (or sequence) of B's copied-message timestamps must be a **prefix** of the candidate P's timestamp sequence. That is, B's messages 1..k (where k is the fork-point message) match P's messages 1..k exactly.

### 3.4 Content matching fails in edge cases (correlated with layer 1)

In the user's test, C1 and C2's last messages are byte-identical:

- Both last assistant: `text="pong\n\n"` (2 trailing newlines)
- Both second-to-last: 13879-byte synthetic `<available-subagents>…</available-subagents>` block (hash-identical at three sample offsets)

The user confirmed this was an artifact of keeping the same prompt for testing. In real usage, divergent work would produce different last messages. **But** when the fork point lies inside the shared prefix (§3.3), content is _also_ identical up to that point — so content matching fails exactly when timestamp matching fails. Content matching is not an independent fallback; it is correlated. Treat it as a hypothetical safety net for "OpenCode regenerated timestamps but not content" — a regression we'd want to detect.

### 3.5 Timestamp prefix-match works (the breakthrough)

OpenCode's fork semantics:

- Copied messages **preserve** their original `time.created` from the parent session, byte-exact (verified across multiple rows).
- Post-fork messages get fresh `time.created` at write time.
- The fork operation itself does **not** rewrite timestamps on copied rows.
- Forks can happen at any `messageID` (§3.3), so the match rule is prefix-match, not last-message-compare.

Empirical confirmation:

```
C1 last msg time.created = 1786179112173
C2 last msg time.created = 1786179174614   (~62 s later)
C1 first 11 msgs share time_created=1786179065084 with C2 (inherited from B)
```

**The disambiguator (always-pick fallback chain):** When multiple candidates match the title pattern, pick in priority order:

1. **Single candidate** → use it
2. **Multiple candidates with any prefix match** → pick the one with longest exact `time.created` prefix match (could be 0-length)
3. **Multiple candidates with no prefix match** → pick the candidate with most recently modified state file (mtime)
4. **Zero candidates** → graceful give-up (the only legitimate no-copy case besides subagent/schema-mismatch/missing-file)

The strict timestamp-anchored filter (§4.4) ensures wrong-parent picks are safe: blocks whose timestamps don't match B's set are dropped at filter time.

---

## 4. Solution Design

### 4.1 Trigger point

Hook into `ensureSessionInitialized` (`lib/state/state.ts:226-229`), **inside the `persisted === null` branch** — before the early return. Fresh forks hit this branch first because they have no state file. If inheritance succeeds, the merged state is in place when the early return completes, before B's first `experimental.chat.messages.transform` runs.

> **Why inside the null branch and not after `loadSessionState` returns?** OQ5 mandates "B's own state wins." A fresh fork has no state, so this branch is where the fork case lives. Placing the call after `loadSessionState` would either (a) merge into B's existing state when it has one (contradicting "fresh state wins" — wrong for re-fork scenarios) or (b) silently no-op because the null branch already returned.

The session title is required for fork detection. Currently `ensureSessionInitialized` does not receive it; only `lib/hooks.ts:239-253` fetches it. Cleanest fix: extend `isSubAgentSession` (`lib/state/utils.ts:55-65`) — which already does `client.session.get` inside `ensureSessionInitialized` (`state.ts:208`) — to also return `data.title` (Session type confirms `title: string` at `types.gen.d.ts:479`). One roundtrip, no ordering problem.

The entire fork-detection block (steps 7a–7l below) is gated on `config.compress.experimental.inheritOnFork`. **Default is `true`** per user direction 2026-08-08: always attempt to copy. Setting the flag to `false` disables detection entirely (no SDK roundtrip, no candidate scan, no inheritance).

### 4.2 Algorithm (always-pick fallback chain)

```
ensureSessionInitialized(state, sessionId, opts):
    1. existing logic — reset, early-out if same session, subagent skip
    2. result = isSubAgentSession(client, sessionId, { fetchTitle: true })
       → returns { isSubAgent, parentID, title }
    3. if result.isSubAgent AND !config.compress.experimental.allowSubAgents:
           existing skip; return
    4. state.sessionTitle = result.title   // cached for save calls
    5. persisted = await loadSessionState(sessionId, ...)
    6. if persisted !== null:
           existing field-apply; return          // B has prior state — wins
    7. NEW (inside null branch, gated on inheritOnFork):
       forkInfo = detectParentSessionFromTitle(result.title)
       if !forkInfo.isForked:
           // Not a fork; nothing to inherit. No log (this is the common case for new sessions).
           return
       // Always attempt to copy from this point.
       a. { parentTitle, forkNumber } = forkInfo
       b. candidates = scanDcpStorageDir({ sessionName: parentTitle })
          (only files where persisted.sessionName === parentTitle)
       c. if candidates.length === 0:
              // Case 5: zero candidates — the only legitimate graceful give-up.
              logger.debug(`fork detected (${forkNumber}); no parent state files found for "${parentTitle}"`)
              return
       d. parentId = pickParentCandidate(candidates, state.sessionId, bMessages)  // see §4.3
          Always returns one of the candidates OR throws (caller catches).
       e. parentState = await loadSessionState(parentId, ...)  // schema + age gates
       f. if parentState === null:
              // Subagent parent / schema mismatch / deleted file
              logger.debug(`fork detected (${forkNumber}); parent ${parentId} state unreadable`)
              return
       g. bTimeSet, bTimeToId = buildTimeIndex(bMessages)  // see §4.4
       h. rawBlocks = Object.values(parentState.prune.messages.blocksById)
       i. inheritable = filterInheritableBlocks(rawBlocks, bTimeSet, parentState.prune.messages.blocksById)
          // pass parent set for block-graph closure
       j. rekeyed = rekeyBlocksToFork(inheritable, bTimeToId)  // see §4.4
       k. mergeInheritedBlocks(state, rekeyed, parentId)  // single-writer funnel — see §4.7
       l. coalesceSaveSessionState(state, logger, result.title)  // explicit save (also writes sessionName)
       m. state.inheritedFrom = parentId  // in-memory only, see §4.6
       n. logger.info(`fork inheritance: ${rekeyed.length} blocks from ${parentTitle} (#${forkNumber})`)
    8. existing early return
```

### 4.3 Disambiguator with always-pick fallback chain

After deep-architect review, the 3-layer plan was simplified. Per user direction 2026-08-08, the disambiguator must always pick a session when candidates exist — graceful give-up only when candidates is empty.

**`pickParentCandidate(candidates, sessionId, bMessages)` priority order:**

1. **`candidates.length === 1`** → return `candidates[0].sessionId`. No SDK call needed.

2. **`candidates.length > 1` AND prefix match found** → for each candidate, compute the longest exact `time.created` prefix shared with B's messages (walk from index 0). Pick the candidate with the longest prefix. (Tie-breaker: most recently modified mtime.)

3. **`candidates.length > 1` AND no prefix match** → pick the candidate with most recently modified state file (mtime). Reasonable default: the user was working in that session most recently.

4. **All exceptions during SDK / file I/O** → catch, log debug, fall through to (3) on the surviving candidates. Never throw to caller.

The strict timestamp-anchored filter (§4.4) is the safety net: if (2) or (3) picks the wrong parent, most blocks get filtered out because their timestamps don't match B's set.

### 4.4 Inheritability predicate (timestamp-anchored — REVISED per 2026-08-08 probe)

**CRITICAL GATE UPDATE (2026-08-08):** SQLite probe confirmed message IDs are **regenerated** on every fork (intersect counts A∩B, B∩C1, B∩C2 all = 0). What IS preserved: `time.created` (byte-identical at inherited positions), message text content, ordering.

The original ID-keyed predicate (line 200 of the prior revision) is **silently dead** for every fork. Redesigned to use `time.created` as the inheritance key.

**New fields on `CompressionBlock` (6 total, not 4):**

- `startTime: number` (INTEGER, ms since epoch) — the parent's `time.created` for the message at `startId`. Default `0`.
- `endTime: number` (INTEGER) — same for `endId`. Default `0`.
- `effectiveTimeMs: number[]` — timestamps for all effective-range messages. Default `[]`.
- `directTimeMs: number[]` — timestamps for all direct-range messages. Default `[]`.
- `anchorTime: number` — `time.created` for the message at `anchorMessageId`. Default `0`. **(CRITICAL — was missing in prior revision; see architect flag #1.)**
- `compressTime: number` — `time.created` for the message at `compressMessageId`. Default `0`. **(CRITICAL — was missing in prior revision; see architect flag #1.)**

These are additive fields. **Schema bump required** — bump `FORK_SCHEMA_VERSION` from current to next. **Honest cost (per architect flag #2): pre-bump state files are DROPPED by the schema gate at `lib/state/persistence.ts:303-316`** (per DPP-004 "drop, don't migrate"). Every existing session's blocks, stats, nudges, and manual-mode flags are discarded on upgrade. Users who upgrade and want fork-inheritance functionality must keep A's session active in the same plugin version (or accept the data loss). This contradicts the "no data loss" claim in earlier revisions; corrected here.

**Time index built from B's messages:**

```ts
// lib/state/inherit.ts — buildTimeIndex
function buildTimeIndex(messages: WithParts[]): {
    timeSet: Set<number>
    timeToId: Map<number, string> // first message at this timestamp wins
} {
    const timeSet = new Set<number>()
    const timeToId = new Map<number, string>()
    for (const m of messages) {
        if (!isMessageWithInfo(m)) continue
        const t = m.info.time.created
        if (!timeSet.has(t)) {
            timeSet.add(t)
            timeToId.set(t, m.info.id)
        }
    }
    return { timeSet, timeToId }
}
```

> **Ponytail note:** `timeToId` uses first-wins policy. Same-ms message pairs (user+assistant in one ms) are rare but possible; this is acceptable because the timestamp filter only requires the timestamp to exist in B (not a specific message ID). If `validateMonotonicEnd` (`lib/compress/range.ts:96-103`) spuriously fails on B's next compress due to off-by-one range, switch to dual-maps (first-ID for starts, last-ID for ends). Flag #16 in the architect review.

**Inheritable predicate (timestamp-anchored, 6 fields):**

```
bTimeSet = buildTimeIndex(bMessages).timeSet
parentBlocksById = parentState.prune.messages.blocksById   // closure set

inheritable(block, bTimeSet, parentBlocksById) :=
    !block.deactivatedByUser                                    // never resurrect user-decompress
    && block.startTime !== 0 && bTimeSet.has(block.startTime)   // start present in B (skip pre-bump blocks)
    && block.endTime   !== 0 && bTimeSet.has(block.endTime)     // end present in B
    && block.anchorTime   !== 0 && bTimeSet.has(block.anchorTime)     // anchor present (CRITICAL — block won't survive syncCompressionBlocks otherwise)
    && block.compressTime !== 0 && bTimeSet.has(block.compressTime)   // compress origin present (CRITICAL — sync deactivates if missing)
    && block.effectiveTimeMs.every(bTimeSet.has)                // all effective-range timestamps in B
    && block.directTimeMs.every(bTimeSet.has)                  // all direct-range timestamps in B
    && (block.includedBlockIds ?? []).every(id => parentBlocksById.has(id))   // graph closure
    && (block.consumedBlockIds ?? []).every(id => parentBlocksById.has(id))     // graph closure
    && (block.parentBlockIds ?? []).every(id => parentBlocksById.has(id))      // graph closure
```

> **Why `anchorTime` and `compressTime` matter (CRITICAL — architect flag #1):** `lib/messages/sync.ts:42-53` deactivates any block whose `compressMessageId` is not in B's live message-ID set. Parent A's `compressMessageId` is regenerated in B → **every inherited block deactivates as missing-origin on B's first `syncCompressionBlocks`** (`lib/hooks.ts:313`, runs before prune). Similarly `lib/messages/sync.ts:93-95` only populates `activeByAnchorMessageId` when `messageIds.has(block.anchorMessageId)`. Without rekeying both, the summary injection (the entire point of the feature) never fires.
>
> **Caveat:** if the fork point precedes A's compress tool-call message, the block is dropped — correct behavior, but inheritance only helps when the fork happens after the compress. Document in `docs/features/SESSION_FORK.md`.

**Pre-inheritance rekeying (post-pass) — rewritten to include anchor and compress:**

```ts
// lib/state/inherit.ts — rekeyBlocksToFork
function rekeyBlocksToFork(
    blocks: CompressionBlock[],
    timeToId: Map<number, string>,
): CompressionBlock[] {
    return blocks.map((b) => {
        const rekeyed: CompressionBlock = {
            ...b,
            startId: timeToId.get(b.startTime) ?? "", // "" if no match (shouldn't happen post-filter)
            endId: timeToId.get(b.endTime) ?? "",
            anchorMessageId: timeToId.get(b.anchorTime) ?? "", // CRITICAL — sync.ts checks this
            compressMessageId: timeToId.get(b.compressTime) ?? "", // CRITICAL — sync.ts deactivates if missing
            effectiveMessageIds: b.effectiveTimeMs
                .map((t) => timeToId.get(t) ?? "")
                .filter((s) => s !== ""),
            directMessageIds: b.directTimeMs
                .map((t) => timeToId.get(t) ?? "")
                .filter((s) => s !== ""),
        }
        // byMessageId rebuilt via shared helper (see §4.7 — same helper used by applyCompressionState)
        rekeyed.byMessageId = rebuildByMessageId(rekeyed /* + parent set */)
        return rekeyed
    })
}
```

> **Note on `effectiveTimeMs` / `directTimeMs`:** These are NEW fields on `CompressionBlock` — replacing the ID-based `effectiveMessageIds` / `directMessageIds` for inheritance purposes. The ID arrays stay (still used by the existing prune / sync code paths, which run on the live session). The timestamp arrays are the inheritance-time key. Populated alongside the ID arrays at compress time by the **tool-layer call sites** (`lib/compress/range.ts:183-201`, `lib/compress/message.ts:142-160`), NOT by `applyCompressionState` itself (which receives `CompressionStateInput` with IDs only — see flag #11 in architect review). The change lives at `lib/compress/types.ts` (`CompressionStateInput` enrichment) plus both tool-variant call sites.

**Why the closure checks:** `lib/messages/sync.ts:66` iterates `block.consumedBlockIds`; `lib/commands/decompress.ts:44-63` walks `parentBlockIds`. A surviving block whose `consumedBlockIds` point to a dropped block would crash on decompress or produce stale results. The predicate must either keep referenced blocks transitively or drop the survivor.

### 4.5 Fields to copy (from `parentState` → `state`)

The user's intent is one-to-one copy: as close as possible. Exclusions are reserved for transient, per-fire, per-session, or request-local fields. The previous conservative exclusions (`prune.tools`, `messageIds.*`, recovery flags, `lastCompaction`/`currentTurn`, `stats.totalPruneTokens`, `deactivatedByBlockId`) were reverted on 2026-08-08 per user feedback.

| Field                                                   | Source (`lib/state/types.ts`)            | How                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prune.messages.blocksById`                             | `:64`                                    | Filter via predicate; copy with original block IDs (no remap).                                                                                                                                                                                                                                                                               |
| `prune.messages.byMessageId`                            | `:63`                                    | Rebuilt from filtered `blocksById` keys that survived.                                                                                                                                                                                                                                                                                       |
| `prune.messages.activeBlockIds`                         | `:65`                                    | Rebuilt from filtered `blocksById`.                                                                                                                                                                                                                                                                                                          |
| `prune.messages.activeByAnchorMessageId`                | `:66`                                    | Rebuilt from filtered `blocksById` (consistent with activeBlockIds).                                                                                                                                                                                                                                                                         |
| `prune.messages.nextBlockId`                            | `:67`                                    | `max(parent.nextBlockId, state.nextBlockId)`. (No `+1` — `nextBlockId` is the next-free, and the allocator returns `nextBlockId` then increments, so plain `max` is correct.)                                                                                                                                                                |
| `prune.messages.nextRunId`                              | `:68`                                    | `max(parent.nextRunId, state.nextRunId)`.                                                                                                                                                                                                                                                                                                    |
| `prune.tools`                                           | `:72`                                    | Copy as-is. The rebuild path at `lib/state/utils.ts:426-448` still runs on subsequent prunes (defensive), but the inherited snapshot is the source of truth at fork time.                                                                                                                                                                    |
| `messageIds.{byRawId, byRef, nextRef}`                  | —                                        | **DELETED (architect flag #6):** `messageIds` is NOT in `PersistedSessionState` (`lib/state/persistence.ts:37-54`). `assignMessageRefs` (`lib/message-ids.ts:119-159`) runs fresh on B's first transform (`lib/hooks.ts:312`); it's order-deterministic and produces identical refs for the shared prefix. Nothing to copy; refs regenerate. |
| `userForced`                                            | `:100-102`                               | Copy. Per user feedback: A's user-mode choice carries over; B's user is the same person making a consistent choice.                                                                                                                                                                                                                          |
| `manualMode`                                            | (same)                                   | Copy. Same reasoning.                                                                                                                                                                                                                                                                                                                        |
| `recoveryForced`                                        | (same)                                   | Copy. Per user feedback. If A was in recovery mode, B inherits that state — A's recent compresses failed, and B's autonomous compress will encounter A's already-compact blocks, so the same failure mode may repeat. Copy is consistent with the one-to-one-copy intent.                                                                    |
| `nonCompactingRunCount`                                 | (same)                                   | Copy. Same reasoning.                                                                                                                                                                                                                                                                                                                        |
| `recoveryFadeCounter`                                   | (same)                                   | Copy. Same reasoning.                                                                                                                                                                                                                                                                                                                        |
| `lastCompaction`                                        | —                                        | **DELETED (architect flag #7):** Not persisted (see STATE_PERSISTENCE.md persisted-vs-in-memory table). Recomputed from B's own messages at `lib/state/state.ts:221-223` before the hook point. The recomputed value is _more_ correct than A's. Nothing to copy.                                                                            |
| `currentTurn`                                           | —                                        | **DELETED (architect flag #7):** Same reasoning as `lastCompaction`. Recomputed from B's own messages. Nothing to copy.                                                                                                                                                                                                                      |
| `stats.totalPruneTokens`                                | `:22`                                    | Copy. Per user feedback: B inherits A's savings. The double-count in `loadAllSessionStats` is a separate latent bug — see BUG-088 (filed 2026-08-08, Option B is the recommended fix).                                                                                                                                                       |
| `deactivatedByBlockId`                                  | `CompressionBlock.deactivatedByBlockId?` | **SIMPLIFIED (architect flag #8):** `deactivatedByBlockId` is an optional field on each `CompressionBlock` (not a state-level map as previously assumed). It rides along automatically with copied blocks. Blocks that fail the predicate are dropped, taking their `deactivatedByBlockId` flag with them.                                   |
| `nudges.{contextLimit,turnNudge,iterationNudge}Anchors` | (persisted nudge state)                  | **DROPPED ON INHERITANCE (architect flag #9):** Nudge anchors are parent message IDs which are invalid in B (regenerated). Drop them; nudge state regenerates from B's live traffic. Simpler than a third rekey path.                                                                                                                        |
| `forkSchemaVersion`                                     | `:130`                                   | Set to current `FORK_SCHEMA_VERSION` constant. **Bump required** — see §5 and §7. Pre-bump state files are DROPPED by the schema gate.                                                                                                                                                                                                       |

### 4.6 Fields NOT to copy

| Field                                                     | Reason                                                                                                                                                                                                                                                              |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pendingManualTrigger`                                    | Transient request-local. If A had `/dcp-compress m15..m25` queued, applying that to B would fire the compress against A's message references in B's context. Catastrophic surprise. Never carry.                                                                    |
| `compressionTiming.{starts,pending}ByCallId`              | Transient in-flight tool state. A's in-flight `compress` call shouldn't fire in B's transform.                                                                                                                                                                      |
| `toolParameters`, `subAgentResultCache`                   | Per-process in-memory caches, never persisted. Moot.                                                                                                                                                                                                                |
| `modelContextLimit`, `systemPromptTokens`, `diagnostic.*` | Per-fire computed values. Same model = same value; diagnostic.\* is per-request.                                                                                                                                                                                    |
| `sessionId`, `isSubAgent`, `compressPermission`           | B's own values. `sessionId` MUST be B's own (the merge function receives `state` already initialized to B). `isSubAgent` is detected per-call at `ensureSessionInitialized`. `compressPermission` is resolved per-session via `resolveEffectiveCompressPermission`. |

### 4.7 Single-writer funnel (DPP-006 / PAT-002 compliance)

`applyCompressionState` (`lib/compress/state.ts`) is the canonical writer of new blocks; `syncCompressionBlocks` (`lib/messages/sync.ts`) is the only sanctioned bulk reconciliation path. `tryInheritFromParent` would be a **third writer** of block shape — directly violating DPP-006 / PAT-002 unless explicitly addressed.

**Resolution:** Add a new exported function `mergeInheritedBlocks(state, blocks, parentSessionId)` to `lib/compress/state.ts` (next to `applyCompressionState`). It is the canonical merge path for inherited blocks and upholds the same invariants `applyCompressionState` does (block-graph closure, monotonic IDs, anchor index consistency). `lib/state/inherit.ts` calls this function — it does NOT write `state.prune.messages.*` directly. ADR-003 records this as the sanctioned third writer (after `applyCompressionState` and `syncCompressionBlocks`).

### 4.8 Configuration

`ExperimentalConfig` gains a flag, **default `true`** per user direction 2026-08-08 (always attempt to copy; opt-OUT for users who want strict session isolation):

```typescript
// lib/config.ts — ExperimentalConfig
inheritOnFork?: boolean   // default: true
```

Why default-on:

- User intent: "always attempt to copy the original session's state." Fork-bloat is the dominant UX surprise; inheritance is the dominant UX expectation.
- ADR-002's "session-scoped by design" invariant is preserved by default because fork inheritance is opt-IN from the user's perspective (they have to fork in the first place). The flag is for users who actively want strict isolation.
- Config schema bump is unnecessary (additive field with default).
- Setting `inheritOnFork: false` short-circuits the entire fork-detection block at `lib/hooks.ts:225-260` — no SDK roundtrip, no candidate scan, no inheritance.

---

## 5. File-Level Changes

| File                                           | Change                                                                                                                                                                                                                                                                                                                                                                                              | Lines (est) |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| `lib/state/types.ts`                           | **Add 4 new fields to `CompressionBlock`**: `startTime`, `endTime`, `effectiveTimeMs`, `directTimeMs` (timestamp arrays). All additive with `0`/`[]` defaults. **Bump `FORK_SCHEMA_VERSION`**.                                                                                                                                                                                                      | ~15         |
| `lib/state/inherit.ts`                         | NEW. `tryInheritFromParent()`, `pickParentCandidate()` (always-pick fallback chain), `buildTimeIndex()`, `filterInheritableBlocks()` (timestamp-anchored), `rekeyBlocksToFork()`, `findCandidateParents()`.                                                                                                                                                                                         | ~250        |
| `lib/state/state.ts:226-229`                   | Insert `tryInheritFromParent` call **inside the `persisted === null` branch**, before the early return.                                                                                                                                                                                                                                                                                             | ~15         |
| `lib/state/utils.ts:55-65`                     | Extend `isSubAgentSession` to also return `data.title`.                                                                                                                                                                                                                                                                                                                                             | ~10         |
| `lib/state/utils.ts`                           | Add pure helper `messagesTimeCreated(messages: WithParts[]): number[]`. **Update `loadPruneMessagesState` (`lib/state/utils.ts:231-288`)** to default the 6 new `CompressionBlock` fields to `0`/`[]` on load (architect flag #12). **Add `getSessionMetadata(client, sessionID)`** new helper (returns `{ isSubAgent, title? }`); `isSubAgentSession` becomes a thin wrapper (architect flag #14). | ~35         |
| `lib/compress/state.ts`                        | **NEW** exported function `mergeInheritedBlocks(state, blocks, parentSessionId)` — canonical merge path (third sanctioned writer per DPP-006/PAT-002). **Modify `applyCompressionState`** to populate `startTime`/`endTime`/`effectiveTimeMs`/`directTimeMs` alongside the existing ID arrays.                                                                                                      | ~50         |
| `lib/state/persistence.ts`                     | **Bump `FORK_SCHEMA_VERSION` constant + handler.** **Single edit in `saveSessionState`**: default `sessionName` from in-memory `state.sessionTitle` when not explicitly passed. Avoids editing 9 call sites (architect flag #10).                                                                                                                                                                   | ~5          |
| `lib/state/state.ts`                           | Cache `state.sessionTitle`; add in-memory `state.inheritedFrom?: string \| null` (NOT persisted).                                                                                                                                                                                                                                                                                                   | ~15         |
| `lib/hooks.ts:162-179`                         | **Remove** the system-prompt hint entirely (per user direction 2026-08-08).                                                                                                                                                                                                                                                                                                                         | -18         |
| `lib/hooks.ts:225-260`                         | Gate fork-detection block on `config.experimental.inheritOnFork`. When `false`: no SDK roundtrip. When `true` (default): always attempt. Rewire UX warning to reflect inheritance outcome.                                                                                                                                                                                                          | ~10         |
| `lib/config.ts`                                | Add `inheritOnFork` to `ExperimentalConfig`, `VALID_CONFIG_KEYS`, default `true` in `mergeExperimental`, validator.                                                                                                                                                                                                                                                                                 | ~30         |
| `dcp.schema.json`                              | Add `experimental.inheritOnFork: { type: "boolean", default: true }`.                                                                                                                                                                                                                                                                                                                               | ~5          |
| `tests/session-fork-inherit.test.ts`           | NEW. ~22 tests (PAT-011 XDG sandbox, PAT-012 audit-trail trailer, PAT-013 `BUG-089:` in test names).                                                                                                                                                                                                                                                                                                | ~350        |
| `tests/session-fork.test.ts`                   | **UPDATES (architect flag #5):** Tests at `:290-313` assert system-prompt hint exists → will fail when `lib/hooks.ts:162-179` is removed. Rewrite 4 stale tests (~100 lines). Tests at `:267-288`, `:315-351` encode old "no inheritance" behavior; rewrite to match new always-pick semantics.                                                                                                     | ~100        |
| `docs/DECISIONS/003-fork-state-inheritance.md` | NEW ADR. Records design + amends DPP-006/PAT-002 to name `mergeInheritedBlocks` as the third sanctioned writer.                                                                                                                                                                                                                                                                                     | ~180        |
| `docs/features/SESSION_FORK.md`                | NEW. User-facing behavior, config docs, edge cases.                                                                                                                                                                                                                                                                                                                                                 | ~120        |

**Total: ~1,055 lines across 15 files** (was 915 in earlier revision; +140 for `startTime`/`endTime`/`effectiveTimeMs`/`directTimeMs` plumbing, schema bump, rekeying post-pass, extra tests).

---

## 6. Acceptance Criteria

1. **Inheritance fires on real fork** — When B is loaded for the first time after being forked from A, B's `prune.messages.blocksById` contains the parent's filtered (timestamp-anchored) blocks. Requires fix in §4.1 (call inside `persisted === null` branch). ✓ test `inheritance-fires-on-real-fork`.

2. **Single candidate → direct pick** — Title scan returns 1 match. Inherited directly without timestamp query. ✓ test `single-candidate`.

3. **Multiple candidates → longest timestamp prefix** — Given two `(fork #2)` siblings C1/C2 with diverged timestamps at message 12+, forking one of them yields a new D whose inherited blocks match the correct parent. ✓ test `disambiguate-longest-prefix`.

4. **Multiple candidates with no prefix match → recency fallback** — Sibling case where no candidate has a shared timestamp prefix with B. Pick the candidate with most recently modified state file (mtime). Most blocks will fail the timestamp filter — net effect is reduced inheritance but no corruption. ✓ test `disambiguate-recency-fallback`.

5. **Zero candidates → graceful give-up** — Title scan returns 0 matches. Inheritance is skipped with a debug log (the only legitimate "no parent" case besides subagent/schema/missing-file). ✓ test `empty-candidate-set`.

6. **Mid-history fork → recency fallback** — When the fork point lies inside the candidates' shared prefix, no exact prefix match exists. Recency fallback picks the most recently modified. ✓ test `mid-history-fork-picks-recency`.

7. **Timestamp-anchored predicate works despite ID regeneration** — Parent's block has `startId = msg_<A's id>`, `startTime = 1786179065084`. B's message at `time.created = 1786179065084` (different `msg_<B's id>`) is in `bTimeSet`. Predicate passes; block is inheritable. ✓ test `predicate-timestamp-anchored-despite-id-regen`.

8. **Block filter is correct** — A block whose `startTime`/`endTime` are not in B's time set is dropped. A block whose `deactivatedByUser: true` is dropped. A block whose `consumedBlockIds`/`parentBlockIds`/`includedBlockIds` reference a non-inheritable block is dropped. ✓ test `filter-inheritable-blocks`.

9. **Post-pass rekeying produces valid fork IDs** — `startId`/`endId`/`effectiveMessageIds`/`directMessageIds` are rewritten from parent's IDs to fork's IDs via `bTimeToId`. Resulting block is valid for B's live session. ✓ test `rekey-blocks-to-fork`.

10. **Recovery state IS copied** — `recoveryForced`, `userForced`, `manualMode`, `nonCompactingRunCount`, `recoveryFadeCounter` are inherited from parent. ✓ test `recovery-state-copied`.

11. **ID monotonic max** — `state.prune.messages.nextBlockId` after merge is `max(parent.nextBlockId, state.nextBlockId)` (no `+1`). ✓ test `id-monotonic-max`.

12. **Stats ARE copied** — `stats.totalPruneTokens` after merge equals parent's value. Reference BUG-088 for the latent aggregation bug. ✓ test `stats-copied`.

13. **`prune.tools` IS copied** — A's prune.tools set carries over verbatim. ✓ test `prune-tools-copied`.

14. **Lifecycle position copies nothing** — `lastCompaction`, `currentTurn` are NOT persisted (architect flag #7); they recompute from B's own messages. ✓ test `lifecycle-position-not-copied` asserts B's values are recomputed, not A's.

15. **`messageIds.*` copies nothing** — Not in `PersistedSessionState` (architect flag #6); `assignMessageRefs` regenerates deterministically. ✓ test `message-ids-not-copied-rebuilt`.

16. **`deactivatedByBlockId` rides with blocks** — Per-block field, not state-level map (architect flag #8). Blocks that fail the predicate are dropped, taking their flag with them. ✓ test `deactivated-block-id-rides-with-block`.

17. **Schema bump drops pre-bump state** — `FORK_SCHEMA_VERSION` bumped. Pre-bump state files are DROPPED by the schema gate (architect flag #2 — DPP-004 "drop, don't migrate"). Honest data loss on upgrade. ✓ test `schema-bump-drops-pre-bump-state`.

18. **Schema gate applies** — If parent's state has older `forkSchemaVersion` than B's current, parent is dropped silently. ✓ test `schema-mismatch-no-inherit`.

19. **Errors degrade gracefully** — If SDK call fails or filesystem scan fails, inheritance is skipped with a debug log. No exception propagates into the transform handler. ✓ test `sdk-failure-graceful`.

20. **Malformed parent state file** — `loadSessionState` returns null → graceful no-op. ✓ test `malformed-parent-state-no-inherit`.

21. **Multi-generation A→B→C** — B inherits from A. C inherits from B. C's state has B's filtered blocks. ✓ test `multi-generation`.

22. **`sessionName` round-trip** — When B saves state, the persisted file contains `sessionName` (defaulted from `state.sessionTitle`). When B is reloaded, the file is found by title-scan. ✓ test `sessionname-round-trip`.

23. **Default-on behavior** — Fresh install with no config: `inheritOnFork` defaults to `true`, fork inheritance is active. ✓ test `default-on-inheritance`.

24. **Opt-out short-circuits SDK roundtrip** — With `experimental.inheritOnFork: false`, no `client.session.get` call happens for fork detection. ✓ test `opt-out-skips-detection`.

25. **System prompt hint removed** — `lib/hooks.ts:162-179` block is gone; no fork-related text appears in the rendered system prompt. ✓ test `no-fork-hint-in-system-prompt`.

26. **Nudge anchors dropped on inheritance** — Parent's nudge anchors are parent message IDs (invalid in B). Drop them; regenerate from B's live traffic. ✓ test `nudge-anchors-dropped`.

27. **Anchor and compress rekeyed to fork IDs** — `anchorMessageId` and `compressMessageId` are rewritten via `bTimeToId` post-filter (architect flag #1). Without this, `syncCompressionBlocks` deactivates every inherited block. ✓ test `anchor-compress-rekeyed`.

28. **Single-writer funnel respected** — `mergeInheritedBlocks` is the only path that writes inherited blocks to `state.prune.messages`. ✓ review check.

29. **Full suite green** — All existing tests pass + ~22 new tests pass + ~100 lines of `tests/session-fork.test.ts` updates. `npm run typecheck` clean. `npm run format:check` clean.

---

## 7. Risks and Trade-offs

| Risk                                                                                                                                                                       | Severity | Mitigation                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`FORK_SCHEMA_VERSION` bump** — adding `startTime`/`endTime`/`effectiveTimeMs`/`directTimeMs`/`anchorTime`/`compressTime` to `CompressionBlock` changes the on-disk shape | Medium   | Bump `FORK_SCHEMA_VERSION`. Pre-bump state files are **DROPPED by the schema gate at `lib/state/persistence.ts:303-316`** (DPP-004 "drop, don't migrate"). Honest data loss on upgrade. ADR-003 records the bump. Users who upgrade and want fork inheritance must keep A's session active in the same plugin version.                                                           |
| **`sessionName` never written to disk** → candidate scan returns ∅ → feature is dead code                                                                                  | Critical | **Single edit in `saveSessionState`** (`lib/state/persistence.ts`): default `sessionName` from in-memory `state.sessionTitle` when not explicitly passed. Avoids editing 9 call sites (architect flag #10). Add round-trip test.                                                                                                                                                 |
| **Wrong-parent pick** (sibling ambiguity + mid-history fork falls back to recency) → B inherits blocks from the wrong parent                                               | Low      | The timestamp-anchored filter (§4.4) drops blocks whose `startTime`/`endTime`/`effectiveTimeMs`/`directTimeMs`/`anchorTime`/`compressTime` don't appear in B's `bTimeSet`. Wrong-parent picks yield at most a partial (safe) inheritance. Logged at info level so the user can verify.                                                                                           |
| **OpenCode regenerates `time.created` on fork in a future version**                                                                                                        | Medium   | Recency fallback degrades gracefully. No silent corruption; behavior degrades to "always pick, mostly empty inheritance". `// ponytail:` comment names the dependency.                                                                                                                                                                                                           |
| **Same-title unrelated sessions** (user manually titles a session identical to `parentTitle`) become phantom candidates                                                    | Low      | Recency fallback picks the most recently modified — usually the user's actual parent. Even if wrong, the timestamp filter drops unrelated blocks.                                                                                                                                                                                                                                |
| **User has 100+ sessions, all sharing a base title**                                                                                                                       | Low      | Per-candidate SDK call is bounded (typically 2-5 candidates). Add a `state.scanCandidates` config to limit scan if this becomes a real problem.                                                                                                                                                                                                                                  |
| **Parent's state file deleted between fork and B's first transform**                                                                                                       | Low      | `loadSessionState` returns null → graceful no-op.                                                                                                                                                                                                                                                                                                                                |
| **Parent was a subagent** (skipped persistence per `lib/state/state.ts:216-219`)                                                                                           | Low      | `loadSessionState` returns null → graceful no-op.                                                                                                                                                                                                                                                                                                                                |
| **A and B diverge before B's first transform**                                                                                                                             | Medium   | Inheritance is one-shot (at first transform of B). If A's blocks change after that, B doesn't re-sync. Documented behavior.                                                                                                                                                                                                                                                      |
| **Fork-to-reset workflow inherits recovery state**                                                                                                                         | Medium   | User forks specifically to "reset" their session; B inherits A's `recoveryForced`/`manualMode` and stays locked down. Document in `docs/features/SESSION_FORK.md` + the rewired UX warning explicitly states "inherited N blocks + recovery state from parent."                                                                                                                  |
| **Performance: per-fork SDK roundtrip**                                                                                                                                    | Low      | One SDK call per session transition (extending existing `isSubAgentSession`'s `client.session.get`). Adds ~50-200 ms to first transform of B. Gated on `inheritOnFork` (default true) — disabling saves the roundtrip entirely.                                                                                                                                                  |
| **Third-writer violation of DPP-006 / PAT-002 / PAT-015**                                                                                                                  | Medium   | Resolved via `mergeInheritedBlocks` canonical function in `lib/compress/state.ts`. ADR-003 names it as the sanctioned third writer. PAT-015 also implicated (side-effect funnel).                                                                                                                                                                                                |
| **Block-graph closure violations** (surviving block references dropped block)                                                                                              | Medium   | Predicates 4.4 require `includedBlockIds`/`consumedBlockIds`/`parentBlockIds` to all resolve in parent set. Test 8 covers it.                                                                                                                                                                                                                                                    |
| **`loadAllSessionStats` double-count** (latent bug exposed by inheritance)                                                                                                 | Low      | `stats.totalPruneTokens` is copied per §4.5. All-time aggregation at `lib/state/persistence.ts:503` will sum once for A and once for B. BUG-088 (filed 2026-08-08) tracks this. Recommended fix: Option B (split `sessionOwnPruneTokens` vs `inheritedPruneTokens`). Until fixed, the all-time stat is inflated per fork. `/dcp stats` is informational, not a correctness gate. |
| **Anchor + compress IDs not rekeyed → `syncCompressionBlocks` deactivates every inherited block** (architect flag #1)                                                      | Critical | `rekeyBlocksToFork` rewrites `anchorMessageId`/`compressMessageId` from parent's IDs to B's IDs via `bTimeToId`. Test 27 covers it.                                                                                                                                                                                                                                              |

---

## 8. Test Plan

`tests/session-fork-inherit.test.ts` (new file, ~350 lines; PAT-011 XDG sandbox, PAT-012 audit-trail trailer `// Logic Verified: see BUG-089 plan §8`, PAT-013 test names prefixed `BUG-089:`):

1. **Core inheritance scenario** — Parent state file with one compression block `b1`. New session B with no state file, fork-pattern title. Load B. Assert B's `blocksById` contains `b1` (filtered, valid). **No write to B's file before load** — simulates real fork.

2. **Single candidate → direct pick** — Title scan returns 1 match. Assert inherited directly without timestamp query.

3. **Multiple candidates → longest timestamp prefix** — Two parent state files P1/P2 with same `sessionName` but different message timestamps. Forked session B's messages have timestamps matching exactly one prefix. Assert correct parent picked.

4. **Multiple candidates with no prefix match → recency fallback** — Sibling case where no candidate has a shared timestamp prefix with B. Pick the candidate with most recently modified state file (mtime). Most blocks will fail the timestamp filter — net effect is reduced inheritance but no corruption.

5. **Mid-history fork → recency fallback** — Fork point inside shared prefix of multiple candidates. Assert recency fallback picks a session (NOT give-up as in prior revision — architect flag #3).

6. **Filter predicate: dangling refs** — Block X survives basic filter, but X's `consumedBlockIds` point to a block that was dropped. Assert X is dropped (or refs pruned) — decompress does not throw.

7. **Filter predicate: deactivated** — Block with `deactivatedByUser: true` → dropped.

8. **Filter predicate: orphan messages** — Block references timestamp not in B's set → dropped.

9. **Anchor + compress IDs rekeyed to fork IDs** — Inherited block has parent `compressMessageId = msg_<A's id>`, parent `compressTime = 1786179065084`. After rekey, `compressMessageId = msg_<B's id>`. Verify `syncCompressionBlocks` does NOT deactivate the block.

10. **Recovery state IS inherited** — Parent has `recoveryForced: true`, `nonCompactingRunCount: 3`, `userForced: true`, `manualMode: true`, `recoveryFadeCounter: 5`. Assert B's state has identical values after merge.

11. **ID monotonic max** — Parent's `nextBlockId: 50`, B's `nextBlockId: 10`. Assert B's after merge is 50.

12. **Stats ARE copied** — Parent's `stats.totalPruneTokens: 5000`. Assert B's after merge is 5000 (inherited), not 0. Reference BUG-088 for the latent aggregation bug.

13. **`prune.tools` IS copied** — Parent's `prune.tools` set carries over verbatim to B.

14. **Lifecycle position NOT copied** — Parent's `lastCompaction: 1234567890` and `currentTurn: 47` are NOT inherited (recomputed from B's own messages). Assert B's values are recomputed (architect flag #7).

15. **`messageIds.*` NOT copied** — `messageIds` is not in `PersistedSessionState`. Assert B's `messageIds` are deterministically regenerated (architect flag #6).

16. **`deactivatedByBlockId` rides with blocks** — Per-block field (architect flag #8). Block with `deactivatedByBlockId: true` carries the flag through rekeying.

17. **Nudge anchors dropped on inheritance** — Parent's nudge anchors (parent message IDs) are dropped; do not propagate to B (architect flag #9).

18. **Schema bump drops pre-bump state** — `FORK_SCHEMA_VERSION` bumped. Pre-bump state files are DROPPED by the schema gate (architect flag #2). Assert graceful no-inheritance + warning logged.

19. **Schema mismatch** — Parent state file with older `forkSchemaVersion`. Assert dropped silently.

20. **SDK failure** — Mock SDK throws on `client.session.messages`. Assert no inheritance + warning logged + transform continues.

21. **Malformed parent state file** — Parent's JSON is unparseable. `loadSessionState` returns null → graceful no-op.

22. **Empty candidate set** — Title scan returns 0 matches. Assert no inheritance + warning. (The only legitimate "no parent" case.)

23. **Multi-generation A→B→C** — A→B inherit succeeds; B→C inherit succeeds. C's state has B's filtered blocks.

24. **`sessionName` round-trip** — Save state with title "X (fork #1)". Reload state, assert `sessionName` is "X (fork #1)". Other test: scan DCP storage dir for "X (fork #1)" finds the file. **Critical — production write path coverage.**

25. **Default-on behavior** — Fresh install with no config: `inheritOnFork` defaults to `true`, fork inheritance is active.

26. **Opt-out short-circuits SDK roundtrip** — With `experimental.inheritOnFork: false`, no `client.session.get` call happens for fork detection.

27. **System prompt hint removed** — `lib/hooks.ts:162-179` block is gone; no fork-related text appears in the rendered system prompt.

28. **Subagent-skip wins** — Subagent session with fork-pattern title + `allowSubAgents: false`. Assert no inheritance (subagent-skip happens before fork detection).

`tests/session-fork.test.ts` UPDATES (existing file, ~100 lines):

29. **System-prompt hint absence** — Asserts that the fork hint is no longer in the rendered system prompt (replaces the old test that asserted presence).

30. **Default-on: state inheritance on fork** — Updates the existing "no inheritance" assertions to match the always-pick + default-on semantics.

31. **Multi-generation: state inheritance through chain** — Updates assertions to verify state carries through A→B→C correctly.

---

## 9. References

- **BUG-087**: `known_issues/fixed/BUG-087-forked-session-context-bloat.md` — initial UX-only mitigation, status Fixed 2026-08-07.
- **BUG-088**: `known_issues/BUG-088-load-all-session-stats-double-count.md` — latent double-count bug exposed when fork inheritance copies `stats.totalPruneTokens`. Filed 2026-08-08. Recommended fix: Option B (split `sessionOwnPruneTokens` vs `inheritedPruneTokens`). This plan copies the field per user feedback; the aggregation bug is a separate fix tracked by BUG-088.
- **BUG-089**: `known_issues/BUG-089-fork-state-inheritance-protocol-layer.md` — protocol-layer remainder of BUG-087 after the UX mitigation ships. Filed 2026-08-08. This plan implements the fix.
- **ADR-002**: `docs/DECISIONS/002-compression-state-is-session-scoped.md` — default behavior stays session-scoped; this plan adds opt-in cross-session inheritance.
- **ADR-003** (new, this plan): fork state inheritance design — records the timestamp-disambiguator rationale + amends DPP-006/PAT-002 to name `mergeInheritedBlocks`.
- **OpenCode issues** (closed "not planned", unlikely to land soon): #4317, #15403.
- **PR #20744** (merged): adds `x-parent-session-id` HTTP header to LLM providers but NOT plugin hooks. Worth re-checking when stable.
- **`lib/state/utils.ts:54-65`**: existing `isSubAgentSession` helper — confirms `parentID` is set for task-spawned subagents only.
- **`lib/state/utils.ts:85-103`**: existing `detectParentSessionFromTitle` — reused by this plan.
- **`lib/state/state.ts:169-229`**: integration point inside `ensureSessionInitialized`.
- **`lib/state/types.ts:62-69`**: `CompressionBlock` shape — referenced by filter predicate.
- **`lib/compress/state.ts`**: canonical writer (`applyCompressionState`) — `mergeInheritedBlocks` will live here.
- **`lib/messages/sync.ts:16-136`**: `syncCompressionBlocks` — second sanctioned writer; pattern reference.
- **`lib/messages/prune.ts:179-264`**: `filterCompressedRanges` — runs after our merge in the same transform fire.
- **`lib/state/persistence.ts:166-169`**: single-file merge correctly uses `Math.max` for `totalPruneTokens` (no double-count within a session).
- **`lib/state/persistence.ts:479-512`**: `loadAllSessionStats` — buggy aggregation; tracked by BUG-088.
- **SDK types** (`node_modules/@opencode-ai/sdk/dist/gen/`):
    - `types.gen.d.ts:43-45, 102-105` — `time.created: number` on messages.
    - `types.gen.d.ts:469, 479` — `parentID?: string`, `title: string` on Session.
    - `types.gen.d.ts:493-498` — `EventSessionCreated` (event exists, `parentID` is NULL).
    - `types.gen.d.ts:2037-2048` — `SessionForkData.body.messageID?` (forks can be at any message).
    - `sdk.gen.d.ts:170` — `client.session.messages()` exists.
    - `types.gen.d.ts:2231-2240` — `SessionMessagesResponse`.

---

## 10. Resolved Decisions (as of 2026-08-08)

1. **Schema version bump** — **Yes, bump.** Adding `startTime`/`endTime`/`effectiveTimeMs`/`directTimeMs` to `CompressionBlock`. Old state files load with `startTime=0, endTime=0` → predicate fails → inheritance silently disabled for old files. No data loss.
2. **Side-index for parent ID** — **No, YAGNI.** Title-scan + always-pick fallback chain is sufficient.
3. **Race condition** — **No race within a process.** `checkSession` is awaited at `lib/hooks.ts:215` before any prune logic. Cross-process race already exists in `lib/state/persistence.ts:152-160` and is unchanged.
4. **Subagent fork interaction** — **No inheritance for subagents.** Existing subagent-skip runs before fork detection. Documented invariant.
5. **Order of operations** — **`tryInheritFromParent` runs INSIDE the `persisted === null` branch.** "B's own state wins" semantics preserved.
6. **Recursion limit** — **Immediate parent only.** Transitivity is automatic through B's own persisted state (test 20 verifies).
7. **Inheritance + subagent detection** — **Subagent-skip wins** automatically; documented.
8. **Persistence** — **Explicit `coalesceSaveSessionState` call required.** Not relying on implicit save later in the transform pipeline. The explicit save also fixes the `sessionName`-never-written risk.
9. **Always-pick fallback chain** — **Single-layer disambiguator + recency fallback.** Per user direction 2026-08-08: when candidates exist, always pick one (single → longest prefix → recency). Graceful give-up only when zero candidates.
10. **Integration point branch** — **Inside `persisted === null` branch.** Initial §5 placement was a critical bug; corrected.
11. **Default behavior** — **Default ON.** `experimental.inheritOnFork` defaults to `true` per user direction 2026-08-08. Users opt-OUT for strict session isolation.
12. **System prompt hint** — **Removed entirely** per user direction 2026-08-08. The hint was harmful in BOTH cases (without inheritance it lied about block visibility; with inheritance it contradicted visible blocks).
13. **Message-ID preservation** — **Confirmed not preserved on fork** (SQLite probe 2026-08-08). Inheritance key redesigned to use `time.created` (the only surviving ID-like value) instead of message IDs.
