/**
 * Vehicle-level matching primitives (AGENTS 11, 13).
 *
 * The point of these tests is the boundary the module has to keep: it cuts a VIN
 * into ISO 3779 positions and compares it against declared criteria. It must not
 * validate, must not guess and must not invent evidence for a position the caller
 * did not supply.
 */

import assert from "node:assert/strict";
import { test } from "vitest";
import {
  VIN_POSITIONS,
  containsValue,
  declaredVinCriteria,
  findToken,
  matchesPattern,
  vinPositions,
} from "./vehicles.js";

const FULL_VIN = "WVWZZZ1JZHW000001";

test("a 17-character VIN yields every ISO 3779 position", () => {
  const facts = vinPositions(FULL_VIN);
  assert.equal(facts.vin, FULL_VIN);
  assert.equal(facts.wmi, "WVW");
  assert.equal(facts.vds, "ZZZ1J");
  assert.equal(facts.modelYearChar, "H");
  assert.equal(facts.plantChar, "W");
  assert.equal(facts.serial, "000001");
});

test("positions are normalised: surrounding space and lower case disappear", () => {
  const facts = vinPositions(`  ${FULL_VIN.toLowerCase()} `);
  assert.equal(facts.vin, FULL_VIN);
  assert.equal(facts.wmi, "WVW");
});

test("a short VIN yields fewer facts instead of empty strings or padding", () => {
  const three = vinPositions("WVW");
  assert.equal(three.wmi, "WVW");
  assert.equal(three.vds, undefined);
  assert.equal(three.modelYearChar, undefined);
  assert.equal(three.plantChar, undefined);
  assert.equal(three.serial, undefined);

  const eight = vinPositions("WVWZZZ1J");
  assert.equal(eight.vds, "ZZZ1J");
  assert.equal(eight.modelYearChar, undefined, "position 10 does not exist yet");
});

test("an empty VIN yields no position at all", () => {
  const facts = vinPositions("");
  assert.equal(facts.vin, "");
  assert.equal(facts.wmi, undefined);
  assert.equal(facts.modelYearChar, undefined);
});

test("the position table agrees with the cut, so a change cannot pass silently", () => {
  assert.equal(FULL_VIN.slice(VIN_POSITIONS.wmi.start, VIN_POSITIONS.wmi.end), "WVW");
  assert.equal(FULL_VIN.slice(VIN_POSITIONS.vds.start, VIN_POSITIONS.vds.end), "ZZZ1J");
  assert.equal(FULL_VIN.charAt(VIN_POSITIONS.checkDigit), "Z");
  assert.equal(FULL_VIN.charAt(VIN_POSITIONS.modelYear), "H");
  assert.equal(FULL_VIN.charAt(VIN_POSITIONS.plant), "W");
  assert.equal(FULL_VIN.slice(VIN_POSITIONS.serial.start, VIN_POSITIONS.serial.end), "000001");
});

test("a VDS pattern matches position for position, never as a prefix", () => {
  assert.ok(matchesPattern("ZZZ1J", "ZZZ.."));
  assert.ok(matchesPattern("zzz1j", "ZZZ.."), "comparison is case insensitive");
  assert.ok(matchesPattern("ZZZ1J", "....."), "wildcards only match everything");
  assert.ok(!matchesPattern("ZZA1J", "ZZZ.."));
  assert.ok(!matchesPattern("ZZZ1", "ZZZ.."), "a shorter value cannot satisfy the pattern");
  assert.ok(!matchesPattern("ZZZ1JX", "ZZZ.."), "a longer value cannot either");
});

test("`?` in the pattern is a wildcard, in the value it is just a character", () => {
  assert.ok(matchesPattern("ZZA1J", "ZZ?1J"));
  assert.ok(!matchesPattern("ZZ?1J", "ZZA1J"));
});

test("containsValue compares trimmed and case insensitive, and never on empty input", () => {
  assert.ok(containsValue("  wvw ", ["WVW"]));
  assert.ok(!containsValue(undefined, ["WVW"]));
  assert.ok(!containsValue("WVW", undefined));
  assert.ok(!containsValue("WVW", []));
  assert.ok(!containsValue("", [""]));
});

test("findToken locates a declared token inside a real identification answer", () => {
  // ECUs pad and prefix identification answers; the token has to be found anyway.
  assert.equal(findToken("  H04 PN-1234-AB   0001", ["pn-1234-ab"]), "pn-1234-ab");
  assert.equal(findToken("PN-1", ["PN-1", "PN-2"]), "PN-1");
  assert.equal(findToken("PN-2", ["PN-1", "PN-2"]), "PN-2");
  assert.equal(findToken("unrelated", ["PN-1"]), undefined);
  assert.equal(findToken(undefined, ["PN-1"]), undefined);
  assert.equal(findToken("PN-1", undefined), undefined);
  assert.equal(findToken("PN-1", []), undefined);
  assert.equal(findToken("   ", ["PN-1"]), undefined);
});

test("findToken never matches an empty token, which would fit every answer", () => {
  assert.equal(findToken("anything", ["", "  "]), undefined);
  assert.equal(findToken("anything", ["", "NY"]), "NY");
});

test("declaredVinCriteria lists only criteria that carry data", () => {
  assert.deepEqual(declaredVinCriteria(undefined), []);
  assert.deepEqual(declaredVinCriteria({}), []);
  assert.deepEqual(declaredVinCriteria({ wmi: [] }), []);
  assert.deepEqual(declaredVinCriteria({ wmi: ["WVW"] }), ["wmi"]);
  assert.deepEqual(
    declaredVinCriteria({
      wmi: ["WVW"],
      vdsPattern: "ZZZ..",
      modelYearChars: [],
      plantChars: ["W"],
    }),
    ["wmi", "vdsPattern", "plantChars"],
  );
  assert.deepEqual(declaredVinCriteria({ modelYearChars: ["H"] }), ["modelYearChars"]);
});
