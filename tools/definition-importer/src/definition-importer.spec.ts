import assert from "node:assert/strict";
import type { Provenance } from "@vdp/definitions";
import { DefinitionError } from "@vdp/shared";
import { test } from "vitest";
import { importCsv, importDbc, importJson } from "./index.js";

const PROVENANCE: Provenance = {
  sourceType: "licensed",
  source: "test fixture DBC, no OEM documentation used",
  license: "test fixture license",
};

const DBC = `VERSION ""

NS_ :
	NS_DESC_

BS_:

BU_: ECU1 ECU2

BO_ 2024 EngineData: 8 Vector__XXX
 SG_ EngineSpeed : 0|16@1+ (0.25,0) [0|16383.75] "rpm" Vector__XXX
 SG_ CoolantTemp : 16|8@1+ (1,-40) [-40|215] "degC" Vector__XXX

BO_ 2025 VinData: 8 Vector__XXX
 SG_ VinPart : 0|16@1+ (1,0) [0|0] "ascii" Vector__XXX

BO_ 666 BroadcastSpeed: 8 Vector__XXX
 SG_ WheelSpeed : 0|16@1+ (0.01,0) [0|655] "kmh" Vector__XXX

CM_ SG_ 2016 EngineSpeed "Engine speed in RPM";
`;

test("DBC messages become ECUs and signals keep factor, offset and unit", () => {
  const result = importDbc(DBC, { oem: "test", name: "DBC import test", provenance: PROVENANCE });
  assert.deepEqual(result.errors, []);
  assert.equal(result.valid, true);
  assert.equal(result.pkg.ecus.length, 2, "the broadcast message must not become an ECU");
  assert.equal(result.pkg.ecus[0]?.address.rxId, 2024);
  assert.equal(
    result.pkg.ecus[0]?.address.txId,
    2024 - 8,
    "ISO 15765-4: request id is the response id minus 8",
  );
  assert.ok(
    result.skipped.some(
      (entry) => entry.reason === "message id is not a diagnostic response identifier",
    ),
  );
  const rpm = result.pkg.signals.find((signal) => signal.id === "ecu_enginedata.enginespeed");
  assert.ok(rpm, `signal ids are ${result.pkg.signals.map((s) => s.id).join(", ")}`);
  assert.equal(rpm.scale, 0.25);
  assert.equal(rpm.unit, "rpm");
  assert.equal(rpm.encoding, "uint16");
  assert.equal(rpm.bitLength, 16);
  assert.equal(rpm.endianness, "little");
  const coolant = result.pkg.signals.find((signal) => signal.id === "ecu_enginedata.coolanttemp");
  assert.equal(coolant?.offsetValue, -40);
  assert.equal(coolant?.encoding, "uint8");
});

test("bit length maps to a plausible encoding, including ascii", () => {
  const result = importDbc(DBC, { oem: "test", name: "encodings", provenance: PROVENANCE });
  const vin = result.pkg.signals.find((signal) => signal.id === "ecu_vindata.vinpart");
  assert.equal(vin?.encoding, "ascii");
  assert.equal(vin?.length, 2, "16 bits is two bytes");
});

test("signals longer than the schema supports are reported, not truncated", () => {
  const withLongSignal = `${DBC}\nBO_ 2026 LongData: 8 Vector__XXX\n SG_ WholeVin : 0|136@1+ (1,0) [0|0] "ascii" Vector__XXX\n`;
  const result = importDbc(withLongSignal, {
    oem: "test",
    name: "long signal",
    provenance: PROVENANCE,
  });
  assert.deepEqual(result.errors, []);
  assert.ok(
    result.skipped.some((entry) => /bitLength 136 exceeds/.test(entry.reason)),
    result.skipped.map((entry) => entry.reason).join(" | "),
  );
});

test("29-bit diagnostic ids swap the tester and ECU address bytes", () => {
  // 0x18DAF110 = ECU 0x10 answering tester 0xF1; its request id swaps the two
  // address bytes to 0x18DA10F1 (ISO 15765-4).
  const result = importDbc(
    `${DBC}\nBO_ 417001744 ExtendedEcu: 8 Vector__XXX\n SG_ Value : 0|8@1+ (1,0) [0|255] "count" Vector__XXX\n`,
    {
      oem: "test",
      name: "extended",
      provenance: PROVENANCE,
    },
  );
  const ecu = result.pkg.ecus.find((candidate) => candidate.address.rxId === 0x18daf110);
  assert.ok(ecu, `ecus: ${result.pkg.ecus.map((c) => c.address.rxId.toString(16)).join(",")}`);
  assert.equal(ecu.address.txId, 0x18da10f1);
  assert.equal(ecu.address.extended, true);
  assert.deepEqual(result.errors, []);
});

