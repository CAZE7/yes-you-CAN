/**
 * DtcScanner — definition enrichment, grouping and before/after comparison
 * (AGENTS 20).
 *
 * The scanner is the only place where a fault code meets a definition package, and
 * the only place where "what changed" is decided. Both are read by a human to
 * judge whether a repair worked, so the rules are pinned here:
 *
 * - nothing is invented: a code without a definition stays without a description;
 * - a definition from the *first* matching package wins, so a base package cannot
 *   be overwritten by an OEM one loaded after it;
 * - a comparison is keyed per ECU, because the same code on two ECUs is two faults;
 * - variant knowledge is layered on top of the package wording only while a
 *   vehicle is bound, and every record says which of the two it is showing
 *   (`knowledge.scope`) — a package text never poses as variant knowledge (§24).
 *
 * First/last seen tracking lives in `dtc-tracker.spec.ts`, the write path in
 * `dtc.spec.ts`.
 */

import assert from "node:assert/strict";
import {
  CURRENT_SCHEMA_VERSION,
  type DefinitionPackage,
  type EcuDefinition,
} from "@vdp/definitions";
import { describeEvidence, isProven } from "@vdp/diagnostic-ir";
import { type DtcRecord, decodeDtcStatus, dtcSeverity } from "@vdp/protocols-uds";
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { DtcScanner, type EnrichedDtc, toEnrichedDtc } from "./scanner.js";

function record(code: string, status = 0x08): DtcRecord {
  const statusBits = decodeDtcStatus(status);
  return {
    code,
    raw: code,
    failureType: "00",
    status,
    statusBits,
    severity: dtcSeverity(statusBits),
  };
}

/** A package with exactly the shape the scanner reads — no more. */
function packageWith(
  ecus: EcuDefinition[],
  signals: DefinitionPackage["signals"] = [],
): DefinitionPackage {
  return {
    schemaVersion: 1,
    oem: "test",
    name: "scanner fixture",
    version: "1.0.0",
    provenance: { sourceType: "own", source: "unit test fixture" },
    ecus,
    signals,
  };
}

const FULL_PACKAGE = packageWith(
  [
    {
      id: "engine",
      name: "Engine Control Unit",
      address: { txId: 0x7e0, rxId: 0x7e8 },
      protocol: "uds",
      dtcs: [
        {
          code: "P0420",
          description: "Catalyst efficiency below threshold",
          hint: "check rear O2 sensor trace before replacing the cat",
          severity: "major",
          relatedSignals: ["engine.rpm", "engine.long_term_fuel_trim", "not.in.this.package"],
        },
        { code: "P0171", description: "System too lean" },
      ],
    },
    {
      id: "abs",
      name: "ABS Module",
      address: { txId: 0x7e2, rxId: 0x7ea },
      protocol: "uds",
      dtcs: [{ code: "P0420", description: "SHOULD NEVER WIN — same code, second ECU" }],
    },
  ],
  [
    {
      id: "engine.rpm",
      name: "Engine speed",
      ecu: "engine",
      did: 0xf40c,
      byteOffset: 0,
      length: 2,
      encoding: "uint16",
    },
    {
      id: "engine.long_term_fuel_trim",
      name: "Long term fuel trim",
      ecu: "engine",
      did: 0xf407,
      byteOffset: 0,
      length: 1,
      encoding: "int8",
    },
  ],
);

/** Second package: shares P0171 with a different text, and adds C1234. */
const EXTRA_PACKAGE = packageWith([
  {
    id: "gearbox",
    name: "Transmission",
    address: { txId: 0x7e3, rxId: 0x7eb },
    protocol: "uds",
    dtcs: [
      { code: "P0171", description: "OEM lean detection (different wording)" },
      { code: "C1234", description: "Wheel speed sensor circuit", severity: "critical" },
    ],
  },
]);

/** Minutes advance per clock call, so first/last seen stay distinguishable. */
function scannerOf(...packages: DefinitionPackage[]): DtcScanner {
  let minute = 0;
  return new DtcScanner({
    definitions: packages,
    clock: () => new Date(Date.UTC(2026, 2, 1, 9, minute++)),
  });
}

