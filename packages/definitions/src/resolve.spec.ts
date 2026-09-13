/**
 * Vehicle resolution (AGENTS 11, 13).
 *
 * The contract under test is not "does it pick the right car" — it is:
 *  - every answer carries the evidence that produced it, in both directions,
 *  - more evidence and harder evidence rank higher, reproducibly,
 *  - nothing is invented: an unknown WMI, an unknown ECU or a package without
 *    vehicle definitions is reported instead of being guessed away,
 *  - placeholder data never silently outranks sourced data (ADR 0003).
 */

import assert from "node:assert/strict";
import { test } from "vitest";
import { DefinitionRegistry } from "./index.js";
import { type VehicleResolutionInput, VehicleResolver } from "./resolve.js";
import {
  CURRENT_SCHEMA_VERSION,
  type DefinitionPackage,
  type VehicleDefinition,
} from "./schema.js";
import { vagExamplePackage } from "./vag/vag-package.js";

/** WVW · ZZZ1J · Z · H(2017) · W · 000001 — matches the hatch fixture. */
const HATCH_VIN = "WVWZZZ1JZHW000001";
/** Same car family, different descriptor section — matches the wagon fixture. */
const WAGON_VIN = "WVWZZA1JZHW000001";

function hatch(): VehicleDefinition {
  return {
    id: "hatch",
    brand: "ACME",
    model: "Hatch",
    platform: "P1",
    modelYears: { from: 2013, to: 2020 },
    vinMatch: {
      wmi: ["WVW", "WV1"],
      vdsPattern: "ZZZ..",
      modelYearChars: ["D", "E", "F", "G", "H", "J", "K", "L"],
      plantChars: ["W", "Z"],
    },
    engines: [{ id: "e14", name: "1.4 turbo", fuel: "petrol", codes: ["EXA", "EXB"] }],
    gearboxes: [{ id: "g7", name: "7-speed dual clutch", type: "dual-clutch", codes: ["EXG"] }],
    ecus: [
      { ecu: "engine", partNumbers: ["PN-1"], softwareVersions: ["SW-1"], engine: "e14" },
      { ecu: "abs" },
      { ecu: "trailer", optional: true },
    ],
  };
}

function wagon(): VehicleDefinition {
  return {
    id: "wagon",
    brand: "ACME",
    model: "Wagon",
    modelYears: { from: 2016 },
    vinMatch: { wmi: ["WVW"], vdsPattern: "ZZA.." },
    ecus: [{ ecu: "engine", partNumbers: ["PN-2"] }, { ecu: "abs" }, { ecu: "hvac" }],
  };
}

function fixture(overrides: Partial<DefinitionPackage> = {}): DefinitionPackage {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    oem: "acme",
    name: "ACME fixture",
    version: "1.0.0",
    provenance: { sourceType: "own", source: "test fixture" },
    ecus: [
      {
        id: "engine",
        name: "Engine",
        protocol: "uds",
        address: { txId: 0x7e0, rxId: 0x7e8 },
        identification: [
          { label: "VIN", did: 0xf190, encoding: "ascii" },
          { label: "Spare part number", did: 0xf187, encoding: "ascii" },
          { label: "Application software", did: 0xf191, encoding: "ascii" },
          { label: "ECU serial number", did: 0xf18c, encoding: "ascii" },
        ],
      },
      { id: "abs", name: "ABS", protocol: "uds", address: { txId: 0x7e1, rxId: 0x7e9 } },
      { id: "trailer", name: "Trailer", protocol: "uds", address: { txId: 0x7e2, rxId: 0x7ea } },
      { id: "hvac", name: "Climate", protocol: "uds", address: { txId: 0x7e3, rxId: 0x7eb } },
    ],
    signals: [],
    vehicles: [hatch(), wagon()],
    ...overrides,
  };
}

function resolve(input: VehicleResolutionInput, packages = [fixture()]) {
  return new VehicleResolver(packages).resolve(input);
}

function kinds(evidence: readonly { kind: string }[]): string[] {
  return evidence.map((entry) => entry.kind);
}

test("a VIN alone already ranks the matching variant first", () => {
  const result = resolve({ vin: HATCH_VIN });
  assert.equal(result.unresolved, false);
  assert.equal(result.best?.vehicleId, "hatch");
  assert.deepEqual(
    result.candidates.map((candidate) => candidate.vehicleId),
    ["hatch", "wagon"],
    "the wagon shares the WMI and stays a candidate, but ranks behind",
  );
  assert.equal(result.best?.score, 0.7);
  assert.deepEqual(kinds(result.best?.evidence ?? []), [
    "vin-wmi",
    "vin-vds",
    "vin-model-year",
    "vin-plant",
    "ecu-coverage",
  ]);
  assert.equal(result.best?.platform, "P1");
});

