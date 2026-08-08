// Regression tests for BUG-019 (clampers untested) and BUG-012 (validator
// claims "will be clamped to 1" but merge passes raw values through).
//
// Both bugs share the same fix surface — DPP-012 says fork-protocol fields are
// clamped, not rejected. BUG-019 is the unit-level contract on the three clamp
// helpers in `lib/config.ts`; BUG-012 is the load-time contract on the merge
// functions that apply `clampMin1` to the three keys the validator explicitly
// promises clamping for (`compress.nudgeFrequency`,
// `compress.iterationNudgeThreshold`, `strategies.purgeErrors.turns`).
//
// Tests MUST fail on the current code and pass after the implementer round
// (export clampers from lib/config.ts; apply clampMin1 in mergeCompress /
// mergeStrategies for the three promised keys).

import assert from "node:assert/strict"
import test from "node:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdirSync, writeFileSync } from "node:fs"
// KNOWN BUG (BUG-019): the three clamp helpers are NOT exported from
// `lib/config.ts` in the current code. The implementer round must export them
// so this test (and downstream merge tests) can pin their behaviour.
// See: known_issues/BUG-019-clampers-untested.md
import { clampRatio, clampMin1, clampNullOrNonNeg, getConfig } from "../lib/config"

// Per-test XDG sandbox so getConfig + the persistence layer never touch the
// host filesystem. Each test calls `withConfigFile(...)` with a fresh path
// containing process.pid and a random suffix to avoid collisions when the
// suite runs in parallel.
function withConfigFile(content: Record<string, unknown>): void {
    const tag = `clampers_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const xdgConfigHome = join(tmpdir(), `dcp-clampers-cfg-${tag}`)
    const xdgDataHome = join(tmpdir(), `dcp-clampers-data-${tag}`)
    const opencodeConfigDir = join(xdgConfigHome, "opencode")

    mkdirSync(opencodeConfigDir, { recursive: true })
    mkdirSync(xdgDataHome, { recursive: true })

    process.env.XDG_CONFIG_HOME = xdgConfigHome
    process.env.XDG_DATA_HOME = xdgDataHome

    writeFileSync(join(opencodeConfigDir, "dcp.jsonc"), JSON.stringify(content))
}

// ────────────────────────────────────────────────────────────────────────────
// BUG-019 — clampRatio
// ────────────────────────────────────────────────────────────────────────────

test("BUG-019: clampRatio preserves in-range values", () => {
    assert.equal(clampRatio(0.5), 0.5)
    assert.equal(clampRatio(1), 1)
    assert.equal(clampRatio(0.001), 0.001)
})

test("BUG-019: clampRatio returns 0.7 for NaN", () => {
    assert.equal(clampRatio(NaN), 0.7)
})

test("BUG-019: clampRatio returns 0.7 for +/-Infinity", () => {
    assert.equal(clampRatio(Infinity), 0.7)
    assert.equal(clampRatio(-Infinity), 0.7)
})

test("BUG-019: clampRatio clamps zero and negatives to 0.7", () => {
    assert.equal(clampRatio(0), 0.7)
    assert.equal(clampRatio(-0.1), 0.7)
    assert.equal(clampRatio(-1), 0.7)
    assert.equal(clampRatio(-100), 0.7)
})

test("BUG-019: clampRatio clamps above-1 to 1", () => {
    assert.equal(clampRatio(1.0001), 1)
    assert.equal(clampRatio(2), 1)
    assert.equal(clampRatio(100), 1)
})

// ────────────────────────────────────────────────────────────────────────────
// BUG-019 — clampMin1
// ────────────────────────────────────────────────────────────────────────────

test("BUG-019: clampMin1 preserves values >= 1", () => {
    assert.equal(clampMin1(1), 1)
    assert.equal(clampMin1(2), 2)
    assert.equal(clampMin1(15), 15)
})

test("BUG-019: clampMin1 clamps zero and negatives to 1", () => {
    assert.equal(clampMin1(0), 1)
    assert.equal(clampMin1(-1), 1)
    assert.equal(clampMin1(-100), 1)
    assert.equal(clampMin1(0.5), 1)
})

test("BUG-019: clampMin1 returns 1 for NaN and Infinity", () => {
    assert.equal(clampMin1(NaN), 1)
    assert.equal(clampMin1(Infinity), 1)
})

// ────────────────────────────────────────────────────────────────────────────
// BUG-019 — clampNullOrNonNeg
// ────────────────────────────────────────────────────────────────────────────

test("BUG-019: clampNullOrNonNeg returns null for null", () => {
    assert.equal(clampNullOrNonNeg(null), null)
})

test("BUG-019: clampNullOrNonNeg returns null for undefined", () => {
    assert.equal(clampNullOrNonNeg(undefined), null)
})

test("BUG-019: clampNullOrNonNeg preserves non-negative numbers", () => {
    assert.equal(clampNullOrNonNeg(0), 0)
    assert.equal(clampNullOrNonNeg(7), 7)
    assert.equal(clampNullOrNonNeg(0.5), 0.5)
})

test("BUG-019: clampNullOrNonNeg clamps negatives to 0", () => {
    assert.equal(clampNullOrNonNeg(-1), 0)
    assert.equal(clampNullOrNonNeg(-100), 0)
})

test("BUG-019: clampNullOrNonNeg returns null for NaN and Infinity", () => {
    assert.equal(clampNullOrNonNeg(NaN), null)
    assert.equal(clampNullOrNonNeg(Infinity), null)
})

// ────────────────────────────────────────────────────────────────────────────
// BUG-012 — load-time clampMin1 enforcement
//
// `validateConfigTypes` in lib/config.ts emits a user-visible toast claiming
// `(will be clamped to 1)` for three keys. In the current code
// `mergeCompress` / `mergeStrategies` use plain `??` fallback and never
// clamp, so the toast is a lie — the bad value flows through. The implementer
// round must apply `clampMin1` at load time for these three keys.
// ────────────────────────────────────────────────────────────────────────────

test("BUG-012: compress.nudgeFrequency = 0 is clamped to 1 at load time", () => {
    withConfigFile({ compress: { nudgeFrequency: 0 } })

    const config = getConfig({
        directory: tmpdir(),
        client: {},
    } as any)

    // After fix: merge applies clampMin1 → 1.
    // Current: ?? fallback returns 0 → toast was a lie.
    assert.equal(config.compress.nudgeFrequency, 1)
})

test("BUG-012: compress.nudgeFrequency = -5 is clamped to 1 at load time", () => {
    withConfigFile({ compress: { nudgeFrequency: -5 } })

    const config = getConfig({
        directory: tmpdir(),
        client: {},
    } as any)

    assert.equal(config.compress.nudgeFrequency, 1)
})

test("BUG-012: compress.iterationNudgeThreshold = 0 is clamped to 1 at load time", () => {
    withConfigFile({ compress: { iterationNudgeThreshold: 0 } })

    const config = getConfig({
        directory: tmpdir(),
        client: {},
    } as any)

    // After fix: merge applies clampMin1 → 1.
    // Current: ?? fallback returns 0 → "always nudge".
    assert.equal(config.compress.iterationNudgeThreshold, 1)
})

test("BUG-012: compress.iterationNudgeThreshold = -1 is clamped to 1 at load time", () => {
    withConfigFile({ compress: { iterationNudgeThreshold: -1 } })

    const config = getConfig({
        directory: tmpdir(),
        client: {},
    } as any)

    assert.equal(config.compress.iterationNudgeThreshold, 1)
})

test("BUG-012: strategies.purgeErrors.turns = 0 is clamped to 1 at load time", () => {
    withConfigFile({ strategies: { purgeErrors: { turns: 0 } } })

    const config = getConfig({
        directory: tmpdir(),
        client: {},
    } as any)

    // After fix: merge applies clampMin1 → 1.
    // Current: ?? fallback returns 0 → "purge every error instantly"
    // (note: lib/strategies/purge-errors.ts:46 has a defensive Math.max(1,...)
    // for this key, but the other two keys do NOT — the inconsistency is part
    // of BUG-012's smell).
    assert.equal(config.strategies.purgeErrors.turns, 1)
})

test("BUG-012: strategies.purgeErrors.turns = -3 is clamped to 1 at load time", () => {
    withConfigFile({ strategies: { purgeErrors: { turns: -3 } } })

    const config = getConfig({
        directory: tmpdir(),
        client: {},
    } as any)

    assert.equal(config.strategies.purgeErrors.turns, 1)
})

test("BUG-012: in-range values pass through untouched by clamp", () => {
    // Sanity: the clamp must not damage valid values.
    withConfigFile({
        compress: { nudgeFrequency: 7, iterationNudgeThreshold: 20 },
        strategies: { purgeErrors: { turns: 5 } },
    })

    const config = getConfig({
        directory: tmpdir(),
        client: {},
    } as any)

    assert.equal(config.compress.nudgeFrequency, 7)
    assert.equal(config.compress.iterationNudgeThreshold, 20)
    assert.equal(config.strategies.purgeErrors.turns, 5)
})

// Logic Verified: clamp helper edge cases (NaN, Infinity, out-of-range, null,
// negative) and load-time clamping for the three keys the validator promises
// (nudgeFrequency, iterationNudgeThreshold, purgeErrors.turns).
// Bugs Documented: BUG-019 (clampers not exported / untested),
//                  BUG-012 (validator toast lies; merge passes bad values).
// Fakes Updated: none.
// Review Status: pending implementer round.
// Logic Verified: clampRatio / clampMin1 / clampNullOrNonNeg clamp fork-protocol keys to safe ranges and tolerate NaN/Infinity.
// Bugs Documented: BUG-019, BUG-012.
// Fakes Updated: none
// Review Status: pending independent review.