/** Turn a plain record into the enriched shape `compare` consumes. */
function enriched(
  code: string,
  options: { status?: number; ecuId?: string; ecuName?: string } = {},
): EnrichedDtc {
  const status = options.status ?? 0x08;
  return {
    ...record(code, status),
    ecuName: options.ecuName ?? "Engine Control Unit",
    ecuId: options.ecuId ?? "engine",
  };
}

/* ------------------------------------------------------------- definitions */

describe("DtcScanner — enrichment from definition packages", () => {
  test("a documented code gains description, hint, severity and its related signals", () => {
    const scanner = scannerOf(FULL_PACKAGE);
    const [dtc] = scanner.enrich([record("P0420", 0x2f)], "Engine Control Unit", "engine");
    assert.ok(dtc);
    assert.equal(dtc.description, "Catalyst efficiency below threshold");
    assert.equal(dtc.hint, "check rear O2 sensor trace before replacing the cat");
    assert.equal(dtc.severity, "major");
    assert.equal(dtc.ecuName, "Engine Control Unit");
    assert.equal(dtc.ecuId, "engine");
    assert.deepEqual(dtc.relatedSignals, [
      { id: "engine.rpm", name: "Engine speed" },
      { id: "engine.long_term_fuel_trim", name: "Long term fuel trim" },
    ]);
  });

  test("related signals the package does not define are dropped, not guessed", () => {
    const scanner = scannerOf(FULL_PACKAGE);
    const [dtc] = scanner.enrich([record("P0420")], "Engine", "engine");
    assert.ok(
      dtc?.relatedSignals?.every((entry) => entry.name !== entry.id),
      "every surviving entry resolved to a display name",
    );
    assert.equal(
      dtc?.relatedSignals?.some((entry) => entry.id === "not.in.this.package"),
      false,
    );
  });

  test("an undocumented code keeps its own fields and invents nothing", () => {
    const scanner = scannerOf(FULL_PACKAGE);
    const [dtc] = scanner.enrich([record("U0121", 0x01)], "Gateway", "gateway");
    assert.ok(dtc);
    assert.equal(dtc.description, undefined);
    assert.equal(dtc.hint, undefined);
    assert.equal(dtc.relatedSignals, undefined);
    assert.ok(
      !("description" in dtc),
      "the key is absent, not empty — a report must not print an empty row",
    );
    assert.equal(dtc.severity, "critical", "severity falls back to what the status bits say");
    assert.equal(dtc.statusBits.testFailed, true);
  });

  test("a definition without severity keeps the record severity instead of defaulting", () => {
    const scanner = scannerOf(FULL_PACKAGE);
    const [lean] = scanner.enrich([record("P0171", 0x08)], "Engine", "engine");
    assert.equal(lean?.description, "System too lean");
    assert.equal(lean?.severity, "major", "confirmed but not failing → major, from the bits");
    assert.ok(lean && !("hint" in lean), "no hint was documented, so none is added");
  });

  test("the first package that documents a code wins, and a later ECU cannot shadow it", () => {
    // P0420 appears on two ECUs of one package and P0171 in both packages: the
    // first sighting is what a session recorded with stays recorded with, so a
    // stored session never changes its wording because a package was reordered.
    const scanner = scannerOf(FULL_PACKAGE, EXTRA_PACKAGE);
    assert.equal(scanner.describe("P0420"), "Catalyst efficiency below threshold");
    assert.equal(scanner.describe("P0171"), "System too lean");
    assert.equal(
      scanner.describe("C1234"),
      "Wheel speed sensor circuit",
      "a code only the second package knows is still resolved",
    );
  });

  test("definitionOf and describe answer the same table, definitionOf case-insensitively", () => {
    const scanner = scannerOf(FULL_PACKAGE);
    assert.deepEqual(scanner.definitionOf("P0420"), {
      description: "Catalyst efficiency below threshold",
      hint: "check rear O2 sensor trace before replacing the cat",
      severity: "major",
      relatedSignals: [
        { id: "engine.rpm", name: "Engine speed" },
        { id: "engine.long_term_fuel_trim", name: "Long term fuel trim" },
      ],
    });
    assert.equal(
      scanner.definitionOf("p0420")?.description,
      "Catalyst efficiency below threshold",
      "the lookup upper-cases",
    );
    assert.equal(
      scanner.describe("p0420"),
      undefined,
      "describe does not — a code is always read from a DTC record, where the ECU spells it upper case",
    );
    assert.equal(scanner.describe("C9999"), undefined);
    assert.equal(scanner.definitionOf("C9999"), undefined);
  });

  test("a scanner without definitions still stamps ECU, severity and the scan window", () => {
    const scanner = new DtcScanner({ clock: () => new Date("2026-03-01T09:00:00.000Z") });
    const [dtc] = scanner.enrich([record("P0420", 0x09)], "Engine", "engine");
    assert.ok(dtc);
    assert.equal(dtc.description, undefined);
    assert.equal(dtc.firstSeen, "2026-03-01T09:00:00.000Z");
    assert.equal(dtc.lastSeen, "2026-03-01T09:00:00.000Z");
    assert.equal(dtc.firstSeenInThisScan, true);
    assert.equal(dtc.severity, "critical", "0x09 has testFailed set");
  });

  test("the input records are never mutated", () => {
    const scanner = scannerOf(FULL_PACKAGE);
    const input = record("P0420", 0x2f);
    const [dtc] = scanner.enrich([input], "Engine", "engine");
    assert.ok(dtc);
    assert.notEqual(dtc, input, "enrichment returns new objects");
    assert.deepEqual(
      Object.keys(input).sort(),
      ["code", "failureType", "raw", "severity", "status", "statusBits"].sort(),
      "the record the caller handed in still has only its own fields",
    );
  });

  test("enriching an empty scan is an empty result", () => {
    const scanner = scannerOf(FULL_PACKAGE);
    assert.deepEqual(scanner.enrich([], "Engine", "engine"), []);
  });
});

