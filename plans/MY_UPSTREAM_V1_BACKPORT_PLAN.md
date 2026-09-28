# MY_UPSTREAM_V1_BACKPORT_PLAN.md — Upstream V1 Bug-Fix + QoL Backport Plan

## Header

- **Date:** 2026-09-28
- **Author:** OpenCode agent (Marco)
- **Branch (target):** `fork/dcp-3.1.15-m1` (cumulative branch per the M1 plan)
- **Fork version (current):** 3.1.19 (M1 + M2 + M3 + M4 + M5 + M2.5 + M2.5b + M2.5c + M2.5d all landed; prompt-only 2026-08-06 and 2026-08-31 / 2026-09-10 additions also in)
- **Upstream range scanned:** `v3.1.14..v3.2.0` (53 commits, 11,457 insertions / 1,436 deletions across 84 files)
- **Upstream clone used for diffing:** `C:\Beheer\OpenCode\opencode_plugins\opencode-dynamic-context-pruning\`
- **Fork clone target of the patches:** `C:\Beheer\OpenCode\opencode_plugins\opencode-dynamic-context-pruning-fork-v2\`
- **Status:** PLAN. No code changes have been made yet — every diff below is a draft to be reviewed and applied in one or more focused commits.

## Executive summary

The fork's M1–M2.5d work is **already in sync** with upstream on every M-overlap (M3 Windows path, M2 manual-mode round-trip, M5 internal-agent detection). The `42ac1a0e` follow-up (restore-manual-mode after compress) is **superseded** by the fork's v2 protocol (`userForced` / `recoveryForced` flags + `effectiveManualMode` helper). The fork does **not** need to port any of those.

The fork is, however, **missing three concrete fixes** that upstream landed in v3.1.15 and v3.2.0, plus **two security dep updates** that have not been pulled into the lockfile. This plan covers those.

| # | Upstream commit | What | Action | Risk |
|---|---|---|---|---|
| 1 | `acb1fdc5` (Fixes #555) | Strip trailing `mXXXX</parameter>` hallucination | **PORT** | LOW |
| 2 | `f236e0de` (Fixes #556) | Strip injected `mXXXX</dcp-message-id>` suffix before paired-tag regex | **PORT** | LOW |
| 3 | `34ad1938` (PR #583) | `allowTrailingCommas: true` in `dcp.schema.json` | **PORT** | NEGLIGIBLE |
| 4 | `25417d2b` + `6bb9381c` | Bump `brace-expansion` (2.1.1 → 2.1.4) and `browserslist` (4.28.2 → 4.29.0) family for CVE hygiene | **PORT** | LOW |
| 5 | `77d800b8` | OpenTUI peer/devDep loosen (`^0.4.2` → `>=0.4.2` peer, `^0.5.0` dev) | **SKIP** — see §5 | — |
| 6 | `5f8f33bb` (M3) | Windows path normalisation | **ALREADY IN SYNC** (fork `lib/protected-patterns.ts:3`) | — |
| 7 | `9f9a185b` (M2 #590) | `manualMode` strict equality | **ALREADY IN SYNC** (fork `lib/compress/pipeline.ts:146`) | — |
| 8 | `e2047e2e` (#581) | Internal-agent detection from primary system prompt only | **SUPERSEDED** — fork's `isInternalAgentSystem` (`lib/hooks.ts:68-102`) is a strict superset (handles `metadata:` prefix) | — |
| 9 | `42ac1a0e` | Restore manual mode after compress-pending reset | **SUPERSEDED** — fork's v2 protocol already covers this | — |

**Total diff for items 1–4:** ~10 lines of TS in 2 files + 1 line in `dcp.schema.json` + 1 `package-lock.json` write from `npm update`. Items 1 + 2 are best landed as a single commit (both touch the same function and were upstream-PR'd within hours of each other).

---

## 1. `acb1fdc5` + `f236e0de` — Strip suffix hallucinations (#555 + #556)

### 1.1 Why this matters

The fork's `injectMessageIds` writes XML-style message-id tags into the model's live context, e.g. `` for message 3 with high priority. The model occasionally echoes part of that pattern back into its own response (the assistant-text portion that goes through `text.complete`). When the echo is a **complete** pair of `<dcp-message-id>...</dcp-message-id>` tags, the existing `DCP_PAIRED_TAG_REGEX` catches it on the next `stripHallucinations` call. When the echo is **partial** — either the orphan tail `>m0123</dcp-message-id>` (the model lost the opening `<dcp-message-id …`) or a hallucinated `m0340</parameter>` (the model closed the wrong tag) — the existing regexes miss it, and the garbage stays in the next prompt.

Upstream landed two regexes to catch these two failure modes specifically. Both are **lookbehind-anchored to a newline** so they only fire at the natural end-of-message boundary, not in the middle of legitimate text.

### 1.2 Upstream references

- Commit `acb1fdc5` (2026-08-08) — Fixes #555, message subject `fix: strip trailing mXXXX</parameter> hallucinations`
- Commit `f236e0de` (2026-08-08) — Fixes #556, message subject `fix: strip injected message-id suffix before paired tag regex`
- Author: LHMQ878
- Test additions: `tests/message-priority.test.ts` lines 814–820 (#555) and adjacent (#556)
- v3.2.0 final state in upstream `lib/messages/utils.ts:11-12`:
  ```ts
  const INJECTED_MESSAGE_ID_SUFFIX_REGEX = /(?<=\n)<]*>m\d+<\/dcp-message-id>\s*$/
  const HALLUCINATED_PARAMETER_SUFFIX_REGEX = /(?<=\n)m\d+<\/parameter>\s*$/
  ```
  (Note: the leading `]*` in `INJECTED_MESSAGE_ID_SUFFIX_REGEX` is a no-op — `*` matches zero characters. The regex effectively anchors on a newline + `>m\d+</dcp-message-id>` tail. Do not "fix" this; it is the upstream-blessed form, and any divergence is a future-merge risk.)

### 1.3 Current fork state

**File:** `lib/messages/utils.ts` lines 8–11 (regex block) and 208–210 (`stripHallucinationsFromString` body).

```ts
// line 8-11
const SUMMARY_ID_HASH_LENGTH = 16
const DCP_BLOCK_ID_TAG_REGEX = /(])[^>]*>)b\d+(<\/dcp-message-id>)/g
const DCP_PAIRED_TAG_REGEX = /]*>[\s\S]*?<\/dcp[^>]*>/gi
const DCP_UNPAIRED_TAG_REGEX = /<\/?dcp[^>]*>/gi
```

```ts
// line 208-210
export const stripHallucinationsFromString = (text: string): string => {
    return text.replace(DCP_PAIRED_TAG_REGEX, "").replace(DCP_UNPAIRED_TAG_REGEX, "")
}
```

Both regexes are absent; the function only handles full pairs and stray open/close tags.

### 1.4 Patch to apply

**Edit 1 — `lib/messages/utils.ts` after line 11** (add the two suffix regexes):

```diff
 const SUMMARY_ID_HASH_LENGTH = 16
 const DCP_BLOCK_ID_TAG_REGEX = /(])[^>]*>)b\d+(<\/dcp-message-id>)/g
 const DCP_PAIRED_TAG_REGEX = /]*>[\s\S]*?<\/dcp[^>]*>/gi
 const DCP_UNPAIRED_TAG_REGEX = /<\/?dcp[^>]*>/gi
