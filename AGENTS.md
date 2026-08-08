# AGENTS.md - Agent Directives

This file defines **operating constraints and initial procedures** for AI agents working on this codebase.

For system architecture, patterns, and technical details, see the documentation in `docs/`.

## What it is

OpenCode plugin: `@tarquinen/opencode-dcp` — Dynamic Context Pruning. Replaces obsolete tool outputs in conversation context with high-fidelity summaries before LLM calls. Session history on disk is never mutated; pruning is an in-flight transform.

Fork note: this fork adds a v2 fork-protocol layer on top of upstream DCP (see `compress.maxCompactionRatio`, `compress.maxContextLimitRecovery`, `compress.recoveryFadeWindow`, `compress.forkSchemaVersion`, `compress.stateMaxAgeDays` in `lib/config.ts`).

## MANDATORY: PREFLIGHT CHECKLIST

> **CRITICAL: DO NOT PROCEED WITH ANY USER REQUEST UNTIL ALL ITEMS BELOW ARE COMPLETED**
>
> Failure to complete this checklist will result in context loss and incorrect implementation.

### Phase 1: System Context (REQUIRED)

You MUST read these files in EXACT order:

| #   | File                        | Purpose                       |
| --- | --------------------------- | ----------------------------- |
| 1   | `docs/MASTER.md`            | System overview and doc index |
| 2   | `docs/DESIGN_PRINCIPLES.md` | Core architectural principles |
| 3   | `docs/ARCHITECTURE.md`      | Layer responsibilities        |
| 4   | `docs/PATTERNS.md`          | Code patterns and standards   |

After completing the core files above, **discover and read** all remaining documentation relevant to your task:

1. **List** `docs/` to discover any additional project-level documents
2. **List** `docs/features/` to discover feature-specific subsystem documentation
3. **List** `docs/DECISIONS/` to discover Architecture Decision Records (ADRs)
4. **Use `docs/MASTER.md`** as the authoritative index — it catalogs all documentation files and contains the glossary of domain terms
5. **Read** Selectively read additional project-level, feature-level, and ADR documents relevant to your assigned task

## Commands

| Task           | Command                                                  |
| -------------- | -------------------------------------------------------- |
| Build          | `npm run build` (tsup + emit types)                      |
| Typecheck      | `npm run typecheck`                                      |
| Test           | `npm test` (node `--test` runner over `tests/*.test.ts`) |
| Format         | `npm run format` / `npm run format:check`                |
| Package verify | `npm run check:package`                                  |
| Dev loop       | `npm run dev` (opencode plugin dev)                      |
| Print config   | `npm run dcp`                                            |

## Layout

```
index.ts                # Plugin entry: wires hooks, config, commands
lib/
  config.ts             # JSONC config loader + 3-layer merge (global → configDir → project)
  hooks.ts              # OpenCode hook handlers (system/messages/command/text/event)
  compress/             # compress tool (range + message modes)
  messages/             # prune/nudge/priority/blocks/injectMessageIds
  strategies/           # deduplication, purgeErrors
  commands/             # /dcp and /dcp-compress slash command handlers
  prompts/              # renderable system + nudge prompts (user-overridable)
  state/                # per-session state, save/load, schema version
  subagents/            # subagent result extension/injection
  tui/, ui/             # panel + notifications
  auth.ts, update.ts, host-permissions.ts, message-ids.ts, ...
tests/                  # 33 node:test files; one per concern
scripts/                # one-off CLIs and `verify-package.mjs`
dcp.schema.json         # JSON schema for dcp.jsonc
tui.tsx                 # standalone TUI panel entry
```

## Architecture (one-screen)

`index.ts` → `getConfig(ctx)` → builds `SessionState` + `PromptStore` + `Logger` → returns the OpenCode hook surface. The heavy work happens in `experimental.chat.messages.transform` (`lib/hooks.ts::createChatMessageTransformHandler`): `filterMessages` → `prune` → `injectCompressNudges` → `injectMessageIds` → `saveContext`. Compress tool is registered in `tool:` (gated by `compress.permission !== "deny"` and `compress.mode`). Slash commands `/dcp` and `/dcp-compress` are handled in `command.execute.before`; the `config` hook injects them only when `commands.enabled` and `compress.permission !== "deny"`.

## Hard rules

- **Read-only on session history.** Pruning is a transform of `output.messages` before the LLM call. Never write to OpenCode's session storage.
- **3-layer config merge, replace-semantics for `protectedTools`.** User's `dcp.jsonc` is the single source of truth — `[]` means nothing protected, not "merge with default". See `mergeCompress` / `mergeStrategies` / `mergeCommands` ponytail comments in `lib/config.ts`.
- **Skip subagent sessions unless `experimental.allowSubAgents = true`.** Honored in both system-prompt and message-transform handlers.
- **Skip internal OpenCode agents** (`isInternalAgentSystem` in `lib/hooks.ts`) — title generators, summarizers.
- **Host permission baseline.** `*:deny` in `opencode.json` forces `compress.permission = "deny"` and the `compress` tool is unregistered. User can re-allow with explicit `"compress": "allow"`.
- **Cache-aware pruning has a trade-off.** Pruning invalidates prompt-cache prefixes from the prune point forward (~85% hit-rate vs 90% without). Don't claim "free" token savings.
- **Fork-protocol keys are clamped**, not rejected (see `clampRatio` / `clampMin1` / `clampNullOrNonNeg`). Bad values fall back rather than fail.

