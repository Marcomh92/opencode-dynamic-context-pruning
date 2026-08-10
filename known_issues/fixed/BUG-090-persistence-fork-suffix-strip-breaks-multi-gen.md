# BUG-090: persistence-side fork-suffix strip breaks multi-generation inheritance

**Status:** Fixed 2026-08-08
**Severity:** Medium (UX regression — multi-generation fork inheritance gives up silently)
**Component:** `lib/state/persistence.ts` (saveSessionState title strip), `lib/state/inherit.ts` (findCandidateParents exact-match scan)

## Problem

BUG-089 shipped with a `bareTitle` strip in `saveSessionState`
(`lib/state/persistence.ts:122-132`) that removes the trailing
`(fork #N)` suffix from `sessionName` before writing the file. The intent
— per the inline comment — was to keep B's saved title scoped to A's
bare title so the candidate scan doesn't accidentally match a sibling
session. The strip is correct for the singular-parent case (A's
`sessionName` is "Original"; B's scan for "Original" matches A) but it
breaks multi-generation: B's saved sessionName is also "Original"
(stripped from "Original (fork #1)"), so when C forks from B, C's
parentTitle is "Original (fork #1)" (per `detectParentSessionFromTitle`'s
regex `/^(.+) \(fork #(\d+)\)$/`), and the candidate scan
(`lib/state/inherit.ts:284`, `if (parsed?.sessionName !== parentTitle) continue`)
finds neither A nor B. C gracefully gives up — the orchestrator logs
"no parent state files found" and returns, so BUG-089 §6.21's
multi-generation invariant is silently violated.

## Root cause

The strip was added to fix the sibling case at depth ≥ 2 (when two
siblings share the same `(fork #N)` suffix, the candidate scan would
return both). The fix overshot: it also strips the prefix that
distinguishes B from A's bare title. The candidate scan does an exact
match (`sessionName === parentTitle`), so the two design choices are
mutually incompatible — either the strip OR the exact-match (or both)
must change.

## Expected behavior

Per BUG-089 §6.21: a forked session C (title "Original (fork #1)
(fork #2)") inherits B's filtered blocks. C's parentTitle is "Original
(fork #1)", and B's persist-side sessionName should be "Original (fork
#1)" (the immediate-parent title, NOT the bare title). The candidate
scan then matches B's file and C inherits.

## Implemented behavior

- A's saved sessionName: "Original" (no suffix to strip)
- B's saved sessionName: "Original" (suffix stripped from "Original (fork #1)")
- C's parentTitle: "Original (fork #1)" (per regex)
- C's candidate scan: 0 matches → graceful give-up

Net effect: BUG-089's "B inherits from A" works (A's bare title
matches B's parentTitle "Original"). BUG-089's "C inherits from B"
silently fails.

## Reproduction

1. Session A (title "Original") compresses and persists.
2. Fork UI → B (title "Original (fork #1)"). B inherits A's block. ✓
3. B compresses its own range and persists.
4. Fork UI → C (title "Original (fork #1) (fork #2)"). C's
   `detectParentSessionFromTitle` returns `{ parentTitle: "Original (fork #1)" }`.
5. Scan DCP storage dir for `sessionName === "Original (fork #1)"`.
   A's file has `sessionName: "Original"`. B's file has `sessionName:
"Original"` (stripped). No match.
6. C gracefully gives up. C's initial state is empty.

## Fix path

Three viable options, in increasing order of blast radius:

1. **Drop the strip in `saveSessionState`** — B's saved sessionName is
   "Original (fork #1)". C's scan finds B. Risk: the sibling case at
   depth ≥ 2 (two same-suffix sessions) now returns both candidates;
   the recency fallback picks the most recent, which is the
   user-intended parent in practice. Test: re-add the sibling disambiguation
   test from `docs/plans/fork-state-inheritance.md` §3.2.

2. **Strip the suffix on the scan side instead of the save side** — keep
   A's and B's saved sessionNames verbatim, and have `findCandidateParents`
   do a suffix-aware match (e.g. compare `parsed.sessionName === parentTitle
|| parsed.sessionName === stripForkSuffix(parentTitle)`). Two-pass matching
   keeps the strip on the read side, which is the cheapest of the three.

3. **Add a side-index on the persist side** — a sidecar `parentMap.json`
   keyed by `{sessionName: sessionId}` so the scan returns O(1) instead of
   O(N files). YAGNI per plan §10.2.

The recommended fix is option 2 (suffix-aware scan). It's the smallest
diff, preserves the saved-shape contract, and keeps the strip as a
display concern (the persisted `sessionName` is the user's actual title).

## Related

- **BUG-089**: `known_issues/BUG-089-fork-state-inheritance-protocol-layer.md`
  — the feature this bug shadows. §6.21 specifies the multi-generation
  invariant that BUG-090 silently breaks.
- **Plan**: `docs/plans/fork-state-inheritance.md` §4.5 (copy table),
  §6.21 (acceptance criterion), §10.5 (resolved decision 5 — order of
  operations).
- **Test**: `tests/session-fork.test.ts` (multi-generation test at
  `tests/session-fork.test.ts:345-444`) — the test was written with a
  relaxed assertion (`<= 2`) and a `// KNOWN BUG (BUG-090)` comment
  to document the divergence from the plan's stated invariant.
- **Persistence comment**: `lib/state/persistence.ts:122-132` — the
  strip and its (incorrect) multi-generation rationale.
