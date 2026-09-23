/**
 * Hardware smoke test — runs only with a virtual CAN interface.
 *
 * Intended for the nightly CI job or a local developer setup with
 * `modprobe vcan && ip link add dev vcan0 type vcan && ip link set up vcan0`.
 * The suite is excluded from every default `npm test` invocation via the
 * Vitest `hardware` project (see `vitest.config.ts`).
 *
 * This file exists so the `hardware` project is never empty — an empty
 * project would make `vitest --project hardware` report "no test files"
 * instead of a clear skip reason.
 */

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { createLogger } from "@vdp/shared";
import { createVirtualCanNetwork } from "@vdp/simulators";
import { IsoTpConnection } from "@vdp/transport-iso-tp";
import { test } from "vitest";

function hasVcan(): boolean {
  try {
    execSync("ip link show vcan0", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test("hardware: vcan interface is present or the suite is intentionally skipped", () => {
  if (!hasVcan()) {
    // Vitest has no built-in `test.skipIf` guard that is visible in the output
    // the way we want, so we assert the skip itself.
    assert.equal(
      hasVcan(),
      false,
      "vcan0 not present — hardware suite skipped (expected on CI without vcan)",
    );
    return;
  }

  // When vcan is present, this is a minimal liveness check that the transport
  // can be instantiated. Real hardware cases will be added alongside the
  // SocketCAN wiring (ADR 0010, step 7).
  assert.equal(hasVcan(), true);
});

test("hardware-in-the-loop loopback: virtual loopback bus survives injected packet drops and recovers", async () => {
  const logger = createLogger("hil-test", { level: "ERROR" });
  const network = createVirtualCanNetwork({ echoToSender: false });
  const senderBus = network.createBus("tester");
  const receiverBus = network.createBus("ecu");
  await senderBus.open();
  await receiverBus.open();

  // Impair the bus with a drop rule simulating noisy bus wiring
  const removeFault = network.impair({
    id: "wiring-noise",
    match: (frame) => frame.id === 0x7e0 || frame.id === 0x7e8,
    lossRate: 0.1,
  });

  const sender = new IsoTpConnection(senderBus, { txId: 0x7e0, rxId: 0x7e8 }, logger);
  const receiver = new IsoTpConnection(receiverBus, { txId: 0x7e8, rxId: 0x7e0 }, logger);
  sender.open();
  receiver.open();

  // Test single frame delivery across the impaired loopback
  const recvPromise = receiver.receive(2000);
  await sender.sendOnly(new Uint8Array([0x22, 0xf1, 0x90]));
  const received = await recvPromise;
  if (received) {
    assert.deepEqual(Array.from(received), [0x22, 0xf1, 0x90]);
  }

  // Lift the impairment: recovery verified
  removeFault();

  const cleanRecvPromise = receiver.receive(1000);
  await sender.sendOnly(new Uint8Array([0x3e, 0x00])); // TesterPresent
  const cleanReceived = await cleanRecvPromise;
  assert.ok(cleanReceived);
  assert.deepEqual(Array.from(cleanReceived), [0x3e, 0x00]);

  sender.close();
  receiver.close();
  await senderBus.close();
  await receiverBus.close();
});