+const INJECTED_MESSAGE_ID_SUFFIX_REGEX = /(?<=\n)<]*>m\d+<\/dcp-message-id>\s*$/
+const HALLUCINATED_PARAMETER_SUFFIX_REGEX = /(?<=\n)m\d+<\/parameter>\s*$/
```

**Edit 2 — `lib/messages/utils.ts` replace the `stripHallucinationsFromString` body (line 208-210):**

```diff
 export const stripHallucinationsFromString = (text: string): string => {
-    return text.replace(DCP_PAIRED_TAG_REGEX, "").replace(DCP_UNPAIRED_TAG_REGEX, "")
+    const withoutKnownSuffixes = text
+        .replace(INJECTED_MESSAGE_ID_SUFFIX_REGEX, "")
+        .replace(HALLUCINATED_PARAMETER_SUFFIX_REGEX, "")
+    return withoutKnownSuffixes
+        .replace(DCP_PAIRED_TAG_REGEX, "")
+        .replace(DCP_UNPAIRED_TAG_REGEX, "")
 }
```

That is the entire code change: 4 added lines (2 declarations + 2 replace calls) and 1 net line rearranged in the function body.

### 1.5 Test additions

Add to `tests/message-priority.test.ts` (the file the fork already uses for hallucination-stripping tests; the `#555` test in upstream was inserted at line 814 of that file). Two new cases:

