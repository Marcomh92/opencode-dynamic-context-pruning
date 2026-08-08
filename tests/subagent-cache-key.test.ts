import assert from "node:assert/strict"
import test from "node:test"
import { buildSubAgentCacheKey } from "../lib/subagents/cache-key"

// ────────────────────────────────────────────────────────────────────────────
// BUG-015 + BUG-076 — buildSubAgentCacheKey separator collisions
//
// `buildSubAgentCacheKey(sessionId, callID)` joins with the literal `::`
// separator. Two distinct pairs that happen to concatenate to the same string
// collide in the cache Map. The proposed fix uses length-prefixed NUL-
// delimited encoding so the inputs are recoverable from the key alone.
//
// These tests assert the contract — they fail in the current code (because
// the separator collides) and pass after the fix (which is collision-proof
// and reversible).
// ────────────────────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────────────────────
// Scenario 1 — collision-free join. Pairs whose textual concatenations look
// the same must produce distinct keys.
// ────────────────────────────────────────────────────────────────────────────

test("BUG-015/BUG-076: 'a::b' + 'c' and 'a' + 'b::c' produce distinct keys", () => {
    const left = buildSubAgentCacheKey("a::b", "c")
    const right = buildSubAgentCacheKey("a", "b::c")

    assert.notEqual(
        left,
        right,
        `keys must differ for collision-prone inputs — got equal: ${JSON.stringify(left)}`,
    )
})

test("BUG-015/BUG-076: 'x' + 'y' and 'x' + 'y' (same inputs) produce identical keys", () => {
    const a = buildSubAgentCacheKey("x", "y")
    const b = buildSubAgentCacheKey("x", "y")

    assert.equal(
        a,
        b,
        "deterministic — same inputs must always produce the same key (otherwise the cache is useless)",
    )
})

test("BUG-015/BUG-076: every collision-prone pair in the suite produces distinct keys", () => {
    const collisionProne: Array<[string, string, string, string]> = [
        ["a::b", "c", "a", "b::c"],
        ["::", "", "", "::"],
        ["x", "y::z", "x::y", "z"],
        ["ses", "abc::def", "ses::abc", "def"],
        ["", "", "x", ""],
        ["::", "::", ":", ":::"],
    ]

    for (const [a1, b1, a2, b2] of collisionProne) {
        const key1 = buildSubAgentCacheKey(a1, b1)
        const key2 = buildSubAgentCacheKey(a2, b2)
        assert.notEqual(
            key1,
            key2,
            `collision-prone pair must produce distinct keys: ` +
                `((${JSON.stringify(a1)}, ${JSON.stringify(b1)})) vs ` +
                `((${JSON.stringify(a2)}, ${JSON.stringify(b2)})) — got ${JSON.stringify(key1)}`,
        )
    }
})

// ────────────────────────────────────────────────────────────────────────────
// Scenario 2 — round-trip / recoverability. The key must be parseable back
// into the original (sessionId, callID) pair. The fix uses NUL-delimited +
// length-prefixed encoding, so this is straightforward:
//   parseKey(`${len}\x00${a}\x00${len}\x00${b}`)
// ────────────────────────────────────────────────────────────────────────────

function parseCacheKey(key: string): [string, string] | null {
    // The fixed format is `${a.length}\x00${a}\x00${b.length}\x00${b}`.
    // Split on NUL; the four parts must parse consistently: parts[0] and
    // parts[2] are decimal length headers whose values equal the length of
    // the adjacent content parts (parts[1] and parts[3]). Any mismatch means
    // the key is not in the expected format and the inputs cannot be
    // recovered unambiguously.
    const parts = key.split("\x00")
    if (parts.length !== 4) return null
    const aLen = Number.parseInt(parts[0], 10)
    const bLen = Number.parseInt(parts[2], 10)
    if (!Number.isInteger(aLen) || !Number.isInteger(bLen)) return null
    if (aLen !== parts[1].length || bLen !== parts[3].length) return null
    return [parts[1], parts[3]]
}

