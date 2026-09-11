/**
 * SignalDecoder — range and bounds (AGENTS 14, 24, 34.7).
 *
 * Two questions this decoder has to answer exactly, because everything downstream
 * (graphs, anomaly detection, reports) trusts them:
 *
 * 1. `outOfRange` — is the *reported physical* value inside the min/max window the
 *    definition declares? The check is a range test on the rounded value, not on
 *    the raw one, and its boundaries are inclusive.
 * 2. bounds — a signal window that does not fit the payload is a decode failure.
 *    Reading whatever happens to be in the buffer would fabricate a measurement,
 *    which is the one thing the raw/decoded split exists to prevent.
 *
 * The round trip of every encoding is covered in `signal-codec.spec.ts`; this file
 * is only about the edges.
 */

import assert from "node:assert/strict";
import type { SignalDefinition } from "@vdp/definitions";
import { createLogger, fromHex, toHex } from "@vdp/shared";
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { SignalDecoder } from "./decoder.js";

const lenient = new SignalDecoder({ strict: false });
const strict = new SignalDecoder({ strict: true });

function signal(overrides: Partial<SignalDefinition> = {}): SignalDefinition {
  return {
    id: "engine.edge_case",
    name: "edge case signal",
    ecu: "engine",
    did: 0x1234,
    byteOffset: 0,
    length: 2,
    encoding: "uint16",
    ...overrides,
  };
}

/** Decode with the lenient decoder and insist on a result — for value assertions. */
function decode(
  definition: SignalDefinition,
  payload: Uint8Array,
): { value: number; outOfRange: boolean; rawValue: number | string | boolean } {
  const decoded = lenient.decode(definition, payload);
  assert.ok(
    decoded,
    `expected the window ${definition.byteOffset}+${definition.length} of payload "${toHex(payload)}" to decode`,
  );
  return {
    value: decoded.value as number,
    outOfRange: decoded.outOfRange,
    rawValue: decoded.rawValue,
  };
}

/* ------------------------------------------------------------- min / max range */