```ts
// Existing imports — stripHallucinationsFromString is already imported in this file (line 12).
// New cases — add inside the existing "hallucination stripping" describe/test block, after
// the "does not affect non-dcp tags" case (upstream inserted at line 814):

test("hallucination stripping removes trailing mXXXX</parameter> artifact (issue #555)", () => {
    assert.equal(
        stripHallucinationsFromString(
            "Total: maybe 20 lines changed.\n\nm0340</parameter>\n\n",
        ),
        "Total: maybe 20 lines changed.\n\n",
    )
})

test("hallucination stripping removes injected mXXXX</dcp-message-id> suffix (issue #556)", () => {
    // The lookbehind (?<=\n) requires the suffix to be preceded by a newline.
    // Without the lookbehind this regex would over-strip legitimate content;
    // with it, only the natural end-of-message boundary is targeted.
    assert.equal(
        stripHallucinationsFromString("Did the work.\n>m0123</dcp-message-id>"),
        "Did the work.",
    )
    // Negative case: in the middle of the message, the suffix should NOT be stripped.
    assert.equal(
        stripHallucinationsFromString("line one\n>m0123</dcp-message-id> line two"),
        "line one\n>m0123</dcp-message-id> line two",
    )
})
```

The negative case is the load-bearing test — it pins the `(?<=\n)` lookbehind behavior, which is the entire reason the upstream fix uses that detail (a plain `m\d+</dcp-message-id>` match would be too greedy).

### 1.6 Verification

```bash
cd "C:\Beheer\OpenCode\opencode_plugins\opencode-dynamic-context-pruning-fork-v2"

# 1. Typecheck — must remain clean.
bun run typecheck

# 2. Targeted test — should pass and exercise the new regex.
bun run test -- --test-name-pattern "555|556"

# 3. Full test suite — must remain at 195+ (currently 195 + 2 = 197).
bun run test

# 4. Build — dist/ output must remain functional.
bun run build

# 5. Optional smoke test on a real session where the model has previously echoed
#    a trailing mXXXX</parameter> or mXXXX</dcp-message-id>. Check
#    ${XDG_CONFIG_HOME}/opencode/logs/dcp/context/<sessionId>/<ts>.json to
#    confirm the strip now removes the artifact.
```

### 1.7 Risks and mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| The lookbehind `(?<=\n)` is a Node-V8-only feature; some old Node hosts may not support it | LOW — the fork requires Node ≥ 20 (per `package.json:24`) | Already gated by `engines.node`; no new constraint |
| The negative test fails (over-strip in middle of message) | LOW — both regexes are anchored to a newline lookbehind | The negative case is the test that would catch a regression here; if it fails, the regex was written wrong |
| A future fork prompt addition introduces a legitimate `m\d+</parameter>` pattern (very unlikely) | VERY LOW | `(\d{4})` is the format the fork uses, so `m1234</parameter>` would have to be intentional. Override via `experimental.customPrompts` is the user escape hatch |
| A pre-existing test in the fork already covers one of these cases and would now run twice | LOW | `grep` `tests/message-priority.test.ts` for `m\d\{4\}</parameter>` and `m\d\{4\}</dcp-message-id>` before adding — if a case exists, extend it instead of duplicating |

### 1.8 Backward compatibility

The new regexes are **purely additive** — they only strip suffixes at a newline boundary, and only at end-of-string. They cannot cause `stripHallucinations` to alter text that it would not have altered before. Sessions already in flight when the patch lands see no behavior change for any input that was already being stripped; the only delta is the new suffix-stripping case, which is the bug we're fixing.

---

## 2. `34ad1938` — `allowTrailingCommas: true` in `dcp.schema.json`

### 2.1 Why this matters

The runtime config parser (`jsonc-parser` in `lib/config.ts`) already accepts trailing commas in `dcp.jsonc` — that is the entire point of the JSONC-vs-JSON distinction. The **schema validator** that the user's editor (VSCode, Zed, IntelliJ) runs on `dcp.jsonc` is strict, however, and currently flags any trailing comma as a schema violation. The `allowTrailingCommas` flag in JSON Schema draft-07+ is a hint to the editor to relax that check. This is **editor QoL, not runtime behavior**.

