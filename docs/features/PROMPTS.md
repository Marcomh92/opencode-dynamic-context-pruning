# PROMPTS

Prompt layering, override behavior, and the runtime-only extensions. The system prompt and the six per-feature prompts are user-overridable; format schemas and computed extensions are not.

## Six overridable prompts

`PROMPT_KEYS` in `lib/prompts/store.ts`:

| Key                   | Bundled default                      | Source                |
| --------------------- | ------------------------------------ | --------------------- |
| `system`              | `lib/prompts/system.ts`              | `SYSTEM`              |
| `compress-range`      | `lib/prompts/compress-range.ts`      | `COMPRESS_RANGE`      |
| `compress-message`    | `lib/prompts/compress-message.ts`    | `COMPRESS_MESSAGE`    |
| `context-limit-nudge` | `lib/prompts/context-limit-nudge.ts` | `CONTEXT_LIMIT_NUDGE` |
| `turn-nudge`          | `lib/prompts/turn-nudge.ts`          | `TURN_NUDGE`          |
| `iteration-nudge`     | `lib/prompts/iteration-nudge.ts`     | `ITERATION_NUDGE`     |

## Override paths

`PromptPaths` defines four directories:

| Tier      | Path                                               |
| --------- | -------------------------------------------------- |
| global    | `$XDG_CONFIG_HOME/opencode/dcp-prompts/overrides/` |
| configDir | `$OPENCODE_CONFIG_DIR/dcp-prompts/overrides/`      |
| project   | `<projectRoot>/.opencode/dcp-prompts/overrides/`   |
| defaults  | built-in                                           |

Override precedence is project > configDir > global. Defaults are written to disk only when `experimental.customPrompts` is enabled.

## Runtime-only extensions (not overridable)

`lib/prompts/extensions/*` holds content the user cannot override:

| Extension                                      | Source                 | Appended by                                  |
| ---------------------------------------------- | ---------------------- | -------------------------------------------- |
| `MANUAL_MODE_SYSTEM_EXTENSION`                 | `extensions/system.ts` | `renderSystemPrompt` when `state.manualMode` |
| `SUBAGENT_SYSTEM_EXTENSION`                    | `extensions/system.ts` | `renderSystemPrompt` when `state.isSubAgent` |
| `buildProtectedToolsExtension(protectedTools)` | `extensions/system.ts` | `renderSystemPrompt` always                  |
| `RANGE_FORMAT_EXTENSION`                       | `extensions/tool.ts`   | tool description for range mode              |
| `MESSAGE_FORMAT_EXTENSION`                     | `extensions/tool.ts`   | tool description for message mode            |
| `buildCompressedBlockGuidance`                 | `extensions/nudge.ts`  | `appendGuidanceToDcpTag`                     |
| `renderMessagePriorityGuidance`                | `extensions/nudge.ts`  | `appendGuidanceToDcpTag`                     |

`RANGE_FORMAT_EXTENSION` and `MESSAGE_FORMAT_EXTENSION` are explicitly kept out of the override set so they cannot be modified independently of the tool's input validation. See `DPP-015`.

## System-prompt composition

`renderSystemPrompt(state, config, ctx)` (`lib/prompts/index.ts:4-29`):

1. Read `prompts.system` (override or default).
2. Strip `<manual>...</manual>` and `<subagent>...</subagent>` conditional tags via `stripConditionalTag` (for the `system` key only).
3. Append `protectedToolsExtension`.
4. Conditionally append `MANUAL_MODE_SYSTEM_EXTENSION` and `SUBAGENT_SYSTEM_EXTENSION`.
5. Trim, filter empty, join `\n\n`, collapse multiple blank lines, trim.

The hook wires `renderSystemPrompt` via `experimental.chat.system.transform` (`lib/hooks.ts:93-105`): appends to the last system prompt or pushes a new entry. `prompts.reload()` is called at the top of each hook handler so a user edit takes effect on the next request without restarting.

## `wrapRuntimePromptContent`

For `compress-range` / `compress-message`, `wrapRuntimePromptContent` returns the trimmed text as-is (no `<<dcp-system-reminder>>` wrap). The model treats the text as environment metadata. For non-compress keys, the helper calls `normalizeReminderPromptContent`.

## `getRuntimePrompts()`

Returns a shallow copy of the runtime prompts. Callers cannot mutate the internal state. The hook reads via `prompts.getRuntimePrompts()`.

## Conditional tag removal in overrides

An override for the `system` key may omit the `<manual>...</manual>` and `<subagent>...</subagent>` sections entirely. The plugin will not re-inject them unless `state.manualMode` / `state.isSubAgent` are true at render time. This is the only override path that can structurally change the system prompt.

## Style guidance for overrides

- Edit the bundled file in `lib/prompts/*.ts` to see the upstream text before writing an override.
- Keep the override minimal: change the section that matters; preserve the rest. The plugin's invariants are not encoded in the prompt text and will not survive a hostile override.
- Avoid changing tool-formatting language in the system prompt. Tool format is in `RANGE_FORMAT_EXTENSION` / `MESSAGE_FORMAT_EXTENSION` and is not overridable.
