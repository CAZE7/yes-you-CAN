/**
 * DBC parser and definition package generator specs (master backlog / OEM knowledge).
 */

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { dbcToDefinitionPackage, parseDbc } from "./dbc.js";
import { DefinitionRegistry } from "./index.js";
import { assertValidPackage } from "./validate.js";

const SAMPLE_DBC = `
VERSION ""

NS_ :

BS_:

BU_: ECM ABS BCM

BO_ 200 EngineStatus: 8 ECM
 SG_ EngineSpeed : 0|16@1+ (0.25,0) [0|8000] "rpm" ABS,BCM
 SG_ CoolantTemp : 16|8@1- (1,-40) [-40|150] "degC" BCM
 SG_ ThrottlePos : 24|8@1+ (0.39215686,0) [0|100] "%" BCM

BO_ 201 VehicleSpeedMsg: 4 ABS
 SG_ VehicleSpeed : 0|16@1+ (0.01,0) [0|300] "km/h" ECM,BCM

CM_ BO_ 200 "Engine telemetry from primary powertrain module";
CM_ SG_ 200 EngineSpeed "Crankshaft rotational speed";
`;

const COMPLEX_DBC = `
BO_ 2147485696 ExtendedMsg: 8 GW
 SG_ BigEndianSig : 7|12@0+ (1,0) [0|4095] "" 
 SG_ SignedInt32 : 32|32@1- (1,0) [-2147483648|2147483647] "raw" Vector__XXX
 SG_ Int16Sig : 16|16@1- (1,0) [0|0] "" 
 SG_ BitfieldSig : 3|5@1+ (1,0) [0|31] "" 
 SG_ Uint32Sig : 0|32@1+ (1,0) [0|4294967295] "" 

CM_ BO_ 999 "Unmatched message comment";
CM_ SG_ 999 NonExistent "Unmatched signal comment";
CM_ SG_ 2147485696 NonExistentInMsg "Unmatched in message";
`;

describe("DBC parser", () => {
  test("parses nodes, messages and signals from DBC text", () => {
    const db = parseDbc(SAMPLE_DBC);
    assert.deepEqual(db.nodes.sort(), ["ABS", "BCM", "ECM"]);
    assert.equal(db.messages.length, 2);

    const engineMsg = db.messages.find((m) => m.name === "EngineStatus");
    assert.ok(engineMsg);
    assert.equal(engineMsg.id, 200);
    assert.equal(engineMsg.dlc, 8);
    assert.equal(engineMsg.transmitter, "ECM");
    assert.equal(engineMsg.description, "Engine telemetry from primary powertrain module");
    assert.equal(engineMsg.signals.length, 3);

    const speedSig = engineMsg.signals.find((s) => s.name === "EngineSpeed");
    assert.ok(speedSig);
    assert.equal(speedSig.startBit, 0);
    assert.equal(speedSig.bitLength, 16);
    assert.equal(speedSig.endianness, "little");
    assert.equal(speedSig.signed, false);
    assert.equal(speedSig.scale, 0.25);
    assert.equal(speedSig.offset, 0);
    assert.equal(speedSig.min, 0);
    assert.equal(speedSig.max, 8000);
    assert.equal(speedSig.unit, "rpm");
    assert.equal(speedSig.description, "Crankshaft rotational speed");

    const tempSig = engineMsg.signals.find((s) => s.name === "CoolantTemp");
    assert.ok(tempSig);
    assert.equal(tempSig.signed, true);
    assert.equal(tempSig.offset, -40);
    assert.equal(tempSig.unit, "degC");
  });

  test("handles empty or whitespace lines gracefully", () => {
    const db = parseDbc("   \n\n\n");
    assert.deepEqual(db.messages, []);
    assert.deepEqual(db.nodes, []);
  });

  test("parses 29-bit extended CAN IDs, big endian, and various encodings", () => {
    const db = parseDbc(COMPLEX_DBC);
    assert.equal(db.messages.length, 1);
    const msg = db.messages[0];
    assert.ok(msg);
    assert.equal(msg.extended, true);
    assert.equal(msg.signals.length, 5);

    const bigSig = msg.signals.find((s) => s.name === "BigEndianSig");
    assert.ok(bigSig);
    assert.equal(bigSig.endianness, "big");
    assert.equal(bigSig.unit, undefined);
    assert.deepEqual(bigSig.receivers, []);

    const s32 = msg.signals.find((s) => s.name === "SignedInt32");
    assert.ok(s32);
    assert.equal(s32.signed, true);
    assert.equal(s32.bitLength, 32);
  });

  test("dbcToDefinitionPackage produces a schema-valid DefinitionPackage", () => {
    const pkg = dbcToDefinitionPackage(SAMPLE_DBC, {
      oem: "vag-dbc",
      name: "VAG OpenDBC Import",
      version: "1.0.0",
      provenanceSource: "https://github.com/commaai/opendbc/volkswagen_mqb.dbc",
    });

    assert.equal(pkg.oem, "vag-dbc");
    assert.equal(pkg.schemaVersion, 3);
    assert.equal(pkg.version, "1.0.0");
    assert.ok(pkg.ecus.length >= 2);
    assert.ok(pkg.signals.length === 4);

    // Verify it passes full schema validation
    const validated = assertValidPackage(pkg);
    assert.equal(validated.oem, "vag-dbc");

    // Register into DefinitionRegistry
    const registry = new DefinitionRegistry([pkg]);
    const retrieved = registry.get("vag-dbc");
    assert.ok(retrieved);
    assert.equal(retrieved.signals.length, 4);
    assert.ok(retrieved.signals.some((s) => s.name === "EngineSpeed"));
  });

  test("dbcToDefinitionPackage converts complex types and handles default options", () => {
    const pkg = dbcToDefinitionPackage(COMPLEX_DBC, {
      oem: "generic-complex",
      name: "Complex Test",
    });

    assert.equal(pkg.version, "1.0.0");
    assert.equal(pkg.provenance.source, "DBC Database Import");
    assert.equal(pkg.ecus[0]?.address.extended, true);

    const validated = assertValidPackage(pkg);
    assert.ok(validated);
  });

  test("dbcToDefinitionPackage handles empty database with fallback gateway", () => {
    const pkg = dbcToDefinitionPackage("", {
      oem: "empty",
      name: "Empty DB",
    });

    assert.equal(pkg.ecus.length, 1);
    assert.equal(pkg.ecus[0]?.id, "gateway");
    assert.equal(pkg.signals.length, 0);
  });
});
