/**
 * Fault knowledge per vehicle variant (AGENTS 20, 23).
 *
 * The contract under test is not "does it return a nice text" — it is:
 *  - the narrowest declared statement wins (engine, then gearbox, then vehicle),
 *    and a statement scoped to another variant is no match at all, not a weak one,
 *  - wider knowledge stays visible next to the narrow answer instead of being
 *    hidden by it,
 *  - the answer says where it came from (`scope`) and what is missing (`notes`),
 *    so a package-wide description can never pose as variant knowledge (§24),
 *  - nothing is invented: an unknown code, an unknown vehicle or a check against
 *    a signal the package does not define is dropped or reported, never guessed.
 */

import assert from "node:assert/strict";
import { test } from "vitest";
import { DefinitionRegistry } from "./index.js";
import { documentedDtcCodes, dtcKnowledgeQuery, findDtcKnowledge } from "./knowledge.js";
import { VehicleResolver } from "./resolve.js";
import {
  CURRENT_SCHEMA_VERSION,
  type DefinitionPackage,
  type DtcKnowledgeDefinition,
  type Provenance,
  type VehicleDefinition,
} from "./schema.js";
import { SIMULATOR_VIN, simulatorPackage } from "./simulator/simulator-package.js";

const OWN: Provenance = { sourceType: "own", source: "this test" };
const ENTRY_SOURCE: Provenance = {
  sourceType: "licensed",
  source: "workshop manual",
  license: "x",
};

function vehicle(knowledge: DtcKnowledgeDefinition[]): VehicleDefinition {
  return {
    id: "car",
    brand: "ACME",
    model: "Test car",
    engines: [
      { id: "petrol", name: "Petrol", codes: ["PET"] },
      { id: "diesel", name: "Diesel", codes: ["DIE"] },
    ],
    gearboxes: [
      { id: "manual", name: "Manual", codes: ["MAN"] },
      { id: "auto", name: "Automatic", codes: ["AUT"] },
    ],
    ecus: [{ ecu: "engine", engine: "petrol" }],
    vinMatch: { wmi: ["WVW"], vdsPattern: "ZZZ.." },
    dtcKnowledge: knowledge,
    provenance: OWN,
  };
}

function pkgWith(knowledge: DtcKnowledgeDefinition[]): DefinitionPackage {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    oem: "test",
    name: "Test package",
    version: "1.0.0",
    provenance: OWN,
    ecus: [
      {
        id: "engine",
        name: "Engine",
        protocol: "uds",
        address: { txId: 0x7e0, rxId: 0x7e8 },
        dtcs: [
          {
            code: "P0420",
            description: "Package-wide catalyst text",
            severity: "major",
            hint: "Package-wide hint",
            relatedSignals: ["engine.long_term_fuel_trim"],
          },
        ],
      },
      {
        id: "gateway",
        name: "Gateway",
        protocol: "uds",
        address: { txId: 0x7e1, rxId: 0x7e9 },
        dtcs: [{ code: "P0420", description: "Gateway copy of the same code", severity: "info" }],
      },
      {
        id: "abs",
        name: "ABS",
        protocol: "uds",
        address: { txId: 0x713, rxId: 0x77b },
      },
    ],
    signals: [
      {
        id: "engine.long_term_fuel_trim",
        name: "Long term fuel trim",
        ecu: "engine",
        did: 0xf407,
        byteOffset: 0,
        length: 1,
        encoding: "uint8",
        unit: "%",
      },
      {
        id: "engine.coolant_temperature",
        name: "Coolant temperature",
        ecu: "engine",
        did: 0xf405,
        byteOffset: 0,
        length: 1,
        encoding: "uint8",
        unit: "°C",
      },
      {
        id: "transmission.oil_temperature",
        name: "Oil temperature",
        ecu: "gateway",
        did: 0xf405,
        byteOffset: 0,
        length: 1,
        encoding: "uint8",
        unit: "°C",
      },
    ],
    vehicles: [vehicle(knowledge)],
  };
}

const PETROL_QUERY = { code: "P0420", vehicleId: "car", engineIds: ["petrol"] };