test("BUG-015/BUG-076: simple key round-trips through parseCacheKey", () => {
    const sessionId = "ses-abc"
    const callID = "call-1"

    const key = buildSubAgentCacheKey(sessionId, callID)
    const parsed = parseCacheKey(key)

    assert.ok(parsed, `key must be parseable; got ${JSON.stringify(key)}`)
    assert.equal(parsed[0], sessionId)
    assert.equal(parsed[1], callID)
})

test("BUG-015/BUG-076: collision-prone keys round-trip correctly", () => {
    // The whole point of the fix: even collision-prone inputs must remain
    // recoverable from the key.
    const cases: Array<[string, string]> = [
        ["a::b", "c"],
        ["a", "b::c"],
        ["::", ""],
        ["", "::"],
        ["ses::foo", "call::bar"],
        [":::", "::"],
    ]

    for (const [sessionId, callID] of cases) {
        const key = buildSubAgentCacheKey(sessionId, callID)
        const parsed = parseCacheKey(key)
        assert.ok(
            parsed,
            `key must be parseable for collision-prone pair ` +
                `${JSON.stringify([sessionId, callID])} — got ${JSON.stringify(key)}`,
        )
        assert.equal(
            parsed[0],
            sessionId,
            `round-trip lost sessionId for ${JSON.stringify([sessionId, callID])}`,
        )
        assert.equal(
            parsed[1],
            callID,
            `round-trip lost callID for ${JSON.stringify([sessionId, callID])}`,
        )
    }
})

test("BUG-015/BUG-076: parseCacheKey rejects malformed legacy '::' keys", () => {
    // The legacy format `a::b` is exactly what the fix replaces. A parser
    // built for the new format must NOT mis-parse the old format — that
    // would let stale cache entries (or external readers) silently decode
    // a collision. The point of the fix is that the new format cannot be
    // confused with the old.
    const legacyKeys: string[] = ["a::b::c", "x::y", "ses-abc::call-1", "::"]

    for (const legacy of legacyKeys) {
        const parsed = parseCacheKey(legacy)
        assert.equal(
            parsed,
            null,
            `legacy '::' key must NOT decode into a (sessionId, callID) pair: ${JSON.stringify(legacy)}`,
        )
    }
})

// ────────────────────────────────────────────────────────────────────────────
// Scenario 3 — original inputs are recoverable from the key alone. This is
// the load-bearing property: the key format encodes enough information to
// reconstruct both inputs, so the cache is bidirectional-safe (a future
// write site that needs to validate its inputs cannot be fooled by a
// collision-prone pair).
// ────────────────────────────────────────────────────────────────────────────

test("BUG-015/BUG-076: original inputs are recoverable for the canonical ses-/call- shapes", () => {
    const canonicalPairs: Array<[string, string]> = [
        ["ses-abc123", "call-001"],
        ["ses-abc123", "call-002"],
        ["ses-xyz789", "call-001"],
        ["ses-abc123", "call-001-extra-stuff"],
    ]

    const seen = new Set<string>()
    for (const [sessionId, callID] of canonicalPairs) {
        const key = buildSubAgentCacheKey(sessionId, callID)
        assert.ok(
            !seen.has(key),
            `distinct canonical pairs must not collide: ${JSON.stringify([sessionId, callID])}`,
        )
        seen.add(key)

        const parsed = parseCacheKey(key)
        assert.ok(parsed, `canonical key must be parseable: ${key}`)
        assert.equal(parsed[0], sessionId)
        assert.equal(parsed[1], callID)
    }
})

// Logic Verified: collision-free separator; parseable key format; original inputs recoverable.
// Bugs Documented: BUG-015 (collision), BUG-076 (length-prefixed upgrade path).
// Fakes Updated: none — pure helper, no IO.
// Review Status: pending implementer round.
