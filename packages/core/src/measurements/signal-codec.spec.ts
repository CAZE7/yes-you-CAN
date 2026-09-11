/**
 * Signal codec property tests (testing standards: property-based tests for every
 * signal encoder/decoder).
 *
 * The round-trip law of the measurement engine (AGENTS 14):
 *
 *   decode(signal, encodeSignal(signal, value)) === value
 *
 * must hold for generated values across *both byte orders* — Intel (`little`)
 * and Motorola (`big`) — and every encoding the schema supports. Values are
 * generated on the representable grid (offset + k·scale) because only those are
 * required to survive; everything else is a rounding question, not a codec one.
 */

import assert from "node:assert/strict";
import type { SignalDefinition } from "@vdp/definitions";
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { SignalDecoder } from "./decoder.js";
import { encodeSignal, encodeValue } from "./encoder.js";

const decoder = new SignalDecoder({ strict: true });

function baseSignal(overrides: Partial<SignalDefinition>): SignalDefinition {
  return {
    id: "engine.property",
    name: "property signal",
    ecu: "engine",
    did: 0x1234,
    byteOffset: 0,
    length: 2,
    encoding: "uint16",
    ...overrides,
  };
}

/** Value exactly on the grid the scale/offset pair can represent. */
function gridValue(k: number, scale: number, offset: number): number {
  return Math.round((offset + k * scale) * 1e6) / 1e6;
}

describe("numeric round trips, Intel (little) and Motorola (big)", () => {
  const numericEncodings = [
    { encoding: "uint8" as const, length: 1, min: 0, max: 255 },
    { encoding: "uint16" as const, length: 2, min: 0, max: 65_535 },
    { encoding: "uint24" as const, length: 3, min: 0, max: 16_777_215 },
    { encoding: "int8" as const, length: 1, min: -128, max: 127 },
    { encoding: "int16" as const, length: 2, min: -32_768, max: 32_767 },
    { encoding: "int32" as const, length: 4, min: -2_147_483_648, max: 2_147_483_647 },
  ];

  for (const endianness of ["big", "little"] as const) {
    for (const spec of numericEncodings) {
      test(`property: ${spec.encoding} ${endianness === "little" ? "Intel" : "Motorola"} raw decode(encode(v)) === v`, () => {
        fc.assert(
          fc.property(fc.integer({ min: spec.min, max: spec.max }), (raw) => {
            const signal = baseSignal({ encoding: spec.encoding, length: spec.length, endianness });
            const payload = encodeSignal(signal, raw);
            const decoded = decoder.decode(signal, payload);
            assert.ok(decoded, "a representable value must always decode");
            assert.equal(decoded.rawValue, raw);
            assert.equal(decoded.value, raw);
            assert.equal(decoded.outOfRange, false);
          }),
          { numRuns: 300 },
        );
      });
    }

    test(`property: ${specEncodingsLabel(endianness)} scaled decode(encode(v)) === v on the representable grid`, () => {
      fc.assert(
        fc.property(
          fc.constantFrom(...numericEncodings),
          fc.integer({ min: 0, max: 65_535 }),
          fc.constantFrom(1, 0.5, 0.1, 0.01),
          fc.integer({ min: -40, max: 165 }),
          (spec, k, scale, offset) => {
            const raw = k % (spec.max + 1);
            if (spec.min < 0) {
              // signed encodings: keep k inside the representable raw range
              if (raw > spec.max || raw < spec.min) return;
            } else if (raw > spec.max) return;
            const signal = baseSignal({
              encoding: spec.encoding,
              length: spec.length,
              endianness,
              scale,
              offsetValue: offset,
            });
            const physical = gridValue(raw, scale, offset);
            const payload = encodeSignal(signal, physical);
            const decoded = decoder.decode(signal, payload);
            assert.ok(decoded, `value ${physical} must survive the round trip`);
            assert.equal(decoded.rawValue, raw, "the raw value must be recovered exactly");
            assert.equal(decoded.value, physical);
          },
        ),
        { numRuns: 400 },
      );
    });
  }
});

function specEncodingsLabel(endianness: "big" | "little"): string {
  return endianness === "little" ? "Intel" : "Motorola";
}

