# BUG-085: lib/compress/index.ts re-exports type-only `ToolContext` as a value

## Description

`lib/compress/index.ts` line 1 re-exports `ToolContext` as a value:

```ts
export { ToolContext } from "./types"
```

But `ToolContext` is declared as an `interface` in `lib/compress/types.ts:6`:

```ts
export interface ToolContext { ... }
```

Interfaces have no runtime representation. Under Node's ESM loader (used by `node --import tsx --test`), attempting to import a name that doesn't exist as a runtime export fails with:

```
SyntaxError: The requested module './types' does not provide an export named 'ToolContext'
```

This crash is triggered transitively by every test that imports `../index` (or anything that pulls in `lib/compress/index.ts`), including `tests/permission-gates.test.ts`.

## Location

- `lib/compress/index.ts:1`
- `lib/compress/types.ts:6` (the type declaration)

## Expected vs Actual

**Expected:** `lib/compress/index.ts` either re-exports `ToolContext` correctly as a type (so the line is dead-but-harmless) or omits the line entirely since nothing imports it as a value.

**Actual:** The line forces every consumer that loads `lib/compress/index.ts` to crash at module-evaluation time under Node ESM. The fact that every other test in the suite happens to import `ToolContext` via `import type { ToolContext } from "../lib/compress/types"` directly (never through the barrel) means the bug was hidden in upstream DCP where these tests didn't load `../index` at all.

## Impact

- **Severity:** High — `tests/permission-gates.test.ts` cannot run.
- **Surface:** Every test that dynamically imports `../index` (currently only `tests/permission-gates.test.ts:38`). Production code in `index.ts` does not import `lib/compress/index.ts` as a barrel — it imports `createCompressMessageTool` / `createCompressRangeTool` directly from `./compress/message` and `./compress/range`. So the runtime only crashes inside the test harness, not in real OpenCode plugin use.
- **Discovery:** Surfaced when fixing the unrelated syntax error in `tests/permission-gates.test.ts:34`. Before that fix, the test file failed to parse, masking this bug entirely.

## Reproduction

```bash
npm test -- tests/permission-gates.test.ts
```

```
SyntaxError: The requested module './types' does not provide an export named 'ToolContext'
    at async <anonymous> (.../tests/permission-gates.test.ts:38:21)
```

## Audit — who actually uses ToolContext?

All consumers import it as a type-only import:

- `tests/compress-pipeline-robustness.test.ts:19` — `import type { ToolContext }`
- `tests/compress-protocol.test.ts:21` — `import type { ToolContext }`
- `tests/synthetic-compress-burn.test.ts:15` — `import type { ToolContext }`
- `lib/compress/range.ts:2` — `import type { ToolContext }`
- `lib/compress/pipeline.ts:9` — `import type { ToolContext }`
- `lib/compress/message.ts:2` — `import type { ToolContext }`

**No file imports `ToolContext` as a runtime value**, so the re-export on `lib/compress/index.ts:1` is dead.

## Fix (proposed — DO NOT apply in a test-only commit)

Replace `lib/compress/index.ts:1` with a type-only re-export:

```ts
export type { ToolContext } from "./types"
```

Or delete the line entirely — no consumer reaches `ToolContext` via this barrel. Deletion is the minimal fix and matches the project's `// ponytail:` style for dead code (per `lib/hooks.ts` and `lib/state/` patterns).

## Related

- Discovered while fixing `tests/permission-gates.test.ts:34` syntax error (TypeScript `type` keyword in destructure).
- No other test imports `../index` dynamically, so no other test currently exposes this bug.
