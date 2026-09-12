import assert from "node:assert/strict";
import {
  addMarker,
  clearDtcs,
  connectVehicle,
  disconnectVehicle,
  getAnomalies,
  getAvailableActions,
  getDtcClearPrecheck,
  getDtcList,
  getEcu,
  getEcuCapabilities,
  getEcuList,
  getMarkers,
  getMeasurementStatus,
  getMeasurements,
  getRecordingHistory,
  getSession,
  getSignalList,
  getStatistics,
  getVehicle,
  identifyEcus,
  readDid,
  readDtcFreezeFrame,
  readDtcs,
  snapshotSignals,
  startMeasurements,
  stopMeasurements,
} from "@vdp/application";
import { genericPackage } from "@vdp/definitions";
import { RecordingEventBus, policyForWriteOperation } from "@vdp/domain";
import { createDiagnosticRuntime } from "@vdp/runtime";
import { MemorySink, createLogger } from "@vdp/shared";
import { VirtualVehicle } from "@vdp/simulators";
import { afterAll, beforeAll, test } from "vitest";

/**
 * Runtime integration test (target architecture §33: "ideale Core-Nutzung").
 *
 * The whole platform is driven through the runtime's application API —
 * commands, queries and domain events — never through engine internals:
 *
 *   runtime.vehicle.connect() → runtime.dtc.read() → …
 *
 * Same virtual vehicle as the full-stack test, same determinism.
 */

const logSink = new MemorySink();
const logger = createLogger("runtime-app", { level: "WARN" }, [logSink]);
const vehicle = new VirtualVehicle({ logger, dynamic: true, seed: 42 });
const events = new RecordingEventBus();
const runtime = createDiagnosticRuntime({
  bus: vehicle.testerBus,
  definitions: [genericPackage],
  logger,
  events,
});

beforeAll(async () => {
  await vehicle.start();
});

afterAll(async () => {
  await runtime.dispose();
  await vehicle.stop();
});

test("runtime.connect() discovers ECUs through the command bus", async () => {
  const result = await runtime.commands.dispatch(
    connectVehicle({ windowMs: 120, probeDelayMs: 0 }),
  );
  assert.ok(result.session.sessionId.length > 0);
  assert.ok(result.ecus.length >= 3, `expected at least 3 ECUs, got ${result.ecus.length}`);
  assert.ok(result.vehicle?.vin, "VIN must be detected through the runtime");
  const rxIds = result.ecus.map((ecu) => ecu.rxId);
  assert.ok(rxIds.includes(0x7e8));
});

test("connection publishes domain events with correlation ids", async () => {
  const connected = events.ofType("vehicle-connected");
  assert.equal(connected.length, 1);
  const session = await runtime.commands.query(getSession());
  assert.equal(connected[0]?.sessionId, session?.sessionId);
  assert.ok((connected[0]?.ecuCount ?? 0) >= 3);
  const discovered = events.ofType("ecu-discovered");
  assert.ok(discovered.length >= 3);
  assert.ok(discovered.every((payload) => payload.sessionId === connected[0]?.sessionId));
  const capabilities = events.ofType("ecu-capabilities-updated");
  assert.ok(capabilities.length >= 1, "probed services become capability events");
});

test("ECU summaries carry capability-driven data (§6)", async () => {
  const ecus = await runtime.commands.query(getEcuList());
  const engineEcu = ecus.find((ecu) => ecu.rxId === 0x7e8);
  assert.ok(engineEcu);
  assert.ok(engineEcu.capabilities.includes("read-dtc"), "the engine ECU answers 0x19");
  assert.ok(engineEcu.capabilities.includes("read-did"), "the engine ECU answers 0x22");

  const byId = await runtime.commands.query(getEcu(engineEcu.ecuId));
  assert.equal(byId?.name, engineEcu.name);
  const byAddress = runtime.ecus.get("0x7e8");
  assert.equal(
    byAddress?.ecuId,
    engineEcu.ecuId,
    "ECUs are addressable by record id and hex address",
  );

  const capabilities = await runtime.commands.query(getEcuCapabilities(engineEcu.ecuId));
  assert.deepEqual(capabilities, engineEcu.capabilities);
});