/* ---------------------------------------------------------------- groups */

describe("DtcScanner — severity grouping and summary", () => {
  test("groupBySeverity returns all four buckets, always present and empty when unused", () => {
    const scanner = scannerOf(FULL_PACKAGE);
    const groups = scanner.groupBySeverity([
      enriched("P0420", { status: 0x2f }),
      enriched("P0171", { status: 0x08 }),
      enriched("C1234", { status: 0x04 }),
      enriched("U0100", { status: 0x00 }),
    ]);
    assert.deepEqual(Object.keys(groups).sort(), ["critical", "info", "major", "minor"]);
    assert.deepEqual(
      groups.critical.map((dtc) => dtc.code),
      ["P0420"],
    );
    assert.deepEqual(
      groups.major.map((dtc) => dtc.code),
      ["P0171"],
    );
    assert.deepEqual(
      groups.minor.map((dtc) => dtc.code),
      ["C1234"],
    );
    assert.deepEqual(
      groups.info.map((dtc) => dtc.code),
      ["U0100"],
    );
  });

  test("groupBySeverity of an empty scan is four empty buckets", () => {
    const groups = scannerOf().groupBySeverity([]);
    assert.deepEqual(groups, { critical: [], major: [], minor: [], info: [] });
  });

  test("an out-of-contract severity is a crash, not a silently dropped fault", () => {
    const scanner = scannerOf();
    const bogus = { ...enriched("P0420"), severity: "catastrophic" } as unknown as EnrichedDtc;
    expect(() => scanner.groupBySeverity([bogus])).toThrow(TypeError);
  });

  test("summary counts per severity, totals duplicates and lists codes once", () => {
    const scanner = scannerOf();
    const summary = scanner.summary([
      enriched("P0420", { status: 0x2f, ecuId: "engine" }),
      enriched("P0420", { status: 0x2f, ecuId: "transmission", ecuName: "Gearbox" }),
      enriched("P0171", { status: 0x08 }),
      enriched("U0100", { status: 0x00 }),
    ]);
    assert.equal(summary.total, 4, "two ECUs with the same code are two findings");
    assert.equal(summary.critical, 2);
    assert.equal(summary.major, 1);
    assert.equal(summary.info, 1);
    assert.equal(summary.minor, 0);
    assert.deepEqual(
      summary.codes,
      ["P0171", "P0420", "U0100"],
      "the code list is de-duplicated and sorted",
    );
  });

  test("summary of nothing is zeros, not an error", () => {
    assert.deepEqual(scannerOf().summary([]), {
      total: 0,
      critical: 0,
      major: 0,
      minor: 0,
      info: 0,
      codes: [],
    });
  });
});

/* --------------------------------------------------------------- compare */