test("the score is the share of evaluated criteria that supports the candidate", () => {
  const result = resolve({ vin: HATCH_VIN });
  const best = result.best;
  assert.ok(best);
  assert.equal(best.weights.evaluated, 10, "wmi 3 + vds 2 + model year 1 + plant 1 + coverage 3");
  assert.equal(best.weights.support, 7, "coverage contributes nothing when no ECU answered");
  assert.equal(best.weights.conflict, 0);
  assert.equal(best.score, 0.7);
});

test("a contradicting VIN criterion is reported as a conflict, with its weight", () => {
  const result = resolve({ vin: WAGON_VIN });
  assert.equal(result.best?.vehicleId, "wagon");
  const hatchCandidate = result.candidates.find((candidate) => candidate.vehicleId === "hatch");
  assert.ok(hatchCandidate);
  assert.equal(hatchCandidate.conflicts.length, 1);
  assert.equal(hatchCandidate.conflicts[0]?.kind, "vin-vds");
  assert.equal(hatchCandidate.conflicts[0]?.observed, "ZZA1J");
  assert.equal(hatchCandidate.conflicts[0]?.expected, "ZZZ..");
});

test("discovered ECUs raise coverage, and optional equipment is not a conflict", () => {
  const result = resolve({
    vin: HATCH_VIN,
    discoveredAddresses: [
      { txId: 0x7e0, rxId: 0x7e8 },
      { txId: 0x7e1, rxId: 0x7e9 },
      { txId: 0x7e2, rxId: 0x7ea },
    ],
  });
  const best = result.best;
  assert.ok(best);
  assert.deepEqual(best.coverage, { expected: 2, matched: 2, unexpected: 0, missing: [] });
  assert.equal(best.score, 1, "every declared criterion is now confirmed");
  assert.equal(best.weights.support, best.weights.evaluated);
});

test("a response id alone identifies the ECU, because discovery often sees it first", () => {
  const result = resolve({
    discoveredAddresses: [{ txId: 0x7df, rxId: 0x7e8 }],
    declared: { oem: "acme" },
  });
  const best = result.best;
  assert.ok(best);
  assert.equal(best.coverage.matched, 1, "the engine answered on its response id");
});

test("missing expected ECUs are named, so a partial bus is explainable", () => {
  const result = resolve({
    vin: HATCH_VIN,
    discoveredAddresses: [{ txId: 0x7e0, rxId: 0x7e8 }],
  });
  const best = result.best;
  assert.ok(best);
  assert.deepEqual(best.coverage.missing, ["abs"]);
  const coverage = best.evidence.find((entry) => entry.kind === "ecu-coverage");
  assert.match(coverage?.reason ?? "", /did not answer: abs/);
  assert.equal(coverage?.weight, 1.5, "half of the coverage criterion");
});

test("an ECU that belongs to the package but not to the vehicle is a penalty", () => {
  const result = resolve({
    vin: HATCH_VIN,
    // The hatch lists engine/abs/trailer; `hvac` belongs to the wagon only.
    discoveredAddresses: [
      { txId: 0x7e0, rxId: 0x7e8 },
      { txId: 0x7e1, rxId: 0x7e9 },
      { txId: 0x7e3, rxId: 0x7eb },
    ],
  });
  const best = result.best;
  assert.ok(best);
  assert.equal(best.coverage.unexpected, 1);
  assert.deepEqual(kinds(best.conflicts), ["unexpected-ecu"]);
});

test("a part number read from the ECU is the strongest evidence there is", () => {
  const result = resolve({
    vin: WAGON_VIN,
    identifications: [{ ecu: "engine", did: 0xf187, value: "H04 PN-1 0001" }],
  });
  const best = result.best;
  assert.equal(best?.vehicleId, "hatch", "the wagon's own VIN cannot outweigh a wrong part number");
  const evidence = best?.evidence.find((entry) => entry.kind === "part-number");
  assert.equal(evidence?.weight, 4);
  assert.equal(evidence?.expected, "PN-1");
  const wagonCandidate = result.candidates.find((candidate) => candidate.vehicleId === "wagon");
  assert.deepEqual(kinds(wagonCandidate?.conflicts ?? []), ["part-number"]);
});