### 2.2 Upstream reference

- Commit `34ad1938` (2026-07-06) — author Tiago de Paula (`marmitar`), PR #583
- Message subject: `feat: allow trailing commas in config schema`
- One-line change in `dcp.schema.json` line 8 of the upstream file at v3.2.0.

### 2.3 Current fork state

**File:** `dcp.schema.json` lines 1–8. The schema currently has:

```json
{
    "$schema": "http://json-schema.org/draft-07/schema#",
    "$id": "https://raw.githubusercontent.com/Opencode-DCP/opencode-dynamic-context-pruning/master/dcp.schema.json",
    "title": "DCP Plugin Configuration",
    "description": "Configuration schema for the OpenCode Dynamic Context Pruning plugin",
    "type": "object",
    "additionalProperties": false,
    "properties": {
```

No `allowTrailingCommas` flag. Trailing-comma editing triggers the schema validator warning.

### 2.4 Patch to apply

**Edit `dcp.schema.json` line 8 (insert one line):**

```diff
     "description": "Configuration schema for the OpenCode Dynamic Context Pruning plugin",
     "type": "object",
     "additionalProperties": false,
+    "allowTrailingCommas": true,
     "properties": {
```

### 2.5 Test additions

None. JSON-schema `allowTrailingCommas` is a validator hint; the runtime test in `tests/` is not the right place. If desired, a manual smoke test: open `dcp.jsonc` in VSCode, type `,` after the last key, confirm the red squiggle does not appear.

### 2.6 Verification

```bash
cd "C:\Beheer\OpenCode\opencode_plugins\opencode-dynamic-context-pruning-fork-v2"

# 1. Schema is still valid JSON.
node -e "JSON.parse(require('fs').readFileSync('dcp.schema.json', 'utf8'))"

# 2. Schema still validates an existing dcp.jsonc fixture (the fork ships an
#    empty one with just $schema).
node -e "
  const Ajv = require('ajv');
  const addFormats = require('ajv-formats');
  const ajv = new Ajv({allowTrailingCommas: true, strict: false});
  addFormats(ajv);
  const schema = JSON.parse(require('fs').readFileSync('dcp.schema.json', 'utf8'));
  const valid = ajv.validate(schema, JSON.parse(require('fs').readFileSync('dcp.jsonc', 'utf8')));
  if (!valid) { console.error(ajv.errors); process.exit(1); }
"

# 3. bun run typecheck (sanity, no schema code in TS).
bun run typecheck
```

### 2.7 Risks and mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| A user has set `dcp.jsonc` with an `additionalProperties` entry (a typo) and now sees no warning | LOW — `additionalProperties: false` is still set, so unknown properties are still flagged | None — that's the user-stated intent of this flag |
| Future editors may not honor the flag | LOW — VSCode, Zed, and IntelliJ all honor it | If a user's editor ignores it, the runtime parser is unchanged |

### 2.8 Backward compatibility

None. The flag is a hint to the editor, not a runtime behavior change.

---

## 3. Security dep updates — `brace-expansion` + `browserslist` family

### 3.1 Why this matters

The fork's `package-lock.json` (created 2026-08-05, last refreshed 2026-09-01 with the libc-entry cleanup) pins **pre-patch versions** of two transitive dependencies that have known CVE-class issues. The runtime risk in a Node-loaded plugin is low (the plugin does not call into `browserslist` directly), but the build pipeline (tsup → esbuild → tsc) does traverse the lockfile, and lockfile hygiene is cheap.

### 3.2 Upstream references

- Commit `25417d2b` (2026-08-16) — author Daniel Smolsky — `fix: update vulnerable brace expansion` — bumps `brace-expansion` 2.1.1 → 2.1.4
- Commit `6bb9381c` (2026-09-16) — author Daniel Smolsky — `fix: update vulnerable Browserslist dependency` — bumps `browserslist` 4.28.2 → 4.29.0, `baseline-browser-mapping` 2.10.37 → 2.11.24, `caniuse-lite` 1.0.30001799 → 1.0.30001810, `electron-to-chromium` 1.5.373 → 1.5.430, `node-releases` 2.0.47 → 2.0.55, `update-browserslist-db` 1.2.3 → 1.3.3