describe("DtcScanner.compare — before/after a repair or a clear", () => {
  test("identical scans report everything as unchanged", () => {
    const scanner = scannerOf();
    const before = [enriched("P0420"), enriched("P0171")];
    const after = [enriched("P0420"), enriched("P0171")];
    const result = scanner.compare(before, after);
    assert.deepEqual(result.added, []);
    assert.deepEqual(result.removed, []);
    assert.deepEqual(result.changed, []);
    assert.equal(result.unchanged.length, 2);
    assert.equal(
      result.unchanged[0],
      after[0],
      "the entries are the after-records, so a caller can read their timestamps",
    );
  });

  test("an empty fault memory after a clear is a full removal", () => {
    const scanner = scannerOf();
    const before = [enriched("P0420", { status: 0x2f }), enriched("P0300", { status: 0x08 })];
    const result = scanner.compare(before, []);
    assert.deepEqual(
      result.removed.map((dtc) => dtc.code),
      ["P0420", "P0300"],
    );
    assert.deepEqual(result.added, []);
    assert.deepEqual(result.unchanged, []);
    assert.equal(result.removed[0], before[0], "removed entries come from the before-scan");
  });

  test("a fresh scan with no history is a full addition", () => {
    const scanner = scannerOf();
    const after = [enriched("P0420")];
    const result = scanner.compare([], after);
    assert.deepEqual(result.added, after);
    assert.deepEqual(result.removed, []);
    assert.deepEqual(result.unchanged, []);
  });

  test('the same code on a different ECU is one removal plus one addition, never "unchanged"', () => {
    const scanner = scannerOf();
    const result = scanner.compare(
      [enriched("P0420", { ecuId: "engine" })],
      [enriched("P0420", { ecuId: "gearbox" })],
    );
    assert.deepEqual(
      result.removed.map((dtc) => dtc.ecuId),
      ["engine"],
    );
    assert.deepEqual(
      result.added.map((dtc) => dtc.ecuId),
      ["gearbox"],
    );
    assert.deepEqual(result.unchanged, []);
    assert.deepEqual(result.changed, []);
  });

  test("only the status bits changing is a change, with both values and the ECU name", () => {
    const scanner = scannerOf();
    const result = scanner.compare(
      [enriched("P0420", { status: 0x2f, ecuName: "Engine Control Unit" })],
      [enriched("P0420", { status: 0x08, ecuName: "Engine Control Unit" })],
    );
    assert.deepEqual(result.changed, [
      { code: "P0420", before: 0x2f, after: 0x08, ecuName: "Engine Control Unit" },
    ]);
    assert.deepEqual(result.added, []);
    assert.deepEqual(result.removed, []);
    assert.deepEqual(
      result.unchanged,
      [],
      'a code that is still there but differently bad is not "unchanged"',
    );
  });

  test("a status change is per ECU, and only codes present on both sides can change", () => {
    const scanner = scannerOf();
    const result = scanner.compare(
      [
        enriched("P0420", { ecuId: "engine", status: 0x2f }),
        enriched("P0171", { ecuId: "engine", status: 0x08 }),
      ],
      [
        enriched("P0420", { ecuId: "engine", status: 0x08 }),
        enriched("P0420", { ecuId: "gearbox", status: 0x2f }),
      ],
    );
    assert.deepEqual(result.changed, [
      { code: "P0420", before: 0x2f, after: 0x08, ecuName: "Engine Control Unit" },
    ]);
    assert.deepEqual(
      result.removed.map((dtc) => dtc.code),
      ["P0171"],
    );
    assert.deepEqual(
      result.added.map((dtc) => `${dtc.ecuId}:${dtc.code}`),
      ["gearbox:P0420"],
    );
  });

  test("identity is normalised, the reported spelling survives", () => {
    // P0 #6 (ADR 0037): one identity rule for the whole DTC path. The tracker,
    // the knowledge lookup and the comparison all use `ECU + code` normalised —
    // "p0420" and "P0420" are the same three bytes of ISO 14229-1, so they are
    // the same fault. The *text* the ECU produced is what a record shows, which
    // is where a spelling change stays visible instead of being compared away.
    const scanner = scannerOf();
    const result = scanner.compare([enriched("P0420")], [enriched("p0420")]);
    assert.deepEqual(result.removed, []);
    assert.deepEqual(result.added, []);
    assert.deepEqual(result.changed, []);
    assert.equal(result.unchanged.length, 1);
    assert.equal(
      result.unchanged[0]?.code,
      "p0420",
      "the after-side keeps the spelling it was reported with",
    );

    const different = scanner.compare([enriched("P0420")], [enriched("P0421")]);
    assert.deepEqual(
      different.removed.map((dtc) => dtc.code),
      ["P0420"],
      "a genuinely different code is still loud",
    );
    assert.deepEqual(
      different.added.map((dtc) => dtc.code),
      ["P0421"],
    );
  });

  test("a duplicated code on one ECU collapses in the maps and repeats in the lists", () => {
    const scanner = scannerOf();
    const before = [enriched("P0420", { status: 0x00 }), enriched("P0420", { status: 0x2f })];
    const after = [enriched("P0420", { status: 0x08 }), enriched("P0420", { status: 0x08 })];
    const result = scanner.compare(before, after);
    // The map keeps the *last* duplicate as the reference for both after-records,
    // and both after-records are classified against it.
    assert.equal(result.unchanged.length, 0);
    assert.deepEqual(result.changed, [
      { code: "P0420", before: 0x2f, after: 0x08, ecuName: "Engine Control Unit" },
      { code: "P0420", before: 0x2f, after: 0x08, ecuName: "Engine Control Unit" },
    ]);
    assert.deepEqual(result.added, []);
    assert.equal(result.removed.length, 0, "the code is still present, so nothing was removed");
  });

  test("freeze frame and extended data on the after-side survive into unchanged", () => {
    const scanner = scannerOf();
    const withSnapshot: EnrichedDtc = {
      ...enriched("P0420"),
      snapshot: new Uint8Array([0x0c, 0x30]),
    };
    const result = scanner.compare([withSnapshot], [withSnapshot]);
    assert.deepEqual(result.unchanged, [withSnapshot]);
    assert.equal(
      result.unchanged[0]?.snapshot?.length,
      2,
      "the comparison carries the records through, it does not rebuild them",
    );
  });

  test("order of both sides is preserved", () => {
    const scanner = scannerOf();
    const before = ["P0420", "P0171", "P0300"].map((code) => enriched(code));
    const after = ["P0300", "P0505", "P0171"].map((code) => enriched(code));
    const result = scanner.compare(before, after);
    assert.deepEqual(
      result.unchanged.map((dtc) => dtc.code),
      ["P0300", "P0171"],
    );
    assert.deepEqual(
      result.added.map((dtc) => dtc.code),
      ["P0505"],
    );
    assert.deepEqual(
      result.removed.map((dtc) => dtc.code),
      ["P0420"],
    );
  });

  test("comparing two empty scans is four empty buckets", () => {
    assert.deepEqual(scannerOf().compare([], []), {
      added: [],
      removed: [],
      changed: [],
      unchanged: [],
    });
  });

  test("a comparison is pure: both input lists are untouched", () => {
    const scanner = scannerOf();
    const before = [enriched("P0420", { status: 0x2f })];
    const after = [enriched("P0420", { status: 0x08 }), enriched("P0171")];
    scanner.compare(before, after);
    assert.equal(before.length, 1);
    assert.equal(after.length, 2);
    assert.equal(
      before[0]?.status,
      0x2f,
      "the before-scan keeps its own status after being compared",
    );
  });
});