describe("special encodings", () => {
  test("property: bool round trips for both states", () => {
    fc.assert(
      fc.property(fc.boolean(), fc.constantFrom("big", "little" as const), (value, endianness) => {
        const signal = baseSignal({ encoding: "bool", length: 1, endianness });
        const decoded = decoder.decode(signal, encodeSignal(signal, value));
        assert.ok(decoded);
        assert.equal(decoded.value, value);
        assert.equal(decoded.rawValue, value);
      }),
    );
  });

  test("property: bitmask preserves the raw pattern and skips scaling by design", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 255 }),
        fc.constantFrom("big", "little" as const),
        (pattern, endianness) => {
          const signal = baseSignal({ encoding: "bitmask", length: 1, endianness, scale: 10 });
          const decoded = decoder.decode(signal, encodeSignal(signal, pattern));
          assert.ok(decoded);
          assert.equal(decoded.value, pattern, "bitmasks are never scaled");
          assert.equal(decoded.rawValue, pattern);
        },
      ),
    );
  });

  test("property: BCD digits survive encoding for values with up to length·2 digits", () => {
    fc.assert(
      fc.property(fc.nat({ max: 9999 }), fc.constantFrom(2, 3, 4), (value, length) => {
        if (value >= 100 ** length) return;
        const signal = baseSignal({ encoding: "bcd", length });
        const decoded = decoder.decode(signal, encodeSignal(signal, value));
        assert.ok(decoded);
        assert.equal(decoded.value, value);
      }),
    );
  });

  test("property: float32 round trips within float32 precision, both byte orders", () => {
    // Values below the float32 denormal range collapse to ±0 — a rounding
    // artefact of the format, not a codec property, so the generator skips them.
    fc.assert(
      fc.property(
        fc
          .double({ min: -1_000_000, max: 1_000_000, noNaN: true, noDefaultInfinity: true })
          .filter((v) => !Object.is(v, -0) && Math.abs(v) > 1e-35),
        fc.constantFrom("big", "little" as const),
        (value, endianness) => {
          const signal = baseSignal({ encoding: "float32", length: 4, endianness });
          const payload = encodeSignal(signal, value);
          const decoded = decoder.decode(signal, payload);
          assert.ok(decoded);
          const f32 = Math.fround(value);
          // The codec level recovers the exact float32…
          assert.equal(decoded.rawValue, f32);
          // …while the engine level reports the value rounded to the scale
          // resolution (AGENTS 14: readable physical values).
          assert.equal(decoded.value, roundToScaleResolution(f32, 1));
        },
      ),
    );
  });

  test("property: ASCII is preserved up to the field length and space-padded", () => {
    const printable = fc.constantFrom(..."ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-".split(""));
    fc.assert(
      fc.property(fc.array(printable, { minLength: 0, maxLength: 8 }), (chars) => {
        const text = chars.join("");
        const signal = baseSignal({ encoding: "ascii", length: 8 });
        const payload = encodeSignal(signal, text);
        const decoded = decoder.decode(signal, payload);
        assert.ok(decoded);
        assert.equal(decoded.value, text);
      }),
    );
  });

  test("property: bitfields extract the declared MSB-first window for both byte orders of the container", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
        fc.constantFrom("big", "little" as const),
        (high, low, endianness) => {
          const signal = baseSignal({
            encoding: "uint16",
            length: 2,
            endianness,
            bitOffset: 4,
            bitLength: 8,
          });
          // Bits 4..11 of the 16-bit container [high, low] in either byte order.
          const word = (high << 8) | low;
          const payload = encodeValue(
            baseSignal({ encoding: "uint16", length: 2, endianness }),
            word,
          );
          const decoded = decoder.decode(signal, payload);
          assert.ok(decoded);
          const expected =
            endianness === "big"
              ? ((high & 0x0f) << 4) | (low >> 4)
              : ((low & 0x0f) << 4) | (high >> 4);
          assert.equal(decoded.value, expected);
        },
      ),
    );
  });
});

/** Mirrors the decoder's documented "round to the scale resolution" step. */
function roundToScaleResolution(value: number, scale: number): number {
  const decimals = Math.max(0, Math.min(6, Math.ceil(-Math.log10(scale))));
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

describe("invalid input is rejected (strict) or reported (lenient)", () => {
  const lenient = new SignalDecoder({ strict: false });

  test("property: every truncated payload is reported, never decoded from thin air", () => {
    fc.assert(
      fc.property(fc.nat({ max: 3 }), (length) => {
        // byteOffset 1 + length 3 ⇒ any payload shorter than 4 bytes is truncated.
        const signal = baseSignal({ encoding: "uint16", length: 3, byteOffset: 1 });
        const payload = new Uint8Array(length);
        const decoded = lenient.decode(signal, payload);
        expect(decoded).toBeNull();
        expect(() => decoder.decode(signal, payload)).toThrow(/cannot decode/);
      }),
    );
  });

  test("property: unsigned encodings reject negative values, signed accept them", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -32_768, max: -1 }),
        fc.constantFrom("big", "little" as const),
        (negative, endianness) => {
          const unsigned = baseSignal({ encoding: "uint16", length: 2, endianness });
          expect(() => encodeValue(unsigned, negative)).toThrow(/unsigned/);
          const signed = baseSignal({ encoding: "int16", length: 2, endianness });
          const payload = encodeValue(signed, negative);
          expect(decoder.decode(signed, payload)?.value).toBe(negative);
        },
      ),
    );
  });

  test("unsupported encodings are an EncodeError/DecodeError, not a crash", () => {
    const bogus = baseSignal({ encoding: "float64" as never });
    assert.throws(() => encodeValue(bogus, 1), /unsupported encoding/);
  });

  test("non-numeric input to a numeric signal is rejected with the signal id", () => {
    const signal = baseSignal({ encoding: "uint8", length: 1 });
    assert.throws(
      () => encodeValue(signal, "not-a-number" as unknown as number),
      /engine\.property/,
    );
  });

  test("out-of-range values are flagged, not silently accepted", () => {
    const signal = baseSignal({ encoding: "uint8", length: 1, min: 0, max: 100 });
    const decoded = decoder.decode(signal, encodeSignal(signal, 200));
    assert.ok(decoded);
    assert.equal(decoded.outOfRange, true);
  });
});