test("a value is compared against the kind its DID is documented as", () => {
  const result = resolve({
    identifications: [
      { ecu: "engine", did: 0xf187, value: "H04 PN-1 0001" },
      { ecu: "engine", did: 0xf191, value: "SW-1 / EXA / EXG" },
    ],
  });
  const best = result.best;
  assert.ok(best);
  // 0xF187 is documented as the part number, 0xF191 as the application software,
  // so each fact is compared against exactly the tokens that describe it.
  assert.deepEqual(
    kinds(best.evidence).filter((kind) => kind !== "ecu-coverage"),
    ["part-number", "software-version", "powertrain-code", "powertrain-code"],
  );
  assert.deepEqual(best.engineIds, ["e14"]);
  assert.deepEqual(best.gearboxIds, ["g7"]);
});

test("an ECU that answered but is not part of the vehicle contradicts it", () => {
  const result = resolve({
    vin: HATCH_VIN,
    identifications: [{ ecu: "hvac", did: 0xf187, value: "whatever" }],
  });
  const best = result.best;
  assert.ok(best);
  assert.deepEqual(kinds(best.conflicts), ["ecu-not-in-vehicle"]);
});

test("an ECU no package knows is reported as unexplained, never dropped", () => {
  const result = resolve({
    identifications: [{ ecu: "gateway", did: 0xf187, value: "X" }],
    discoveredAddresses: [{ txId: 0x7f0, rxId: 0x7f8 }],
  });
  assert.equal(result.unexplained.length, 2);
  assert.match(result.unexplained[0] ?? "", /no registered package defines that ECU/);
  assert.match(result.unexplained[1] ?? "", /0x7f0\/0x7f8 \(11-bit\) answered/);
});

test("a vehicle without an ECU list treats the whole package as its ECU set", () => {
  const oemWide = fixture({
    vehicles: [{ id: "oem-wide", brand: "ACME", model: "Anything", vinMatch: { wmi: ["WVW"] } }],
  });
  const result = resolve(
    {
      vin: HATCH_VIN,
      discoveredAddresses: [
        { txId: 0x7e0, rxId: 0x7e8 },
        { txId: 0x7e1, rxId: 0x7e9 },
        { txId: 0x7e2, rxId: 0x7ea },
        { txId: 0x7e3, rxId: 0x7eb },
      ],
      identifications: [{ ecu: "hvac", did: 0xf187, value: "X" }],
    },
    [oemWide],
  );
  const best = result.best;
  assert.ok(best);
  assert.deepEqual(best.coverage, { expected: 4, matched: 4, unexpected: 0, missing: [] });
  assert.deepEqual(best.conflicts, [], "an OEM-wide definition cannot contradict an answering ECU");
  assert.equal(best.score, 1);
});

test("what the operator declares counts, but less than what the bus says", () => {
  const declaredOnly = resolve({ declared: { brand: "acme", model: "HATCH", platform: "p1" } });
  assert.equal(declaredOnly.best?.vehicleId, "hatch");
  assert.deepEqual(kinds(declaredOnly.best?.evidence ?? []).slice(0, 3), [
    "declared-brand",
    "declared-model",
    "declared-platform",
  ]);

  const busWins = resolve({
    vin: WAGON_VIN,
    declared: { model: "Hatch" },
    identifications: [{ ecu: "engine", did: 0xf187, value: "PN-2" }],
    discoveredAddresses: [
      { txId: 0x7e0, rxId: 0x7e8 },
      { txId: 0x7e1, rxId: 0x7e9 },
      { txId: 0x7e3, rxId: 0x7eb },
    ],
  });
  assert.equal(
    busWins.best?.vehicleId,
    "wagon",
    "its own part number plus three answered ECUs outweigh a typed-in model name",
  );
});

test("a model year outside the declared range contradicts the candidate", () => {
  const result = resolve({ vin: HATCH_VIN, declared: { modelYear: 1999 } });
  const hatchCandidate = result.candidates.find((candidate) => candidate.vehicleId === "hatch");
  assert.ok(hatchCandidate);
  assert.deepEqual(kinds(hatchCandidate.conflicts), ["declared-model-year"]);
  assert.equal(hatchCandidate.conflicts[0]?.expected, "2013–2020");
});