/**
 * FULL_PACKAGE plus one vehicle variant that documents its own faults. Two
 * engines on purpose: knowledge for one of them must not leak into the other.
 */
function knowledgePackage(): DefinitionPackage {
  return {
    ...FULL_PACKAGE,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    vehicles: [
      {
        id: "variant",
        brand: "Fixture",
        model: "Variant",
        engines: [
          { id: "petrol", name: "Petrol" },
          { id: "diesel", name: "Diesel" },
        ],
        gearboxes: [{ id: "auto", name: "Automatic" }],
        ecus: [{ ecu: "engine", engine: "petrol" }],
        provenance: { sourceType: "own", source: "unit test fixture" },
        dtcKnowledge: [
          {
            code: "P0420",
            ecu: "engine",
            engine: "petrol",
            description: "Catalyst efficiency on the petrol variant",
            severity: "critical",
            hint: "measure the trims in closed loop first",
            conditions: "only in closed loop above 80 °C",
            relatedSignals: ["engine.long_term_fuel_trim", "not.in.this.package"],
            provenance: {
              sourceType: "licensed",
              source: "workshop manual",
              license: "contract",
            },
            patterns: [
              {
                id: "catalyst-aged",
                name: "Aged catalyst",
                likelihood: "common",
                repair: "replace it only after the checks hold",
                checks: [
                  {
                    signal: "engine.long_term_fuel_trim",
                    expect: "neutral",
                    min: -5,
                    max: 5,
                  },
                ],
              },
            ],
          },
          { code: "P0171", engine: "diesel", description: "Lean correction on the diesel variant" },
          {
            code: "C1234",
            gearbox: "auto",
            description: "Wheel speed plausibility on the automatic",
            patterns: [{ id: "no-window", name: "Only prose" }],
          },
        ],
      },
    ],
  };
}

