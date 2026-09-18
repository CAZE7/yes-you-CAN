import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "vitest";
import { sha256Hex } from "./hash.js";

/**
 * The published examples of the standard itself (FIPS 180-4 §B.1/§B.2/§B.3). A
 * known answer from the specification is the one reference that does not depend on
 * the platform this test runs on.
 */
const FIPS_EXAMPLES: ReadonlyArray<{ input: string; digest: string }> = [
  {
    input: "",
    digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  },
  {
    input: "abc",
    digest: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  },
  {
    // 56 bytes: the message plus the terminator does not fit in its last block,
    // so the padding opens a second one (§4.1).
    input: "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
    digest: "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
  },
];

/** Deterministic pseudo-random bytes — a fixed seed, so a failure is reproducible. */
function bytes(length: number, seed = 1): Uint8Array {
  let state = seed;
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    out[i] = state & 0xff;
  }
  return out;
}

/** The reference implementation — the same function a stored manifest came from. */
function nodeDigest(input: Uint8Array | string): string {
  const hash = createHash("sha256");
  if (typeof input === "string") hash.update(input, "utf8");
  else hash.update(input);
  return hash.digest("hex");
}

describe("sha256Hex", () => {
  test("reproduces the examples published with the standard", () => {
    for (const { input, digest } of FIPS_EXAMPLES) assert.equal(sha256Hex(input), digest);
  });

  test("agrees with node:crypto for every length across the block boundaries", () => {
    // 0..200 walks the two padding shapes (≤55 bytes → one pad block, ≥56 → two)
    // and three whole blocks; the exact multiples of 64 are where an off-by-one in
    // the pad length shows up as a different digest.
    for (let length = 0; length <= 200; length += 1) {
      const input = bytes(length, length + 7);
      assert.equal(sha256Hex(input), nodeDigest(input), `length ${length}`);
    }
  });

  test("agrees with node:crypto on a multi-kibibyte message", () => {
    // 100 KiB is 1600 full blocks for a zero-padded tail — long enough to prove the
    // round-state and the reused scratch words carry over correctly between blocks.
    const input = bytes(102_400, 99);
    assert.equal(sha256Hex(input), nodeDigest(input));
    assert.equal(sha256Hex(input), nodeDigest(input), "the same input twice must not drift");
  });

  test("reads a string as UTF-8, exactly as update with the utf8 encoding does", () => {
    // The trace digest carries `°` and `…`, and an emoji reaches the byte length
    // through a surrogate pair — the two cases a charCodeAt loop gets wrong.
    for (const text of ["Kühlmittel 90 °C", "45…55 km/h — Kühlung", "🔧", "a\0b\nc"]) {
      assert.equal(sha256Hex(text), nodeDigest(text), text);
    }
  });

  test("hashes the bytes and their hex-free string form to one value", () => {
    const text = "10 01 62 F1 90";
    assert.equal(sha256Hex(text), sha256Hex(new TextEncoder().encode(text)));
  });

  test("separates inputs that only the length field can tell apart", () => {
    // "ab" and "ab\0" share the visible bytes; without the bit length they would
    // hash to the same value (§5.1.1).
    assert.notEqual(sha256Hex("ab"), sha256Hex("ab\0"));
    assert.notEqual(sha256Hex("a"), sha256Hex("aa"));
  });
});
