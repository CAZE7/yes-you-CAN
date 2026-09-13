import assert from "node:assert/strict";
import { DefinitionError } from "@vdp/shared";
import { test } from "vitest";
import { genericPackage } from "./generic/generic-package.js";
import { parseDefinitionPackage, parseDefinitionPackageJson } from "./json.js";
import { CURRENT_SCHEMA_VERSION } from "./schema.js";
import { validateDefinitionPackage } from "./validate.js";

test("a built-in package round-trips through JSON", () => {
  const json = JSON.stringify(genericPackage);
  const parsed = parseDefinitionPackageJson(json);
  assert.equal(parsed.oem, genericPackage.oem);
  assert.equal(parsed.version, genericPackage.version);
  assert.equal(parsed.ecus.length, genericPackage.ecus.length);
  assert.equal(parsed.signals.length, genericPackage.signals.length);
  assert.equal(validateDefinitionPackage(parsed).valid, true);
});

test("parseDefinitionPackage accepts a plain object and preserves signal detail", () => {
  const parsed = parseDefinitionPackage(JSON.parse(JSON.stringify(genericPackage)));
  const original = genericPackage.signals[0];
  const round = parsed.signals.find((s) => s.id === original?.id);
  assert.ok(original && round);
  assert.equal(round.did, original.did);
  assert.equal(round.byteOffset, original.byteOffset);
  assert.equal(round.encoding, original.encoding);
});

test("structural problems are collected into one DefinitionError", () => {
  assert.throws(
    () =>
      parseDefinitionPackage({
        schemaVersion: 1,
        // oem missing
        name: "broken",
        version: "1.0.0",
        provenance: { sourceType: "own", source: "test" },
        ecus: [],
        signals: [
          { id: "x", name: "x", ecu: "e", did: 1, byteOffset: 0, length: 1 /* encoding missing */ },
        ],
      }),
    (error: unknown) => {
      assert.ok(error instanceof DefinitionError);
      const details = error.details as { errors: string[] };
      assert.ok(details.errors.some((e) => e.includes("oem")));
      assert.ok(details.errors.some((e) => e.includes("encoding")));
      return true;
    },
  );
});

test("semantic problems are rejected like built-in validation", () => {
  assert.throws(
    () =>
      parseDefinitionPackage({
        schemaVersion: 1,
        oem: "test",
        name: "bad-version",
        version: "not-semver",
        provenance: { sourceType: "own", source: "test" },
        ecus: [],
        signals: [],
      }),
    /not valid SemVer/,
  );
});

test("malformed JSON raises a DefinitionError, not a SyntaxError", () => {
  assert.throws(() => parseDefinitionPackageJson("{ not json"), DefinitionError);
});

test("non-object input is rejected", () => {
  assert.throws(() => parseDefinitionPackage("a string"), DefinitionError);
  assert.throws(() => parseDefinitionPackage(null), DefinitionError);
  assert.throws(() => parseDefinitionPackage([1, 2, 3]), DefinitionError);
});

test("every optional field survives the round-trip", () => {
  const parsed = parseDefinitionPackage({
    schemaVersion: 1,
    oem: "rich",
    name: "rich-package",
    version: "2.1.0",
    provenance: {
      sourceType: "licensed",
      source: "manufacturer",
      license: "internal",
      version: "2026-01",
      retrievedAt: "2026-09-11T00:00:00Z",
      notes: "retrieved under workshop licence 2026/114",
    },
    ecus: [
      {
        id: "gateway",
        name: "Gateway",
        protocol: "kwp2000",
        description: "central gateway",
        address: {
          txId: 0x7b0,
          rxId: 0x7b8,
          extended: true,
          addressing: "extended",
          functionalId: 0x7df,
        },
        identification: [{ label: "Part number", did: 0xf187, encoding: "ascii" }],
        services: [0x10, 0x22],
        dtcs: [{ code: "U0100", description: "lost communication" }],
        timing: { p2Ms: 50, p2StarMs: 500 },
      },
    ],
    signals: [
      {
        id: "gateway.mode",
        name: "Mode",
        ecu: "gateway",
        did: 0x2000,
        service: 0x22,
        byteOffset: 0,
        length: 2,
        bitOffset: 4,
        bitLength: 3,
        encoding: "bitmask",
        endianness: "little",
        scale: 0.5,
        offsetValue: -40,
        unit: "°C",
        min: -40,
        max: 215,
        enumMapping: { 0: "off", 1: "on" },
        description: "gateway operating mode",
        critical: true,
      },
    ],
  });

  const signal = parsed.signals[0];
  assert.ok(signal);
  assert.equal(signal?.endianness, "little");
  assert.equal(signal?.scale, 0.5);
  assert.equal(signal?.offsetValue, -40);
  assert.equal(signal?.unit, "°C");
  assert.equal(signal?.critical, true);
  assert.equal(signal?.enumMapping?.[1], "on");

  const ecu = parsed.ecus[0];
  assert.ok(ecu);
  assert.equal(ecu?.protocol, "kwp2000");
  assert.equal(ecu?.address.extended, true);
  assert.equal(ecu?.address.functionalId, 0x7df);
  assert.equal(ecu?.timing?.p2StarMs, 500);
  assert.equal(parsed.provenance.license, "internal");
  assert.equal(parsed.provenance.version, "2026-01");
  assert.equal(parsed.provenance.retrievedAt, "2026-09-11T00:00:00Z");
  assert.equal(
    parsed.provenance.notes,
    "retrieved under workshop licence 2026/114",
    "the notes are part of the source declaration — dropping them would lose the only " +
      "human-readable qualification of a licence (AGENTS 24)",
  );
});

