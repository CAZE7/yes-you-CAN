import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fc from "fast-check";
import { describe, test } from "vitest";
import { bytesEqual } from "./bytes.js";
import { sha256, sha256Hex, sha256HexUtf8 } from "./sha256.js";

/** The oracle this module replaces in portable layers — spec-only by design. */
function nodeHex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function nodeHexUtf8(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

describe("sha256", () => {
  test("matches the FIPS 180-4 test vectors", () => {
    const vectors: Array<[string, string]> = [
      ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
      ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
      [
        "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
        "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
      ],
      [
        "abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu",
        "cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1",
      ],
      ["a".repeat(1_000_000), "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"],
    ];
    for (const [input, expected] of vectors) {
      assert.equal(sha256HexUtf8(input), expected);
    }
  });

  test("returns the 32 raw digest bytes, not just their hex form", () => {
    const digest = sha256(Uint8Array.from([0x61, 0x62, 0x63]));
    assert.equal(digest.length, 32);
    assert.equal(
      bytesEqual(digest, Uint8Array.from(createHash("sha256").update("abc").digest())),
      true,
    );
  });

  test("encodes every UTF-8 width like the platform encoder, including lone surrogates", () => {
    // 1-byte, 2-byte, 3-byte, 4-byte, lone high surrogate, lone low surrogate.
    for (const text of ["can0", "Größe", "€11,5", "𝄞", "a\ud800b", "a\udc00b"]) {
      assert.equal(sha256HexUtf8(text), nodeHexUtf8(text));
    }
  });

  test("agrees with node:crypto on arbitrary byte strings, including padding edges", () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 0, maxLength: 300 }),
        fc.integer({ min: 0, max: 6 }),
        (prefix, edge) => {
          // 55/56/57, 63/64/65 and 119 bytes straddle padding boundaries.
          const edgeLengths = [55, 56, 57, 63, 64, 65, 119];
          const extra = new Uint8Array(edgeLengths[edge] ?? 0).fill(0x61);
          const data = Uint8Array.from([...prefix.slice(0, 8), ...extra]);
          assert.equal(sha256Hex(data), nodeHex(data));
        },
      ),
    );
  });

  test("agrees with node:crypto on arbitrary text", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 120 }), (text) => {
        assert.equal(sha256HexUtf8(text), nodeHexUtf8(text));
      }),
    );
  });
});