/** A variant that declares exactly one engine and one gearbox. */
function singlePowertrainPkg(knowledge: DtcKnowledgeDefinition[]): DefinitionPackage {
  const pkg = pkgWith(knowledge);
  const car = pkg.vehicles?.[0];
  assert.ok(car);
  car.engines = [{ id: "petrol", name: "Petrol", codes: ["PET"] }];
  car.gearboxes = [{ id: "auto", name: "Automatic", codes: ["AUT"] }];
  return pkg;
}

test("variant knowledge replaces the package wording and says it did", () => {
  const pkg = pkgWith([
    {
      code: "P0420",
      ecu: "engine",
      engine: "petrol",
      description: "Catalyst efficiency on the petrol engine",
      severity: "critical",
      conditions: "Only in closed loop above 80 °C",
      hint: "Check the trims first",
      relatedSignals: ["engine.coolant_temperature"],
      provenance: ENTRY_SOURCE,
    },
  ]);
  const hit = findDtcKnowledge([pkg], { ...PETROL_QUERY, ecu: "engine" });
  assert.ok(hit);
  assert.equal(hit.scope, "vehicle-engine");
  assert.equal(hit.description, "Catalyst efficiency on the petrol engine");
  assert.equal(hit.severity, "critical", "the variant severity overrides the package one");
  assert.equal(hit.hint, "Check the trims first");
  assert.equal(hit.conditions, "Only in closed loop above 80 °C");
  assert.equal(hit.vehicleId, "car");
  assert.equal(hit.oem, "test");
  assert.equal(hit.packageVersion, "1.0.0");
  assert.deepEqual(hit.knowledgeProvenance, ENTRY_SOURCE);
  assert.deepEqual(hit.baselineProvenance, OWN);
  assert.ok(
    hit.notes.some((note) => note.includes("documents wording only")),
    "wording without a pattern cannot be checked against the bus, and says so",
  );
});

test("wording the entry does not declare falls back to the package description", () => {
  const pkg = pkgWith([{ code: "P0420", engine: "petrol" }]);
  const hit = findDtcKnowledge([pkg], PETROL_QUERY);
  assert.ok(hit);
  assert.equal(hit.scope, "vehicle-engine");
  assert.equal(hit.description, "Package-wide catalyst text");
  assert.equal(hit.severity, "major");
  assert.equal(hit.hint, "Package-wide hint");
  assert.ok(
    hit.notes.some((note) => note.includes("documents wording only")),
    hit.notes.join(" | "),
  );
});

test("an entry scoped to another engine is no match, not a weak one", () => {
  const pkg = pkgWith([{ code: "P0420", engine: "diesel", description: "Diesel catalyst text" }]);
  const petrol = findDtcKnowledge([pkg], PETROL_QUERY);
  assert.ok(petrol, "the package-wide description still answers");
  assert.equal(petrol.description, "Package-wide catalyst text");
  assert.equal(petrol.scope, "package");

  const diesel = findDtcKnowledge([pkg], {
    code: "P0420",
    vehicleId: "car",
    engineIds: ["diesel"],
  });
  assert.equal(diesel?.description, "Diesel catalyst text");
});

test("the gearbox axis answers for a gearbox-scoped code", () => {
  const pkg = pkgWith([
    {
      code: "P0715",
      ecu: "gateway",
      gearbox: "auto",
      description: "Input speed sensor on the automatic",
      patterns: [
        {
          id: "open-circuit",
          name: "Open circuit",
          checks: [{ signal: "transmission.oil_temperature", expect: "warm gearbox", min: 60 }],
        },
      ],
    },
  ]);
  const manual = findDtcKnowledge([pkg], {
    code: "P0715",
    vehicleId: "car",
    gearboxIds: ["manual"],
  });
  assert.equal(manual, undefined, "neither knowledge nor a package description exists for it");

  const automatic = findDtcKnowledge([pkg], {
    code: "P0715",
    vehicleId: "car",
    gearboxIds: ["auto"],
    ecu: "gateway",
  });
  assert.ok(automatic);
  assert.equal(automatic.scope, "vehicle-gearbox");
  assert.equal(automatic.description, "Input speed sensor on the automatic");
  assert.deepEqual(
    automatic.patterns.map((pattern) => pattern.id),
    ["open-circuit"],
  );
  assert.deepEqual(automatic.patterns[0]?.checks, [
    {
      signal: "transmission.oil_temperature",
      signalName: "Oil temperature",
      expect: "warm gearbox",
      min: 60,
      measurable: true,
    },
  ]);
  // No entry-level provenance: the vehicle's own provenance still names a source.
  assert.deepEqual(automatic.knowledgeProvenance, OWN);
});