test("invalid enums and wrong-typed optional fields are reported, not guessed", () => {
  assert.throws(
    () =>
      parseDefinitionPackage({
        schemaVersion: 1,
        oem: "t",
        name: "t",
        version: "1.0.0",
        provenance: { sourceType: "not-a-type", source: "x" },
        ecus: [{ id: "e", name: "E", protocol: "other", address: { txId: "nope", rxId: 2 } }],
        signals: [
          { id: "s", name: "S", ecu: "e", did: "x", byteOffset: 0, length: 1, encoding: 42 },
        ],
      }),
    (error: unknown) => {
      assert.ok(error instanceof DefinitionError);
      const errors = (error.details as { errors: string[] }).errors;
      assert.ok(errors.some((e) => e.includes("sourceType")));
      assert.ok(errors.some((e) => e.includes("protocol")));
      assert.ok(errors.some((e) => e.includes("txId")));
      assert.ok(errors.some((e) => e.includes("did")));
      assert.ok(errors.some((e) => e.includes("encoding")));
      return true;
    },
  );
});

test("a missing provenance object is a structural error", () => {
  assert.throws(
    () =>
      parseDefinitionPackage({
        schemaVersion: 1,
        oem: "t",
        name: "t",
        version: "1.0.0",
        ecus: [],
        signals: [],
      }),
    /provenance/,
  );
});

test("non-object entries inside ecus/signals and a scalar provenance are reported", () => {
  assert.throws(
    () =>
      parseDefinitionPackage({
        schemaVersion: 1,
        oem: "t",
        name: "t",
        version: "1.0.0",
        provenance: 42,
        ecus: ["not-an-ecu-object"],
        signals: [7, null],
      }),
    (error: unknown) => {
      assert.ok(error instanceof DefinitionError);
      const errors = (error.details as { errors: string[] }).errors;
      assert.ok(errors.some((e) => e.includes("ecus[0]")));
      assert.ok(errors.some((e) => e.includes("signals[0]")));
      assert.ok(errors.some((e) => e.includes("signals[1]")));
      assert.ok(errors.some((e) => e.includes("provenance")));
      return true;
    },
  );
});

test("omitted ecus/signals arrays are reported as structural errors", () => {
  assert.throws(
    () =>
      parseDefinitionPackage({
        schemaVersion: 1,
        oem: "t",
        name: "t",
        version: "1.0.0",
        provenance: { sourceType: "own", source: "x" },
      }),
    (error: unknown) => {
      assert.ok(error instanceof DefinitionError);
      const errors = (error as DefinitionError & { details: { errors: string[] } }).details.errors;
      assert.ok(errors.some((e) => e.includes("ecus")));
      assert.ok(errors.some((e) => e.includes("signals")));
      return true;
    },
  );
});

/**
 * The two signals the knowledge fixture below measures against. A check naming a
 * signal the package does not declare is a semantic error, so a valid fixture has
 * to bring its own measuring points.
 */
function knowledgeSignals(): typeof genericPackage.signals {
  const ids = ["engine.long_term_fuel_trim", "engine.coolant_temperature"];
  return genericPackage.signals.filter((signal) => ids.includes(signal.id));
}

