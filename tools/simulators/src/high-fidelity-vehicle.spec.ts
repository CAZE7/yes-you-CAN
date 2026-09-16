/**
 * High-fidelity virtual vehicle — measured over the wire (AGENTS 32, 11, 20).
 *
 * The rule these tests are written against is a simple one: **nothing is asserted on a
 * setter's return value or on a field of the simulator.** A cause is applied to the
 * vehicle, the model is advanced, and the *answer on the diagnostic wire* is what gets
 * checked — a `0x22` read of a DID, a `0x19` read of a fault memory, a `0x2E` write
 * that the module then lives by. That is the difference between "the test could set it"
 * and "the vehicle behaves so that a scan finds it", and only the second one is worth
 * anything to a diagnosis.
 *
 * Stack under every test: real `UdsClient` → real `IsoTpConnection` → virtual CAN →
 * real `UdsServer` of the module, with the behaviour model behind it.
 */

import assert from "node:assert/strict";
import { type DtcRecord, UdsClient } from "@vdp/protocols-uds";
import { createLogger } from "@vdp/shared";
import { IsoTpConnection } from "@vdp/transport-iso-tp";
import { afterAll, beforeAll, describe, test } from "vitest";
import { HEARTBEAT_IDS, HighFidelityVehicle } from "./high-fidelity-vehicle.js";
import type { VirtualEcu } from "./virtual-vehicle.js";

const logger = createLogger("hifi-spec", { level: "ERROR" });

/**
 * A tester on the vehicle's own bus, addressed like the engine would address that ECU.
 *
 * `p2Ms` is short on purpose: the "does it answer" assertions wait for a timeout, and a
 * timeout is the thing under test — not a sleep (AGENTS 31/ADR 0019).
 */
function testerFor(vehicle: HighFidelityVehicle, ecuId: string): UdsClient {
  const ecu = vehicle.ecu(ecuId);
  if (ecu === undefined) throw new Error(`no such ECU: ${ecuId}`);
  const isoTp = new IsoTpConnection(
    vehicle.testerBus,
    {
      // The definition's ids are named from the tester's side, so they are *not*
      // swapped here — the ECU's own connection is the one that mirrors them.
      txId: ecu.definition.address.txId,
      rxId: ecu.definition.address.rxId,
      extended: ecu.definition.address.extended ?? false,
      addressing: ecu.definition.address.addressing ?? "normal",
      padding: true,
    },
    logger,
  );
  isoTp.open();
  return new UdsClient(isoTp, {
    name: ecu.definition.name,
    logger,
    timing: { p2Ms: 60, p2StarMs: 120, s3Ms: 5_000 },
  });
}

/** Battery voltage as the BCM reports it on DID 0x2001 (uint16, 0.01 V per bit). */
async function readSupplyVolts(tester: UdsClient): Promise<number> {
  const payload = await tester.readDid(0x2001);
  assert.ok(payload, "the BCM answers a read of its own supply DID");
  return (((payload[0] ?? 0) << 8) | (payload[1] ?? 0)) / 100;
}

/** Engine speed as the engine reports it on PID 0x0C (0.25 rpm per bit). */
async function readRpm(tester: UdsClient): Promise<number> {
  const payload = await tester.readDid(0xf40c);
  assert.ok(payload);
  return (((payload[0] ?? 0) << 8) | (payload[1] ?? 0)) * 0.25;
}

function stored(records: readonly DtcRecord[], code: string): DtcRecord | undefined {
  return records.find((dtc) => dtc.code === code);
}

/** A healthy supply plus enough cranking for the engine to catch — the honest way in. */
function crankToRunning(vehicle: HighFidelityVehicle): void {
  vehicle.setIgnition("start");
  vehicle.advance(2_000);
  vehicle.setIgnition("on");
  vehicle.advance(400);
  assert.equal(
    vehicle.model.state.engineRunning,
    true,
    "the model said no start, so the test says so too",
  );
}

