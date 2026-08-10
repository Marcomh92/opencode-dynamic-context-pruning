# BUG-093: erify-package.mjs carve-out at line 193 checks the wrong path for jsonc-parser

**Status:** Open
**Severity:** Medium (pre-publish verifier fails on the canonical, documented import path)
**Component:** scripts/verify-package.mjs:193-195; lib/config.ts:13

## Problem

scripts/verify-package.mjs is the pre-publish verifier (
pm run check:package). On a clean checkout of HEAD 92daaf1, running 
ode scripts/verify-package.mjs fails with:

`
package verification failed: lib\config.ts uses named import from CommonJS-style package jsonc-parser
`

The script's carve-out at line 193 only skips the deep ESM path:

`js
if (entry.specifier === "jsonc-parser/lib/esm/main.js") {
    continue
}
`

But lib/config.ts:13 imports the **bare** specifier:

`	s
import { parse } from "jsonc-parser"
`

The bare specifier resolves via 
ode_modules/jsonc-parser/package.json's "main": "./lib/umd/main.js" (the CJS UMD path). The carve-out checks the wrong path, so the legitimate import — the one PAT-014 and the file-header comment at lib/config.ts:4-12 explicitly require — fails the gate.

## Root cause

The carve-out rationale ("Node 24 + tsx in test mode can't surface named exports from the deep ESM path") is correct, but the implementation matches against the deep ESM path while the project imports the bare specifier (CJS UMD via main). The carve-out never triggers, so every erify-package.mjs run fails since the import was introduced.

Traced to commit d28afa7 "fix: harden runtime imports for package loading" (predates the Linux-compat PRs). Pre-existing on HEAD 92daaf1.

## Why it surfaced now

Discovered during the integration review of the Linux-compat rollout (PR-1/2/3, branch ork/dcp-3.1.15-m1). The Linux-compat PRs are clean and did not introduce the failure — scripts/verify-package.mjs:64,156,186,216 were touched by PR-3 (encoding strings "utf8" → "utf-8"), but those are functionally a no-op on Node's UTF-8 codec. The carve-out logic is unchanged from baseline.

## Reproduction

On a clean checkout of HEAD 92daaf1:

`sh
node scripts/verify-package.mjs
`

Expected: passes (or fails only on a genuine CJS import that has no named-export shim).
Actual: fails with lib\config.ts uses named import from CommonJS-style package jsonc-parser.

## Suggested fix

Widen the carve-out to also match the bare jsonc-parser specifier:

`js
if (
    entry.specifier === "jsonc-parser" ||
    entry.specifier === "jsonc-parser/lib/esm/main.js"
) {
    continue
}
`

The bare specifier resolves to lib/umd/main.js (CJS UMD), which is exactly the path PAT-014 and the file-header comment at lib/config.ts:4-12 require. One-line change.

## Impact

- 
pm run check:package (build + verify-package) fails before any publish.
- The plugin otherwise functions correctly — the import is legitimate, the carve-out is just incorrectly scoped.
- CI does not currently invoke erify-package.mjs, so the failure is invisible at PR time.

## Related

- **PAT-014**: "JSONC parse via jsonc-parser package's CJS UMD entry, NOT jsonc-parser/lib/esm/main.js — Node 24 + tsx in test mode can't surface named exports from the deep ESM path."
- **lib/config.ts:4-12**: file-header comment explaining the CJS UMD requirement.
- **Linux-compat PRs (branch ork/dcp-3.1.15-m1)**: unrelated to this defect; the PRs are clean and the failing verifier is a pre-existing baseline condition.

## Severity rationale

Medium: blocks 
pm run check:package (pre-publish), but does not affect runtime, dev loop, or test suite. CI is unaffected. Easy one-line fix once prioritized.