test("a single model year is written as that year, not as a range", () => {
  const result = resolve({ vin: HATCH_VIN, declared: { modelYear: 2015 } }, [
    fixture({ vehicles: [{ ...hatch(), modelYears: { from: 2015, to: 2015 } }] }),
  ]);
  const candidate = result.best;
  assert.ok(candidate);
  assert.equal(
    candidate.evidence.find((entry) => entry.kind === "declared-model-year")?.expected,
    "2015",
    "a range of one year reads like a data error, so it is written as one year",
  );
});

test("an open-ended model year range accepts everything from its start", () => {
  const result = resolve({ vin: HATCH_VIN, declared: { modelYear: 2024 } });
  const wagonCandidate = result.candidates.find((candidate) => candidate.vehicleId === "wagon");
  assert.ok(wagonCandidate);
  assert.equal(
    wagonCandidate.conflicts.find((entry) => entry.kind === "declared-model-year"),
    undefined,
  );
  assert.equal(
    wagonCandidate.evidence.find((entry) => entry.kind === "declared-model-year")?.expected,
    "from 2016",
  );
});

test("VIN facts handed over by the caller win, including a withheld model year", () => {
  const result = resolve({
    vin: HATCH_VIN,
    vinFacts: { vin: HATCH_VIN, wmi: "WVW", vds: "ZZZ1J", plantChar: "W" },
  });
  const best = result.best;
  assert.ok(best);
  assert.equal(
    best.evidence.find((entry) => entry.kind === "vin-model-year"),
    undefined,
    "position 10 was not declared a model year, so it must not become evidence",
  );
  assert.equal(best.score, 0.67, "one criterion less is evaluated, the rest still matches");
});

test("the VIN names the manufacturer even when no vehicle definition matches", () => {
  const result = resolve({ vin: HATCH_VIN }, []);
  assert.equal(result.unresolved, true);
  assert.equal(result.vinLookup?.wmi, "WVW");
  assert.equal(result.vinLookup?.manufacturer, "Volkswagen AG");
  assert.equal(result.vinLookup?.country, "DE");
  assert.equal(result.vinLookup?.region, "Europe");
  assert.equal(result.vinLookup?.known, true);
  assert.match(result.notes[0] ?? "", /none of the 0 registered package/);
});

test("an unknown WMI stays unknown and is said so", () => {
  const result = resolve({ vin: "QQQZZZ1JZHW000001" });
  assert.equal(result.vinLookup?.known, false);
  assert.equal(result.vinLookup?.manufacturer, undefined);
  assert.match(result.notes.join(" "), /WMI QQQ is not in the reference table/);
});

test("packages without vehicle definitions cannot resolve a car", () => {
  const flat = fixture({ vehicles: undefined });
  const result = resolve({ vin: HATCH_VIN }, [flat]);
  assert.equal(result.unresolved, true);
  assert.deepEqual(result.candidates, []);
  assert.match(result.notes.join(" "), /none of the 1 registered package\(s\) declares vehicle/);
});

test("sourced data outranks placeholder data at equal evidence (ADR 0003)", () => {
  const placeholder = fixture({
    oem: "acme-copy",
    name: "ACME fixture (placeholder)",
    provenance: { sourceType: "example-placeholder", source: "invented" },
  });
  const result = resolve({ vin: HATCH_VIN }, [placeholder, fixture()]);
  const scores = result.candidates.map((candidate) => candidate.score);
  assert.equal(scores[0], scores[1], "both explain the VIN equally well");
  assert.equal(result.best?.trust, 1);
  assert.equal(result.best?.provenance.sourceType, "own");
  assert.equal(
    result.candidates.find((candidate) => candidate.trust === 0.3)?.provenance.sourceType,
    "example-placeholder",
  );
});

test("a vehicle-level provenance refines the package one", () => {
  const refined = fixture({
    vehicles: [
      {
        ...hatch(),
        provenance: { sourceType: "licensed", source: "OEM documentation", license: "contract" },
      },
      wagon(),
    ],
  });
  const result = resolve({ vin: HATCH_VIN }, [refined]);
  assert.equal(result.best?.provenance.license, "contract");
  assert.equal(result.best?.trust, 1);
});

test("winning with placeholder data always says so", () => {
  const result = resolve({ vin: "WVWZZZ1JZDW000001" }, [vagExamplePackage]);
  assert.equal(result.best?.vehicleId, "vag-example-variant");
  assert.match(result.notes.join(" "), /placeholder data, not vehicle truth/);
});