### 3.3 Current fork state (`package-lock.json`)

Confirmed via grep on 2026-09-28:

| Package | Pinned version | Lines |
|---|---|---|
| `brace-expansion` | 2.1.1 | 1695–1697 |
| `browserslist` | 4.28.2 | 1705–1707 |
| `baseline-browser-mapping` | 2.10.37 | 1682–1684 |
| `update-browserslist-db` | 1.2.3 | 3039–3041 |
| `caniuse-lite` | 1.0.30001799 | (transitive, picked up by browserslist bump) |
| `electron-to-chromium` | 1.5.373 | (transitive) |
| `node-releases` | 2.0.47 | (transitive) |

All four are pre-fix.

### 3.4 Patch to apply

**No source patch.** Run `npm update` on the four direct consumers (the transitive deps roll with them):

```bash
cd "C:\Beheer\OpenCode\opencode_plugins\opencode-dynamic-context-pruning-fork-v2"

npm update brace-expansion browserslist baseline-browser-mapping update-browserslist-db
```

`npm update` will rewrite the `node_modules/` and `package-lock.json` to the latest semver-compatible version of each. The user can also use `bun update` if they prefer; the lockfile format is the same.

### 3.5 Test additions

None. These are dep versions, not new behavior. The full test suite is the verification.

### 3.6 Verification

```bash
cd "C:\Beheer\OpenCode\opencode_plugins\opencode-dynamic-context-pruning-fork-v2"

# 1. Confirm the new versions are in the lockfile.
grep -A 1 '"node_modules/brace-expansion":' package-lock.json | head -3
grep -A 1 '"node_modules/browserslist":' package-lock.json | head -3
grep -A 1 '"node_modules/baseline-browser-mapping":' package-lock.json | head -3
grep -A 1 '"node_modules/update-browserslist-db":' package-lock.json | head -3

# 2. Audit should report no known vulnerabilities in the four packages.
npm audit

# 3. Build, typecheck, test — all must remain clean.
bun run build
bun run typecheck
bun run test
```

### 3.7 Risks and mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| A new transitive dep version pulls in a breaking change | LOW — all four are minor patches within a semver-minor series | The test suite is the smoke test; if it breaks, the dep bump is the cause |
| The `workspaces` field is empty in the fork; npm update may print a warning | LOW | Ignore the warning — it is harmless |
| `bun update` would rewrite the lockfile to Bun's preferred format; the fork already uses `bun` for install | LOW | Either tool is fine; match the user's habit. The fork's MY_README documents `bun install`, so prefer `bun update` for consistency |

### 3.8 Backward compatibility

None. Dep version bumps do not change the plugin's behavior. Sessions in flight when the lockfile changes see no delta.

---

## 4. `77d800b8` — OpenTUI peer/devDep loosen — DECISION: SKIP

### 4.1 What upstream did

```diff
 "peerDependencies": {
     "@opencode-ai/plugin": ">=1.4.3",
-    "@opentui/core": "^0.4.2",
-    "@opentui/solid": "^0.4.2",
+    "@opentui/core": ">=0.4.2",
+    "@opentui/solid": ">=0.4.2",
     "solid-js": "^1.9.12"
 },
 "devDependencies": {
     "@opencode-ai/plugin": "^1.4.3",
-    "@opentui/core": "^0.4.2",
-    "@opentui/solid": "^0.4.2",
+    "@opentui/core": "^0.5.0",
+    "@opentui/solid": "^0.5.0",
```

