# ADR 001 — v2 fork-protocol layer

Status: Accepted (in this fork).

## Context

The upstream DCP plugin prunes tool outputs and lets the model call a `compress` tool to persist summarized blocks. The model is the summarizer; the plugin is the validator. Two issues surfaced under real use:

1. **Autonomous compressions that are not actually compacting.** A compress call that produces a summary longer than the content it removed wastes tokens and burns the cache prefix without benefit. Repeated calls in this state silently degrade session quality.
2. **No user-controlled lockdown.** When a user wants the plugin to stop generating new compression blocks, the only path is to disable the plugin entirely. A per-session "stop generating new blocks" flag was needed.

The fork adds a small state machine on top of the upstream compress protocol.

## Decision

Add four fork-protocol fields to `CompressConfig`:

| Field | Purpose |
|---|---|
| `maxCompactionRatio` | Lower bound for `summaryTokens / removedTokens` to count a run as "compacting". |
| `maxContextLimitRecovery` | Number of consecutive non-compacting runs before `recoveryForced` is set. |
| `recoveryFadeWindow` | Number of consecutive successful manual compresses required to clear `recoveryForced`. |
| `forkSchemaVersion` | Schema version for the persisted state file. Bump on shape change. |
| `stateMaxAgeDays` | Optional wall-clock age gate on persisted state. |

Add two boolean flags to `SessionState`:

| Flag | Set by | Cleared by |
|---|---|---|
| `userForced` | `/dcp manual on`; successful manual compress | `/dcp manual off`; successful manual compress |
| `recoveryForced` | `nonCompactingRunCount ≥ maxContextLimitRecovery` | session restart; `recoveryFadeCounter ≥ recoveryFadeWindow` after a manual compress |

Derive `manualMode` as a cached value of `userForced || recoveryForced`. Add a transient `"compress-pending"` flag set only by the `/dcp-compress` slash command handler so the slash command can bypass the gate.

Clamp the four numeric fields. Reject nothing.

## Consequences

Positive:

- Repeated non-compacting autonomous compresses trip the recovery gate and stop calling the tool without disabling the plugin.
- The user has a single-command lockdown (`/dcp manual on`) that does not require a config change.
- The recovery fade window gives the user a clean way to clear the recovery state without restarting.
- Clamping means a misconfigured user still gets a working plugin.

Negative:

- The cached `manualMode` adds a third value (`"compress-pending"`) that must be preserved by `#590`-era readers.
- The fork-protocol layer adds four fields to `dcp.schema.json` and the docs that users must learn.
- Autonomous compresses no longer clear `userForced`. A user who set `manual on` and got an autonomous compress will not see the flag clear; this is deliberate (manual intent is preserved).
- `recoveryForced` and the streak counters are intentionally not restored from v1 state files. A session reload during recovery clears the flag.

## Compliance

| Rule | Where enforced |
|---|---|
| Net-compaction guard | `lib/compress/pipeline.ts:142-172` |
| Recovery fade counter | `lib/compress/pipeline.ts:178-189` |
| `userForced` clearing | `lib/commands/manual.ts:64-75`, `lib/compress/pipeline.ts:132-134` |
| Clamping | `clampRatio` / `clampMin1` / `clampNullOrNonNeg` in `lib/config.ts` |
| Schema gate | `lib/state/persistence.ts:312-322` |
| Age gate | `lib/state/persistence.ts:327-343` |
| `compress-pending` single writer | `lib/commands/manual.ts` |

## Related

- `MY_CHANGELOG.md` M2 entry.
- `MY_LOOSE_COMPRESSION.md` (fork design intent for these fields).
- `docs/features/COMPRESSION.md` invariants INV-5 through INV-8.
