import assert from "node:assert/strict";
import { test } from "vitest";
import {
  ascii,
  bytesEqual,
  concatBytes,
  fromHex,
  readBitsBE,
  readFloat32BE,
  readIntBE,
  readUintBE,
  toHex,
  u16be,
  u32be,
  writeU16be,
  writeU32be,
} from "./bytes.js";

test("toHex formats uppercase with separator", () => {
  assert.equal(toHex(new Uint8Array([0x02, 0x10, 0x03])), "02 10 03");
  assert.equal(toHex(new Uint8Array([0x02, 0x10]), ""), "0210");
});

test("fromHex tolerates 0x prefixes and separators", () => {
  assert.deepEqual(fromHex("0x7D 0xF0 02 10 03"), new Uint8Array([0x7d, 0xf0, 0x02, 0x10, 0x03]));
  assert.deepEqual(fromHex("7D.F0"), new Uint8Array([0x7d, 0xf0]));
  assert.deepEqual(fromHex("0x07e8"), new Uint8Array([0x07, 0xe8]));
});

test("fromHex rejects odd digit counts", () => {
  assert.throws(() => fromHex("ABC"));
});

test("big-endian unsigned/signed reads", () => {
  const data = fromHex("01 00 FF 80 00 0A");
  assert.equal(readUintBE(data, 0, 2), 256);
  assert.equal(readIntBE(data, 2, 2), -128);
  assert.equal(readUintBE(data, 2, 2), 0xff80);
  assert.equal(readUintBE(data, 4, 2), 10);
});

test("readBitsBE reads MSB-first bit ranges", () => {
  // 0b10110100 = 0xB4
  const data = new Uint8Array([0xb4]);
  assert.equal(readBitsBE(data, 0, 2), 0b10);
  assert.equal(readBitsBE(data, 2, 4), 0b1101);
  assert.equal(readBitsBE(data, 7, 1), 0);
});

test("float32 big-endian decode", () => {
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, 1.5, false);
  assert.equal(readFloat32BE(new Uint8Array(view.buffer)), 1.5);
});

test("ascii stops at NUL and trims", () => {
  assert.equal(ascii(new Uint8Array([0x57, 0x56, 0x57, 0x00, 0x20])), "WVW");
});

test("concatBytes concatenates without extra allocation semantics", () => {
  assert.deepEqual(
    concatBytes([new Uint8Array([1, 2]), new Uint8Array([3])]),
    new Uint8Array([1, 2, 3]),
  );
  assert.deepEqual(concatBytes([]), new Uint8Array([]));
});

/* ------------------------------------------------------------------ *
 * Property-based round trips (fast-check, testing standards).        *
 * decode(encode(x)) === x — and its inverse — over generated input.  *
 * ------------------------------------------------------------------ */

import fc from "fast-check";

test("property: fromHex(toHex(bytes)) is the identity", () => {
  fc.assert(
    fc.property(fc.uint8Array({ minLength: 0, maxLength: 64 }), (bytes) => {
      assert.deepEqual(Array.from(fromHex(toHex(bytes))), Array.from(bytes));
    }),
    { numRuns: 500 },
  );
});

test("property: u16be/writeU16be round trip over the full range", () => {
  fc.assert(
    fc.property(fc.nat({ max: 0xffff }), (value) => {
      assert.equal(u16be(writeU16be(value)), value);
    }),
  );
});

test("property: u32be/writeU32be round trip over the full range", () => {
  fc.assert(
    fc.property(fc.nat({ max: 0xffffffff }), (value) => {
      assert.equal(u32be(writeU32be(value)), value);
    }),
  );
});

test("property: readUintBE reads back big-endian writes of any length 1..6", () => {
  fc.assert(
    fc.property(fc.nat({ max: 0xffffffff }), fc.nat({ max: 5 }), (value, lengthIndex) => {
      const length = lengthIndex + 1;
      const bytes = new Uint8Array(length);
      let remaining = value;
      for (let i = length - 1; i >= 0; i--) {
        bytes[i] = remaining & 0xff;
        remaining = Math.floor(remaining / 256);
      }
      const read = readUintBE(bytes, 0, length);
      assert.ok(read <= value, "read must not exceed the written value");
      if (value < 256 ** length) assert.equal(read, value);
    }),
  );
});

test("property: readIntBE applies two’s complement for every byte length", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: -2_147_483_648, max: 2_147_483_647 }),
      fc.nat({ max: 3 }),
      (value, lengthIndex) => {
        const length = lengthIndex + 1;
        const min = -(256 ** (length - 1));
        const max = 256 ** (length - 1) - 1;
        if (value < min || value > max) return;
        let unsigned = value < 0 ? value + 256 ** length : value;
        const bytes = new Uint8Array(length);
        for (let i = length - 1; i >= 0; i--) {
          bytes[i] = unsigned % 256;
          unsigned = Math.floor(unsigned / 256);
        }
        assert.equal(readIntBE(bytes, 0, length), value);
      },
    ),
  );
});

test("property: readBitsBE extracts MSB-first bit windows", () => {
  fc.assert(
    fc.property(
      fc.uint8Array({ minLength: 4, maxLength: 4 }),
      fc.nat({ max: 31 }),
      fc.nat({ max: 8 }),
      (bytes, bitOffset, bitLength) => {
        if (bitOffset + bitLength > 32) return;
        let expected = 0;
        for (let i = 0; i < bitLength; i++) {
          const byte = bytes[Math.floor((bitOffset + i) / 8)] as number;
          expected = expected * 2 + ((byte >>> (7 - ((bitOffset + i) % 8))) & 1);
        }
        assert.equal(readBitsBE(bytes, bitOffset, bitLength), expected);
      },
    ),
  );
});

test("bytesEqual compares the length first and then every byte", () => {
  assert.equal(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2])), true);
  assert.equal(
    bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3])),
    false,
    "different lengths are never equal",
  );
  assert.equal(
    bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3])),
    false,
    "a single differing byte is enough",
  );
  assert.equal(bytesEqual(new Uint8Array([]), new Uint8Array([])), true, "two empty buffers match");
});

test("readers past the end of a buffer yield defined zero-padded values", () => {
  // Truncated frames arrive from real buses. The readers answer with a defined
  // value instead of NaN, so a decoder fails on the content and not on arithmetic.
  assert.equal(u16be(new Uint8Array([0x12]), 0), 0x1200, "the missing low byte counts as zero");
  assert.equal(u16be(new Uint8Array([]), 4), 0, "an offset beyond the buffer reads as zero");
  assert.equal(u32be(new Uint8Array([0x12, 0x34]), 0), 0x12340000);
  assert.equal(readUintBE(new Uint8Array([0xff]), 0, 3), 0xff0000);
  assert.equal(
    readBitsBE(new Uint8Array([0b1000_0000]), 0, 4),
    0b1000,
    "MSB-first within the byte",
  );
  assert.equal(readBitsBE(new Uint8Array([]), 0, 8), 0, "bits beyond the buffer read as zero");
});
