import assert from "node:assert/strict";
import { genericPackage } from "@vdp/definitions";
import { describe, test } from "vitest";
import { PackageDefinitionProvider } from "./index.js";

describe("PackageDefinitionProvider", () => {
  const provider = new PackageDefinitionProvider([genericPackage]);

  test("lists packages with their SemVer", () => {
    const packages = provider.listPackages();
    assert.equal(packages.length, 1);
    assert.equal(packages[0]?.oem, "generic");
    assert.match(packages[0]?.version ?? "", /^\d+\.\d+\.\d+/);
  });

  test("finds ECUs by id and by bus address", () => {
    const byId = provider.findEcu({ id: "engine", oem: "generic" });
    assert.ok(byId);
    assert.equal(byId.name, "Engine Control Unit");
    assert.equal(byId.protocol, "uds");

    const byRxId = provider.findEcu({ rxId: 0x7e8 });
    assert.equal(byRxId?.id, "engine");
    const byTxId = provider.findEcu({ txId: 0x7e0 });
    assert.equal(byTxId?.id, "engine");
  });

  test("oem filter is honoured", () => {
    assert.equal(provider.findEcu({ id: "engine", oem: "vag" }), undefined);
  });

  test("finds signal DIDs and identification DIDs", () => {
    const signalDid = genericPackage.signals[0];
    assert.ok(signalDid);
    const found = provider.findDid({ did: signalDid.did, ecu: signalDid.ecu });
    assert.ok(found, `DID 0x${signalDid.did.toString(16)} must be defined`);
    assert.ok((found.signalIds ?? []).length > 0);

    const vin = provider.findDid({ did: 0xf190 });
    assert.ok(vin, "the VIN identification DID must resolve");
  });

  test("finds signals by id", () => {
    const signal = provider.findSignal("engine.rpm");
    assert.ok(signal);
    assert.equal(signal.ecu, "engine");
    assert.equal(signal.unit, "rpm");
    assert.equal(provider.findSignal("does.not.exist"), undefined);
  });

  test("source describes the origin", () => {
    assert.equal(provider.source, "builtin-packages");
    const custom = new PackageDefinitionProvider([], "file:/tmp/pkg.json");
    assert.equal(custom.source, "file:/tmp/pkg.json");
    assert.deepEqual(custom.listPackages(), []);
  });

  test("extended addressing and declared services travel with the ECU ref", () => {
    const custom = new PackageDefinitionProvider([
      {
        schemaVersion: 1,
        oem: "test",
        name: "Test Package",
        version: "0.1.0",
        provenance: { sourceType: "own", source: "unit test" },
        ecus: [
          {
            id: "gateway",
            name: "Gateway",
            address: { txId: 0x18db33f1, rxId: 0x18daf1, extended: true },
            protocol: "uds",
            services: [0x10, 0x22],
          },
        ],
        signals: [
          {
            id: "gateway.mode",
            name: "Mode",
            ecu: "gateway",
            did: 0x2000,
            byteOffset: 0,
            length: 1,
            encoding: "uint8",
          },
        ],
      },
    ]);
    const gateway = custom.findEcu({ rxId: 0x18daf1 });
    assert.ok(gateway);
    assert.equal(gateway.address?.extended, true);
    assert.deepEqual(gateway.services, [0x10, 0x22]);
    assert.equal(custom.findEcu({ txId: 0x1234 }), undefined);
    const unitless = custom.findSignal("gateway.mode");
    assert.ok(unitless);
    assert.equal(unitless.unit, undefined);
  });

  test("unknown DIDs resolve to undefined", () => {
    assert.equal(provider.findDid({ did: 0x0001, ecu: "engine" }), undefined);
    assert.equal(provider.findDid({ did: 0x0001 }), undefined);
  });
});
