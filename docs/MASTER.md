# MASTER

Developer documentation index for `@tarquinen/opencode-dcp` (fork).

This fork is a Dynamic Context Pruning OpenCode plugin. The plugin is a transform layer that rewrites the message stream fed to the model on every LLM call. It never mutates OpenCode's on-disk session history.

## Quick reference

| Topic | Path |
|---|---|
| Architecture, data flow, state lifecycle | `docs/ARCHITECTURE.md` |
| Design principles and hard rules | `docs/DESIGN_PRINCIPLES.md` |
| Patterns and conventions | `docs/PATTERNS.md` |
| Testing philosophy and layout | `docs/TESTING.md` |
| Performance budgets and trade-offs | `docs/PERFORMANCE.md` |
| Configuration merge and override semantics | `docs/CONFIGURATION.md` |
| OpenCode hook surface, permissions, TUI | `docs/features/OPENCODE_INTEGRATION.md` |
| Compress tool protocol and block lifecycle | `docs/features/COMPRESSION.md` |
| Prune / strategy / nudge pipeline | `docs/features/PRUNING.md` |
| Persisted state schema and storage path | `docs/features/STATE_PERSISTENCE.md` |
| Prompt override behavior and extensions | `docs/features/PROMPTS.md` |
| Architecture Decision Records | `docs/DECISIONS/` |

## Glossary

| Term | Definition |
|---|---|
| DCP | Dynamic Context Pruning. The plugin's overall transform contract. |
| Plugin | The npm package `@tarquinen/opencode-dcp`; an OpenCode plugin. |
| Fork | This repository; a v2 fork-protocol layer on top of upstream DCP. |
| Fork protocol | The v2 manual/recovery state machine and its compress-blocking rules. See `docs/features/COMPRESSION.md`. |
| Session | A single OpenCode chat session. The plugin keeps at most one in-memory state per process. |
| Session state | `SessionState` in `lib/state/types.ts`. Persisted to disk under XDG data dir. |
| Transform | A single call to the `experimental.chat.messages.transform` hook. |
| Prune | The in-flight replacement of obsolete tool outputs with synthetic summaries. See `docs/features/PRUNING.md`. |
| Compress | The model's call to the `compress` tool. Persists a compression block; next transform materializes it. See `docs/features/COMPRESSION.md`. |
| Compression block | A persisted unit of compressed content. Identified by `bN`. |
| Anchor | The assistant message that owns a compression block; identified by `mNNNN`. |
| Block graph | The set of compression blocks and their deactivation relationships. |
| Manual mode | The v2 flag preventing autonomous compress. Set by `/dcp manual on` or by the recovery protocol. |
| Recovery mode | The v2 flag set after repeated non-compacting compresses. Cleared only on session restart or after a successful manual fade window. |
| Ponytail | In-source comment marker `// ponytail: ...` that names a deliberate simplification, its ceiling, and an upgrade path. See `docs/PATTERNS.md`. |
| Protected tool | A tool name the user has listed in `compress.protectedTools`. v2 fork default is `[]`; callers must opt in. |
| Override (prompts) | A user-editable prompt file under `~/.config/opencode/dcp-prompts/overrides/`. Gated by `experimental.customPrompts`. See `docs/features/PROMPTS.md`. |
| Effective permission | The DCP `compress.permission` resolved against OpenCode host permissions. See `docs/features/OPENCODE_INTEGRATION.md`. |
| Subagent session | An OpenCode session that was spawned by a `task` tool call. DCP skips these unless `experimental.allowSubAgents = true`. |
| Internal agent | OpenCode's title-generator / summarizer agents. Skipped via `isInternalAgentSystem` in `lib/hooks.ts`. |
| Coalesced save | The per-microtask single-writer contract for `saveSessionState`. See `docs/features/STATE_PERSISTENCE.md`. |
| Schema gate | The check that drops persisted state when `forkSchemaVersion` does not match `FORK_SCHEMA_VERSION`. |
| Age gate | Optional per-file freshness check; drops persisted state older than `compress.stateMaxAgeDays`. |
| Message ID (`mNNNN`) | An injected per-transform id assigned to a visible message. See `docs/features/PRUNING.md`. |
| Block ID (`bN`) | An identifier for a compression block. See `docs/features/COMPRESSION.md`. |
| Boundary | A `startId` / `endId` pair pointing at canonical messages or earlier blocks. |
| Net compaction | `summaryTokens` vs. `removedTokens * maxCompactionRatio`. The guard for the recovery protocol. |
| Recovery fade window | Number of consecutive successful manual compresses required to clear `recoveryForced`. |
| DCP prompt tag | A system-prompt tag written by the plugin to scope its instructions. |

## Where to look first

| Question | Read |
|---|---|
| How is this plugin wired into OpenCode? | `docs/features/OPENCODE_INTEGRATION.md` |
| How does the plugin transform a request? | `docs/ARCHITECTURE.md` |
| How does the `compress` tool work? | `docs/features/COMPRESSION.md` |
| How is the on-disk state managed? | `docs/features/STATE_PERSISTENCE.md` |
| What can a user override? | `docs/features/PROMPTS.md` and `docs/CONFIGURATION.md` |
| What are the hard rules? | `docs/DESIGN_PRINCIPLES.md` |
| What is new in the v2 fork-protocol layer? | `docs/DECISIONS/001-v2-fork-protocol.md` |

## Status

- This is a fresh documentation initialization for a fork that previously had no `docs/` directory.
- `AGENTS.md`, `MY_README.md`, `MY_CHANGELOG.md`, `MY_LOOSE_COMPRESSION.md`, and `MY_PROJECT_CONTEXT_PRESERVATION.md` are the upstream narrative; the docs here are the developer-facing source of truth derived from source code.
- `MY_PROJECT_CONTEXT_PRESERVATION.md` is explicitly marked superseded in this fork and is not authoritative.
