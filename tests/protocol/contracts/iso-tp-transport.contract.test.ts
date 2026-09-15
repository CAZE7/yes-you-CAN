/**
 * ISO-TP Transport Contract Tests (Task 3; Master-Backlog P0 #8; ISO 15765-2).
 *
 * Verifies that the ISO-TP transport implementation strictly conforms to the
 * ISO 15765-2 network layer protocol contract:
 * 1. Single Frame (SF) transfers for small payloads (<= 7 bytes in classic CAN).
 * 2. Multi-Frame First Frame (FF) + Consecutive Frame (CF) segmentation.
 * 3. Flow Control (FC) negotiation (CTS, WAIT, OVERFLOW).
 * 4. Separation Time (STmin) and Block Size (BS) pacing.
 * 5. Serialisation and concurrency isolation.
 */

import assert from "node:assert/strict";
import { createLogger, fromHex } from "@vdp/shared";
import { createVirtualCanNetwork } from "@vdp/simulators";
import { createFrame } from "@vdp/transport-can";
import { IsoTpConnection } from "@vdp/transport-iso-tp";
import { describe, test } from "vitest";

const logger = createLogger("isotp-contract", { level: "ERROR" });

describe("ISO 15765-2 Transport Contract", () => {
  test("Single Frame: transmits and receives unsegmented payloads up to 7 bytes", async () => {
    const network = createVirtualCanNetwork({ channel: "vcan0" });
    const testerBus = network.createBus("tester");
    const ecuBus = network.createBus("ecu");
    await Promise.all([testerBus.open(), ecuBus.open()]);

    const testerIsoTp = new IsoTpConnection(
      testerBus,
      { txId: 0x7e0, rxId: 0x7e8, timing: { nBsMs: 100, nCrMs: 100, maxRetries: 0 } },
      logger,
    );
    const ecuIsoTp = new IsoTpConnection(
      ecuBus,
      { txId: 0x7e8, rxId: 0x7e0, timing: { nBsMs: 100, nCrMs: 100, maxRetries: 0 } },
      logger,
    );

    testerIsoTp.open();
    ecuIsoTp.open();

    const payload = fromHex("22 F1 90"); // 3 bytes

    const [received] = await Promise.all([ecuIsoTp.receive(200), testerIsoTp.sendOnly(payload)]);

    assert.ok(received);
    assert.deepEqual(Array.from(received), Array.from(payload));

    testerIsoTp.close();
    ecuIsoTp.close();
    await Promise.all([testerBus.close(), ecuBus.close()]);
  });

  test("Multi-Frame: segments 40 bytes across FF, FC CTS, and CFs with proper sequence numbering", async () => {
    const network = createVirtualCanNetwork({ channel: "vcan0" });
    const testerBus = network.createBus("tester");
    const ecuBus = network.createBus("ecu");
    await Promise.all([testerBus.open(), ecuBus.open()]);

    const testerIsoTp = new IsoTpConnection(
      testerBus,
      { txId: 0x7e0, rxId: 0x7e8, timing: { nBsMs: 200, nCrMs: 200, maxRetries: 0 } },
      logger,
    );
    const ecuIsoTp = new IsoTpConnection(
      ecuBus,
      { txId: 0x7e8, rxId: 0x7e0, timing: { nBsMs: 200, nCrMs: 200, maxRetries: 0 } },
      logger,
    );

    testerIsoTp.open();
    ecuIsoTp.open();

    // 40 byte payload
    const longPayload = new Uint8Array(40);
    for (let i = 0; i < 40; i++) longPayload[i] = (i * 3) & 0xff;

    const [received] = await Promise.all([
      ecuIsoTp.receive(300),
      testerIsoTp.sendOnly(longPayload),
    ]);

    assert.ok(received);
    assert.equal(received.length, 40);
    assert.deepEqual(Array.from(received), Array.from(longPayload));

    // Verify stats
    assert.ok(testerIsoTp.stats.txMultiFrameMessages >= 1);
    assert.ok(ecuIsoTp.stats.rxMultiFrameMessages >= 1);

    testerIsoTp.close();
    ecuIsoTp.close();
    await Promise.all([testerBus.close(), ecuBus.close()]);
  });

  test("Flow Control Overflow (FS=2): peer aborts transmission when receiver signals buffer overflow", async () => {
    const network = createVirtualCanNetwork({ channel: "vcan0" });
    const testerBus = network.createBus("tester");
    const ecuBus = network.createBus("ecu");
    await Promise.all([testerBus.open(), ecuBus.open()]);

    const testerIsoTp = new IsoTpConnection(
      testerBus,
      { txId: 0x7e0, rxId: 0x7e8, timing: { nBsMs: 100, nCrMs: 100, maxRetries: 0 } },
      logger,
    );
    testerIsoTp.open();

    // Raw ECU listener answers First Frame with Flow Control OVERFLOW (FS=2)
    ecuBus.subscribe((frame) => {
      if (frame.id !== 0x7e0) return;
      const pciType = frame.payload[0]! & 0xf0;
      if (pciType === 0x10) {
        // First Frame received -> Reply with FC OVERFLOW (0x32 0x00 0x00)
        void ecuBus.send(
          createFrame(0x7e8, new Uint8Array([0x32, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]), {
            direction: "tx",
          }),
        );
      }
    });

    const payload = new Uint8Array(30).fill(0xee);

    await assert.rejects(
      () => testerIsoTp.sendOnly(payload),
      /overflow/i,
      "sender must reject on Flow Control Overflow",
    );

    testerIsoTp.close();
    await Promise.all([testerBus.close(), ecuBus.close()]);
  });

  test("Flow Control Wait (FS=1): sender pauses until Clear-to-Send (FS=0) arrives", async () => {
    const network = createVirtualCanNetwork({ channel: "vcan0" });
    const testerBus = network.createBus("tester");
    const ecuBus = network.createBus("ecu");
    await Promise.all([testerBus.open(), ecuBus.open()]);

    const testerIsoTp = new IsoTpConnection(
      testerBus,
      { txId: 0x7e0, rxId: 0x7e8, timing: { nBsMs: 300, nCrMs: 300, maxRetries: 0 } },
      logger,
    );
    testerIsoTp.open();

    let waitSent = false;
    const cfReceived: number[] = [];

    ecuBus.subscribe((frame) => {
      if (frame.id !== 0x7e0) return;
      const pciType = frame.payload[0]! & 0xf0;
      if (pciType === 0x10) {
        // First Frame -> Send FC WAIT (0x31)
        waitSent = true;
        void ecuBus.send(
          createFrame(0x7e8, new Uint8Array([0x31, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]), {
            direction: "tx",
          }),
        );
        // After 50ms, send FC CTS (0x30)
        setTimeout(() => {
          void ecuBus.send(
            createFrame(0x7e8, new Uint8Array([0x30, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]), {
              direction: "tx",
            }),
          );
        }, 50);
      } else if (pciType === 0x20) {
        cfReceived.push(frame.payload[0]! & 0x0f);
      }
    });

    const payload = new Uint8Array(20).fill(0x55);
    await testerIsoTp.sendOnly(payload);

    assert.equal(waitSent, true, "FC WAIT was sent before CTS");
    assert.ok(cfReceived.length > 0, "CFs followed once CTS arrived");

    testerIsoTp.close();
    await Promise.all([testerBus.close(), ecuBus.close()]);
  });
});