const ENGINE_REF = { oem: "test", ecu: "engine" };
const PETROL_VARIANT = { oem: "test", vehicleId: "variant", engineIds: ["petrol"] };

test("without a bound vehicle nothing is claimed to be variant knowledge", () => {
  const scanner = scannerOf(knowledgePackage());
  const [dtc] = scanner.enrich([record("P0420")], "Engine Control Unit", "engine", ENGINE_REF);
  assert.equal(dtc?.description, "Catalyst efficiency below threshold");
  assert.equal(dtc?.severity, "major");
  assert.equal(dtc?.knowledge, undefined, "no car is resolved, so no variant answer exists");
  assert.equal(scanner.vehicleContext, undefined);
});

test("the resolved variant overrides wording, severity and related signals", () => {
  const scanner = scannerOf(knowledgePackage());
  scanner.setVehicle(PETROL_VARIANT);
  const [dtc] = scanner.enrich([record("P0420")], "Engine Control Unit", "engine", ENGINE_REF);
  assert.ok(dtc);
  assert.equal(dtc.description, "Catalyst efficiency on the petrol variant");
  assert.equal(dtc.hint, "measure the trims in closed loop first");
  assert.equal(dtc.severity, "critical", "the variant severity replaces the package one");
  assert.deepEqual(
    dtc.relatedSignals,
    [
      { id: "engine.rpm", name: "Engine speed" },
      { id: "engine.long_term_fuel_trim", name: "Long term fuel trim" },
    ],
    "package and variant signals are merged, once each, and only ids the package defines",
  );

  const knowledge = dtc.knowledge;
  assert.ok(knowledge, "the record says what the variant adds");
  assert.equal(knowledge.scope, "vehicle-engine");
  assert.equal(knowledge.vehicleId, "variant");
  assert.equal(knowledge.conditions, "only in closed loop above 80 °C");
  assert.equal(knowledge.provenanceType, "licensed");
  assert.equal(knowledge.provenanceSource, "workshop manual");
  assert.deepEqual(knowledge.notes, []);
  assert.deepEqual(
    knowledge.patterns.map((pattern) => pattern.id),
    ["catalyst-aged"],
  );
  assert.deepEqual(knowledge.patterns[0]?.checks, [
    {
      signal: "engine.long_term_fuel_trim",
      signalName: "Long term fuel trim",
      expect: "neutral",
      min: -5,
      max: 5,
      measurable: true,
    },
  ]);
});

test("knowledge for another engine stays where it belongs", () => {
  const scanner = scannerOf(knowledgePackage());
  scanner.setVehicle({ oem: "test", vehicleId: "variant", engineIds: ["diesel"] });
  const [catalyst, lean] = scanner.enrich(
    [record("P0420"), record("P0171")],
    "Engine Control Unit",
    "engine",
    ENGINE_REF,
  );
  assert.equal(catalyst?.description, "Catalyst efficiency below threshold");
  assert.equal(catalyst?.severity, "major");
  assert.equal(catalyst?.knowledge?.scope, "package");
  assert.ok(
    catalyst?.knowledge?.notes.some((note) => note.includes("no variant-specific knowledge")),
    catalyst?.knowledge?.notes.join(" | "),
  );
  assert.equal(lean?.description, "Lean correction on the diesel variant");
  assert.equal(lean?.knowledge?.scope, "vehicle-engine");
});

