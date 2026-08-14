# OPENCODE_INTEGRATION

How the plugin plugs into OpenCode. OpenCode's plugin contract is the boundary; everything inside that boundary is the plugin's responsibility.

## Hook surface

The plugin returns this hook set from `index.ts`:

| Hook                                   | Purpose                                           |
| -------------------------------------- | ------------------------------------------------- |
| `experimental.chat.system.transform`   | Inject or replace the system prompt.              |
| `experimental.chat.messages.transform` | Transform the message stream before the LLM call. |
| `experimental.text.complete`           | Text completion hook.                             |
| `command.execute.before`               | Slash command dispatch.                           |
| `event`                                | Subscribe to OpenCode events.                     |
| `config`                               | Register slash commands and tool permissions.     |

The experimental message hook is cast through `as any` to bridge the experimental API. The cast is the seam; the upstream OpenCode API is not yet stable.

## Tool registration

| Tool                      | Registered when                                                    | Source                                      |
| ------------------------- | ------------------------------------------------------------------ | ------------------------------------------- |
| `compress` (range mode)   | `compress.mode !== "message"` and `compress.permission !== "deny"` | `index.ts:84-86`, `lib/compress/range.ts`   |
| `compress` (message mode) | `compress.mode === "message"` and `compress.permission !== "deny"` | `index.ts:84-86`, `lib/compress/message.ts` |

Only one of the two tool variants is registered per process. The mode is set in `dcp.jsonc`.

## Slash commands

| Command         | Registered when                                      | Source                                       |
| --------------- | ---------------------------------------------------- | -------------------------------------------- |
| `/dcp-compress` | `commands.enabled && compress.permission !== "deny"` | `index.ts:110-113`, `lib/commands/manual.ts` |
| `/dcp`          | same                                                 | `index.ts:114-117`, `lib/commands/index.ts`  |

`/dcp` subcommands: `stats`, `context`, `sweep [N]`, `manual [on|off]`, `decompress <n>`, `recompress <n>`, `help`.

## Permissions

Effective permission is the combination of DCP config and OpenCode host permissions. See `lib/host-permissions.ts` and `lib/compress-permission.ts`. Resolution order:

1. Plugin's `dcp.jsonc` `compress.permission`.
2. OpenCode ordered rules (argument, agent, global, wildcard).
3. Later rules win. Explicit agent `allow` can override a global wildcard `deny`.
4. Argument-specific `deny` does not disable the tool; only the matching argument is rejected.

With `experimental.allowSubAgents = false`, `compress` is added to OpenCode's `experimental.primary_tools`. This forces subagent sessions to use the parent session's tool registry.

## Subagent and internal-agent gates

| Gate              | Where                                           | Why                                                                              |
| ----------------- | ----------------------------------------------- | -------------------------------------------------------------------------------- |
| Subagent sessions | `lib/hooks.ts:75-77, 138-140`                   | DCP skips subagent sessions unless `experimental.allowSubAgents = true`.         |
| Internal agents   | `isInternalAgentSystem` in `lib/hooks.ts:43-58` | Title generators, summarizers, and similar OpenCode-internal agents are skipped. |

Subagent detection is one SDK call in `ensureSessionInitialized`; the result is cached on `state.isSubAgent`. Errors fall through to `false` (treats unreachable subagent lookup as primary session).

## Third-party plugin output

Third-party plugins (e.g. `opencode-agent-delegation`, `opencode-agent-skills`) can inject synthetic user-message bodies containing tag-shaped blocks like `<available-skills>...</available-skills>`. Two layers of protection apply:

- **Flag-level exclusion (BUG-094).** `isIgnoredUserMessage` recognises `part.synthetic: true` as a skip signal, so synthetic-flagged messages are excluded from `isProtectedUserMessage` and do not appear verbatim in compression summaries under `compress.protectUserMessages: true`.
- **Content-level strip (`compress.stripPatterns`).** A user-listed tag pattern (e.g. `<available-skills>`) is removed from `part.text` / completed `state.output` at pipeline step 2, before the LLM call. This guarantees the synthetic block never reaches the model context — and therefore cannot reach a compression summary via any other path (range mode, message mode, or unprotected mode).

The two layers are independent and complementary. The flag-level fix is the safe default; the content-level strip is the explicit user opt-in. See `docs/features/PRUNING.md` INV-P7 and `docs/CONFIGURATION.md` "Strip patterns".

## TUI entrypoint

`tui.tsx` is a separate entrypoint that ships with the package. The TUI:

- runs only under Bun;
- dynamically loads OpenTUI dependencies;
- reconstructs state from the sidecar at startup;
- registers the DCP panel command.

Desktop's Node sidecar exits before importing OpenTUI, so the TUI never blocks the host process. The TUI is a reader, not a writer; state changes go through the server plugin.

## Notifications

Chat notifications append an ignored record to the session via `client.session.prompt({ noReply: true, parts: [{ ignored: true, ... }] })`. Toast and off modes do not. The record is ignored by the transform.

## What is out of scope

- Modifications to OpenCode's session storage. The plugin is a transform layer.
- End-user documentation. The README is end-facing; see `README.md`.
- Plugin authoring for other host systems. OpenCode is the only target.
