import assert from "node:assert/strict";
import { SIMULATOR_VIN, genericPackage, simulatorPackage } from "@vdp/definitions";
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

/** Every address the simulated car answers on, taken from its own definition. */
const SIMULATOR_ADDRESSES = simulatorPackage.ecus.map((ecu) => ({
  txId: ecu.address.txId,
  rxId: ecu.address.rxId,
  extended: ecu.address.extended ?? false,
}));

/** What the simulated car reports when its identification DIDs are read. */
const SIMULATOR_IDENTIFICATION = [
  { oem: "simulator", ecu: "engine", did: 0xf187, value: "ENGINE-f187" },
  { oem: "simulator", ecu: "engine", did: 0xf181, value: "ENGINE-f181" },
  { oem: "simulator", ecu: "engine", did: 0xf18c, value: "ENGINE-f18c" },
  { oem: "simulator", ecu: "transmission", did: 0xf18c, value: "TRANSMISSION-f18c" },
  { oem: "simulator", ecu: "abs", did: 0xf193, value: "ABS-f193" },
];

describe("PackageDefinitionProvider.resolveVehicle", () => {
  const provider = new PackageDefinitionProvider([simulatorPackage]);

  test("a resolved candidate keeps every field the layers above need", () => {
    const result = provider.resolveVehicle({
      vin: SIMULATOR_VIN,
      identifications: SIMULATOR_IDENTIFICATION,
      discoveredAddresses: SIMULATOR_ADDRESSES,
    });
    assert.equal(result.unresolved, false);
    const best = result.best;
    assert.ok(best);
    assert.equal(best.oem, "simulator");
    assert.equal(best.packageVersion, simulatorPackage.version);
    assert.equal(best.vehicleId, "virtual-vehicle");
    assert.equal(best.brand, "Virtual");
    assert.equal(best.model, "Simulator vehicle");
    assert.equal(best.platform, "SIM-1");
    assert.equal(best.provenanceType, "own");
    assert.equal(best.trust, 1, "own data is fully trusted");
    assert.equal(best.score, 1, "the simulated car confirms everything it is claimed to be");
    assert.deepEqual(best.engineIds, ["sim-petrol"]);
    assert.deepEqual(best.gearboxIds, ["sim-automatic"]);
    assert.equal(best.expectedEcus, 3);
    assert.equal(best.matchedEcus, 3);
    assert.deepEqual(best.missingEcus, []);
    assert.deepEqual(best.conflicts, []);
    assert.deepEqual(
      best.evidence.map((item) => item.kind),
      [
        "vin-wmi",
        "vin-vds",
        "vin-model-year",
        "vin-plant",
        "part-number",
        "software-version",
        "powertrain-code",
        "powertrain-code",
        "hardware-version",
        "ecu-coverage",
      ],
    );
    assert.equal(best, result.candidates[0], "best is the mapped candidate, not a second copy");
    assert.equal(result.vinLookup?.manufacturer, "Honda of America Mfg.");
  });

  test("evidence carries observed, expected, weight and reason for the UI", () => {
    const result = provider.resolveVehicle({ vin: SIMULATOR_VIN });
    const wmi = result.best?.evidence.find((item) => item.kind === "vin-wmi");
    assert.deepEqual(wmi, {
      kind: "vin-wmi",
      observed: "1HG",
      expected: "1HG",
      weight: 3,
      reason: "WMI 1HG is one this Virtual definition claims",
    });
  });

  test("a VIN no definition claims still says who built the car", () => {
    const result = provider.resolveVehicle({ vin: "WVWZZZ1JZHW000001" });
    assert.equal(result.unresolved, true);
    assert.deepEqual(result.candidates, []);
    assert.equal(result.best, undefined);
    assert.equal(result.vinLookup?.wmi, "WVW");
    assert.equal(result.vinLookup?.manufacturer, "Volkswagen AG");
    assert.equal(result.vinLookup?.known, true);
  });

  test("a VIN alone cannot confirm ECU coverage", () => {
    const result = provider.resolveVehicle({ vin: SIMULATOR_VIN });
    const best = result.best;
    assert.ok(best);
    assert.ok(best.score < 1, "nothing answered the bus, so something stays unproven");
    assert.equal(best.expectedEcus, 3);
    assert.equal(best.matchedEcus, 0);
    assert.deepEqual(best.missingEcus, ["engine", "transmission", "abs"]);
    assert.equal(best.evidence.find((item) => item.kind === "ecu-coverage")?.weight, 0);
  });

  test("identification from another package is not credited", () => {
    const result = provider.resolveVehicle({
      vin: SIMULATOR_VIN,
      identifications: [{ oem: "vag", ecu: "engine", did: 0xf187, value: "ENGINE-f187" }],
      discoveredAddresses: SIMULATOR_ADDRESSES,
    });
    assert.equal(
      result.best?.evidence.some((item) => item.kind === "part-number"),
      false,
      "a value read from a VAG-defined ECU must not support a simulator candidate",
    );
  });

  test("a package without vehicle definitions explains why nothing resolves", () => {
    const result = new PackageDefinitionProvider([genericPackage]).resolveVehicle({
      vin: SIMULATOR_VIN,
      identifications: SIMULATOR_IDENTIFICATION,
    });
    assert.equal(result.unresolved, true);
    assert.deepEqual(result.candidates, []);
    assert.equal(result.notes.length, 1);
    assert.match(result.notes[0] ?? "", /vehicle definitions/);
    assert.equal(result.vinLookup?.wmi, "1HG", "the VIN lookup works without any vehicle data");
  });

  test("without input nothing is claimed", () => {
    assert.deepEqual(provider.resolveVehicle({}), {
      candidates: [],
      unresolved: true,
      notes: [],
      unexplained: [],
    });
  });

  test("listPackages reports how many vehicles a package carries", () => {
    assert.equal(provider.listPackages()[0]?.vehicles, 1);
    assert.equal(
      new PackageDefinitionProvider([genericPackage]).listPackages()[0]?.vehicles,
      0,
      "0 says the package is OEM-wide: reference data without vehicle definitions",
    );
  });
});