test("a gearbox-scoped entry answers for the gearbox the resolution named", () => {
  const scanner = scannerOf(knowledgePackage(), EXTRA_PACKAGE);
  scanner.setVehicle({ oem: "test", vehicleId: "variant", gearboxIds: ["auto"] });
  const [dtc] = scanner.enrich([record("C1234")], "Transmission", "gearbox", {
    oem: "test",
    ecu: "gearbox",
  });
  assert.equal(dtc?.description, "Wheel speed plausibility on the automatic");
  assert.equal(dtc?.knowledge?.scope, "vehicle-gearbox");
  assert.ok(
    dtc?.knowledge?.notes.some((note) => note.includes("no numeric window")),
    dtc?.knowledge?.notes.join(" | "),
  );
});

test("a code nothing documents stays without an answer", () => {
  const scanner = scannerOf(knowledgePackage());
  scanner.setVehicle(PETROL_VARIANT);
  const [dtc] = scanner.enrich([record("B9999")], "Engine Control Unit", "engine", ENGINE_REF);
  assert.equal(dtc?.description, undefined);
  assert.equal(dtc?.knowledge, undefined);
});

test("the ECU that reported the code supplies the manufacturer", () => {
  const scanner = scannerOf(knowledgePackage());
  // No oem in the context: the definition reference of the answering ECU says
  // which package the knowledge has to come from.
  scanner.setVehicle({ vehicleId: "variant", engineIds: ["petrol"] });
  const [dtc] = scanner.enrich([record("P0420")], "Engine Control Unit", "engine", ENGINE_REF);
  assert.equal(dtc?.description, "Catalyst efficiency on the petrol variant");
});

test("rebinding another vehicle replaces the cached knowledge", () => {
  const scanner = scannerOf(knowledgePackage());
  scanner.setVehicle(PETROL_VARIANT);
  const [petrol] = scanner.enrich([record("P0420")], "Engine Control Unit", "engine", ENGINE_REF);
  assert.equal(petrol?.description, "Catalyst efficiency on the petrol variant");

  scanner.setVehicle({ oem: "test", vehicleId: "variant", engineIds: ["diesel"] });
  const [diesel] = scanner.enrich([record("P0420")], "Engine Control Unit", "engine", ENGINE_REF);
  assert.equal(diesel?.description, "Catalyst efficiency below threshold");

  scanner.setVehicle(undefined);
  const [unbound] = scanner.enrich([record("P0420")], "Engine Control Unit", "engine", ENGINE_REF);
  assert.equal(unbound?.knowledge, undefined, "detaching removes every variant claim");
  assert.equal(unbound?.description, "Catalyst efficiency below threshold");
});

test("knowledge survives a repeated scan of the same ECU unchanged", () => {
  const scanner = scannerOf(knowledgePackage());
  scanner.setVehicle(PETROL_VARIANT);
  const first = scanner.enrich([record("P0420")], "Engine Control Unit", "engine", ENGINE_REF);
  const second = scanner.enrich([record("P0420")], "Engine Control Unit", "engine", ENGINE_REF);
  assert.deepEqual(second[0]?.knowledge, first[0]?.knowledge);
  assert.equal(second[0]?.firstSeenInThisScan, false, "the code was already there");
  assert.equal(second[0]?.firstSeen, first[0]?.firstSeen);
});

test("a comparison keeps the variant knowledge of the scan it came from", () => {
  const scanner = scannerOf(knowledgePackage());
  scanner.setVehicle(PETROL_VARIANT);
  const before: EnrichedDtc[] = scanner.enrich(
    [record("P0420")],
    "Engine Control Unit",
    "engine",
    ENGINE_REF,
  );
  const after: EnrichedDtc[] = scanner.enrich(
    [record("P0420", 0x00)],
    "Engine Control Unit",
    "engine",
    ENGINE_REF,
  );
  const comparison = scanner.compare(before, after);
  assert.equal(comparison.changed.length, 1);
  assert.equal(after[0]?.knowledge?.scope, "vehicle-engine");
});

/* ---------------------------------------------------- the IR underneath (P0 #6) */