test("the candidate list can be capped, best first", () => {
  const capped = new VehicleResolver([fixture()], { maxCandidates: 1 }).resolve({
    vin: HATCH_VIN,
  });
  assert.equal(capped.candidates.length, 1);
  assert.equal(capped.best?.vehicleId, "hatch");
  const unlimited = resolve({ vin: HATCH_VIN });
  assert.ok(unlimited.candidates.length > capped.candidates.length);
});

test("an input without any observation resolves to nothing and says nothing", () => {
  const result = resolve({});
  assert.equal(result.unresolved, true);
  assert.deepEqual(result.candidates, []);
  assert.equal(result.best, undefined);
  assert.deepEqual(result.notes, []);
  assert.deepEqual(result.unexplained, []);
  assert.equal(result.vinLookup, undefined);
});

test("resolution is deterministic: the same input yields the same bytes twice", () => {
  const input: VehicleResolutionInput = {
    vin: HATCH_VIN,
    identifications: [{ ecu: "engine", did: 0xf187, value: "PN-1" }],
    discoveredAddresses: [
      { txId: 0x7e0, rxId: 0x7e8 },
      { txId: 0x7e1, rxId: 0x7e9 },
    ],
    declared: { oem: "acme" },
  };
  const first = JSON.stringify(resolve(input));
  const second = JSON.stringify(resolve(input));
  assert.equal(first, second);
});

test("equal candidates keep registration order, so a rerun cannot swap them", () => {
  const twin = fixture({
    oem: "beta",
    name: "Beta fixture",
    vehicles: [
      { ...hatch(), id: "hatch-twin" },
      { ...wagon(), id: "wagon-twin" },
    ],
  });
  const result = resolve({ vin: HATCH_VIN }, [fixture(), twin]);
  const twins = result.candidates.filter((candidate) => candidate.packageKey === "beta@1.0.0");
  assert.deepEqual(
    twins.map((candidate) => candidate.vehicleId),
    ["hatch-twin", "wagon-twin"],
  );
  const hatchCandidates = result.candidates.filter((candidate) =>
    candidate.vehicleId.startsWith("hatch"),
  );
  assert.equal(hatchCandidates.length, 2);
  assert.equal(
    hatchCandidates[0]?.packageKey,
    "acme@1.0.0",
    "the earlier package key wins the tie",
  );
});

test("the registry resolves vehicles and looks them up by id", () => {
  const registry = new DefinitionRegistry([fixture()]);
  const result = registry.resolveVehicle({ vin: HATCH_VIN });
  assert.equal(result.best?.vehicleId, "hatch");
  assert.equal(registry.findVehicle("hatch")?.packageKey, "acme@1.0.0");
  assert.equal(registry.findVehicle("hatch")?.oem, "acme");
  assert.equal(registry.findVehicle("does-not-exist"), undefined);
  assert.deepEqual(
    registry.vehicles().map((entry) => entry.vehicle.id),
    ["hatch", "wagon"],
  );
  assert.equal(registry.list()[0]?.vehicles, 2);
  assert.deepEqual(
    registry.all("acme").map((pkg) => pkg.oem),
    ["acme"],
  );
  assert.deepEqual(registry.all("other"), []);
});

test("several packages per OEM are all considered", () => {
  const second = fixture({ oem: "acme", name: "ACME platform package", version: "2.0.0" });
  const registry = new DefinitionRegistry([fixture(), second]);
  assert.equal(registry.all("acme").length, 2, "the same OEM may be registered twice");
  assert.equal(registry.get("acme")?.version, "1.0.0", "get() keeps its first-match semantics");
  const result = registry.resolveVehicle({ vin: HATCH_VIN });
  assert.ok(result.candidates.some((candidate) => candidate.packageKey === "acme@2.0.0"));
});

test("an identification without a DID still produces evidence, and says less", () => {
  const withDid = resolve({
    identifications: [{ ecu: "engine", did: 0xf187, value: "PN-1" }],
  });
  const withoutDid = resolve({ identifications: [{ ecu: "engine", value: "PN-1" }] });
  assert.equal(withDid.best?.vehicleId, withoutDid.best?.vehicleId);
  assert.equal(withDid.best?.score, withoutDid.best?.score, "the DID does not change the weight");
  assert.match(withDid.best?.evidence[0]?.reason ?? "", /engine \(DID 0xf187\) reported/);
  assert.match(withoutDid.best?.evidence[0]?.reason ?? "", /^engine reported/);

  // The same holds for an ECU that does not belong to the vehicle.
  const foreign = resolve({ vin: HATCH_VIN, identifications: [{ ecu: "hvac", value: "X" }] });
  const conflict = foreign.candidates.find((candidate) => candidate.vehicleId === "hatch");
  assert.match(conflict?.conflicts[0]?.observed ?? "", /^hvac reported "X"$/);
});