/** One vehicle whose `dtcKnowledge` is exactly `knowledge` — for the error table. */
function knowledgeVehicle(knowledge: unknown): unknown[] {
  return [{ id: "car", brand: "B", model: "M", dtcKnowledge: knowledge }];
}

/** The generic package with one vehicle definition, as a JSON source would carry it. */
function vehicleSource(): Record<string, unknown> {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    oem: "json-fixture",
    name: "JSON vehicle fixture",
    version: "1.0.0",
    provenance: { sourceType: "own", source: "test" },
    ecus: genericPackage.ecus,
    signals: [],
    vehicles: [
      {
        id: "car",
        brand: "Fixture",
        model: "One",
        platform: "P",
        generation: "1",
        bodyStyles: ["hatchback"],
        modelYears: { from: 2015, to: 2020 },
        vinMatch: { wmi: ["WVW"], vdsPattern: "ZZZ..", modelYearChars: ["F"], plantChars: ["W"] },
        engines: [
          {
            id: "e1",
            name: "Engine one",
            fuel: "petrol",
            displacementCc: 1395,
            powerKw: 110,
            torqueNm: 250,
            emissionStandard: "euro6d",
            codes: ["EX"],
            description: "fixture",
          },
        ],
        gearboxes: [
          { id: "g1", name: "Gearbox one", type: "dual-clutch", gears: 7, codes: ["EXG"] },
        ],
        ecus: [
          {
            ecu: genericPackage.ecus[0]!.id,
            partNumbers: ["PN"],
            softwareVersions: ["SW"],
            hardwareVersions: ["HW"],
            engine: "e1",
            gearbox: "g1",
            optional: false,
          },
        ],
        provenance: { sourceType: "licensed", source: "OEM documentation", license: "contract" },
        description: "fixture vehicle",
      },
    ],
  };
}

test("a vehicle definition survives the JSON round trip with every field", () => {
  const source = vehicleSource();
  const parsed = parseDefinitionPackage(JSON.parse(JSON.stringify(source)));
  const vehicle = parsed.vehicles?.[0];
  assert.ok(vehicle);
  assert.equal(vehicle.id, "car");
  assert.equal(vehicle.platform, "P");
  assert.equal(vehicle.generation, "1");
  assert.deepEqual(vehicle.bodyStyles, ["hatchback"]);
  assert.deepEqual(vehicle.modelYears, { from: 2015, to: 2020 });
  assert.deepEqual(vehicle.vinMatch, {
    wmi: ["WVW"],
    vdsPattern: "ZZZ..",
    modelYearChars: ["F"],
    plantChars: ["W"],
  });
  assert.equal(vehicle.engines?.[0]?.fuel, "petrol");
  assert.equal(vehicle.engines?.[0]?.displacementCc, 1395);
  assert.equal(vehicle.engines?.[0]?.emissionStandard, "euro6d");
  assert.equal(vehicle.gearboxes?.[0]?.type, "dual-clutch");
  assert.equal(vehicle.gearboxes?.[0]?.gears, 7);
  assert.deepEqual(vehicle.ecus?.[0]?.softwareVersions, ["SW"]);
  assert.equal(vehicle.ecus?.[0]?.optional, false);
  assert.equal(vehicle.provenance?.license, "contract");
  assert.equal(validateDefinitionPackage(parsed).valid, true);
});

test("a package stringifies and parses back to the same vehicles", () => {
  const parsed = parseDefinitionPackage(vehicleSource());
  const round = parseDefinitionPackageJson(JSON.stringify(parsed));
  assert.deepEqual(round.vehicles, parsed.vehicles);
});