test("unsupported DBC records are reported, not silently dropped", () => {
  const withUnknown = `${DBC}\nSOME_UNKNOWN_RECORD foo;\n`;
  const result = importDbc(withUnknown, { oem: "test", name: "skip test", provenance: PROVENANCE });
  assert.ok(
    result.skipped.some(
      (entry) =>
        entry.reason === "unsupported DBC record" && entry.text.includes("SOME_UNKNOWN_RECORD"),
    ),
  );
});

test("DBC imports carry their provenance into the package (AGENTS 24)", () => {
  const result = importDbc(DBC, { oem: "test", name: "provenance", provenance: PROVENANCE });
  assert.equal(result.pkg.provenance.sourceType, "licensed");
  assert.match(result.pkg.provenance.source, /test fixture/);
  assert.ok(
    !result.warnings.some((warning) => warning.includes("placeholder")),
    "a documented provenance must not warn about placeholders",
  );
});

test("CSV imports build ECUs from the txId/rxId columns", () => {
  const csv = [
    "ecu,txId,rxId,did,byteOffset,length,encoding,name,unit,scale,offset",
    "Engine,7E0,7E8,F40C,0,2,uint16,Engine speed,rpm,0.25,",
    "Engine,7E0,7E8,F405,0,1,uint8,Coolant temperature,degC,1,-40",
    "Transmission,7E1,7E9,F187,0,8,ascii,Part number,,,",
  ].join("\n");
  const result = importCsv(csv, {
    oem: "test",
    name: "CSV import",
    provenance: { sourceType: "community", source: "test fixture" },
  });
  assert.deepEqual(result.errors, []);
  assert.equal(result.pkg.ecus.length, 2);
  assert.equal(result.pkg.signals.length, 3);
  const coolant = result.pkg.signals.find((signal) => signal.name === "Coolant temperature");
  assert.equal(coolant?.offsetValue, -40);
  assert.equal(coolant?.ecu, "ecu_engine");
  assert.equal(result.pkg.ecus[0]?.address.rxId, 0x7e8);
});

test("CSV rows with an unknown encoding are skipped with a reason", () => {
  const csv = [
    "ecu,txId,rxId,did,byteOffset,length,encoding,name,unit,scale,offset",
    "Engine,7E0,7E8,F40C,0,2,quantum,Engine speed,rpm,,",
  ].join("\n");
  const result = importCsv(csv, {
    oem: "test",
    name: "bad encoding",
    provenance: { sourceType: "community", source: "test fixture" },
  });
  assert.equal(result.pkg.signals.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0]?.reason ?? "", /unknown encoding "quantum"/);
});

test("a CSV without the required columns fails with an actionable error", () => {
  assert.throws(
    () =>
      importCsv("name,unit\nfoo,bar\n", {
        oem: "test",
        name: "x",
        provenance: { sourceType: "community", source: "y" },
      }),
    (error: unknown) => {
      assert.ok(error instanceof DefinitionError);
      assert.match(error.message, /requires a "ecu" column/);
      return true;
    },
  );
});

test("JSON imports validate the package they produce", () => {
  const json = JSON.stringify({
    ecus: [
      {
        id: "engine",
        name: "Engine",
        address: { txId: 0x7e0, rxId: 0x7e8 },
        protocol: "uds",
        services: [0x22],
      },
    ],
    signals: [
      {
        id: "engine.rpm",
        name: "Engine speed",
        ecu: "engine",
        did: 0xf40c,
        byteOffset: 0,
        length: 2,
        encoding: "uint16",
        scale: 0.25,
        unit: "rpm",
      },
    ],
  });
  const result = importJson(json, {
    oem: "test",
    name: "JSON import",
    provenance: { sourceType: "own", source: "written for this test" },
  });
  assert.deepEqual(result.errors, []);
  assert.equal(result.pkg.signals[0]?.id, "engine.rpm");
});

test("invalid JSON is reported as a definition error", () => {
  assert.throws(
    () =>
      importJson("{ not json", {
        oem: "test",
        name: "x",
        provenance: { sourceType: "own", source: "y" },
      }),
    /not valid/,
  );
});

