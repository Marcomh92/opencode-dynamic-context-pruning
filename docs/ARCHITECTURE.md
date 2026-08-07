# ARCHITECTURE

Layers, data flow, and state lifecycle. The plugin is a transform layer over OpenCode's LLM-call surface; the heavy work is one async hook plus one model-callable tool.

## Layers

| Layer | Responsibility | Source |
|---|---|---|
| Composition | Build plugin surface, return OpenCode hooks and tool factories. | `index.ts` |
| Configuration | Layered JSONC merge, defaults, validators. | `lib/config.ts` |
| Hooks | Coordinate request transforms, slash commands, completions, events. | `lib/hooks.ts` |
| Context domain | Message IDs, prune, synthetic summaries, nudges, strategies. | `lib/messages/`, `lib/strategies/` |
| Compression domain | Validate agent summaries, update compression-block state. | `lib/compress/` |
| State / persistence | Maintain the current session cache and plugin-owned sidecars. | `lib/state/` |
| Prompts | Bundled defaults, user override resolution, runtime extensions. | `lib/prompts/` |
| Infrastructure | SDK calls, host permissions, auth, updater, logging, notifications. | `lib/host-permissions.ts`, `lib/auth.ts`, `lib/update.ts`, `lib/logger.ts`, `lib/ui/notification.ts` |

The architecture is pragmatic hook orchestration, not strict clean architecture. `lib/hooks.ts` directly coordinates state, messages, commands, prompts, and SDK calls. The diagram below is a one-screen view of the request path.

## Request path (one screen)

```
OpenCode request
   │
   ├─ experimental.chat.system.transform
   │      resolve model limit → skip subagent / internal-agent prompts
   │      → inject DCP system prompt (with extensions)
   │
   └─ experimental.chat.messages.transform
            strip hallucinations → cache system-prompt tokens
            → assign message refs → sync compression blocks
            → sync tool cache → build tool id list
            → prune → inject subagent-cache extensions
            → build priority map → inject compress nudges
            → inject message ids → apply pending manual trigger
            → strip stale metadata
            → return transformed messages

Model calls compress tool (range or message)
   → effectiveManualMode gate
   → ask host permission
   → fetchSessionMessages (canonical)
   → ensureSessionInitialized
   → assignMessageRefs
   → deduplicate + purgeErrors (manual-mode only)
   → buildSearchContext
   → resolveSelection per plan
   → validate boundary ids / monotonic / non-overlap
   → appendProtected* (user, prompt, tools)
   → allocate block / run ids
   → applyCompressionState
   → finalizeSession (net-compaction guard, recovery fade, save)
```

## Entrypoint

- `index.ts` exports the default plugin factory. The factory calls `getConfig(ctx)`, returns `{}` when disabled, otherwise builds one `Logger`, one `SessionState`, one `PromptStore`, and the host-permission snapshot, then returns the hook surface.
- The hook surface is: `experimental.chat.system.transform`, `experimental.chat.messages.transform`, `experimental.text.complete`, `command.execute.before`, `event`, `config`, and the custom `compress` tool.
- The experimental message hook is cast through `as any` to bridge OpenCode's experimental API surface.
- A separate TUI entrypoint (`tui.tsx`) builds a panel that reads from the sidecar; see `lib/tui/data.ts`. It is independent of the server plugin's in-memory state.

## State lifecycle

| Phase | What runs | Where |
|---|---|---|
| Process start | Build state, prompt store, host-permission snapshot. | `index.ts` |
| Per request | `system.transform` then `messages.transform`. | `lib/hooks.ts` |
| Session switch | `ensureSessionInitialized` resets and reloads from disk. | `lib/state/state.ts` |
| Compress call | `prepareSession` → per-block allocation → `finalizeSession`. | `lib/compress/pipeline.ts` |
| Save | `coalesceSaveSessionState` (one write per microtask per session). | `lib/state/persistence.ts` |
| Process exit | Pending writes flushed by Node's normal exit. | runtime |

## Cross-cutting contracts

| Contract | Source | Notes |
|---|---|---|
| Compress tool surface | `lib/compress/index.ts` | Re-exports `ToolContext`, `createCompressRangeTool`, `createCompressMessageTool`. |
| Prompt runtime surface | `lib/prompts/index.ts` | `renderSystemPrompt`, `PromptStore`, `RuntimePrompts`. |
| Persistence surface | `lib/state/index.ts` | All five state modules re-exported; no `PersistedSessionState` constructed outside tests and `loadAllSessionStats`. |
| Subagent cache key | `lib/subagents/cache-key.ts` | `buildSubAgentCacheKey` is the single source of truth. |
| Effective permission | `lib/host-permissions.ts`, `lib/compress-permission.ts` | Combines DCP config with OpenCode ordered rules. |
| Protected patterns | `lib/protected-patterns.ts` | Shared by strategies, sweep, and compress. |

## Cross-references

- Layer rules and rationale: `docs/DESIGN_PRINCIPLES.md`.
- Per-subsystem contracts: `docs/features/*.md`.
- Configuration layering: `docs/CONFIGURATION.md`.
- Storage: `docs/features/STATE_PERSISTENCE.md`.
