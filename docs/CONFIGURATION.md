# CONFIGURATION

Configuration layering, defaults, and override semantics. The user-facing config is `dcp.jsonc`. The plugin's source of truth for the schema is `dcp.schema.json` and `VALID_CONFIG_KEYS` in `lib/config.ts`.

## Layered merge

The plugin reads JSONC config from up to four sources and merges them in this order:

1. Built-in defaults (`lib/config.ts`).
2. Global config (`$XDG_CONFIG_HOME/opencode/dcp.jsonc`).
3. `$OPENCODE_CONFIG_DIR` config (e.g. `$XDG_CONFIG_HOME/opencode`).
4. Nearest project `.opencode` config (walking up from the working directory).

`.jsonc` wins over `.json` at the same layer. JSONC allows comments and trailing commas.

**Rationale.** Users can override per-project without forking the global file. Layering is independent of OpenCode's own config layering.

## Replace vs additive semantics

| Key                                      | Semantics                                                                                       | Rationale                                                             |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `compress.protectedTools`                | Replace per layer. `[]` means nothing protected.                                                | An explicit `[]` is the user's choice; default-merge would surprise.  |
| `compress.stripPatterns`                 | Replace per layer. `[]` means strip nothing.                                                    | Same rule as `protectedTools`: an explicit `[]` is the user's choice. |
| `compress.protectedFilePatterns`         | Additive per layer.                                                                             | Pattern lists compose naturally; an empty list is harmless.           |
| Other arrays (e.g. `commands.something`) | See `mergeCompress` / `mergeStrategies` / `mergeCommands` ponytail comments in `lib/config.ts`. | Per-key; the comments are the spec.                                   |

The replace rule is the v2 fork's hard rule (`DPP-007`).

## Pattern matching (case-sensitivity)

`compress.protectedFilePatterns` and the tool-name patterns inside `compress.protectedTools` are evaluated by the custom glob matcher in `lib/protected-patterns.ts`. The matcher is **case-sensitive on every platform** — the underlying regex does not use the `i` flag. To match case-insensitively, list the patterns explicitly (e.g. `["*.md", "*.MD"]` for both `.md` and `.MD` suffixes).

Note: on case-insensitive filesystems (Windows, default macOS HFS+/APFS), the _file system_ folds case, but the matcher does not. A pattern like `README.md` matches the literal string `README.md`, not `readme.md`.

## Strip patterns (block-name vs literal substring)

`compress.stripPatterns` (`lib/messages/strip-patterns.ts`) is evaluated by `compileStripPattern`, with two modes per entry:

| Entry shape           | Meaning                                                                                                                | Use                                                                                                                                            |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `<name>` (single tag) | Matches the entire `<name>...</name>` block including content (lazy match). Regex special chars in `name` are escaped. | Strip synthetic blocks injected by third-party plugins (e.g. `<available-skills>` from `opencode-agent-delegation` / `opencode-agent-skills`). |
| Any other string      | Literal substring match. All regex special chars are escaped.                                                          | Strip arbitrary markers (e.g. `[TODO]`, `End of section`).                                                                                     |

The strip runs at the protected-text injection point in `lib/compress/protected-content.ts` (`appendProtectedUserMessages` and `appendProtectedPromptInfo`). It is applied to the verbatim user-message dump of a compression summary only — the agent still sees the original block in its live conversation. Entries are hard-capped at 32 by `validateConfigTypes`; see the `lib/config.ts:541-546` ponytail for the per-fire cost rationale.

## Validation

- Unknown keys and type errors trigger a delayed toast. The layer is still merged.
- Fork-protocol fields are clamped to safe ranges via `clampRatio` / `clampMin1` / `clampNullOrNonNeg`. Bad values fall back rather than fail (`DPP-012`).
- `dcp.schema.json` is the JSON Schema mirror of `PluginConfig`. Editors can use it for autocompletion.

## Runtime defaults

| Key                           | Default           | Source                                             |
| ----------------------------- | ----------------- | -------------------------------------------------- |
| `compress.mode`               | `range`           | `lib/config.ts` runtime defaults                   |
| `compress.permission`         | `allow`           | `lib/config.ts` runtime defaults                   |
| `compress.protectedTools`     | `[]`              | v2 fork; no default                                |
| `compress.stripPatterns`      | `[]`              | `lib/config.ts:941`; no behavior change on default |
| `autoUpdate`                  | `false`           | `lib/config.ts` runtime defaults                   |
| `compress.stateMaxAgeDays`    | `null` (disabled) | `lib/config.ts`                                    |
| `compress.stateRetentionDays` | `7`               | `lib/config.ts`                                    |

`compress.stateRetentionDays` is the wall-clock retention for files in the DCP storage dir. Days before state files are excluded from the fork candidate scan (mtime pre-filter, `lib/state/inherit.ts:365-398`) and deleted by the sweep on save (`lib/state/persistence.ts:101-155`). Default `7`. Values below 1 (including `0`, negative, and fractional) collapse to `null` (disabled) via `clampStateRetentionDays` (`lib/config.ts:1130-1135`) — the helper enforces this so a user typo of `-1` or `0` falls back to disabled instead of silently deleting every state file. Distinct from `compress.stateMaxAgeDays` (load gate, also disabled at `null`); `stateRetentionDays` is the sweep + scan threshold (file deletion); `stateMaxAgeDays` is the load-time rejection threshold (no file deletion). BUG-092.

## Override paths (prompts)

`lib/prompts/store.ts` defines four `PromptPaths`:

- global: `$XDG_CONFIG_HOME/opencode/dcp-prompts/overrides/`
- configDir: `$OPENCODE_CONFIG_DIR/dcp-prompts/overrides/`
- project: `<projectRoot>/.opencode/dcp-prompts/overrides/`
- defaults (built-in)

Override precedence is project > configDir > global. Defaults are written to disk only when `experimental.customPrompts` is enabled.

The six overridable keys are listed in `docs/features/PROMPTS.md`.

## Host permission baseline

`opencode.json` is OpenCode's permission system. The plugin's `compress.permission` is resolved against the host's rules in this order:

1. Plugin's `dcp.jsonc` declaration (or runtime default `allow`).
2. OpenCode ordered rules: argument-specific, agent-specific, global, wildcard.
3. Later rules win. Explicit agent `allow` can override a global wildcard `deny`.
4. Argument-specific `deny` does not disable the entire tool; only the matching argument is rejected.

If the host's `opencode.json` declares `*:deny` (or the host's per-agent deny targets the plugin), the plugin flips `compress.permission = "deny"` and removes `compress` from `experimental.primary_tools`. The user can re-allow with an explicit `compress: allow` in `dcp.jsonc`. See `DPP-010`.

## Where to look

- Field list and types: `dcp.schema.json` and `VALID_CONFIG_KEYS` in `lib/config.ts`.
- Merge functions: `mergeCompress` / `mergeStrategies` / `mergeCommands` in `lib/config.ts`.
- Validation: `lib/config.ts` validator functions; each clamp is named.
- Prompt overrides: `docs/features/PROMPTS.md`.
