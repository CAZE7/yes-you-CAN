/**
 * ISO-TP parameter encoding (ISO 15765-2) — unit + property tests.
 */

import assert from "node:assert/strict";
import fc from "fast-check";
import { describe, test } from "vitest";
import {
  DEFAULT_TIMING,
  encodeStMin,
  type IsoTpTiming,
  parseStMin,
  SLOW_LINK_TIMING,
} from "./params.js";

describe("STmin encoding (ISO 15765-2 §9.4.5.4)", () => {
  test("the ms range is the identity", () => {
    for (let ms = 0; ms <= 0x7f; ms++) assert.equal(encodeStMin(ms), ms);
  });

  test("values above 127 ms clamp to the maximum", () => {
    assert.equal(encodeStMin(128), 0x7f);
    assert.equal(encodeStMin(10_000), 0x7f);
  });

  test("negative values clamp to zero", () => {
    assert.equal(encodeStMin(-1), 0);
  });

  test("property: parseStMin inverts encodeStMin on the ms domain", () => {
    fc.assert(
      fc.property(fc.nat({ max: 0x7f }), (ms) => {
        assert.equal(parseStMin(encodeStMin(ms)), ms);
      }),
    );
  });

  test("property: reserved bytes degrade to 127 ms (never to a busy 0)", () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 255 }).filter((b) => b > 0x7f && (b < 0xf1 || b > 0xf9)),
        (reserved) => {
          assert.equal(parseStMin(reserved), 0x7f);
        },
      ),
    );
  });
});

describe("default timing", () => {
  test("defaults are ISO-typical and overridable", () => {
    assert.equal(DEFAULT_TIMING.blockSize, 0);
    assert.equal(DEFAULT_TIMING.maxRetries, 0);
    assert.ok(DEFAULT_TIMING.nBsMs > 0);
  });
});

describe("slow-link timing", () => {
  // A Bluetooth SPP round trip is 50–150 ms, and an ELM327 that switches its
  // transmit identifier first spends two of them before the payload moves. The
  // default of one second and no retries reads that as a dead ECU.
  test("every bound it touches is looser than the default, and only those", () => {
    const bounds: Array<keyof IsoTpTiming> = [
      "nAsMs",
      "sendTimeoutMs",
      "nBsMs",
      "nCrMs",
      "maxRetries",
    ];
    for (const bound of bounds) {
      assert.ok(
        SLOW_LINK_TIMING[bound] >= DEFAULT_TIMING[bound],
        `${bound} must not get tighter: ${SLOW_LINK_TIMING[bound]} < ${DEFAULT_TIMING[bound]}`,
      );
    }
    // And nothing else moves — a profile that quietly changes flow control is
    // not a timing profile, it is a different protocol.
    for (const key of ["stMinMs", "stMinTxMs", "blockSize", "wftMax"] as const) {
      assert.equal(SLOW_LINK_TIMING[key], DEFAULT_TIMING[key], `${key} is unchanged`);
    }
    assert.ok(SLOW_LINK_TIMING.nBsMs > 150, "one Bluetooth round trip must fit inside N_Bs");
    assert.ok(SLOW_LINK_TIMING.nCrMs > 150, "and inside N_Cr");
    assert.ok(SLOW_LINK_TIMING.maxRetries > 0, "a jittered link needs one retry");
  });

  test("the default itself did not move to accommodate the slow link", () => {
    // The tempting fix is to raise DEFAULT_TIMING. That would loosen every
    // timeout every test measures, which makes a gate pass more easily without
    // anyone deciding it should. Pinned so the next person has to say that out
    // loud.
    assert.equal(DEFAULT_TIMING.nBsMs, 1000);
    assert.equal(DEFAULT_TIMING.nCrMs, 1000);
    assert.equal(DEFAULT_TIMING.sendTimeoutMs, 1000);
    assert.equal(DEFAULT_TIMING.maxRetries, 0);
  });
});
