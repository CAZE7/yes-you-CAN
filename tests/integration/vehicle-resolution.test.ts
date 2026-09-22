import assert from "node:assert/strict";
import { connectVehicle, getEcuList, readDtcs, resolveVehicle } from "@vdp/application";
import { SIMULATOR_VIN, simulatorPackage } from "@vdp/definitions";
import { createDiagnosticRuntime } from "@vdp/runtime";
import { createLogger, MemorySink } from "@vdp/shared";
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
 *
 * The last test walks one step further (AGENTS 20, 23): the resolution is what
 * makes fault knowledge specific, so a scanned code has to arrive with the
 * wording, the patterns and the measuring checks of *this* variant — and a code
 * nobody documented for it has to arrive saying exactly that.
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

test("a scanned fault carries the knowledge of the resolved variant", async () => {
  // connect() resolved the car from the bus already, so the first scan is
  // enriched with what this variant documents — no extra operator step.
  const dtcs = await runtime.commands.dispatch(readDtcs());
  const byCode = new Map(dtcs.map((dtc) => [dtc.code, dtc]));

  const catalyst = byCode.get("P0420");
  assert.ok(catalyst, "the virtual vehicle reports the seeded catalyst code");
  assert.equal(catalyst.knowledge?.scope, "vehicle-engine");
  assert.equal(catalyst.knowledge?.vehicleId, "virtual-vehicle");
  assert.equal(catalyst.knowledge?.provenanceType, "own");
  assert.match(catalyst.description ?? "", /2\.4 L petrol/, "the variant wording wins");
  assert.match(catalyst.knowledge?.conditions ?? "", /closed loop/);
  assert.deepEqual(
    catalyst.knowledge?.patterns.map((pattern) => pattern.id),
    ["catalyst-aged", "exhaust-leak-before-catalyst"],
  );
  assert.deepEqual(catalyst.knowledge?.notes, [], "the powertrain was read, nothing is assumed");
  const aged = catalyst.knowledge?.patterns[0];
  assert.equal(aged?.repair !== undefined, true, "repair advice travels with its pattern");
  assert.ok(
    aged?.checks.every((check) => check.measurable && check.name !== undefined),
    "every check names a signal the package defines and a window a tool can evaluate",
  );

  const gearbox = byCode.get("P0715");
  assert.equal(
    gearbox?.knowledge?.scope,
    "vehicle-gearbox",
    "the transmission code answers for the automatic gearbox",
  );

  // The chassis code is variant knowledge without an engine or gearbox axis.
  const chassis = byCode.get("C0035");
  assert.equal(chassis?.knowledge?.scope, "vehicle");
  assert.deepEqual(
    chassis?.knowledge?.patterns.map((pattern) => pattern.id),
    ["implausible-speed-on-straight-run", "intermittent-wheel-harness"],
  );
  const straightRun = chassis?.knowledge?.patterns[0];
  assert.ok(
    straightRun?.checks.every((check) => check.measurable && check.windowMs === 5000),
    "the three-way comparison is evaluable over the same five seconds",
  );
  const harness = chassis?.knowledge?.patterns[1];
  assert.equal(
    harness?.checks[0]?.measurable,
    false,
    "a dropout watch keeps its window and gets no invented bound",
  );
  assert.equal(harness?.checks[0]?.windowMs, 30000);

  // P0700 names no fault of its own, and the knowledge says that instead of
  // inventing causes: one pattern carries no check at all.
  const milRequest = byCode.get("P0700");
  assert.equal(milRequest?.knowledge?.scope, "vehicle-gearbox");
  assert.deepEqual(
    milRequest?.knowledge?.patterns.map((pattern) => pattern.id),
    ["underlying-code-in-module", "request-outlived-the-fault", "module-self-test"],
  );
  assert.deepEqual(milRequest?.knowledge?.patterns[2]?.checks, []);

  // A network code means the same for every engine and gearbox, so no variant
  // entry exists for it — and the answer says so instead of dressing the
  // package-wide wording up as variant knowledge (§24).
  const undocumented = byCode.get("U0121");
  assert.equal(undocumented?.knowledge?.scope, "package");
  assert.ok(
    undocumented?.knowledge?.notes.some((note) =>
      note.includes("no variant-specific knowledge documented"),
    ),
    undocumented?.knowledge?.notes.join(" | "),
  );
  assert.match(
    undocumented?.description ?? "",
    /Lost communication with anti-lock brake system/,
    "the manufacturer-wide wording stays, and says that it is",
  );
});

test("the session stores the determination that decided it", async () => {
  // The resolution used to end in the workbench's memory: a stored session knew the
  // VIN and nothing else, so a report or an analysis could not say which car — with
  // which evidence — this was (AGENTS 11.1, ADR 0026). Compared against the query's
  // own answer, because the earlier tests in this file re-resolve with other inputs
  // and the session always records the *latest* attempt.
  const resolution = await runtime.commands.query(resolveVehicle());
  const data = runtime.session.data();
  assert.ok(data, "connect leaves a session behind");
  const determination = data.determination;
  assert.ok(determination, "resolving records");

  assert.equal(determination.match?.vehicleId, resolution.best?.vehicleId);
  assert.equal(determination.match?.score, resolution.best?.score);
  assert.equal(determination.match?.oem, "simulator");
  assert.equal(determination.match?.packageVersion, "1.0.0");
  assert.equal(determination.match?.trust, 1);
  assert.equal(determination.match?.provenanceType, "own");
  assert.deepEqual(determination.match?.engineIds, ["sim-petrol"]);
  assert.deepEqual(determination.match?.gearboxIds, ["sim-automatic"]);
  assert.deepEqual(determination.match?.ecus, { expected: 3, matched: 3, missing: [] });
  assert.deepEqual(determination.unexplained, []);
  assert.match(determination.resolvedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(
    (determination.match?.evidence ?? []).some((entry) => entry.kind === "part-number"),
    "the evidence that decided the match is readable in the session",
  );

  // The measured identity stays what the bus answered: brand and model are the
  // conclusion, and a conclusion must not creep back in as a premise (§11.1 rule 7).
  assert.equal(data.vehicle?.vin, SIMULATOR_VIN);
  assert.equal(data.vehicle?.brand, undefined);
});

test("the read model names the car the resolution concluded", async () => {
  const summary = runtime.session.current();
  assert.ok(summary, "the session has a summary");
  assert.equal(summary.vehicle?.vehicleId, "virtual-vehicle");
  assert.equal(summary.vehicle?.brand, "Virtual");
  assert.match(summary.vehicle?.description ?? "", /Virtual Simulator vehicle/);
});
