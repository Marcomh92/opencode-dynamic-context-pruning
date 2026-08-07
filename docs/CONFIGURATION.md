# CONFIGURATION

Configuration layering, defaults, and override semantics. The user-facing config is `dcp.jsonc`. The plugin's source of truth for the schema is `dcp.schema.json` and `VALID_CONFIG_KEYS` in `lib/config.ts`.

## Layered merge

The plugin reads JSONC config from up to three sources and merges them in this order:

1. Built-in defaults (`lib/config.ts`).
2. Global config (`$XDG_CONFIG_HOME/opencode/dcp.jsonc`).
3. `$OPENCODE_CONFIG_DIR` config (e.g. `$XDG_CONFIG_HOME/opencode`).
4. Nearest project `.opencode` config (walking up from the working directory).

`.jsonc` wins over `.json` at the same layer. JSONC allows comments and trailing commas.

**Rationale.** Users can override per-project without forking the global file. Layering is independent of OpenCode's own config layering.

## Replace vs additive semantics

| Key | Semantics | Rationale |
|---|---|---|
| `compress.protectedTools` | Replace per layer. `[]` means nothing protected. | An explicit `[]` is the user's choice; default-merge would surprise. |
| `compress.protectedFilePatterns` | Additive per layer. | Pattern lists compose naturally; an empty list is harmless. |
| Other arrays (e.g. `commands.something`) | See `mergeCompress` / `mergeStrategies` / `mergeCommands` ponytail comments in `lib/config.ts`. | Per-key; the comments are the spec. |

The replace rule is the v2 fork's hard rule (`DPP-007`).

## Validation

- Unknown keys and type errors trigger a delayed toast. The layer is still merged.
- Fork-protocol fields are clamped to safe ranges via `clampRatio` / `clampMin1` / `clampNullOrNonNeg`. Bad values fall back rather than fail (`DPP-012`).
- `dcp.schema.json` is the JSON Schema mirror of `PluginConfig`. Editors can use it for autocompletion.

## Runtime defaults

| Key | Default | Source |
|---|---|---|
| `compress.mode` | `range` | `lib/config.ts` runtime defaults |
| `compress.permission` | `allow` | `lib/config.ts` runtime defaults |
| `compress.protectedTools` | `[]` | v2 fork; no default |
| `autoUpdate` | `false` | `lib/config.ts` runtime defaults (note: `README.md` and `dcp.schema.json` still record `true`; this is a known docs drift) |
| `state.maxAgeDays` | `null` (disabled) | `lib/config.ts` |

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
