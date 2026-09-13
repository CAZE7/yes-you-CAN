import assert from "node:assert/strict";
import { connectVehicle, getEcuList, resolveVehicle } from "@vdp/application";
import { SIMULATOR_VIN, simulatorPackage } from "@vdp/definitions";
import { createDiagnosticRuntime } from "@vdp/runtime";
import { MemorySink, createLogger } from "@vdp/shared";
import { VirtualVehicle } from "@vdp/simulators";
import { afterAll, beforeAll, test } from "vitest";

/**
 * Vehicle resolution end to end (AGENTS 11, 13).
 *
 * virtual vehicle → discovery → identification → runtime query bus →
 * definitions resolver → ranked candidates with evidence.
 *
 * This is the proof that the vehicle axis is wired, not just modelled: the VIN
 * comes off the bus, the identification values come out of the UDS responses, the
 * discovered addresses come out of discovery, and nothing about the car is typed
 * in by a test.
 */

const logSink = new MemorySink();
const logger = createLogger("vehicle-resolution", { level: "WARN" }, [logSink]);
const vehicle = new VirtualVehicle({ logger, definitions: simulatorPackage, dynamic: false });
const runtime = createDiagnosticRuntime({
  bus: vehicle.testerBus,
  definitions: [simulatorPackage],
  logger,
});

beforeAll(async () => {
  await vehicle.start();
  await runtime.commands.dispatch(connectVehicle({ windowMs: 120, probeDelayMs: 0 }));
});

afterAll(async () => {
  await runtime.dispose();
  await vehicle.stop();
});

test("the connected virtual vehicle is resolved through the query bus", async () => {
  const resolution = await runtime.commands.query(resolveVehicle());
  assert.equal(resolution.unresolved, false);
  assert.equal(resolution.best?.vehicleId, "virtual-vehicle");
  assert.equal(resolution.best?.brand, "Virtual");
  assert.equal(resolution.best?.platform, "SIM-1");
  assert.equal(resolution.best?.score, 1, "every declared criterion is confirmed by the bus");
  assert.deepEqual(resolution.best?.conflicts, []);
});

test("the evidence names what was actually read", async () => {
  const resolution = await runtime.commands.query(resolveVehicle());
  const best = resolution.best;
  assert.ok(best);
  const byKind = new Map(best.evidence.map((entry) => [entry.kind, entry]));

  assert.equal(byKind.get("vin-wmi")?.observed, SIMULATOR_VIN.slice(0, 3));
  assert.equal(byKind.get("vin-vds")?.observed, "CM826");
  assert.equal(byKind.get("part-number")?.observed, "ENGINE-f187");
  assert.match(byKind.get("part-number")?.reason ?? "", /DID 0xf187/);
  assert.equal(byKind.get("software-version")?.observed, "ENGINE-f181");
  assert.equal(byKind.get("hardware-version")?.observed, "ABS-f193");
  assert.deepEqual(best.engineIds, ["sim-petrol"]);
  assert.deepEqual(best.gearboxIds, ["sim-automatic"]);
});

test("all three ECUs of the definition answered discovery", async () => {
  const resolution = await runtime.commands.query(resolveVehicle());
  const best = resolution.best;
  assert.ok(best);
  assert.equal(best.expectedEcus, 3);
  assert.equal(best.matchedEcus, 3);
  assert.deepEqual(best.missingEcus, []);
});

test("identification entries carry the DID they were read from", async () => {
  const ecus = await runtime.commands.query(getEcuList());
  const engine = ecus.find((ecu) => ecu.rxId === 0x7e8);
  assert.ok(engine);
  const partNumber = engine.identification.find((entry) => entry.label === "Spare part number");
  assert.equal(partNumber?.did, 0xf187, "a value must stay traceable to its request");
  assert.equal(partNumber?.value, "ENGINE-f187");
});

test("a VIN that contradicts the bus is reported, not hidden", async () => {
  const resolution = await runtime.commands.query(resolveVehicle({ vin: "WVWZZZ1JZHW000001" }));
  const best = resolution.best;
  assert.ok(best, "the identification values and the ECU set still speak for this car");
  assert.equal(best.vehicleId, "virtual-vehicle");
  assert.ok(best.score < 0.5, `a contradicting VIN must lower the score, got ${best.score}`);
  assert.deepEqual(best.conflicts.map((entry) => entry.kind).sort(), [
    "vin-model-year",
    "vin-plant",
    "vin-vds",
    "vin-wmi",
  ]);
  assert.equal(resolution.vinLookup?.brand, "Volkswagen", "the VIN itself is still interpreted");
});

test("what the operator declares is weighed, and can be overridden", async () => {
  const matching = await runtime.commands.query(
    resolveVehicle({
      declared: { oem: "simulator", brand: "Virtual", model: "Simulator vehicle" },
    }),
  );
  assert.equal(matching.best?.score, 1);

  const wrong = await runtime.commands.query(
    resolveVehicle({ declared: { model: "Something else" } }),
  );
  assert.ok(wrong.best, "a wrong claim does not discard the bus evidence");
  assert.ok(
    wrong.best?.conflicts.some((entry) => entry.kind === "declared-model"),
    "it is reported as a conflict instead",
  );
});

test("the provider reports how many vehicles a package carries", () => {
  const packages = runtime.definitions.listPackages();
  assert.deepEqual(
    packages.map((pkg) => [pkg.oem, pkg.vehicles]),
    [["simulator", 1]],
  );
});