test("an engine beats a gearbox, and a gearbox beats the whole vehicle", () => {
  const pkg = pkgWith([
    { code: "P0420", description: "vehicle-wide" },
    { code: "P0420", gearbox: "auto", description: "automatic" },
    { code: "P0420", engine: "petrol", description: "petrol" },
  ]);
  const hit = findDtcKnowledge([pkg], {
    code: "P0420",
    vehicleId: "car",
    engineIds: ["petrol"],
    gearboxIds: ["auto"],
  });
  assert.equal(hit?.description, "petrol");
  assert.equal(hit?.scope, "vehicle-engine");

  const gearboxOnly = findDtcKnowledge([pkg], {
    code: "P0420",
    vehicleId: "car",
    gearboxIds: ["auto"],
  });
  assert.equal(gearboxOnly?.description, "automatic");
  assert.equal(gearboxOnly?.scope, "vehicle-gearbox");
});

test("wider patterns stay visible next to the narrow answer, ids unique", () => {
  const pkg = pkgWith([
    {
      code: "P0420",
      description: "vehicle-wide",
      patterns: [
        { id: "shared", name: "Shared cause", checks: [{ signal: "engine.load", expect: "x" }] },
        {
          id: "wide",
          name: "Wide cause",
          checks: [{ signal: "engine.coolant_temperature", expect: "warm", min: 80 }],
          repair: "Fix it",
          likelihood: "possible",
          explanation: "Why it happens",
        },
      ],
    },
    {
      code: "P0420",
      engine: "petrol",
      patterns: [
        {
          id: "shared",
          name: "Same id, engine specific wording — the wider copy is dropped",
          checks: [{ signal: "engine.long_term_fuel_trim", expect: "neutral", min: -5, max: 5 }],
        },
        { id: "narrow", name: "Narrow cause", likelihood: "common" },
      ],
    },
  ]);
  const hit = findDtcKnowledge([pkg], PETROL_QUERY);
  assert.ok(hit);
  assert.deepEqual(
    hit.patterns.map((pattern) => [pattern.id, pattern.scope]),
    [
      ["shared", "vehicle-engine"],
      ["narrow", "vehicle-engine"],
      ["wide", "vehicle"],
    ],
    "most specific first, the duplicate id keeps the narrow copy",
  );
  const shared = hit.patterns[0];
  assert.equal(shared?.name, "Same id, engine specific wording — the wider copy is dropped");
  assert.equal(shared?.checks[0]?.measurable, true);
  const wide = hit.patterns[2];
  assert.equal(wide?.repair, "Fix it");
  assert.equal(wide?.likelihood, "possible");
  assert.equal(wide?.explanation, "Why it happens");
  assert.deepEqual(hit.patterns[1]?.checks, [], "a pattern may be documented without a check");
  assert.ok(!hit.notes.some((note) => note.includes("no numeric window")), hit.notes.join(" | "));
});

test("a pattern that only a human can judge says so", () => {
  const pkg = pkgWith([
    {
      code: "P0420",
      engine: "petrol",
      patterns: [
        {
          id: "by-ear",
          name: "Audible exhaust leak",
          checks: [
            { signal: "engine.coolant_temperature", expect: "listen at operating temperature" },
          ],
        },
      ],
    },
  ]);
  const hit = findDtcKnowledge([pkg], PETROL_QUERY);
  assert.equal(hit?.patterns[0]?.checks[0]?.measurable, false);
  assert.ok(
    hit?.notes.some((note) => note.includes("no numeric window")),
    hit?.notes.join(" | "),
  );
});

