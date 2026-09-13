/**
 * WMI reference data (ISO 3780 / 49 CFR 565).
 *
 * These tests guard two properties that matter more than the table's length: an
 * unknown WMI stays unknown instead of being guessed, and the table itself is
 * internally consistent (no duplicates, no VIN-illegal characters, provenance
 * declared) — because the table is meant to grow from sourced data (AGENTS 24).
 */

import assert from "node:assert/strict";
import { test } from "vitest";
import { WMI_PROVENANCE, knownWmis, lookupWmi, regionForVin } from "./wmi.js";

test("known WMIs name manufacturer, brand and country", () => {
  const vw = lookupWmi("WVW");
  assert.equal(vw?.manufacturer, "Volkswagen AG");
  assert.equal(vw?.brand, "Volkswagen");
  assert.equal(vw?.country, "DE");

  assert.equal(lookupWmi("WAU")?.brand, "Audi");
  assert.equal(lookupWmi("WDB")?.brand, "Mercedes-Benz");
  assert.equal(lookupWmi("TMB")?.country, "CZ");
  assert.equal(lookupWmi("TRU")?.country, "HU", "Audi Hungaria builds under its own WMI");
  assert.equal(lookupWmi("5YJ")?.brand, "Tesla");
  assert.equal(lookupWmi("JTD")?.country, "JP");
});

test("lookup normalises case and a longer VIN, and never guesses", () => {
  assert.equal(lookupWmi("wvw")?.brand, lookupWmi("WVW")?.brand);
  assert.equal(lookupWmi("WVWZZZ1JZHW000001")?.brand, "Volkswagen", "only the first three count");
  assert.equal(lookupWmi(undefined), undefined);
  assert.equal(lookupWmi(""), undefined);
  assert.equal(lookupWmi("QQQ"), undefined, "an unknown WMI must stay unknown (AGENTS 24)");
});

test("the table is internally consistent", () => {
  const entries = knownWmis();
  assert.ok(entries.length >= 40, `expected a usable table, found ${entries.length}`);
  const wmis = entries.map((entry) => entry.wmi);
  assert.equal(new Set(wmis).size, wmis.length, "a WMI must not be assigned twice");
  for (const entry of entries) {
    assert.match(entry.wmi, /^[A-HJ-NPR-Z0-9]{3}$/, `${entry.wmi} is not a valid WMI shape`);
    assert.ok(entry.manufacturer.length > 0, `${entry.wmi} has no manufacturer`);
    if (entry.country) assert.match(entry.country, /^[A-Z]{2}$/, `${entry.wmi}: country code`);
  }
});

test("the returned entries are copies, so a caller cannot edit the table", () => {
  const first = knownWmis()[0];
  assert.ok(first);
  first.manufacturer = "edited";
  assert.equal(lookupWmi(first.wmi)?.manufacturer !== "edited", true);
});

test("the table declares where it came from and that it is not exhaustive", () => {
  assert.equal(WMI_PROVENANCE.sourceType, "own");
  assert.ok(WMI_PROVENANCE.source.length > 0);
  assert.match(WMI_PROVENANCE.notes ?? "", /not exhaustive/i);
});

test("regions follow the ISO 3780 first-character assignment", () => {
  assert.equal(regionForVin("WVWZZZ1JZHW000001"), "Europe");
  assert.equal(regionForVin("TMB12345678901234"), "Europe");
  assert.equal(regionForVin("JTDKN123456789012"), "Asia");
  assert.equal(regionForVin("5YJ3E1EA1LF000001"), "North America");
  assert.equal(regionForVin("9BWZZZ1JZHW000001"), "South America");
  assert.equal(regionForVin("6AB12345678901234"), "Oceania");
  assert.equal(regionForVin("7AB12345678901234"), "Oceania");
  assert.equal(regionForVin("ABC12345678901234"), "Africa");
  assert.equal(regionForVin("HBC12345678901234"), "Africa");
});

test("a region is only reported for a VIN that has a first character", () => {
  assert.equal(regionForVin(undefined), undefined);
  assert.equal(regionForVin(""), undefined);
});

test("a first character ISO 3780 does not assign has no region", () => {
  // I, O and Q are excluded from VINs altogether, so nothing is invented for
  // them: "unknown" is the honest answer, not "Europe" or "Asia".
  assert.equal(regionForVin("IOQ12345678901234"), undefined);
});