test("ecu.identify re-reads identification through the command bus", async () => {
  const summaries = await runtime.commands.dispatch(identifyEcus());
  assert.ok(summaries.length >= 3);
  const engineEcu = summaries.find((ecu) => ecu.rxId === 0x7e8);
  assert.ok(engineEcu);
  assert.ok(engineEcu.identification.length >= 1, "identification DIDs are answered");
  assert.ok(engineEcu.supportedServices.length >= 1, "probed services travel with the summary");
  assert.ok(engineEcu.p2Ms > 0, "polling timing is part of the ECU read model");
  // The address form stays valid as an ECU reference after the re-read.
  assert.equal(runtime.ecus.get("0x7e8")?.ecuId, engineEcu.ecuId);
});

test("available actions derive from capabilities, not brand checks (§7)", async () => {
  const ecus = await runtime.commands.query(getEcuList());
  const engineEcu = ecus.find((ecu) => ecu.rxId === 0x7e8);
  assert.ok(engineEcu);
  const actions = await runtime.commands.query(getAvailableActions(engineEcu.ecuId));
  const ids = actions.map((action) => action.id);
  assert.ok(ids.includes("dtc.read"), "read-dtc capability offers the DTC read action");
  assert.ok(ids.includes("did.read"), "read-did capability offers the DID read action");

  // The architectural property: every offered action's required capabilities
  // are a subset of the ECU's declared capabilities. No brand switch anywhere.
  const declared = new Set(engineEcu.capabilities);
  for (const action of actions) {
    for (const required of action.requiredCapabilities) {
      assert.ok(
        declared.has(required),
        `action ${action.id} requires ${required} which the ECU does not declare`,
      );
    }
  }

  // An ECU without the write capability must not be offered the write action.
  const readOnlyEcu = ecus.find((ecu) => !ecu.capabilities.includes("clear-dtc"));
  if (readOnlyEcu) {
    const readOnlyActions = await runtime.commands.query(getAvailableActions(readOnlyEcu.ecuId));
    assert.ok(!readOnlyActions.map((action) => action.id).includes("dtc.clear"));
  }
});

test("dtc.read scans every ECU and fills the read model", async () => {
  const dtcs = await runtime.commands.dispatch(readDtcs());
  assert.ok(dtcs.length > 0, "the simulator seeds DTCs");
  const catalyst = dtcs.find((dtc) => dtc.code === "P0420");
  assert.ok(catalyst, `expected P0420, got ${dtcs.map((dtc) => dtc.code).join(", ")}`);
  assert.ok(catalyst.description?.toLowerCase().includes("catalyst"));
  assert.ok(catalyst.ecuName.length > 0);

  const readModel = await runtime.commands.query(getDtcList());
  assert.equal(readModel.length, dtcs.length);
  const filtered = await runtime.commands.query(getDtcList(catalyst.ecuId));
  assert.ok(filtered.length >= 1);
  assert.ok(filtered.every((dtc) => dtc.ecuId === catalyst.ecuId));

  assert.ok(events.ofType("dtcs-read").length >= 1);
});

test("dtc.read targets a single ECU without losing the rest of the read model", async () => {
  const all = await runtime.commands.dispatch(readDtcs());
  const target = all.find((dtc) => dtc.code === "P0420");
  assert.ok(target);

  const single = await runtime.commands.dispatch(readDtcs(target.ecuId));
  assert.ok(single.length >= 1);
  assert.ok(single.every((dtc) => dtc.ecuId === target.ecuId));

  const readModel = await runtime.commands.query(getDtcList());
  const otherEcus = readModel.filter((dtc) => dtc.ecuId !== target.ecuId);
  assert.ok(
    otherEcus.length > 0 || all.every((dtc) => dtc.ecuId === target.ecuId),
    "other ECUs stay in the read model",
  );
});

test("dtc.freeze-frame decodes the snapshot and keeps the raw bytes (§20)", async () => {
  const dtcs = await runtime.commands.query(getDtcList());
  const catalyst = dtcs.find((dtc) => dtc.code === "P0420");
  assert.ok(catalyst);

  const frame = await runtime.commands.dispatch(readDtcFreezeFrame(catalyst.ecuId, "P0420"));
  assert.equal(frame.code, "P0420");
  assert.ok(frame.fields.length > 0, "the documented layout splits the record into fields");
  for (const field of frame.fields) {
    assert.match(field.rawHex, /^[0-9A-F ]+$/, "every field keeps its raw bytes");
    assert.ok(field.values.length > 0);
  }
  assert.equal(typeof frame.documented, "boolean");

  // A code the ECU does not know rejects with a usable message.
  await assert.rejects(
    runtime.commands.dispatch(readDtcFreezeFrame(catalyst.ecuId, "P0999")),
    /no freeze frame/,
  );
});

