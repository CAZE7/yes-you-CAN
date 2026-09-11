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
  const result = importJson(JSON.stringify({ ecus: [], signals: [] }), {
    oem: "",
    name: "broken",
    version: "not-semver",
    provenance: { sourceType: "own", source: "y" },
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes("oem is required")));
  assert.ok(result.errors.some((error) => error.includes("SemVer")));
});
