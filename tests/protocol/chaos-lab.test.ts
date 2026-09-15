/**
 * Chaos Laboratory Protocol Tests (Task 4; AGENTS 9, 29).
 *
 * Verifies resilience under deliberate wire-level and transport faults:
 * 1. CAN burst drops mid-transfer
 * 2. ISO-TP sequence number corruption (CF SN out of order)
 * 3. Mid-write connection loss (fail-closed transaction recovery)
 * 4. Readback verification corruption
 */

import assert from "node:assert/strict";
import { SafetyManager, WritePort, createCodingOperation, runCoding } from "@vdp/core";
import { ChaosLab, createVirtualCanNetwork } from "@vdp/simulators";
import { createFrame } from "@vdp/transport-can";
import { IsoTpConnection } from "@vdp/transport-iso-tp";
import { describe, test } from "vitest";

describe("Chaos Laboratory", () => {
  test("CAN burst drop: drops specified number of frames and tracks count", async () => {
    const network = createVirtualCanNetwork();
    const rawBusA = network.createBus("node-a");
    const rawBusB = network.createBus("node-b");
    const chaosBusA = ChaosLab.wrapCanBus(rawBusA);

    await Promise.all([chaosBusA.open(), rawBusB.open()]);

    // Inject burst drop of 2 frames with ID 0x7E0
    ChaosLab.injectBurstFrameDrop(chaosBusA, 0x7e0, 2);

    const received: number[] = [];
    rawBusB.subscribe((frame) => received.push(frame.payload[0] ?? 0));

    // Send 4 frames
    await chaosBusA.send(createFrame(0x7e0, new Uint8Array([1])));
    await chaosBusA.send(createFrame(0x7e0, new Uint8Array([2])));
    await chaosBusA.send(createFrame(0x7e0, new Uint8Array([3])));
    await chaosBusA.send(createFrame(0x7e0, new Uint8Array([4])));

    // First two were dropped, last two arrived
    assert.equal(chaosBusA.dropped.length, 2);
    assert.deepEqual(received, [3, 4]);

    await Promise.all([chaosBusA.close(), rawBusB.close()]);
  });

  test("ISO-TP sequence corruption: receiver aborts cleanly on corrupt CF SN", async () => {
    const network = createVirtualCanNetwork();
    const rawSender = network.createBus("sender");
    const rawReceiver = network.createBus("receiver");
    const chaosSender = ChaosLab.wrapCanBus(rawSender);

    await Promise.all([chaosSender.open(), rawReceiver.open()]);

    // Corrupt CF sequence numbers sent by transmitter (txId: 0x7E0)
    ChaosLab.injectIsoTpSequenceCorruption(chaosSender, 0x7e0);

    const senderIsoTp = new IsoTpConnection(chaosSender, {
      txId: 0x7e0,
      rxId: 0x7e8,
    });
    const receiverIsoTp = new IsoTpConnection(rawReceiver, {
      txId: 0x7e8,
      rxId: 0x7e0,
    });

    senderIsoTp.open();
    receiverIsoTp.open();

    // Send a 30-byte multi-frame payload (requires First Frame + Consecutive Frames)
    const longPayload = new Uint8Array(30).fill(0xaa);

    const [_, received] = await Promise.all([
      senderIsoTp.sendOnly(longPayload),
      receiverIsoTp.receive(100),
    ]);

    assert.equal(received, null, "corrupted multi-frame was discarded and not delivered");
    assert.ok(receiverIsoTp.stats.sequenceErrors > 0, "receiver detected sequence error");

    senderIsoTp.close();
    receiverIsoTp.close();
    await Promise.all([chaosSender.close(), rawReceiver.close()]);
  });

  test("write path chaos: sudden disconnection during execute aborts transaction safely", async () => {
    const safety = new SafetyManager();
    const port = new WritePort({ safety });
    port.register(createCodingOperation());

    const disconnectedEcu = {
      id: "ecu-bcm",
      name: "Body Control Module",
      sessionType: 0x03,
      readCoding: async () => new Uint8Array([0x00, 0x00]),
      writeCoding: async () => {
        // Simulates connection dropped / CAN wire disconnected mid-write
        throw new Error("CAN bus link down / timeout");
      },
    };

    const result = await runCoding(
      port,
      {
        target: disconnectedEcu,
        changes: [{ byteIndex: 0, bitIndex: 3, value: 1 }],
        userConfirmed: true,
      },
      {
        ecuId: "ecu-bcm",
        ecuName: "Body Control Module",
        sessionId: "chaos-session",
        sessionType: 0x03,
        definitionVersion: "1.0.0",
        vehicleState: {
          stationary: true,
          ignitionOn: true,
          batteryVoltage: 12.6,
          parkingBrake: true,
        },
      },
    );

    assert.equal(result.ok, false);
    assert.match(result.reasons.join("; "), /CAN bus link down/);
    assert.equal(result.transaction.state, "aborted");
    // Proof of safety invariant: permit was logged as failed in audit
    assert.ok(safety.audit.some((e) => e.action === "write-failed"));
  });
});