test("dtc.clear-precheck reports missing preconditions without permitting (§26)", async () => {
  const ecus = await runtime.commands.query(getEcuList());
  const engineEcu = ecus.find((ecu) => ecu.rxId === 0x7e8);
  assert.ok(engineEcu);

  const unconfirmed = await runtime.commands.query(
    getDtcClearPrecheck(engineEcu.ecuId, {
      stationary: true,
      ignitionOn: true,
      parkingBrake: true,
      batteryVoltage: 13.1,
    }),
  );
  assert.equal(unconfirmed.ok, false, "without confirmation the precheck fails");
  assert.ok(unconfirmed.failed.some((reason) => /confirmation/i.test(reason)));
  assert.equal(unconfirmed.ecuId, engineEcu.ecuId);
  assert.ok(
    runtime.safety.audit.every((entry) => entry.action !== "permit-issued"),
    "a precheck never issues a permit",
  );
});

test("did.read returns raw bytes through the application API", async () => {
  const ecus = await runtime.commands.query(getEcuList());
  const engineEcu = ecus.find((ecu) => ecu.rxId === 0x7e8);
  assert.ok(engineEcu);
  const vin = await runtime.commands.dispatch(readDid(engineEcu.ecuId, 0xf190));
  assert.equal(vin.byteLength, 17);
  assert.match(vin.hex, /^[0-9A-F ]+$/);
  assert.ok(events.ofType("did-read").length >= 1);
});

test("measurement.snapshot decodes and records through the runtime", async () => {
  const readings = await runtime.commands.dispatch(
    snapshotSignals(["engine.rpm", "engine.coolant_temperature"]),
  );
  assert.ok(readings.length >= 2);
  const rpm = readings.find((reading) => reading.signalId === "engine.rpm");
  assert.ok(rpm);
  assert.equal(rpm.unit, "rpm");
  assert.ok((rpm.value as number) > 0);
  assert.ok(rpm.rawHex.length > 0, "raw bytes travel with the decoded value");

  const samples = await runtime.commands.query(getMeasurements("engine.rpm"));
  assert.ok(samples.length >= 1);
  assert.ok(events.ofType("measurements-recorded").length >= 1);
});

test("live measurements run and stop through commands", async () => {
  await runtime.commands.dispatch(startMeasurements(["engine.rpm"], 10));
  await new Promise((resolve) => setTimeout(resolve, 120));
  await runtime.commands.dispatch(stopMeasurements());
  const samples = await runtime.commands.query(getMeasurements("engine.rpm"));
  assert.ok(samples.length > 1, "polling must have produced several samples");
  assert.deepEqual(await runtime.commands.query(getMeasurementStatus()), { live: false });
});

test("the sample stream observes recorded rounds without recording twice", async () => {
  const before = (await runtime.commands.query(getMeasurements("engine.rpm"))).length;
  const streamed: number[] = [];
  // Registered before the start command: the service buffers listeners until
  // the poll loop exists, so the capture is deterministic — every round of
  // the run is observed.
  const off = runtime.measurements.onSample((round) => {
    streamed.push(...round.readings.map((reading) => reading.t));
  });
  await runtime.commands.dispatch(startMeasurements(["engine.rpm"], 10));
  await new Promise((resolve) => setTimeout(resolve, 120));
  await runtime.commands.dispatch(stopMeasurements());
  off();

  const samples = await runtime.commands.query(getMeasurements("engine.rpm"));
  const recorded = samples.length - before;
  assert.ok(streamed.length > 1, "the stream delivered rounds");
  assert.equal(
    streamed.length,
    recorded,
    "every streamed reading is exactly one recorded sample — no double recording",
  );
  assert.ok(
    streamed.every((t) => t >= 0),
    "streamed readings stay on the recording time axis",
  );
});