test("a check against a signal the package does not define is dropped", () => {
  const pkg = pkgWith([
    {
      code: "P0420",
      engine: "petrol",
      patterns: [
        {
          id: "half-known",
          name: "Partly measurable",
          checks: [
            { signal: "engine.lambda_downstream", expect: "switching activity" },
            { signal: "engine.coolant_temperature", expect: "warm", min: 80 },
          ],
        },
      ],
      relatedSignals: ["engine.coolant_temperature", "engine.lambda_downstream"],
    },
  ]);
  const hit = findDtcKnowledge([pkg], PETROL_QUERY);
  assert.deepEqual(
    hit?.patterns[0]?.checks.map((check) => check.signal),
    ["engine.coolant_temperature"],
    "the unmeasurable check cannot be offered as a step",
  );
  assert.deepEqual(hit?.relatedSignals, [
    "engine.long_term_fuel_trim",
    "engine.coolant_temperature",
  ]);
});

test("related signals are merged from package and variants, once each", () => {
  const pkg = pkgWith([
    { code: "P0420", engine: "petrol", relatedSignals: ["engine.coolant_temperature"] },
    { code: "P0420", relatedSignals: ["engine.coolant_temperature", "engine.long_term_fuel_trim"] },
  ]);
  const hit = findDtcKnowledge([pkg], PETROL_QUERY);
  assert.deepEqual(hit?.relatedSignals, [
    "engine.long_term_fuel_trim",
    "engine.coolant_temperature",
  ]);
});

test("without a resolved vehicle only the package-wide description answers", () => {
  const pkg = pkgWith([{ code: "P0420", engine: "petrol", description: "Variant text" }]);
  const hit = findDtcKnowledge([pkg], { code: "P0420" });
  assert.ok(hit);
  assert.equal(hit.scope, "package");
  assert.equal(hit.vehicleId, undefined);
  assert.equal(hit.description, "Package-wide catalyst text");
  assert.deepEqual(
    hit.knowledgeProvenance,
    OWN,
    "package-wide wording is sourced from the package, not from a vehicle",
  );
  assert.ok(
    hit.notes.some((note) => note.includes("no variant-specific knowledge documented")),
    hit.notes.join(" | "),
  );
});

test("a vehicle the package does not declare is reported, not silently ignored", () => {
  const pkg = pkgWith([{ code: "P0420", description: "Variant text" }]);
  const hit = findDtcKnowledge([pkg], { code: "P0420", vehicleId: "other-car" });
  assert.ok(hit);
  assert.equal(hit.description, "Package-wide catalyst text");
  assert.equal(hit.knowledgeProvenance?.source, "this test", "the package remains the source");
  assert.ok(
    hit.notes.some((note) => note.includes('vehicle "other-car" is not declared')),
    hit.notes.join(" | "),
  );
});

test("the ECU that reported the code owns the package-wide wording", () => {
  const pkg = pkgWith([]);
  const onGateway = findDtcKnowledge([pkg], { code: "P0420", ecu: "gateway" });
  assert.equal(onGateway?.description, "Gateway copy of the same code");
  assert.equal(onGateway?.severity, "info");

  const unscoped = findDtcKnowledge([pkg], { code: "P0420" });
  assert.equal(
    unscoped?.description,
    "Package-wide catalyst text",
    "without an ECU the first definition answers",
  );

  const onAbs = findDtcKnowledge([pkg], { code: "P0420", ecu: "abs" });
  assert.equal(
    onAbs?.description,
    "Package-wide catalyst text",
    "another ECU falls back to the first definition of the code",
  );
});

test("codes are matched case-insensitively and reported in character form", () => {
  const pkg = pkgWith([{ code: "p0420", engine: "petrol", description: "lower case entry" }]);
  const hit = findDtcKnowledge([pkg], { ...PETROL_QUERY, code: " p0420 " });
  assert.equal(hit?.code, "P0420");
  assert.equal(hit?.description, "lower case entry");
});

