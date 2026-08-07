# BUG-021: README.md still claims 10 default protected tools; v2 fork default is `[]`

## Summary
`README.md:214-221` lists `task`, `skill`, `todowrite`, `todoread`, `compress`, `batch`, `plan_enter`, `plan_exit`, `write`, `edit` as "By default, these tools are always protected from pruning." The v2 fork runtime default is `[]` (`lib/config.ts:99` `DEFAULT_PROTECTED_TOOLS: string[] = []`). A user reading only the README and setting up DCP via `compress.protectedTools = []` would believe `task` was still protected by default; it isn't.

## Location
- `README.md:214-221`

## Current vs Expected Behavior
**Current**: README documents a legacy upstream default; the v2 fork runtime uses `[]`.
**Expected**: README reflects the v2 fork reality, or adds a one-line note pointing to `AGENTS.md` / `docs/CONFIGURATION.md`.

## Impact
- **Severity**: High (user-facing docs lie; users will misconfigure protected tools)
- Runtime: not affected.
- User-observable: a user relying on the README's default list will see those tools pruned when they expected them protected.

## Reproduction
Read `README.md:214-221` — 10 tools listed as default-protected.
Read `lib/config.ts:99` and `lib/config.ts:801` — runtime default is `[]`.

## Suggested Fix
Rewrite `README.md:214-221` to reflect the v2 fork reality. Add a brief "Why" pointer so the README is self-explanatory:
```
By default, no tools are protected from pruning. To protect specific tools,
list them in `compress.protectedTools` (DPP-007). The legacy default of
10 tools (`task`, `skill`, ..., `edit`) was the upstream behavior; this fork
intentionally drops it. See AGENTS.md "No default protected tools in v2 fork".
```
Cross-reference `docs/CONFIGURATION.md` (line 40 already documents `compress.protectedTools | [] | v2 fork; no default`).

## Status
Open

## Cross-references
- Source investigator: tests + CI + format + deps
- Source finding ID: DOC-DRIFT-2
- Validator verdict: ✅ CONFIRMED
- Doc anchor: `AGENTS.md` Conventions "No default protected tools in v2 fork", `docs/DESIGN_PRINCIPLES.md` DPP-007

## Architect Review (2026-08-07)
- **Verdict**: CONFIRMED
- **Severity**: **changed High → Low**. Runtime is correct; `docs/CONFIGURATION.md` is authoritative for developers. Doc-only drift; no data loss, no invariant break.
- **Correct Fix**: equivalent; matches `AGENTS.md` and the v2 fork-protocol ADR.
- **Bonus**: `MY_README.md` may have the same drift; worth grepping both. `MY_PROJECT_CONTEXT_PRESERVATION.md` (superseded per `docs/MASTER.md:73`) may still carry the legacy list — quick grep would close the doc-drift cluster.