Upstream **loosened the peer** (so consumers can pick 0.4.x OR 0.5.x) and **tightened the dev** (so upstream's own dev/test runs against 0.5.x). The intent is to give the plugin's published consumers a wider install matrix while still testing on the latest.

### 4.2 Why skip

The fork:

- Is **not published to npm** (M1.5 fork convention; `MY_README.md` documents this). The peer-loosening change only matters for downstream consumers — moot for a local `file://` install.
- Has OpenTUI dependencies that are **Bun-gated** in `tui.tsx` (M3 fork change). Bumping to 0.5.0 risks an API-surface change in `@opentui/core`/`solid` that the fork's `lib/tui/` modules do not yet adapt to. The fork is pinned to 0.4.2 in `package.json:60-61, 71-72` (peer + dev), and that pin has not caused any reported issue.
- Already bundles `@opencode-ai/plugin` via `tsup.config.ts` `noExternal` (M1 fix). The OpenTUI peer does not need to be touched for the fork to work.

### 4.3 When to revisit

- If a future OpenCode host version ships with OpenTUI 0.5+ bundled and the fork's `tui.tsx` import contract breaks, revisit. Until then, the 0.4.2 pin is conservative and correct.
- If the fork is ever republished to npm, loosen the peer to `>=0.4.2` to mirror upstream.

---

## 5. Already-in-sync items (informational; no action)

These upstream commits are listed in the v3.1.14..v3.2.0 range but the fork already has the fix under a different (sometimes better) name. Listed here so a future maintainer doesn't re-derive the decision.

| Upstream | What | Fork equivalent | Where |
|---|---|---|---|
| `5f8f33bb` (M3) | Windows path normalisation | `replaceAll("\\", "/")` | `lib/protected-patterns.ts:3` — identical, M3 commit |
| `9f9a185b` (M2 #590) | `manualMode` strict equality | `=== "active"` | `lib/compress/pipeline.ts:146` — identical, M2 commit |
| `e2047e2e` (#581) | Internal-agent detection from primary system prompt only | `isInternalAgentSystem` with every-prompt + `metadata:` prefix fallback | `lib/hooks.ts:68-102` — strict superset, M5 commit |
| `42ac1a0e` | Restore manual mode after compress-pending reset | `userForced` / `recoveryForced` flags + `effectiveManualMode` helper | `lib/compress/pipeline.ts:42-48, 211-213` — fork's v2 protocol supersedes this; the legacy `manualMode` boolean is derived from the flags |
| `d6379815` | `chore: release v3.2.0` | (no fork action) | — |
| `f882d6e5` | `chore: release v3.2.0` | (no fork action) | — |

---

## Combined execution checklist

When the user is ready to land this plan, the suggested order is:

- [ ] **Commit A** — `fix: strip trailing mXXXX</parameter> and injected mXXXX</dcp-message-id> hallucinations` (items 1.4 + 1.5)
  - Edits `lib/messages/utils.ts` (4 added lines + 1 rearranged line in `stripHallucinationsFromString`)
  - Adds 2 test cases to `tests/message-priority.test.ts`
  - Run `bun run typecheck && bun run test` (expect 195 → 197 passing)
- [ ] **Commit B** — `feat: allow trailing commas in dcp schema` (item 2.4)
  - Edits `dcp.schema.json` (1 added line)
  - No test additions
  - Run schema validation (item 2.6)
- [ ] **Commit C** — `chore: bump brace-expansion and browserslist to current` (item 3.4)
  - Runs `npm update brace-expansion browserslist baseline-browser-mapping update-browserslist-db` (or `bun update …`)
  - Commits the resulting `package-lock.json` diff
  - Run `bun run build && bun run typecheck && bun run test` to confirm no behavior regression
- [ ] **MY_CHANGELOG.md** — add a single `## 2026-09-28 - Upstream v3.1.15 + v3.2.0 V1 Backport` entry covering all three commits, in the format used by the existing entries (Branch, Triggered by, Changes, Files, Test additions, Verification)
- [ ] **Post-port verification** — confirm the build size is unchanged (still 729.27 KB ± a few bytes), the test count is now 197, and the OpenCode host still loads the plugin with no warning in the daily log.

## Effort estimate

- Code changes: ~10 lines TS, 1 line JSON, 1 lockfile rewrite.
- Test additions: 2 test cases.
- Manual review: 1 read-through of the new regex behavior on a real session where the model has previously echoed a trailing artifact.
- End-to-end: ~30 minutes for a developer who already has the fork environment loaded.

## Long-term note

The V2 migration (compact IDs, V2 server adapter, dual-version sandbox) is **out of scope for this V1 backport plan**. See `MY_UPSTREAM_V2_ADOPTION_PLAN.md` for the separate V2 adoption plan, which the fork should evaluate only when there is a concrete V2 use case (e.g., a target user on the new OpenCode V2 host).