test("an unknown code and another manufacturer answer with nothing", () => {
  const pkg = pkgWith([{ code: "P0420", engine: "petrol" }]);
  assert.equal(findDtcKnowledge([pkg], { code: "B1234" }), undefined);
  assert.equal(findDtcKnowledge([pkg], { ...PETROL_QUERY, oem: "other" }), undefined);
  assert.equal(findDtcKnowledge([], PETROL_QUERY), undefined);
});

test("documented codes are listed per vehicle and stay unique", () => {
  const pkg = pkgWith([
    { code: "P0420", engine: "petrol" },
    { code: "p0420", engine: "diesel" },
    { code: "P0715", gearbox: "auto" },
  ]);
  assert.deepEqual(documentedDtcCodes([pkg], "car"), ["P0420", "P0715"]);
  assert.deepEqual(documentedDtcCodes([pkg], "car", "test"), ["P0420", "P0715"]);
  assert.deepEqual(documentedDtcCodes([pkg], "car", "other"), []);
  assert.deepEqual(documentedDtcCodes([pkg], "unknown"), []);
});

test("a resolution candidate carries its own narrowing into the query", () => {
  const pkg = pkgWith([{ code: "P0420", engine: "petrol", description: "petrol answer" }]);
  const resolution = new VehicleResolver([pkg]).resolve({
    vin: "WVWZZZ1JZHW000001",
    identifications: [{ ecu: "engine", value: "PET" }],
  });
  const best = resolution.best;
  assert.ok(best, "the fixture vehicle is resolvable by VIN");
  assert.deepEqual(best.engineIds, ["petrol"], "the identification value narrowed the engine");

  const query = dtcKnowledgeQuery(best, "P0420", "engine");
  assert.deepEqual(query, {
    code: "P0420",
    ecu: "engine",
    oem: "test",
    vehicleId: "car",
    engineIds: ["petrol"],
  });
  const hit = findDtcKnowledge([pkg], query);
  assert.equal(hit?.description, "petrol answer", "the narrowing the resolver found is enough");

  assert.deepEqual(dtcKnowledgeQuery(undefined, "P0420"), { code: "P0420" });
});

test("without powertrain evidence the only declared engine is assumed — and says so", () => {
  const pkg = singlePowertrainPkg([
    { code: "P0420", engine: "petrol", description: "petrol answer" },
    { code: "P0715", gearbox: "auto", description: "automatic answer" },
  ]);
  const hit = findDtcKnowledge([pkg], { code: "P0420", vehicleId: "car" });
  assert.equal(hit?.description, "petrol answer");
  assert.equal(hit?.scope, "vehicle-engine");
  assert.ok(
    hit?.notes.some((note) => note.includes('engine "petrol" is assumed')),
    hit?.notes.join(" | "),
  );

  const gearbox = findDtcKnowledge([pkg], { code: "P0715", vehicleId: "car" });
  assert.equal(gearbox?.description, "automatic answer");
  assert.equal(gearbox?.scope, "vehicle-gearbox");
  assert.ok(gearbox?.notes.some((note) => note.includes('gearbox "auto" is assumed')));
});

test("picking between several declared engines without evidence is refused", () => {
  const pkg = pkgWith([{ code: "P0420", engine: "petrol", description: "petrol answer" }]);
  const hit = findDtcKnowledge([pkg], { code: "P0420", vehicleId: "car" });
  assert.equal(hit?.description, "Package-wide catalyst text", "a coin flip is not an answer");
  assert.equal(hit?.scope, "package");
  assert.ok(
    hit?.notes.some((note) => note.includes("no variant-specific knowledge documented")),
    hit?.notes.join(" | "),
  );
});

test("picking between several declared gearboxes without evidence is refused", () => {
  const pkg = pkgWith([{ code: "P0715", gearbox: "auto", description: "automatic answer" }]);
  const hit = findDtcKnowledge([pkg], { code: "P0715", vehicleId: "car" });
  assert.equal(hit, undefined, "no gearbox was narrowed and two are declared — no answer");
});

