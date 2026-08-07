# Known Issues Index

This directory tracks known bugs, limitations, and design trade-offs in the `@tarquinen/opencode-dcp` fork. Each entry is a single Markdown file with a stable `BUG-NNN` identifier.

## Active Issues

| ID | Title | Severity | Status |
|---|---|---|---|

_No active issues filed yet. Add a row here when the first bug report lands._

## Closed Issues

| ID | Title | Severity | Status | Date fixed |
|---|---|---|---|---|

_Move files to `fixed/` and add a row here when resolved._

## Won't Fix

| ID | Title | Severity | Status | Date closed |
|---|---|---|---|---|

_Move files to `wont_fix/` and add a row here when a limitation is accepted._

## Severity Legend

- **High:** Compile failure, data loss, or invariant broken.
- **Medium:** Functional gap or test that does not verify the contract.
- **Low-Medium:** Validation bypass or quality regression.
- **Low:** Documentation drift, ergonomics, or DX issue.

---

## How to Use This Directory

1. **Before starting work:** Check if the issue is already documented.
2. **When fixing:** Move the report to `fixed/` and add resolution details; append a row to **Closed Issues** with the date.
3. **When accepting a limitation:** Move the report to `wont_fix/` and add a row to **Won't Fix** with a one-line reason.
4. **When discovering:** Create a new bug report following the template below.

## File Naming

`BUG-NNN-short-kebab-title.md` at the repo root, where `NNN` is the next integer. Move verbatim into `fixed/` or `wont_fix/` when closing.

## Bug Report Template

Each report file should be self-contained and reference source paths, not code snippets. Include:

- **Summary:** One or two lines.
- **Location:** `path/to/file.ts` and line numbers.
- **Current vs Expected Behavior:** What the code does vs what the invariant says.
- **Impact:** Severity, runtime/compile effects, which invariant is affected.
- **Reproduction:** Test name or manual steps; prefer a failing test.
- **Suggested Fix:** Where the change should land.
- **Status:** `Open`, `Fixed <date>`, or `WONTFIX — <reason>`.

Cross-reference identifiers from `docs/DESIGN_PRINCIPLES.md` (`DPP-XXX`), `docs/PATTERNS.md` (`PAT-XXX`), `docs/features/COMPRESSION.md` (`INV-1..20`), and `docs/features/PRUNING.md` (`INV-P1..13`) when the bug violates a documented rule.