describe("DtcScanner.observe — the IR the projection is made of", () => {
  test("the ECU's answer and the package's claim are two halves with two proofs", () => {
    const scanner = scannerOf(FULL_PACKAGE);
    const [scan] = scanner.observe(
      [
        {
          ...record("P0420", 0x2f),
          snapshot: new Uint8Array([0x0c, 0x30]),
          extendedData: new Uint8Array([0x01, 0x02]),
        },
      ],
      "Engine Control Unit",
      "engine",
      { oem: "test", ecu: "engine" },
    );
    assert.ok(scan);
    const { observation, enrichment } = scan.state;
    assert.equal(observation.kind, "dtc");
    assert.equal(observation.ecuId, "engine");
    assert.equal(observation.status, 0x2f);
    assert.deepEqual(Array.from(observation.snapshot ?? []), [0x0c, 0x30]);
    assert.deepEqual(Array.from(observation.extendedData ?? []), [0x01, 0x02]);
    assert.ok(isProven(observation.evidence), "the ECU answered, so the record is proven");
    assert.equal(observation.evidence.provenance.serviceId, 0x19);
    // Which definition the claim was made under travels with the claim (AGENTS 13).
    assert.equal(observation.evidence.provenance.definitionVersion, "1.0.0");
    assert.ok(enrichment);
    assert.equal(enrichment.description, "Catalyst efficiency below threshold");
    assert.equal(enrichment.severity, "major");
    assert.ok(isProven(enrichment.evidence));
    assert.equal(enrichment.evidence.provenance.origin, "definition");
  });

  test("an undocumented code keeps the observation and loses the claim, visibly", () => {
    const scanner = scannerOf(FULL_PACKAGE);
    const [scan] = scanner.observe([record("C9999")], "Gateway", "gateway");
    assert.ok(scan);
    assert.equal(scan.state.observation.code, "C9999");
    assert.equal(scan.knowledge, undefined);
    const enrichment = scan.state.enrichment;
    assert.ok(enrichment, "an undocumented code still gets an enrichment - with unproven evidence");
    assert.equal(enrichment.evidence.kind, "unproven");
    assert.match(describeEvidence(enrichment.evidence), /no description/);
    assert.equal(scan.state.firstSeenInThisScan, true);
  });

  test("two entry points, one code path: enrich is the projection of observe", () => {
    const records = [record("P0420", 0x2f), record("P0171"), record("C9999")];
    const projected = scannerOf(FULL_PACKAGE);
    const observed = scannerOf(FULL_PACKAGE);
    assert.deepEqual(
      projected.enrich(records, "Engine Control Unit", "engine", { oem: "test", ecu: "engine" }),
      observed
        .observe(records, "Engine Control Unit", "engine", {
          oem: "test",
          ecu: "engine",
        })
        .map(toEnrichedDtc),
    );
  });

  test("the projection carries one line of provenance so a stored record keeps its source", () => {
    const scanner = scannerOf(FULL_PACKAGE);
    const [documented, undocumented] = scanner.enrich(
      [record("P0420", 0x2f), record("C9999")],
      "Engine Control Unit",
      "engine",
      { oem: "test", ecu: "engine" },
    );
    assert.match(documented?.evidence ?? "", /^definition · /);
    assert.match(documented?.evidence ?? "", /def 1\.0\.0/);
    assert.match(undocumented?.evidence ?? "", /^not proven \(engine\): /);
    assert.match(undocumented?.evidence ?? "", /no description, hint, severity or related signal/);
  });

  test("a claim about urgency wins over the byte rule, and the byte rule is never restated", () => {
    const scanner = scannerOf(FULL_PACKAGE);
    const [dtc] = scanner.enrich([record("P0420")], "Engine Control Unit", "engine", {
      oem: "test",
      ecu: "engine",
    });
    assert.equal(dtc?.severity, "major", "the package declares it major, the status byte does not");
    const [bare] = scanner.enrich([record("C9999", 0x08)], "Gateway", "gateway");
    assert.equal(
      bare?.severity,
      dtcSeverity(decodeDtcStatus(0x08)),
      "without a claim the projection repeats the protocol's own rule",
    );
  });

  test("the projection cannot disagree with the bytes it came from (property)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 0xff }), (status) => {
        const bits = decodeDtcStatus(status);
        const scanner = scannerOf(FULL_PACKAGE);
        const [dtc] = scanner.enrich(
          [
            {
              code: "C9999",
              raw: "9999FF",
              failureType: "FF",
              status,
              statusBits: bits,
              severity: "major",
            },
          ],
          "Gateway",
          "gateway",
        );
        // `severity: "major"` is what the protocol computed for these bytes; the
        // projection must not quietly re-derive a different answer.
        assert.equal(dtc?.severity, "major");
        assert.equal(dtc?.status, status);
        assert.equal(dtc?.statusBits.testFailed, bits.testFailed);
      }),
      { numRuns: 64 },
    );
  });
});