test("a DID documented for another purpose never contradicts the vehicle", () => {
  // The engine also answers 0xF18C (serial number) — a DID this vehicle
  // definition says nothing about. Before attribution existed, that answer was
  // weighed against the part-number list and counted as counter-evidence.
  const result = resolve({
    vin: HATCH_VIN,
    identifications: [{ ecu: "engine", did: 0xf18c, value: "SN-99999" }],
  });
  const best = result.best;
  assert.ok(best);
  assert.deepEqual(best.conflicts, [], "an undocumented DID cannot contradict");
  assert.equal(
    best.evidence.find((entry) => entry.kind === "part-number"),
    undefined,
    "and it cannot support either — it is simply not evidence",
  );
});

test("a documented DID with a wrong value contradicts, naming both sides", () => {
  const result = resolve({
    vin: HATCH_VIN,
    identifications: [{ ecu: "engine", did: 0xf187, value: "PN-9" }],
  });
  const best = result.best;
  assert.ok(best);
  const conflict = best.conflicts.find((entry) => entry.kind === "part-number");
  assert.equal(conflict?.observed, "PN-9");
  assert.equal(conflict?.expected, "PN-1");
  assert.match(conflict?.reason ?? "", /DID 0xf187/);
});

test("an unattributed value can support but never contradict", () => {
  const supporting = resolve({
    vin: HATCH_VIN,
    identifications: [{ ecu: "engine", value: "SW-1" }],
  });
  assert.equal(supporting.best?.vehicleId, "hatch");
  assert.deepEqual(kinds(supporting.best?.evidence ?? []).slice(0, 5), [
    "vin-wmi",
    "vin-vds",
    "vin-model-year",
    "vin-plant",
    "software-version",
  ]);

  const contradicting = resolve({
    vin: HATCH_VIN,
    identifications: [{ ecu: "engine", value: "PN-9" }],
  });
  assert.deepEqual(
    contradicting.best?.conflicts ?? [],
    [],
    "without a DID the resolver cannot know what the value is, so it stays neutral",
  );
});

test("identification from another package is not credited to this one", () => {
  // The engine names a matched ECU "<oem>:<id>", so the same id can exist twice.
  const other = fixture({ oem: "other", name: "Other OEM", version: "1.0.0" });
  const result = resolve(
    { identifications: [{ oem: "other", ecu: "engine", did: 0xf187, value: "PN-1" }] },
    [fixture(), other],
  );
  const acme = result.candidates.filter((candidate) => candidate.oem === "acme");
  assert.deepEqual(acme, [], "no evidence for the acme package, so no acme candidate");
  const otherBest = result.candidates.filter((candidate) => candidate.oem === "other");
  assert.equal(otherBest.length, 1);
  assert.deepEqual(kinds(otherBest[0]?.evidence ?? []), ["part-number", "ecu-coverage"]);
});

test("an address that answered without a definition describing it is reported", () => {
  const result = resolve({
    vin: HATCH_VIN,
    discoveredAddresses: [
      { txId: 0x123, rxId: 0x456 },
      { txId: 0x7e0, rxId: 0x7e8, extended: true },
    ],
  });
  assert.deepEqual(
    result.unexplained,
    [
      "ECU at 0x123/0x456 (11-bit) answered — no definition describes it",
      "ECU at 0x7e0/0x7e8 (29-bit) answered — no definition describes it",
    ],
    "an 11-bit definition does not explain a 29-bit answer, not even at the same ids",
  );
});

test("a vehicle referencing an ECU its package does not define cannot expect it", () => {
  const hatchback = hatch();
  const broken = fixture({
    vehicles: [{ ...hatchback, ecus: [...(hatchback.ecus ?? []), { ecu: "gateway" }] }],
  });
  const result = resolve({ vin: HATCH_VIN }, [broken]);
  assert.equal(result.best?.vehicleId, "hatch", "a dangling reference does not sink the candidate");
  assert.equal(
    result.best?.coverage.expected,
    2,
    "only defined, non-optional ECUs can be expected to answer",
  );
});