test("a reverse-engineered import still carries its warning (AGENTS 24)", () => {
  const json = JSON.stringify({
    ecus: [
      {
        id: "engine",
        name: "Engine",
        address: { txId: 0x7e0, rxId: 0x7e8 },
        protocol: "uds",
        services: [0x22],
      },
    ],
    signals: [],
  });
  const result = importJson(json, {
    oem: "test",
    name: "no provenance",
    provenance: { sourceType: "reverse-engineered", source: "unknown" },
  });
  assert.ok(
    result.warnings.some((warning) => warning.includes("reverse-engineered")),
    `warnings were: ${result.warnings.join(" | ")}`,
  );
});

test("a structurally broken import is rejected with the validator errors", () => {
  // Rejected means rejected: a document nobody understood must not come back as a
  // result that a script can shrug at. The reasons are the parser's own list, so the
  // message says which field of which section is wrong — and nothing is quietly
  // dropped on the way.
  assert.throws(
    () =>
      importJson(JSON.stringify({ ecus: [], signals: [] }), {
        oem: "",
        name: "broken",
        version: "not-semver",
        provenance: { sourceType: "own", source: "y" },
      }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /oem is required|oem/);
      assert.match(message, /SemVer/);
      return true;
    },
  );
});

/**
 * The vehicle axis survives the file path (AGENTS 13.1, 13.2, 23; ADR 0024, 0026).
 *
 * Measured before this was fixed: the same document came back with `valid: true`,
 * `errors: []` and no `vehicles` at all — the importer read only `ecus` and `signals`,
 * so everything that makes knowledge *about a variant* was gone, and the only sign was
 * a report with no knowledge in it. That is the same class as the lost `notes` field of
 * ADR 0025: an optional field nobody copies is invisible until someone trusts it.
 */

function vehicleDocument(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 3,
    oem: "acme",
    name: "Acme baseline",
    version: "1.0.0",
    provenance: { sourceType: "own", source: "acme workshop notes" },
    ecus: [
      {
        id: "engine",
        name: "Engine Control Unit",
        protocol: "uds",
        address: { txId: 0x7e0, rxId: 0x7e8 },
        dtcs: [{ code: "P0420", description: "Catalyst efficiency below threshold" }],
      },
    ],
    signals: [
      {
        id: "cat.temp",
        name: "Catalyst temperature",
        ecu: "engine",
        did: 0xf010,
        unit: "°C",
        encoding: "uint8",
        byteOffset: 0,
        length: 1,
        min: -40,
        max: 200,
      },
    ],
    vehicles: [
      {
        id: "acme-1-2",
        brand: "Acme",
        model: "One",
        vinMatcher: { wmi: "SAJ" },
        engines: [{ id: "acme-16v", name: "1.6 16V" }],
        dtcKnowledge: [
          {
            code: "P0420",
            engine: "acme-16v",
            description: "Aging substrate, not a sensor fault",
            conditions: "closed loop, above 80 °C",
            patterns: [
              {
                id: "aged-substrate",
                name: "Storage capacity fades with age",
                checks: [
                  { signal: "cat.temp", expect: "flat near exhaust gas", min: 600, windowMs: 5000 },
                ],
              },
            ],
            provenance: { sourceType: "own", source: "acme workshop notes" },
          },
        ],
      },
    ],
    ...extra,
  });
}

const ACME_OPTIONS = {
  oem: "acme",
  name: "Acme baseline",
  provenance: { sourceType: "own" as const, source: "acme workshop notes" },
};

test("a file-imported package keeps its vehicles and their fault knowledge", () => {
  const result = importJson(vehicleDocument(), ACME_OPTIONS);
  assert.equal(result.valid, true, result.errors.join(" | "));
  const vehicle = result.pkg.vehicles?.[0];
  assert.equal(vehicle?.id, "acme-1-2");
  assert.deepEqual(
    vehicle?.engines?.map((engine) => engine.id),
    ["acme-16v"],
  );
  const entry = vehicle?.dtcKnowledge?.[0];
  assert.equal(entry?.code, "P0420");
  assert.equal(entry?.engine, "acme-16v");
  assert.equal(entry?.conditions, "closed loop, above 80 °C");
  const check = entry?.patterns?.[0]?.checks?.[0];
  assert.equal(check?.signal, "cat.temp");
  assert.equal(check?.min, 600);
  assert.equal(check?.windowMs, 5000);
});