test("markers, statistics, anomalies and the signal list are queries", async () => {
  const marker = await runtime.commands.dispatch(addMarker("Testereignis", "user"));
  assert.equal(marker.kind, "user");
  const markers = await runtime.commands.query(getMarkers());
  assert.ok(markers.some((entry) => entry.markerId === marker.markerId));

  const statistics = await runtime.commands.query(getStatistics());
  const rpm = statistics.find((stat) => stat.signalId === "engine.rpm");
  assert.ok(rpm, "the polled signal has window statistics");
  assert.ok((rpm.samples ?? 0) > 1);
  assert.equal(rpm.name.length > 0, true);

  assert.ok(Array.isArray(await runtime.commands.query(getAnomalies())));

  const signals = await runtime.commands.query(getSignalList());
  assert.ok(signals.some((signal) => signal.signalId === "engine.rpm"));
  assert.ok(signals.every((signal) => typeof signal.critical === "boolean"));

  const recording = await runtime.commands.query(getRecordingHistory());
  assert.ok(recording.samples.length > 1);
  assert.ok(recording.markers.some((entry) => entry.markerId === marker.markerId));
  assert.ok(recording.startedAt > 0);
  const capped = await runtime.commands.query(getRecordingHistory(10));
  assert.ok(capped.samples.length <= 10);
  assert.equal(capped.markers.length, recording.markers.length);
});

test("dtc.clear runs the safety chain and emits the audit events (§15)", async () => {
  const ecus = await runtime.commands.query(getEcuList());
  const engineEcu = ecus.find((ecu) => ecu.rxId === 0x7e8);
  assert.ok(engineEcu);

  events.clear();

  // 1. Without confirmation the safety chain denies — no bus write happens.
  const refused = await runtime.commands.dispatch(
    clearDtcs(engineEcu.ecuId, false, {
      stationary: true,
      ignitionOn: true,
      parkingBrake: true,
      batteryVoltage: 13.1,
    }),
  );
  assert.equal(refused.ok, false);
  assert.ok(refused.reasons.some((reason) => /confirmation/i.test(reason)));
  assert.equal(events.ofType("safety-approval-denied").length, 1);
  assert.equal(events.ofType("dtcs-cleared").length, 0);

  // 2. Confirmed + valid preconditions: permit → write → verification.
  const outcome = await runtime.commands.dispatch(
    clearDtcs(engineEcu.ecuId, true, {
      stationary: true,
      ignitionOn: true,
      parkingBrake: true,
      batteryVoltage: 13.1,
    }),
  );
  assert.equal(outcome.ok, true);
  assert.equal(outcome.verified, true);
  assert.ok(outcome.permitId, "the audit trail references the safety permit");
  assert.ok(outcome.actionId, "the operation carries a stable action id");
  assert.ok(outcome.beforeCount >= 1, "the before snapshot is the backup");

  const requested = events.ofType("safety-approval-requested");
  assert.equal(requested.length, 2);
  assert.equal(requested[1]?.risk, policyForWriteOperation("clear-dtc").risk);
  assert.equal(events.ofType("safety-approval-granted").length, 1);
  assert.equal(events.ofType("dtcs-cleared").length, 1);
  const executed = events.ofType("action-executed");
  assert.ok(executed.some((payload) => payload.ok === true && payload.operation === "clear-dtc"));

  // 3. Safety service exposes the audit trail.
  const audit = runtime.safety.audit.map((entry) => entry.action);
  assert.ok(audit.includes("permit-issued"));
});

test("the session read model and persistence port work without HTTP", async () => {
  const summary = await runtime.commands.query(getSession());
  assert.ok(summary);
  assert.ok(summary.ecuCount >= 3);
  assert.ok(summary.actionCount >= 1, "the clear was recorded as a session action");
  assert.equal(summary.definitionPackage?.oem, "generic");

  const vehicleSummary = await runtime.commands.query(getVehicle());
  assert.ok(vehicleSummary?.vin);
});

test("disconnect ends the session with a final event", async () => {
  events.clear();
  await runtime.commands.dispatch(disconnectVehicle());
  const disconnected = events.ofType("vehicle-disconnected");
  assert.equal(disconnected.length, 1);
  assert.ok((disconnected[0]?.durationMs ?? -1) >= 0);
  // The closed session stays available for saving/export — it is history now.
  const closed = runtime.session.current();
  assert.ok(closed);
  assert.ok(closed.endedAt, "the session must be marked closed");
});
