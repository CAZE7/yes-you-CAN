/**
 * The grammars themselves, without a socket in front of them.
 *
 * `server-paths.spec.ts` pins the same rules through HTTP, and that is where a route can
 * break them (a forgotten `await`, a body read twice). What this file pins is the module,
 * because it is the one place the workbench decides what an address is — and a rule that
 * seven routes share is worth reading in one file (AGENTS 34.24: one rule, one home).
 */

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { HttpError, parseBurstCount, parseCanId, parseDropRate } from "../src/route-input.js";

describe("parseCanId", () => {
  test("both spellings of an address mean the same number", () => {
    for (const spelling of ["0x7E8", "0x7e8", " 7e8 ", 2024]) {
      assert.equal(parseCanId(spelling), 0x7e8, `"${String(spelling)}" is 0x7E8`);
    }
    assert.equal(parseCanId("0x0"), 0, "the zero address is an address");
    assert.equal(parseCanId(0x1fffffff), 0x1fffffff, "the top of the 29-bit range is included");
  });

  test("what is not an address is refused with the text that was sent", () => {
    // The historical pair of failures: `parseInt` cutting "7e8xyz" to 0x7E8 (a different
    // ECU's answer, read confidently) and a number never meeting a range check.
    for (const notAnId of ["7e8xyz", "0xZZ", "", "   ", "13, 7e8", {}, [], 1.5, -1, 2 ** 33]) {
      assert.throws(
        () => parseCanId(notAnId),
        (error: unknown) => {
          if (!(error instanceof HttpError)) {
            assert.fail(`a refusal is an HttpError, got ${String(error)}`);
          }
          assert.equal(error.statusCode, 400, "400 — the input is the caller's to fix");
          assert.match(
            error.message,
            /is not a CAN identifier|an ECU response id \(rxId\) is required/,
            `"${String(notAnId)}" is refused with a sentence, not a stack trace`,
          );
          return true;
        },
        `"${String(notAnId)}" must not reach a bus`,
      );
    }
  });
});

describe("the chaos fields", () => {
  test("a burst is a whole number of frames at least one", () => {
    assert.equal(parseBurstCount(1), 1);
    assert.equal(parseBurstCount(100), 100);
    for (const notACount of [0, -1, 2.5, Number.NaN, "drei", undefined, null]) {
      assert.throws(
        () => parseBurstCount(notACount),
        /a burst needs a whole number of frames/,
        `"${String(notACount)}" would arm a rule that never ends`,
      );
    }
  });

  test("a drop rate is a fraction, and the ends are allowed", () => {
    assert.equal(parseDropRate(0), 0, "0 is the disarmed rate");
    assert.equal(parseDropRate(1), 1, "1 is everything, and a legitimate test");
    for (const notAFraction of [
      -0.1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      "50%",
      undefined,
    ]) {
      assert.throws(
        () => parseDropRate(notAFraction),
        /a drop rate is a fraction between 0 and 1/,
        `"${String(notAFraction)}" does not say what the field claims`,
      );
    }
  });
});