test("a version 1 source is validated as version 1 and returned upgraded", () => {
  const source = vehicleSource();
  source.schemaVersion = 1;
  delete source.vehicles;
  const parsed = parseDefinitionPackage(source);
  assert.equal(parsed.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.deepEqual(parsed.vehicles, []);
  assert.equal(validateDefinitionPackage(parsed).valid, true);
});

test("an unsupported schema version is rejected by the parser", () => {
  const source = vehicleSource();
  source.schemaVersion = CURRENT_SCHEMA_VERSION + 1;
  assert.throws(
    () => parseDefinitionPackage(source),
    (error: unknown) => {
      assert.ok(error instanceof DefinitionError);
      assert.match(
        error.message,
        new RegExp(`schemaVersion ${CURRENT_SCHEMA_VERSION + 1} is not supported`),
      );
      return true;
    },
  );
});

test("structural problems in vehicles are collected, not silently dropped", () => {
  const cases: Array<[string, unknown, string]> = [
    ["vehicles", "not-an-array", "vehicles: must be an array"],
    ["vehicles", [null], "vehicles[0]: must be an object"],
    ["vehicles", [{ id: "car", model: "One" }], "vehicles[0].brand: must be a string"],
    ["vehicles", [{ id: "car", brand: "B", model: 7 }], "vehicles[0].model: must be a string"],
    [
      "vehicles",
      [{ id: "car", brand: "B", model: "M", bodyStyles: "hatch" }],
      "vehicles[0].bodyStyles: must be an array of strings",
    ],
    [
      "vehicles",
      [{ id: "car", brand: "B", model: "M", bodyStyles: [1] }],
      "vehicles[0].bodyStyles[0]: must be a string",
    ],
    [
      "vehicles",
      [{ id: "car", brand: "B", model: "M", modelYears: 2015 }],
      "vehicles[0].modelYears: must be an object",
    ],
    [
      "vehicles",
      [{ id: "car", brand: "B", model: "M", modelYears: { from: "2015" } }],
      "vehicles[0].modelYears.from: must be a number",
    ],
    [
      "vehicles",
      [{ id: "car", brand: "B", model: "M", vinMatch: "WVW" }],
      "vehicles[0].vinMatch: must be an object",
    ],
    [
      "vehicles",
      [{ id: "car", brand: "B", model: "M", vinMatch: { wmi: "WVW" } }],
      "vehicles[0].vinMatch.wmi: must be an array of strings",
    ],
    [
      "vehicles",
      [{ id: "car", brand: "B", model: "M", vinMatch: { vdsPattern: 5 } }],
      "vehicles[0].vinMatch.vdsPattern: must be a string",
    ],
    [
      "vehicles",
      [{ id: "car", brand: "B", model: "M", engines: "one" }],
      "vehicles[0].engines: must be an array",
    ],
    [
      "vehicles",
      [{ id: "car", brand: "B", model: "M", engines: [{}] }],
      "vehicles[0].engines[0].id: must be a string",
    ],
    [
      "vehicles",
      [{ id: "car", brand: "B", model: "M", engines: [{ id: "e", name: "n", fuel: "steam" }] }],
      "vehicles[0].engines[0].fuel: must be one of",
    ],
    [
      "vehicles",
      [{ id: "car", brand: "B", model: "M", gearboxes: "one" }],
      "vehicles[0].gearboxes: must be an array",
    ],
    [
      "vehicles",
      [{ id: "car", brand: "B", model: "M", gearboxes: [{ id: "g", name: "n", type: "flux" }] }],
      "vehicles[0].gearboxes[0].type: must be one of",
    ],
    [
      "vehicles",
      [{ id: "car", brand: "B", model: "M", ecus: "one" }],
      "vehicles[0].ecus: must be an array",
    ],
    [
      "vehicles",
      [{ id: "car", brand: "B", model: "M", ecus: [{ partNumbers: ["PN"] }] }],
      "vehicles[0].ecus[0].ecu: must be a string",
    ],
    [
      "vehicles",
      [{ id: "car", brand: "B", model: "M", provenance: { sourceType: "unknown", source: "s" } }],
      "vehicles[0].provenance.sourceType: must be one of",
    ],
    [
      "vehicles",
      [{ id: "car", brand: "B", model: "M", provenance: "own" }],
      "vehicles[0].provenance: must be an object",
    ],
    [
      "vehicles",
      [
        {
          id: "car",
          brand: "B",
          model: "M",
          provenance: { sourceType: "own", source: "s", notes: 42 },
        },
      ],
      "vehicles[0].provenance.notes: must be a string",
    ],
    [
      "vehicles",
      [
        {
          id: "car",
          brand: "B",
          model: "M",
          provenance: { sourceType: "licensed", source: "s", license: "x", retrievedAt: 2026 },
        },
      ],
      "vehicles[0].provenance.retrievedAt: must be a string",
    ],
    [
      "vehicles",
      [{ id: "car", brand: "B", model: "M", gearboxes: ["manual"] }],
      "vehicles[0].gearboxes[0]: must be an object",
    ],
    [
      "vehicles",
      [{ id: "car", brand: "B", model: "M", ecus: ["engine"] }],
      "vehicles[0].ecus[0]: must be an object",
    ],

    // --- variant fault knowledge (schema version 3) ------------------------
    ["vehicles", knowledgeVehicle("one"), "vehicles[0].dtcKnowledge: must be an array"],
    ["vehicles", knowledgeVehicle([null]), "vehicles[0].dtcKnowledge[0]: must be an object"],
    [
      "vehicles",
      knowledgeVehicle([{ description: "wording without a code" }]),
      "vehicles[0].dtcKnowledge[0].code: must be a string",
    ],
    [
      "vehicles",
      knowledgeVehicle([{ code: "P0420", severity: "fatal" }]),
      'vehicles[0].dtcKnowledge[0].severity: must be "info"',
    ],
    [
      "vehicles",
      knowledgeVehicle([{ code: "P0420", severity: 3 }]),
      'vehicles[0].dtcKnowledge[0].severity: must be "info"',
    ],
    [
      "vehicles",
      knowledgeVehicle([{ code: "P0420", relatedSignals: "engine.load" }]),
      "vehicles[0].dtcKnowledge[0].relatedSignals: must be an array of strings",
    ],
    [
      "vehicles",
      knowledgeVehicle([{ code: "P0420", relatedSignals: [1] }]),
      "vehicles[0].dtcKnowledge[0].relatedSignals[0]: must be a string",
    ],
    [
      "vehicles",
      knowledgeVehicle([{ code: "P0420", provenance: "own" }]),
      "vehicles[0].dtcKnowledge[0].provenance: must be an object",
    ],
    [
      "vehicles",
      knowledgeVehicle([
        { code: "P0420", provenance: { sourceType: "own", source: "s", version: 1 } },
      ]),
      "vehicles[0].dtcKnowledge[0].provenance.version: must be a string",
    ],
    [
      "vehicles",
      knowledgeVehicle([{ code: "P0420", patterns: "one" }]),
      "vehicles[0].dtcKnowledge[0].patterns: must be an array",
    ],
    [
      "vehicles",
      knowledgeVehicle([{ code: "P0420", patterns: [null] }]),
      "vehicles[0].dtcKnowledge[0].patterns[0]: must be an object",
    ],
    [
      "vehicles",
      knowledgeVehicle([{ code: "P0420", patterns: [{ name: "no id" }] }]),
      "vehicles[0].dtcKnowledge[0].patterns[0].id: must be a string",
    ],
    [
      "vehicles",
      knowledgeVehicle([{ code: "P0420", patterns: [{ id: "p" }] }]),
      "vehicles[0].dtcKnowledge[0].patterns[0].name: must be a string",
    ],
    [
      "vehicles",
      knowledgeVehicle([
        { code: "P0420", patterns: [{ id: "p", name: "n", likelihood: "certain" }] },
      ]),
      'vehicles[0].dtcKnowledge[0].patterns[0].likelihood: must be "common"',
    ],
    [
      "vehicles",
      knowledgeVehicle([{ code: "P0420", patterns: [{ id: "p", name: "n", likelihood: 1 }] }]),
      'vehicles[0].dtcKnowledge[0].patterns[0].likelihood: must be "common"',
    ],
    [
      "vehicles",
      knowledgeVehicle([{ code: "P0420", patterns: [{ id: "p", name: "n", checks: "one" }] }]),
      "vehicles[0].dtcKnowledge[0].patterns[0].checks: must be an array",
    ],
    [
      "vehicles",
      knowledgeVehicle([{ code: "P0420", patterns: [{ id: "p", name: "n", checks: [null] }] }]),
      "vehicles[0].dtcKnowledge[0].patterns[0].checks[0]: must be an object",
    ],
    [
      "vehicles",
      knowledgeVehicle([
        { code: "P0420", patterns: [{ id: "p", name: "n", checks: [{ expect: "no signal" }] }] },
      ]),
      "vehicles[0].dtcKnowledge[0].patterns[0].checks[0].signal: must be a string",
    ],
    [
      "vehicles",
      knowledgeVehicle([
        { code: "P0420", patterns: [{ id: "p", name: "n", checks: [{ signal: "s" }] }] },
      ]),
      "vehicles[0].dtcKnowledge[0].patterns[0].checks[0].expect: must be a string",
    ],
    [
      "vehicles",
      knowledgeVehicle([
        {
          code: "P0420",
          patterns: [{ id: "p", name: "n", checks: [{ signal: "s", expect: "e", min: "five" }] }],
        },
      ]),
      "vehicles[0].dtcKnowledge[0].patterns[0].checks[0].min: must be a number",
    ],
    [
      "vehicles",
      knowledgeVehicle([
        {
          code: "P0420",
          patterns: [{ id: "p", name: "n", checks: [{ signal: "s", expect: "e", max: true }] }],
        },
      ]),
      "vehicles[0].dtcKnowledge[0].patterns[0].checks[0].max: must be a number",
    ],
    [
      "vehicles",
      knowledgeVehicle([
        {
          code: "P0420",
          patterns: [
            { id: "p", name: "n", checks: [{ signal: "s", expect: "e", windowMs: "1000" }] },
          ],
        },
      ]),
      "vehicles[0].dtcKnowledge[0].patterns[0].checks[0].windowMs: must be a number",
    ],
  ];

  for (const [, value, expected] of cases) {
    const source = vehicleSource();
    source.vehicles = value;
    assert.throws(
      () => parseDefinitionPackage(source),
      (error: unknown) => {
        assert.ok(error instanceof DefinitionError, `expected a DefinitionError for ${expected}`);
        assert.ok(error.message.includes(expected), `expected "${expected}" in:\n${error.message}`);
        return true;
      },
      `case: ${expected}`,
    );
  }
});

test("an invalid vehicle that parses structurally is still rejected semantically", () => {
  const source = vehicleSource();
  source.vehicles = [{ id: "car", brand: "Fixture", model: "One", vinMatch: { wmi: ["IOQ"] } }];
  assert.throws(
    () => parseDefinitionPackage(source),
    (error: unknown) => {
      assert.ok(error instanceof DefinitionError);
      assert.match(error.message, /is not a valid package|WMI "IOQ"/);
      return true;
    },
  );
});

test("a file-loaded package faces the same provenance gates (AGENTS 24)", () => {
  // The JSON path is how licensed data will arrive, so a source declaration that
  // the validator rejects must not become loadable by being written to a file.
  const source = vehicleSource();
  source.provenance = { sourceType: "licensed", source: "OEM documentation" };
  assert.throws(
    () => parseDefinitionPackage(source),
    (error: unknown) => {
      assert.ok(error instanceof DefinitionError);
      assert.match(error.message, /licensed data must declare a license/);
      return true;
    },
  );

  source.provenance = {
    sourceType: "licensed",
    source: "OEM documentation",
    license: "workshop licence 2026/114",
    retrievedAt: "11.09.2026",
  };
  assert.throws(
    () => parseDefinitionPackage(source),
    (error: unknown) => {
      assert.ok(error instanceof DefinitionError);
      assert.match(error.message, /not an ISO-8601 date/);
      return true;
    },
  );

  source.provenance = {
    sourceType: "licensed",
    source: "OEM documentation",
    license: "workshop licence 2026/114",
    version: "2026-04",
    retrievedAt: "2026-09-11",
    notes: "delivery as PDF, shelf copy",
  };
  const parsed = parseDefinitionPackage(source);
  assert.deepEqual(parsed.provenance.notes, "delivery as PDF, shelf copy");
});

test("an ECU address that is not an object is named, not defaulted silently", () => {
  const source = vehicleSource();
  source.ecus = [
    { id: "engine", name: "Engine", protocol: "uds", address: "0x7e0/0x7e8" },
    { id: "abs", name: "ABS", protocol: "uds" },
  ];
  assert.throws(
    () => parseDefinitionPackage(source),
    (error: unknown) => {
      assert.ok(error instanceof DefinitionError);
      assert.ok(
        error.message.includes("ecus[0].address: must be an object with txId/rxId"),
        `expected the address problem to be named in:\n${error.message}`,
      );
      assert.ok(
        error.message.includes("ecus[1].address"),
        `a missing address must be reported too:\n${error.message}`,
      );
      return true;
    },
  );
});

test("variant fault knowledge survives the JSON round trip with every field", () => {
  const source = vehicleSource();
  source.signals = knowledgeSignals();
  const vehicles = source.vehicles as Array<Record<string, unknown>>;
  vehicles[0]!.dtcKnowledge = [
    {
      code: "P0420",
      ecu: genericPackage.ecus[0]!.id,
      engine: "e1",
      gearbox: "g1",
      description: "Variant wording",
      severity: "critical",
      hint: "Variant hint",
      conditions: "Only in closed loop above 80 °C",
      relatedSignals: ["engine.coolant_temperature"],
      provenance: { sourceType: "own", source: "written for this test" },
      patterns: [
        {
          id: "catalyst-aged",
          name: "Aged catalyst",
          explanation: "Oxygen storage is gone",
          likelihood: "common",
          repair: "Replace it only after the checks hold",
          checks: [
            { signal: "engine.long_term_fuel_trim", expect: "neutral", min: -5, max: 5 },
            { signal: "engine.coolant_temperature", expect: "warm", min: 80, windowMs: 2000 },
          ],
        },
        { id: "no-checks", name: "Documented without a measurement" },
      ],
    },
  ];

  const parsed = parseDefinitionPackage(JSON.parse(JSON.stringify(source)));
  const entry = parsed.vehicles?.[0]?.dtcKnowledge?.[0];
  assert.ok(entry, "the knowledge entry survived");
  assert.equal(entry.code, "P0420");
  assert.equal(entry.ecu, genericPackage.ecus[0]!.id);
  assert.equal(entry.engine, "e1");
  assert.equal(entry.gearbox, "g1");
  assert.equal(entry.description, "Variant wording");
  assert.equal(entry.severity, "critical");
  assert.equal(entry.hint, "Variant hint");
  assert.equal(entry.conditions, "Only in closed loop above 80 °C");
  assert.deepEqual(entry.relatedSignals, ["engine.coolant_temperature"]);
  assert.equal(entry.provenance?.sourceType, "own");

  const pattern = entry.patterns?.[0];
  assert.equal(pattern?.name, "Aged catalyst");
  assert.equal(pattern?.explanation, "Oxygen storage is gone");
  assert.equal(pattern?.likelihood, "common");
  assert.equal(pattern?.repair, "Replace it only after the checks hold");
  assert.deepEqual(pattern?.checks?.[0], {
    signal: "engine.long_term_fuel_trim",
    expect: "neutral",
    min: -5,
    max: 5,
  });
  assert.deepEqual(pattern?.checks?.[1], {
    signal: "engine.coolant_temperature",
    expect: "warm",
    min: 80,
    windowMs: 2000,
  });
  assert.deepEqual(entry.patterns?.[1], {
    id: "no-checks",
    name: "Documented without a measurement",
  });

  const result = validateDefinitionPackage(parsed);
  assert.deepEqual(result.errors, [], result.errors.join(", "));
  assert.deepEqual(
    result.warnings.filter((warning) => warning.includes("knowledge for")),
    [
      'vehicle "car": knowledge for P0420, pattern "no-checks" has no measurement check — ' +
        "it can be read, not verified",
    ],
    "the only complaint is the one pattern that documents no measurement",
  );

  const round = parseDefinitionPackageJson(JSON.stringify(parsed));
  assert.deepEqual(round.vehicles, parsed.vehicles, "stringify and parse change nothing");
});

test("knowledge that references nothing real is rejected semantically", () => {
  const source = vehicleSource();
  const vehicles = source.vehicles as Array<Record<string, unknown>>;
  vehicles[0]!.dtcKnowledge = [
    {
      code: "P0420",
      ecu: "nosuch",
      engine: "nosuch",
      gearbox: "nosuch",
      relatedSignals: ["engine.nosuch"],
      patterns: [
        {
          id: "duplicate",
          name: "First",
          checks: [{ signal: "engine.nosuch", expect: "anything" }],
        },
        { id: "duplicate", name: "Second", checks: [] },
      ],
    },
    { code: "P0420", ecu: "nosuch" },
    // Same scope again, written in lower case: the duplicate has to be caught.
    { code: "p0420", ecu: "nosuch" },
    { code: "X9999" },
  ];
  assert.throws(
    () => parseDefinitionPackage(source),
    (error: unknown) => {
      assert.ok(error instanceof DefinitionError);
      const message = error.message;
      for (const expected of [
        'references unknown ECU "nosuch"',
        'references unknown engine "nosuch"',
        'references unknown gearbox "nosuch"',
        'references unknown signal "engine.nosuch"',
        'duplicate failure pattern id "duplicate"',
        "declared twice with the same ECU/engine/gearbox scope",
        'malformed DTC code "X9999"',
      ]) {
        assert.ok(message.includes(expected), `expected "${expected}" in:\n${message}`);
      }
      return true;
    },
  );
});