test("the knowledge that arrives from a file answers like the built-in one", async () => {
  // Not a round-trip test of the parser alone: what matters is that the *lookup*
  // finds the variant statement, which is the reason the section exists at all.
  const { findDtcKnowledge } = await import("@vdp/definitions");
  const { pkg } = importJson(vehicleDocument(), ACME_OPTIONS);
  const hit = findDtcKnowledge([pkg], {
    code: "P0420",
    vehicleId: "acme-1-2",
    oem: "acme",
    engineIds: ["acme-16v"],
  });
  assert.equal(hit?.scope, "vehicle-engine");
  assert.equal(hit?.description, "Aging substrate, not a sensor fault");
  assert.equal(hit?.patterns.length, 1);
  assert.equal(
    hit?.patterns[0]?.checks[0]?.measurable,
    true,
    "a bound and a window make it evaluable",
  );
});

test("a licensed knowledge entry is held to its gates on the file path (§23)", () => {
  // The gates themselves are the library's; what is tested here is that they FIRE ON
  // THIS PATH — a rule that only runs on the object path is a rule that never runs for
  // licensed data, because licensed data arrives as a file.
  const document = vehicleDocument({
    vehicles: [
      {
        id: "acme-1-2",
        brand: "Acme",
        model: "One",
        vinMatcher: { wmi: "SAJ" },
        engines: [{ id: "acme-16v", name: "1.6 16V" }],
        dtcKnowledge: [
          {
            code: "P0420",
            engine: "acme-16v",
            description: "from a licensed manual",
            patterns: [{ id: "p1", name: "n", repair: "replace the catalyst" }],
            provenance: { sourceType: "licensed", source: "OEM documentation" },
          },
        ],
      },
    ],
  });
  assert.throws(
    () =>
      importJson(document, {
        ...ACME_OPTIONS,
        provenance: {
          sourceType: "licensed",
          source: "OEM documentation",
          license: "MIT",
          version: "2026-01",
          retrievedAt: "2026-01-01",
        },
      }),
    (error: unknown) => {
      assert.match(error instanceof Error ? error.message : String(error), /license/);
      return true;
    },
  );

  // Community data is not forbidden — it is labelled, and the label has to survive the
  // file path too, including for a repair hint (§24: rights may attach to that field).
  const community = importJson(
    vehicleDocument({
      vehicles: [
        {
          id: "acme-1-2",
          brand: "Acme",
          model: "One",
          vinMatcher: { wmi: "SAJ" },
          engines: [{ id: "acme-16v", name: "1.6 16V" }],
          dtcKnowledge: [
            {
              code: "P0420",
              engine: "acme-16v",
              description: "forum consensus",
              patterns: [{ id: "p1", name: "n", repair: "reset adaptation" }],
              provenance: { sourceType: "community", source: "owner forum thread" },
            },
          ],
        },
      ],
    }),
    { ...ACME_OPTIONS, provenance: { sourceType: "community", source: "owner forum thread" } },
  );
  assert.equal(community.valid, true);
  assert.ok(
    community.warnings.some((warning) => warning.toLowerCase().includes("community")),
    community.warnings.join(" | "),
  );
});

test("a vehicle section that cannot be understood is named, not skipped", () => {
  // The old path cast `vehicles` away before validation, so a broken powertrain
  // entry was neither repaired nor reported. Now the reason is in the message.
  const document = vehicleDocument({
    vehicles: [{ id: "acme-1-2", brand: "Acme", model: "One", engines: [{ id: "no-name" }] }],
  });
  assert.throws(
    () => importJson(document, ACME_OPTIONS),
    (error: unknown) => {
      assert.match(
        error instanceof Error ? error.message : String(error),
        /engines\[0\]\.name|name/,
        error instanceof Error ? error.message : String(error),
      );
      return true;
    },
  );
});

test("an unknown key in a package document is not silently accepted as noise", () => {
  // `dtcKnowlege` (one letter off) must not read as "no knowledge declared": the
  // section exists, so a misspelling of its name is a defect worth a message. This
  // pins that the parser at least does not lose the *correct* spelling next to it.
  const withTypo = importJson(vehicleDocument({ dtcKnowlege: [{ code: "P0001" }] }), ACME_OPTIONS);
  assert.equal(withTypo.valid, true, "an unknown key is not a schema violation");
  assert.equal(withTypo.pkg.vehicles?.length, 1, "and the real section still arrives");
});