describe("HighFidelityVehicle, measured through UDS", () => {
  const vehicle = new HighFidelityVehicle({
    modelTickMs: 0,
    initialIgnition: "on",
    initialBatteryVoltage: 12.6,
  });
  let bcm: UdsClient;
  let engine: UdsClient;
  let gateway: UdsClient;
  let abs: UdsClient;

  beforeAll(async () => {
    await vehicle.start();
    bcm = testerFor(vehicle, "bcm");
    engine = testerFor(vehicle, "engine");
    gateway = testerFor(vehicle, "gateway");
    abs = testerFor(vehicle, "abs");
  });

  afterAll(async () => {
    await vehicle.stop();
  });

  test("the 5-ECU topology is what the definition package declares", () => {
    assert.deepEqual(vehicle.ecus.map((ecu) => ecu.definition.id).sort(), [
      "abs",
      "bcm",
      "engine",
      "gateway",
      "transmission",
    ]);
    assert.equal(vehicle.ecu("gateway")?.definition.address.txId, 0x7e4);
    assert.equal(vehicle.ecu("engine")?.definition.address.txId, 0x7e0);
    assert.equal(vehicle.ecu("abs")?.definition.address.txId, 0x713);
  });

  test("a behaviour-model vehicle starts with an empty fault memory, on purpose", async () => {
    // The definition package declares codes for every module. With a model that can
    // latch them itself, a scan must not report a fault nothing caused — and the old
    // fixture behaviour stays available, but only when a caller names it.
    assert.deepEqual(await gateway.readDtcByStatusMask(0xff), []);
    const withHistory = new HighFidelityVehicle({
      modelTickMs: 0,
      startWithStoredFaults: true,
      dynamic: false,
    });
    await withHistory.start();
    try {
      const codes = await testerFor(withHistory, "engine").readDtcByStatusMask(0xff);
      assert.ok(
        codes.some((dtc) => dtc.code === "P0420"),
        `opting in keeps the package's own memory, read ${codes.map((d) => d.code)}`,
      );
    } finally {
      await withHistory.stop();
    }
  });

  test("cranking drags the supply down, and the BCM reports it on the wire", async () => {
    const resting = await readSupplyVolts(bcm);
    assert.ok(resting > 13, `a running engine charges, found ${resting} V`);

    vehicle.setIgnition("off");
    vehicle.advance(1_500);
    vehicle.setBatteryVoltage(11.4);
    vehicle.setElectricalLoad(25);
    vehicle.setIgnition("start");
    vehicle.advance(600);

    const cranking = await readSupplyVolts(bcm);
    assert.ok(
      cranking < resting - 1,
      `starter load must be visible at the pins: ${resting} V resting vs ${cranking} V cranking`,
    );
    // And it takes a start to get there: `on` is a key position, not a starter — a
    // model that restarted the engine by itself would hide half of what a no-start
    // complaint is about.
    crankToRunning(vehicle);
    const charging = await readSupplyVolts(bcm);
    assert.ok(charging > cranking + 1, `the alternator has to carry the load, got ${charging} V`);
  });

  test("a supply dip long enough latches B1001, and a scan reads it as active", async () => {
    vehicle.setIgnition("off");
    vehicle.setBatteryVoltage(10.9);
    vehicle.advance(1_000);

    const codes = await bcm.readDtcByStatusMask(0xff);
    const underVoltage = stored(codes, "B1001");
    assert.ok(underVoltage, `BCM must have stored B1001, read ${codes.map((d) => d.code)}`);
    assert.equal(underVoltage.statusBits.testFailed, true, "the condition is present now");
    assert.equal(underVoltage.statusBits.confirmedDtc, true);

    // And the model invents no freeze frame: this package declares no record layout for
    // B1001, so the honest answer to "where was the car when it latched?" is an empty
    // record, not a plausible-looking byte blob (AGENTS 20.1).
    const record = await bcm.readDtcSnapshotRecord("B1001");
    assert.equal(record?.data.length ?? 0, 0, "no documented layout, no snapshot bytes");
  });

  test("the same code heals into stored-only once the cause is gone", async () => {
    vehicle.setIgnition("on");
    vehicle.setBatteryVoltage(13.2);
    vehicle.advance(2_500);

    const codes = await bcm.readDtcByStatusMask(0xff);
    const healed = stored(codes, "B1001");
    assert.ok(healed, "the code stays in the memory after the fault is over");
    assert.equal(healed.statusBits.testFailed, false, "the condition is not present any more");
    assert.equal(healed.statusBits.testFailedThisOperationCycle, true);
  });

  test("a short dip does not latch anything — the debounce is the diagnosis", async () => {
    const fresh = new HighFidelityVehicle({ modelTickMs: 0 });
    await fresh.start();
    const tester = testerFor(fresh, "bcm");
    try {
      fresh.setIgnition("off");
      fresh.setBatteryVoltage(10);
      fresh.advance(120);
      fresh.setBatteryVoltage(12.9);
      fresh.advance(400);
      const codes = await tester.readDtcByStatusMask(0xff);
      assert.deepEqual(
        codes.map((dtc) => dtc.code),
        [],
        "120 ms of undervoltage is shorter than the monitor's window, so nothing is stored",
      );
    } finally {
      await fresh.stop();
    }
  });

  test("cutting a module's supply silences it, and the gateway says so from the wire", async () => {
    // The ABS is alive and talking first — otherwise "lost communication" would be a
    // statement about a module that was never there.
    const heartbeat = HEARTBEAT_IDS.abs ?? 0;
    vehicle.advance(200);
    const framesBefore = vehicle.network
      .snapshot()
      .filter((frame) => frame.id === heartbeat).length;
    assert.ok(framesBefore > 0, "an online module broadcasts, so a peer can notice it");

    vehicle.cutPower("abs");
    vehicle.advance(800);

    await assert.rejects(
      () => abs.readDid(0xf40d),
      /timeout/i,
      "a module with no supply does not answer a read",
    );
    const codes = await gateway.readDtcByStatusMask(0xff);
    const lost = stored(codes, "U0121");
    assert.ok(lost, `the gateway must store U0121, read ${codes.map((d) => d.code)}`);
    assert.equal(lost.statusBits.testFailed, true, "and it is silent right now");

    vehicle.restorePower("abs");
    vehicle.advance(1_600);
    assert.ok(
      (await abs.readDid(0xf40d)) !== null,
      "restored supply means answers again, with nobody setting a flag",
    );
    const after = await gateway.readDtcByStatusMask(0xff);
    const healed = stored(after, "U0121");
    assert.ok(healed, "the code remains in memory after the bus is quiet no longer");
    assert.equal(healed.statusBits.testFailed, false);
  });

  test("a broken wheel-speed channel is a measurement first and a code second", async () => {
    const fresh = new HighFidelityVehicle({ modelTickMs: 0 });
    await fresh.start();
    const absTester = testerFor(fresh, "abs");
    try {
      fresh.drive({ demandSpeedKph: 60, gear: 4 });
      fresh.advance(1_500);
      const intact = await absTester.readDid(0xf40d);
      assert.ok(intact);
      fresh.breakSensor("abs.wheel_speed_front_left", "open-circuit");
      fresh.advance(1_500);
      const broken = await absTester.readDid(0xf40d);
      assert.ok(broken);
      assert.equal(
        ((broken[0] ?? 0) << 8) | (broken[1] ?? 0),
        0,
        "a cut channel reads zero while the car is at 60 km/h — the number is the finding",
      );
      const codes = await absTester.readDtcByStatusMask(0xff);
      assert.ok(
        stored(codes, "C0035"),
        `and the rationality test stores the circuit code, read ${codes.map((d) => d.code)}`,
      );
    } finally {
      await fresh.stop();
    }
  });

  test("a write to an adaptation DID is stored by the module and changes how it runs", async () => {
    // The engine has to be running for an idle target to mean anything, and the tests
    // above left it stopped: a model that keeps its state across a file is the point.
    vehicle.setBatteryVoltage(12.9);
    crankToRunning(vehicle);

    await engine.diagnosticSessionControl(0x03);
    await engine.writeDataByIdentifier(0x2100, new Uint8Array([0x03, 0x20])); // 800
    await engine.writeDataByIdentifier(0x2100, new Uint8Array([0x03, 0x60])); // 864

    vehicle.advance(600);
    const rpm = await readRpm(engine);
    assert.equal(
      vehicle.model.idleAdaptation,
      864,
      "the value landed in the module, not in a map the test reached into",
    );
    assert.ok(
      Math.abs(rpm - 864) < 40,
      `the engine then idles at the adaptation it learned: ${rpm} rpm vs 864`,
    );
  });

  test("a write outside the documented window is refused with a number, not accepted", async () => {
    await engine.diagnosticSessionControl(0x03);
    await assert.rejects(
      () => engine.writeDataByIdentifier(0x2100, new Uint8Array([0x01, 0x2c])),
      /requestOutOfRange/,
      "300 rpm is not an idle the car can run on",
    );
    await assert.rejects(
      () => engine.writeDataByIdentifier(0x2100, new Uint8Array([0x03])),
      /incorrectMessageLengthOrInvalidFormat/,
    );
  });

  test("a measurement DID is read-only, so a write cannot freeze the cause away", async () => {
    await bcm.diagnosticSessionControl(0x03);
    await assert.rejects(
      () => bcm.writeDataByIdentifier(0x2001, new Uint8Array([0x30, 0xd4])),
      /conditionsNotCorrect/,
      "the battery voltage is a reading, and a tester must not be able to invent one",
    );
    assert.ok(await readSupplyVolts(bcm), "the DID still answers with the live value");
  });

  test("coding a load changes the electrical state the next scan reads", async () => {
    await bcm.diagnosticSessionControl(0x03);
    const before = await readSupplyVolts(bcm);
    // Byte 0 bit 3 is the daytime-running-light coding bit of this package's vocabulary.
    await bcm.writeDataByIdentifier(0x0200, new Uint8Array([0x08, 0x00, 0x00, 0x00]));
    vehicle.advance(200);
    const withLights = await readSupplyVolts(bcm);
    assert.ok(
      vehicle.model.state.electricalLoadA >= 12,
      "the coding block is not decoration: the load it switches on is in the model",
    );
    assert.ok(
      withLights <= before + 0.05,
      `a bigger consumer cannot raise the rail: ${before} V → ${withLights} V`,
    );
    await bcm.writeDataByIdentifier(0x0200, new Uint8Array([0x00, 0x00, 0x00, 0x00]));
    vehicle.advance(200);
  });

  test("the coding and adaptation DIDs are registered through the server's own API", () => {
    // The point of `registerWritableDid`: the vehicle holds no cast into the server.
    const bcmEcu: VirtualEcu | undefined = vehicle.ecu("bcm");
    assert.ok(bcmEcu?.server.hasDid(0x0200), "the coding block is registered");
    assert.ok(vehicle.ecu("engine")?.server.hasDid(0x2100), "the adaptation channel too");
    assert.deepEqual(vehicle.ecu("engine")?.server.registeredDids.includes(0xf190), true);
  });
});
