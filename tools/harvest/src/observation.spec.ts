/**
 * The observation vocabulary (ADR 0058).
 *
 * These are the small rules the whole tool rests on: one ECU id rule (so the
 * record, the ODX file and the definition candidate name the same module the same
 * way), one VIN masking rule (so a personal datum does not leave the tool by
 * accident) and one "is this printable" rule (so an ASCII hint is only ever shown
 * when every byte supports it).
 */

import assert from "node:assert/strict";
import { test } from "vitest";
import {
  ecuIdOf,
  HARVEST_VERSION,
  type HarvestReport,
  printableAscii,
  redactVin,
  summariseHarvest,
} from "./observation.js";

test("the ECU id is derived from the response address, in one rule", () => {
  assert.equal(ecuIdOf(0x7e8, false), "ecu-7e8");
  assert.equal(ecuIdOf(0x77b, false), "ecu-77b");
  assert.equal(ecuIdOf(0x18daf110, true), "ecu-18daf110", "29-bit addresses keep all eight digits");
  assert.equal(ecuIdOf(0x10, false), "ecu-010", "a short address is padded, not truncated");
});

test("the VIN is masked by default, keeping the positions a definition matches on", () => {
  // 17 positions: the WMI (3) and the tail (4) stay, the 10 in between are masked.
  assert.equal(redactVin("1HGCM82633A004352"), "1HG**********4352");
  assert.equal(
    redactVin("WVWZZZ3CZWE123456").slice(0, 3),
    "WVW",
    "the WMI survives — it is what a package matches on",
  );
  assert.equal(
    redactVin("WVWZZZ3CZWE123456").slice(-4),
    "3456",
    "the plant and serial tail survives for a comparison",
  );
  assert.equal(redactVin("SHORT").length, 5, "a too-short value is masked completely");
  assert.equal(redactVin("SHORT"), "*****");
});

test("an ASCII hint appears only when every byte is printable", () => {
  assert.equal(printableAscii([0x57, 0x56, 0x57]), "WVW");
  assert.equal(printableAscii([0x41, 0x42, 0x20, 0x7e]), "AB ~", "space and tilde are printable");
  assert.equal(printableAscii([0x41, 0x00, 0x42]), undefined, "a NUL byte ends the claim");
  assert.equal(printableAscii([0x41, 0xff]), undefined, "a byte above 0x7e ends the claim");
  assert.equal(printableAscii([]), undefined, "no bytes is no string");
});

test("the summary names both halves: what answered and what did not", () => {
  const summary = summariseHarvest(report({ ecusAnswered: 3, addressesUnread: 2 }));
  assert.match(summary, /3 ECU\(s\) gelesen/);
  assert.match(summary, /2 Adresse\(n\) ohne Antwort/);
  assert.match(summary, /Anfragen/);
});

test("the record format is versioned, so an older reader can say no", () => {
  assert.equal(HARVEST_VERSION, 1);
  assert.equal(report({}).version, HARVEST_VERSION);
  assert.equal(report({}).kind, "vdp.harvest");
});

function report(counts: Partial<HarvestReport["counts"]>): HarvestReport {
  return {
    kind: "vdp.harvest",
    version: HARVEST_VERSION,
    identity: { source: "test", platformVersion: "0.1.0" },
    bus: { addressing: "11-bit", functionalId: 0x7df },
    startedAt: "2026-09-23T10:00:00.000Z",
    finishedAt: "2026-09-23T10:00:05.000Z",
    durationMs: 5_000,
    plan: {
      services: [0x19, 0x22],
      sessions: [0x01],
      didRanges: [{ from: 0xf180, to: 0xf1ff }],
      standardDids: [0xf190],
      dtcRecordNumbers: [0xff, 0x01],
      budgetPerEcuMs: 20_000,
      requestGapMs: 5,
    },
    ecus: [],
    unread: [],
    counts: {
      ecusAnswered: 0,
      addressesUnread: 0,
      didsRead: 0,
      didsRefused: 0,
      dtcsFound: 0,
      snapshotsRead: 0,
      requestsSent: 0,
      ...counts,
    },
    notes: [],
  };
}