describe("declared range (min/max)", () => {
  test("the boundaries themselves are inside the range", () => {
    const definition = signal({ min: 10, max: 20 });
    assert.equal(
      decode(definition, fromHex("00 0A")).outOfRange,
      false,
      "value === min is in range",
    );
    assert.equal(
      decode(definition, fromHex("00 14")).outOfRange,
      false,
      "value === max is in range",
    );
    assert.equal(decode(definition, fromHex("00 0F")).outOfRange, false);
  });

  test("one step outside either boundary is flagged", () => {
    const definition = signal({ min: 10, max: 20 });
    assert.equal(decode(definition, fromHex("00 09")).outOfRange, true);
    assert.equal(decode(definition, fromHex("00 15")).outOfRange, true);
  });

  test("a range with only a lower bound still flags above it, and vice versa", () => {
    const minOnly = signal({ min: 0 });
    assert.equal(
      decode(minOnly, fromHex("FF FF")).outOfRange,
      false,
      "65535 is above the only bound, that is fine",
    );
    const maxOnly = signal({ max: 100 });
    assert.equal(decode(maxOnly, fromHex("00 65")).outOfRange, true, "101 exceeds max");
    assert.equal(
      decode(maxOnly, fromHex("FF FF")).value,
      65_535,
      "the value is still reported — a flag is not a refusal",
    );
  });

  test("no bounds at all means nothing is ever out of range", () => {
    for (const hex of ["00 00", "FF FF", "7F FF"]) {
      assert.equal(decode(signal(), fromHex(hex)).outOfRange, false);
    }
  });

  test("scaling happens first, so the range is about the physical value", () => {
    // Coolant temperature: raw 900 · 0.1 - 40 = 50 °C — inside a -40..130 window
    // while the raw value 900 is far outside it.
    const definition = signal({ scale: 0.1, offsetValue: -40, min: -40, max: 130 });
    assert.deepEqual(decode(definition, fromHex("03 84")), {
      value: 50,
      outOfRange: false,
      rawValue: 900,
    });
    // The same bytes read without the scale are 900 → above a 130 max.
    assert.equal(decode(signal({ min: -40, max: 130 }), fromHex("03 84")).outOfRange, true);
  });

  test("the offset shifts the window check as well", () => {
    const definition = signal({ scale: 1, offsetValue: -40, min: 0, max: 100 });
    assert.equal(decode(definition, fromHex("00 28")).value, 0, "40 raw - 40 = 0");
    assert.equal(
      decode(definition, fromHex("00 28")).outOfRange,
      false,
      "0 is the lower boundary, inclusive",
    );
    assert.equal(
      decode(definition, fromHex("00 27")).outOfRange,
      true,
      "39 raw - 40 = -1, below min",
    );
  });

  test("the range check sees the value the user is shown, i.e. the rounded one", () => {
    // A half step of a 0.5 scale lands exactly on the boundary only after the
    // rounding that `finish` applies for readability. Pinning the combination keeps
    // a future change of the rounding rule from silently changing the flags too.
    const half = signal({ encoding: "uint8", length: 1, scale: 0.5, min: 1, max: 10 });
    assert.deepEqual(
      decode(half, fromHex("02")),
      { value: 1, outOfRange: false, rawValue: 2 },
      "1.0 === min is inside",
    );
    assert.deepEqual(
      decode(half, fromHex("01")),
      { value: 0.5, outOfRange: true, rawValue: 1 },
      "0.5 is below min",
    );
    assert.deepEqual(
      decode(half, fromHex("15")),
      { value: 10.5, outOfRange: true, rawValue: 21 },
      "10.5 is above max",
    );
    // A scale of 1 means whole numbers only, so nothing is rounded away here.
    const whole = signal({ encoding: "uint8", length: 1, scale: 1, min: 1, max: 10 });
    assert.deepEqual(decode(whole, fromHex("01")), { value: 1, outOfRange: false, rawValue: 1 });
    assert.deepEqual(decode(whole, fromHex("00")), { value: 0, outOfRange: true, rawValue: 0 });
  });

  test("a bit-field range is checked on the extracted bits, scaled", () => {
    // Bit numbering is MSB first, so bits 0..3 of 0xF0 are the four high nibbles.
    const high = signal({
      length: 1,
      encoding: "bitmask",
      bitOffset: 0,
      bitLength: 4,
      min: 0,
      max: 8,
    });
    assert.equal(decode(high, fromHex("F0")).value, 15, "0xF0 >> 4 = 15");
    assert.equal(decode(high, fromHex("F0")).outOfRange, true, "15 is above the declared max of 8");
    assert.equal(decode(high, fromHex("80")).outOfRange, false, "8 === max is inclusive");
    const low = signal({
      length: 1,
      encoding: "bitmask",
      bitOffset: 4,
      bitLength: 4,
      min: 0,
      max: 8,
    });
    assert.equal(
      decode(low, fromHex("F0")).value,
      0,
      "and the same byte has nothing in its low nibble",
    );
    assert.equal(decode(low, fromHex("0F")).value, 15, "which is where the 15 lives here");
  });

  test("text and boolean signals are never out of range, whatever min/max say", () => {
    // The range is a numeric statement; applying it to 'ABCD' or to `true` would
    // flag every single text value, so `finishText`/`finishBoolean` skip it.
    const text = signal({ encoding: "ascii", length: 4, min: 0, max: 1 });
    const decodedText = lenient.decode(text, fromHex("41 42 43 44"));
    assert.equal(decodedText?.value, "ABCD");
    assert.equal(decodedText?.rawValue, "ABCD");
    assert.equal(decodedText?.outOfRange, false);
    assert.equal(decodedText?.rawHex, "41 42 43 44");
    assert.ok(
      decodedText && !("unit" in decodedText),
      "no unit was declared, so the key is absent rather than empty",
    );
    assert.ok(decodedText && !("enumText" in decodedText));

    const bool = signal({ encoding: "bool", length: 1, min: 0, max: 0 });
    assert.equal(lenient.decode(bool, fromHex("01"))?.value, true);
    assert.equal(
      lenient.decode(bool, fromHex("01"))?.outOfRange,
      false,
      "a boolean has no numeric range to leave",
    );
    assert.equal(
      lenient.decode(bool, fromHex("00"))?.value,
      false,
      "every non-zero byte means true, zero means false",
    );
  });

  test("an enum mapping does not influence the range decision", () => {
    const definition = signal({
      min: 0,
      max: 1,
      enumMapping: { 0: "off", 1: "on", 2: "error state" },
    });
    const decoded = lenient.decode(definition, fromHex("00 02"));
    assert.equal(decoded?.enumText, "error state");
    assert.equal(decoded?.outOfRange, true, "an enum entry outside min/max is still out of range");
  });

  test("a negative range works on signed encodings", () => {
    const definition = signal({ encoding: "int16", min: -40, max: 130 });
    assert.equal(decode(definition, fromHex("FF D8")).value, -40, "two’s complement -40");
    assert.equal(decode(definition, fromHex("FF D8")).outOfRange, false);
    assert.equal(decode(definition, fromHex("FF D7")).outOfRange, true, "-41 is below the minimum");
    assert.equal(decode(definition, fromHex("00 83")).outOfRange, true, "131 is above the maximum");
  });

  test("a non-finite value is reported as it is: Infinity leaves the range, NaN cannot", () => {
    const nan = signal({ encoding: "float32", length: 4, min: 0, max: 10 });
    const inf = signal({ encoding: "float32", length: 4, min: 0, max: 10 });
    const view = new DataView(new ArrayBuffer(4));
    view.setFloat32(0, Number.NaN);
    assert.equal(lenient.decode(nan, new Uint8Array(view.buffer))?.value, Number.NaN);
    // Documented limitation: neither NaN < min nor NaN > max is true, so a NaN is
    // never flagged. `outOfRange === false` therefore does not mean "sane value" —
    // the anomaly detection has to look at the value itself.
    assert.equal(lenient.decode(nan, new Uint8Array(view.buffer))?.outOfRange, false);

    view.setFloat32(0, Number.POSITIVE_INFINITY);
    const plusInf = lenient.decode(inf, new Uint8Array(view.buffer));
    assert.equal(plusInf?.value, Number.POSITIVE_INFINITY);
    assert.equal(plusInf?.outOfRange, true, "Infinity is above any finite max");

    view.setFloat32(0, Number.NEGATIVE_INFINITY);
    assert.equal(
      lenient.decode(inf, new Uint8Array(view.buffer))?.outOfRange,
      true,
      "and -Infinity below any finite min",
    );
  });

  test("an inverted range (min > max) flags everything — the validator forbids it, the decoder does not invent a default", () => {
    const definition = signal({ min: 10, max: 5 });
    assert.equal(decode(definition, fromHex("00 00")).outOfRange, true);
    assert.equal(decode(definition, fromHex("00 08")).outOfRange, true);
    assert.equal(decode(definition, fromHex("FF FF")).outOfRange, true);
  });

  test("an out-of-range value is a WARN with the numbers that produced it", () => {
    const logger = createLogger("decoder", { level: "WARN" });
    const decoder = new SignalDecoder({ logger });
    const definition = signal({ min: 0, max: 100 });
    decoder.decode(definition, fromHex("00 64"));
    assert.deepEqual(
      logger.records.filter((record) => record.message.includes("outside declared range")),
      [],
      "an in-range value is silent",
    );
    decoder.decode(definition, fromHex("01 2C"));
    const [warning] = logger.records.filter((record) => record.level === "WARN");
    assert.equal(warning?.message, "decoded value outside declared range");
    assert.deepEqual(warning?.fields, { signal: "engine.edge_case", value: 300, min: 0, max: 100 });
  });

  test('property: the flag is exactly "value < min || value > max" of the reported value', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
        (raw, min, max) => {
          const definition = signal({ encoding: "uint8", length: 1, min, max });
          const decoded = lenient.decode(definition, new Uint8Array([raw]));
          assert.ok(decoded);
          assert.equal(decoded.outOfRange, raw < min || raw > max);
          assert.equal(decoded.value, raw);
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe("general decoding", () => {
  test("endianness reverses the window, not the digits of the value", () => {
    assert.equal(
      decode(signal({ length: 2 }), fromHex("12 34")).value,
      0x1234,
      "big endian is the default",
    );
    assert.equal(
      decode(signal({ length: 2, endianness: "little" }), fromHex("12 34")).value,
      0x3412,
    );
    assert.equal(
      decode(signal({ encoding: "int16", length: 2, endianness: "little" }), fromHex("d8 ff"))
        .value,
      -40,
      "FFD8 little endian is -40",
    );
    const float = signal({ encoding: "float32", length: 4 });
    assert.equal(decode(float, fromHex("3F C0 00 00")).rawValue, 1.5, "big endian is the default");
    assert.equal(
      decode(
        signal({ encoding: "float32", length: 4, endianness: "little" }),
        fromHex("00 00 C0 3F"),
      ).rawValue,
      1.5,
    );
    assert.equal(
      decode(signal({ encoding: "float32", length: 4, scale: 0.1 }), fromHex("3F C0 00 00")).value,
      0.2,
      "0.15 at the resolution of a 0.1 step",
    );
  });

  test("a declared length longer than the encoding name wins — the size comes from the definition", () => {
    assert.equal(decode(signal({ encoding: "uint8", length: 2 }), fromHex("12 34")).value, 0x1234);
    assert.equal(decode(signal({ encoding: "uint32", length: 1 }), fromHex("FF")).value, 255);
  });

  test("scale and offset are applied as written, and only to numeric values", () => {
    assert.equal(decode(signal({ scale: 0.1 }), fromHex("00 64")).value, 10, "100 × 0.1");
    assert.equal(
      decode(signal({ scale: 0.1, offsetValue: -40 }), fromHex("00 64")).value,
      -30,
      "offset after scaling",
    );
    assert.equal(
      decode(signal({ offsetValue: 5 }), fromHex("00 0A")).value,
      15,
      "a scale of 1 is the identity",
    );
    assert.equal(
      decode(signal({ scale: -0.1, offsetValue: 100 }), fromHex("00 64")).value,
      90,
      "an inverted sensor still gets one decimal, not NaN",
    );
  });

  test("the reported value is rounded to the decimals the scale can carry", () => {
    // The number of decimals comes from the size of the step, so a 0-255 byte that
    // maps to 0-100 % is never shown as 50.19607843137255.
    const percent = signal({ encoding: "uint8", length: 1, scale: 0.39215686274509803 });
    assert.equal(decode(percent, fromHex("80")).value, 50.2);
    assert.equal(
      decode(signal({ encoding: "uint8", length: 1, scale: 0.01 }), fromHex("FF")).value,
      2.55,
    );
    assert.equal(
      decode(signal({ encoding: "uint8", length: 1, scale: 10 }), fromHex("FF")).value,
      2550,
      "a coarse scale has no decimals to keep",
    );
    // A float without a declared scale is reported at the resolution of that default
    // step of 1 (AGENTS 14, mirrored by `roundToScaleResolution` in signal-codec.spec):
    // the exact IEEE value stays in `rawValue`, where an export can still carry it.
    const unscaled = signal({ encoding: "float32", length: 4 });
    assert.equal(
      decode(unscaled, fromHex("3F C0 00 00")).value,
      2,
      "1.5 rounded to the scale resolution",
    );
    assert.equal(
      decode(unscaled, fromHex("3F C0 00 00")).rawValue,
      1.5,
      "and the raw value is untouched",
    );
    // Clamped at six decimals: finer than that is rounded away, which is exactly why
    // `raw` and `rawValue` stay next to the value in every export.
    const tiny = signal({ encoding: "uint8", length: 1, scale: 1e-9 });
    assert.equal(decode(tiny, fromHex("01")).value, 0);
    assert.equal(decode(tiny, fromHex("01")).rawValue, 1);
  });

  test("a bit mask is a pattern, not a measurement: no scaling, and no bit window means the whole window", () => {
    assert.equal(decode(signal({ encoding: "bitmask", length: 1 }), fromHex("0A")).value, 10);
    assert.equal(
      decode(
        signal({ encoding: "bitmask", length: 1, scale: 0.1, offsetValue: 100 }),
        fromHex("0A"),
      ).value,
      10,
      "scale and offset are ignored",
    );
    assert.equal(
      decode(signal({ encoding: "bitmask", length: 2 }), fromHex("01 00")).value,
      256,
      "two bytes of pattern are read big endian",
    );
  });

  test("text stops at the first NUL and loses its padding", () => {
    const text = signal({ encoding: "ascii", length: 8 });
    assert.equal(lenient.decode(text, fromHex("41 42 43 00 44 45 46 47"))?.value, "ABC");
    assert.equal(
      lenient.decode(text, fromHex("20 20 41 42 20 20 00 00"))?.value,
      "AB",
      "a padded field is trimmed",
    );
    assert.equal(
      lenient.decode(text, fromHex("00 00 00 00 00 00 00 00"))?.value,
      "",
      "an empty field is an empty string, not a failure",
    );
    const high = signal({ encoding: "ascii", length: 4 });
    assert.equal(
      lenient.decode(high, fromHex("FF FE 41 00"))?.value,
      "\u00ff\u00feA",
      "a byte above ASCII is passed through as its code point",
    );
    const raw = lenient.decode(high, fromHex("41 00 42 00"));
    assert.equal(
      raw?.rawHex,
      "41 00 42 00",
      "the raw window is kept whole even though the text is shorter",
    );
    assert.equal(raw?.rawValue, "A", "and the value is the truncated text");
  });

  test("an enum is looked up by the raw value, and an unmapped code stays a number", () => {
    const scaled = signal({
      encoding: "uint8",
      length: 1,
      scale: 2,
      enumMapping: { 1: "one", 3: "three" },
    });
    const withScale = lenient.decode(scaled, fromHex("03"));
    assert.deepEqual(
      { value: withScale?.value, rawValue: withScale?.rawValue, enumText: withScale?.enumText },
      { value: 6, rawValue: 3, enumText: "three" },
      "the physical value is scaled, the label follows the code that was on the wire",
    );
    const mapped = lenient.decode(
      signal({ encoding: "uint8", length: 1, enumMapping: { 1: "one", 3: "three" } }),
      fromHex("03"),
    );
    assert.deepEqual(
      { value: mapped?.value, rawValue: mapped?.rawValue, enumText: mapped?.enumText },
      { value: 3, rawValue: 3, enumText: "three" },
      "the value is the code and the text is what the table says about it",
    );
    const unmapped = lenient.decode(
      signal({ encoding: "uint8", length: 1, enumMapping: { 1: "one" } }),
      fromHex("03"),
    );
    assert.equal(unmapped?.value, 3, "an undocumented code is still reported as its number");
    assert.ok(unmapped && !("enumText" in unmapped), "and no label is invented for it");
  });

  test("identity fields come from the definition untouched, so a chart can key on them", () => {
    const definition = signal({
      id: "abs.wheel_speed_fl",
      name: "Wheel speed, front left",
      ecu: "abs",
      did: 0xf1a2,
      unit: "km/h",
      length: 2,
    });
    const decoded = lenient.decode(definition, fromHex("00 2A"));
    assert.equal(decoded?.signalId, "abs.wheel_speed_fl");
    assert.equal(decoded?.name, "Wheel speed, front left");
    assert.equal(decoded?.ecu, "abs");
    assert.equal(decoded?.did, 0xf1a2);
    assert.equal(decoded?.unit, "km/h");
  });
});

/* ----------------------------------------------------------------- bounds */

describe("payload bounds", () => {
  test("a window ending exactly on the last byte is still in bounds", () => {
    const definition = signal({ byteOffset: 2, length: 2 });
    const decoded = lenient.decode(definition, fromHex("DE AD BE EF"));
    assert.equal(decoded?.rawHex, "BE EF");
    assert.equal(decoded?.value, 0xbeef);
  });

  test("property: a window that does not fit never decodes, whatever the offset", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 6 }),
        fc.integer({ min: 1, max: 6 }),
        (offset, length) => {
          const payload = new Uint8Array(6);
          const definition = signal({ byteOffset: offset, length, encoding: "uint16" });
          if (offset + length <= payload.length) {
            assert.ok(lenient.decode(definition, payload), "a window that fits always decodes");
            return;
          }
          expect(lenient.decode(definition, payload)).toBeNull();
          expect(() => strict.decode(definition, payload)).toThrow(
            /cannot decode engine\.edge_case/,
          );
        },
      ),
      { numRuns: 60 },
    );
  });

  test("the failure reason states what was available and what was needed", () => {
    const definition = signal({ byteOffset: 1, length: 3 });
    let message = "";
    try {
      strict.decode(definition, fromHex("AA BB"));
    } catch (error) {
      message = (error as Error).message;
    }
    assert.match(message, /payload for DID 0x1234 has 2 bytes but signal needs 3 at offset 1/);
  });

  test("an empty payload is reported, never decoded as zeros", () => {
    for (const encoding of [
      "uint8",
      "uint16",
      "int32",
      "float32",
      "ascii",
      "bool",
      "bitmask",
      "bcd",
    ] as const) {
      const definition = signal({ encoding, length: 2 });
      expect(lenient.decode(definition, new Uint8Array(0))).toBeNull();
    }
  });

  test("a negative byte offset is a decode failure, not a read from the end of the payload", () => {
    // `subarray(-2)` wraps around. Silently accepting it would report the last two
    // bytes of a response as if they were the signal at the front of it.
    const definition = signal({ byteOffset: -2, length: 2 });
    expect(lenient.decode(definition, fromHex("00 01 BE EF"))).toBeNull();
    expect(() => strict.decode(definition, fromHex("00 01 BE EF"))).toThrow(/offset -2/);
  });

  test('a negative length cannot turn the window into "everything but the tail"', () => {
    const definition = signal({ byteOffset: 0, length: -2 });
    expect(lenient.decode(definition, fromHex("00 01 BE EF"))).toBeNull();
  });

  test("a zero length window decodes as empty: raw 0, no bytes of its own", () => {
    // Not a valid definition (the validator requires length ≥ 1) but a total
    // function: the decoder answers "no bytes, so zero" instead of guessing.
    const decoded = lenient.decode(signal({ length: 0 }), fromHex("00 01"));
    assert.equal(decoded?.raw.length, 0);
    assert.equal(decoded?.rawHex, "");
    assert.equal(decoded?.value, 0);
    assert.equal(decoded?.outOfRange, false);
  });

  test("bytes after the window are ignored — and the window itself is copied out", () => {
    const payload = fromHex("00 2A FF FF");
    const definition = signal({ byteOffset: 1, length: 1 });
    const decoded = lenient.decode(definition, payload);
    assert.equal(decoded?.value, 42);
    assert.equal(decoded?.rawHex, "2A", "only the declared window is the signal's raw data");
    // Raw stays evidence: a later write into the shared buffer must not rewrite it.
    payload[1] = 0x99;
    assert.equal(
      toHex(decoded?.raw ?? new Uint8Array()),
      "2A",
      "the recorded raw bytes are the ones that were decoded",
    );
    assert.equal(decoded?.rawHex, "2A");
  });

  test("a bit window outside its container is refused instead of reading zeros", () => {
    // readBitsBE pads missing bytes with 0, so an oversized window would produce a
    // plausible low value rather than an error.
    const definition = signal({ length: 1, bitOffset: 4, bitLength: 8, encoding: "bitmask" });
    expect(lenient.decode(definition, fromHex("AB"))).toBeNull();
    try {
      strict.decode(definition, fromHex("AB"));
      assert.fail("the strict decoder must throw");
    } catch (error) {
      assert.match(
        (error as Error).message,
        /bit window 4\.\.12 does not fit the 8 bit container of DID 0x1234/,
      );
    }
  });

  test("a bit window of zero or negative width is refused, a full-width one is accepted", () => {
    expect(
      lenient.decode(
        signal({ length: 1, bitOffset: 0, bitLength: 0, encoding: "bitmask" }),
        fromHex("AB"),
      ),
    ).toBeNull();
    expect(
      lenient.decode(
        signal({ length: 1, bitOffset: -1, bitLength: 4, encoding: "bitmask" }),
        fromHex("AB"),
      ),
    ).toBeNull();
    const full = lenient.decode(
      signal({ length: 1, bitOffset: 0, bitLength: 8, encoding: "bitmask" }),
      fromHex("AB"),
    );
    assert.equal(full?.value, 0xab, "bits 0..7 of one byte is the whole byte");
  });

  test("an unsupported encoding is reported, not guessed", () => {
    const bogus = signal({ encoding: "float64" as never });
    expect(lenient.decode(bogus, fromHex("00 01"))).toBeNull();
    expect(() => strict.decode(bogus, fromHex("00 01"))).toThrow(/unsupported encoding "float64"/);
  });

  test("decodeAll keeps the signals that fit and drops the ones that do not", () => {
    const ok = signal({ id: "engine.a", byteOffset: 0, length: 2 });
    const missing = signal({ id: "engine.b", byteOffset: 2, length: 2 });
    const decoded = lenient.decodeAll([ok, missing, ok], fromHex("00 2A"));
    assert.deepEqual(
      decoded.map((entry) => [entry.signalId, entry.value]),
      [
        ["engine.a", 42],
        ["engine.a", 42],
      ],
      "order is kept and the failing signal is absent, not zero-filled",
    );
    expect(() => strict.decodeAll([missing], fromHex("00 2A"))).toThrow(/cannot decode/);
    assert.deepEqual(lenient.decodeAll([], new Uint8Array()), []);
  });

  test("a truncated BCD nibble is reported, a partially numeric one is not silently truncated", () => {
    // Documented current behaviour: `parseInt('0a', 10)` is 0, so a corrupt BCD
    // byte that starts with a digit decodes to that leading digit. Only a payload
    // that parses to nothing at all is rejected. Worth knowing before a report
    // treats every decoded BCD value as trustworthy.
    const bcd = signal({ encoding: "bcd", length: 2 });
    assert.equal(lenient.decode(bcd, fromHex("12 34"))?.value, 1234, "a clean BCD pair");
    assert.equal(
      lenient.decode(bcd, fromHex("0A 34"))?.value,
      0,
      'the leading "0a" parses as 0 and swallows the rest',
    );
    expect(lenient.decode(bcd, fromHex("FF FF")), "nothing numeric in it at all").toBeNull();
    assert.equal(
      lenient.decode(bcd, fromHex("0A 34"))?.rawHex,
      "0A 34",
      "the raw bytes are kept either way",
    );
    expect(() => strict.decode(bcd, fromHex("FF FF"))).toThrow(/invalid BCD payload FF FF/);
  });
});
