/**
 * Host serial integration tests (testing standards: test pyramid).
 *
 * These drive *real* character devices — socat connects two pseudo terminals so
 * the production serial code path (open, read loop, framing, close) runs with
 * no adapter plugged in. Real OS resources: integration project, never
 * `test:unit`. `socat` is optional; without it the affected tests skip.
 */

import assert from "node:assert/strict";
import { CanableAdapter } from "@vdp/adapter-canable";
import { configureSerialPort, createHostAdapterCatalog, openSerialStream } from "@vdp/adapter-host";
import { TransportError } from "@vdp/shared";
import { createFrame } from "@vdp/transport-can";
import { test } from "vitest";
import { createDeviceSide, createPtyPair, hasSocat } from "../helpers/pty.js";
import { waitFor } from "../helpers/wait.js";

/* -------------------------------------------------------- serial device */

test.skipIf(!hasSocat())(
  "a serial stream reads and writes over a real character device",
  async () => {
    const pair = await createPtyPair();
    const device = createDeviceSide(pair.b);
    const stream = await openSerialStream({ device: pair.a });
    try {
      const chunks: string[] = [];
      stream.onData((chunk) => chunks.push(chunk));
      await stream.write("ATZ\r");
      await device.waitFor("ATZ");

      device.write("ELM327 v1.5\r");
      await waitFor(() => chunks.join("").includes("ELM327 v1.5"), undefined, { timeoutMs: 3000 });

      assert.equal(stream.isOpen(), true);
      assert.match(stream.describe(), /serial/);
      assert.ok(
        stream.bytesRead > 0 && stream.bytesWritten > 0,
        "byte counters must reflect the transfer",
      );
      const errors: Error[] = [];
      stream.onError((error) => errors.push(error));
      assert.deepEqual(errors, []);
    } finally {
      await stream.close();
      await device.close();
      pair.dispose();
    }
  },
);

test.skipIf(!hasSocat())(
  "line settings are applied with stty, and a bad device fails loudly",
  async () => {
    const pair = await createPtyPair();
    try {
      const command = await configureSerialPort(pair.a, { baudRate: 115_200 });
      assert.match(command, /^stty -F /);
      assert.match(command, /115200/);
    } finally {
      pair.dispose();
    }
    await assert.rejects(
      () => configureSerialPort("/dev/definitely-not-there", { baudRate: 115_200 }),
      /exited with code/,
    );
  },
);

test.skipIf(!hasSocat())(
  "the slcan adapter drives a real serial port and parses frames coming back",
  async () => {
    const pair = await createPtyPair();
    const device = createDeviceSide(pair.b, { slcan: true });
    const _catalog = createHostAdapterCatalog();
    const stream = await openSerialStream({ device: pair.a });
    const adapter = new CanableAdapter({ stream, bitrate: "500k", channel: "slcan-test" });
    try {
      const frames: Array<{ id: number; direction?: string; payload: string }> = [];
      await adapter.open();
      adapter.subscribe((frame) =>
        frames.push({
          id: frame.id,
          ...(frame.direction !== undefined ? { direction: frame.direction } : {}),
          payload: Buffer.from(frame.payload).toString("hex"),
        }),
      );

      // The adapter proves and configures the device before it opens the
      // channel: V handshake, then S6 = 500k, Z1 = timestamps, O = open.
      await device.waitFor("O");
      const init = device.received.join("");
      assert.ok(init.indexOf("V") < init.indexOf("S6"), "the version handshake goes first");
      assert.match(init, /S6/, "bitrate command");
      assert.match(init, /Z1/, "timestamp command");
      assert.match(init, /O/, "open channel command");
      assert.equal(adapter.version, "0101");

      // Frame from the ECU side → adapter listener.
      device.write("t7E83023E80\r");
      await waitFor(() => frames.length > 0, undefined, { timeoutMs: 3000 });
      assert.deepEqual(frames[0], { id: 0x7e8, direction: "rx", payload: "023e80" });

      // Frame from the tester side → wire.
      await adapter.send(createFrame(0x7e0, new Uint8Array([0x02, 0x3e, 0x80])));
      await device.waitFor("t7E03023E80");
      assert.equal(adapter.counters.tx, 1);
      assert.equal(adapter.counters.rx, 1);
    } finally {
      await adapter.close();
      await stream.close();
      await device.close();
      pair.dispose();
    }
  },
);

test.skipIf(!hasSocat())("the catalog creates the adapter it advertised", async () => {
  const pair = await createPtyPair();
  const device = createDeviceSide(pair.b, { respondWithPrompt: true });
  const catalog = createHostAdapterCatalog();
  const entry = catalog.require("elm327");
  const probe = await entry.probe({ device: pair.a }, {});
  assert.equal(probe.available, true, probe.detail);
  const bus = await entry.create({ device: pair.a, baudRate: 38_400 }, {});
  void device;
  try {
    assert.equal(bus.info.id, "elm327");
    await bus.open();
    assert.equal(bus.isOpen(), true);
    await device.waitFor("ATZ");
  } finally {
    await bus.close();
    await device.close();
    pair.dispose();
  }
});

test.skipIf(!hasSocat())(
  "slcan open() fails with the handshake reason when the wire stays silent (real serial port)",
  async () => {
    // Symptom before the handshake: open() reported success on a silent cable —
    // the UI said `connected`, no frame ever arrived, and the failure read as a
    // silent vehicle. Now the missing V-answer fails open() with the cause.
    const pair = await createPtyPair();
    const device = createDeviceSide(pair.b); // mode "silent": no answers at all
    const stream = await openSerialStream({ device: pair.a });
    const adapter = new CanableAdapter({
      stream,
      bitrate: "500k",
      channel: "slcan-test",
      commandTimeoutMs: 250,
    });
    await assert.rejects(
      adapter.open(),
      (error: unknown) =>
        error instanceof TransportError &&
        error.message.includes("version query") &&
        error.message.includes("250 ms"),
      "expected the handshake timeout to name itself",
    );
    assert.equal(adapter.isOpen(), false, "a failed open() must not pretend to be open");
    await device.close().catch(() => undefined);
    pair.dispose();
  },
);

test.skipIf(!hasSocat())(
  "the catalog closes a created slcan adapter cleanly even after a failed open()",
  async () => {
    const pair = await createPtyPair();
    const device = createDeviceSide(pair.b);
    const catalog = createHostAdapterCatalog();
    const bus = await catalog.require("slcan").create(
      {
        device: pair.a,
        bitrate: "500k",
      },
      {},
    );
    await assert.rejects(bus.open(), /version query/, {
      // default commandTimeoutMs is 2 s — plenty for the silent device to be found out
    } as never);
    await bus.close();
    await device.close().catch(() => undefined);
    pair.dispose();
  },
);