test("a confirmed gearbox outranks an engine that had to be assumed", () => {
  const pkg = singlePowertrainPkg([
    { code: "P0715", engine: "petrol", description: "assumed engine answer" },
    { code: "P0715", gearbox: "auto", description: "confirmed gearbox answer" },
  ]);
  const hit = findDtcKnowledge([pkg], {
    code: "P0715",
    vehicleId: "car",
    gearboxIds: ["auto"],
  });
  assert.equal(hit?.description, "confirmed gearbox answer");
  assert.equal(hit?.scope, "vehicle-gearbox");
  assert.ok(
    hit?.notes.some((note) => note.includes('engine "petrol" is assumed')),
    "the wider entry still applies, and its assumption stays visible",
  );
});

test("the registry answers knowledge questions across its packages", () => {
  const registry = new DefinitionRegistry([
    pkgWith([{ code: "P0420", description: "registry hit" }]),
  ]);
  const hit = registry.findDtcKnowledge({ code: "P0420", vehicleId: "car", oem: "test" });
  assert.equal(hit?.description, "registry hit");
  assert.equal(registry.findDtcKnowledge({ code: "P0420", oem: "nobody" }), undefined);
});

test("the seeded simulator knowledge is usable end to end", () => {
  const identified = new VehicleResolver([simulatorPackage]).resolve({
    vin: SIMULATOR_VIN,
    identifications: [
      { ecu: "engine", did: 0xf18c, value: "ENGINE-f18c" },
      { ecu: "transmission", did: 0xf18c, value: "TRANSMISSION-f18c" },
    ],
  });
  const best = identified.best;
  assert.deepEqual(best?.engineIds, ["sim-petrol"], "the simulator answers its engine code");
  assert.deepEqual(best?.gearboxIds, ["sim-automatic"]);

  const hit = findDtcKnowledge([simulatorPackage], dtcKnowledgeQuery(best, "P0420", "engine"));
  assert.ok(hit);
  assert.equal(hit.scope, "vehicle-engine", "the petrol engine narrows the catalyst entry down");
  assert.match(hit.description ?? "", /2\.4 L petrol/);
  assert.equal(hit.severity, "major", "inherited from the package-wide definition");
  assert.ok(hit.conditions?.includes("three"), hit.conditions ?? "");
  const aged = hit.patterns.find((pattern) => pattern.id === "catalyst-aged");
  assert.ok(aged, "the aged-catalyst pattern is documented");
  assert.equal(aged.repair !== undefined, true);
  assert.equal(aged.checks.length, 3);
  assert.ok(
    aged.checks.every((check) => check.measurable),
    "every seeded check has a window a tool can evaluate",
  );
  assert.deepEqual(hit.notes, [], "with the powertrain read from the ECUs nothing is assumed");

  const gearbox = findDtcKnowledge(
    [simulatorPackage],
    dtcKnowledgeQuery(best, "P0715", "transmission"),
  );
  assert.equal(gearbox?.scope, "vehicle-gearbox");
  assert.equal(gearbox?.patterns.length, 2);

  // A VIN alone does not name the engine — the answer stays, but it says so.
  const byVin = new VehicleResolver([simulatorPackage]).resolve({ vin: SIMULATOR_VIN });
  const assumed = findDtcKnowledge(
    [simulatorPackage],
    dtcKnowledgeQuery(byVin.best, "P0420", "engine"),
  );
  assert.equal(assumed?.description, hit.description);
  assert.ok(
    assumed?.notes.some((note) => note.includes('engine "sim-petrol" is assumed')),
    assumed?.notes.join(" | ") ?? "",
  );

  const undocumented = findDtcKnowledge(
    [simulatorPackage],
    dtcKnowledgeQuery(best, "C0035", "abs"),
  );
  assert.equal(undocumented?.scope, "package", "a code without variant knowledge keeps saying so");
  assert.deepEqual(documentedDtcCodes([simulatorPackage], "virtual-vehicle"), [
    "P0420",
    "P0300",
    "P0171",
    "P0715",
  ]);
});
