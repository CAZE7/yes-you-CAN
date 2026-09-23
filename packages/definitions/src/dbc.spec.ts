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
});