## Conventions

- **Ponytail comments** (`// ponytail: ...`) mark deliberate simplifications with a named ceiling and upgrade path. Keep them; they are the why-record.
- **JSONC parse via `jsonc-parser` package's CJS UMD entry**, not `jsonc-parser/lib/esm/main.js` — Node 24 + tsx in test mode can't surface named exports from the deep ESM path. See top-of-file comment in `lib/config.ts`. Do not "fix" this.
- **State schema version** lives in `lib/state/`. Bump when state shape changes; old states are loaded with defaults.
- **Prompts are overridable** under `~/.config/opencode/dcp-prompts/overrides/`. Gated by `experimental.customPrompts`. Six prompts: `system`, `compress-range`, `compress-message`, `context-limit-nudge`, `turn-nudge`, `iteration-nudge`.
- **Tests are one-file-per-concern** in `tests/*.test.ts`; run by `node --import tsx --test`. No test framework. New tests → delegate to `06-test_creator` after the implementation round is complete and stable (never in parallel with active implementation).
- **No default protected tools** in v2 fork. README still documents the legacy default for reference, but the runtime default is `[]`. If a feature requires protection, the caller must list it.

## Where to look first

- "How does pruning decide what to cut?" → `lib/messages/` (priority map, prune, injectCompressNudges)
- "How does compress work?" → `lib/compress/` and `lib/hooks.ts::createChatMessageTransformHandler`
- "How are slash commands wired?" → `lib/hooks.ts::createCommandExecuteHandler` + `lib/commands/`
- "What config keys exist?" → `dcp.schema.json` + `VALID_CONFIG_KEYS` in `lib/config.ts`
- "Where do slash commands and the compress tool get registered?" → `index.ts::config` hook
- "What's new in the fork?" → `MY_CHANGELOG.md`, `MY_LOOSE_COMPRESSION.md`, `MY_PROJECT_CONTEXT_PRESERVATION.md`; v2-protocol fields in `lib/config.ts::CompressConfig`

## Out of scope

- No end-user docs, tutorials, or marketing copy. README.md is end-facing; do not pad it.
- No new deps without justification; the bar is "stdlib/native cannot do this in a few lines."
- No modifications to OpenCode's session storage; this plugin is a transform layer.

## Bug Report Management

Bug reports live in `known_issues/`.

- **When fixing:** Check `known_issues/*.md`, read if found, mark **FIXED** with date after resolving, move to `known_issues/fixed/`
- **When creating:** Check `known_issues/` AND `known_issues/fixed/` for duplicates, use next `BUG-xxx` number, name: `BUG-xxx-short-description.md`

## GitNexus — Code Intelligence

Gitnexus can be used to get a deep architectural view of the codebase so you are less likely to miss dependencies, break call chains, and ship blind edits.

This project is indexed by GitNexus as repo **opencode-dynamic-context-pruning**. All gitnexus\_\* tools are MCP tool calls — invoke them directly, **never** via the bash tool. Always pass `repo: "opencode-dynamic-context-pruning"` explicitly.

#### Index maintenance (escape hatch — only when needed)

The only gitnexus action that uses the bash tool is rebuilding a stale index. Verify staleness first with `gitnexus_query({query: "project overview", repo: "opencode-dynamic-context-pruning"})`. If it reports a stale or missing index, run from the project root:

```
gitnexus analyze
```

Skip this step if `project overview` returns current results.

### Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream", repo: "opencode-dynamic-context-pruning"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes({repo: "opencode-dynamic-context-pruning"})` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept", repo: "opencode-dynamic-context-pruning"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName", repo: "opencode-dynamic-context-pruning"})`.
- **MUST pass `repo: "opencode-dynamic-context-pruning"` in every gitnexus\_\* tool call** — the parameter is technically optional with one indexed repo, but omitting it produces errors in this environment.

### Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.
- NEVER invoke gitnexus\_\* tools via the bash tool — they are MCP tools. The single bash exception is `gitnexus analyze` for rebuilding a stale index.

### Quick Reference

> Every example below includes `repo: "opencode-dynamic-context-pruning"`. Do not omit it.

#### Discover Repositories

```
gitnexus_list_repos()
```

#### Codebase Overview & Staleness Check

```
gitnexus_query({query: "project overview", repo: "opencode-dynamic-context-pruning"})
```

#### Functional Areas (Clusters)

```
gitnexus_cypher({query: "MATCH (c:Community) RETURN c.heuristicLabel, c.symbolCount, c.cohesion ORDER BY c.symbolCount DESC", repo: "opencode-dynamic-context-pruning"})
```

#### Execution Flows (Processes)

```
gitnexus_cypher({query: "MATCH (p:Process) RETURN p.heuristicLabel, p.stepCount, p.processType ORDER BY p.stepCount DESC", repo: "opencode-dynamic-context-pruning"})
```

#### Step-by-Step Execution Trace

```
gitnexus_cypher({query: "MATCH (s)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process) WHERE p.heuristicLabel = 'ProcessName' RETURN s.name, r.step ORDER BY r.step", repo: "opencode-dynamic-context-pruning"})
```
