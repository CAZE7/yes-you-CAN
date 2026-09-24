import assert from "node:assert/strict";
import { AdapterUnsupportedError, fromHex, toHex } from "@vdp/shared";
import { createFrame } from "@vdp/transport-can";
import { test } from "vitest";
import { FakeSocketCanBinding, SocketCanAdapter, tryLoadSocketCanBinding } from "./index.js";

test("open() opens the interface and applies the bitrate", async () => {
  const binding = new FakeSocketCanBinding();
  const adapter = new SocketCanAdapter({ binding, iface: "vcan0", bitrate: 500_000 });
  await adapter.open();
  assert.equal(adapter.isOpen(), true);
  assert.deepEqual(binding.opened, ["vcan0"]);
  assert.equal(binding.bitrate, 500_000);
});

test("sent frames are handed to the kernel binding", async () => {
  const binding = new FakeSocketCanBinding();
  const adapter = new SocketCanAdapter({ binding, iface: "vcan0" });
  await adapter.open();
  await adapter.send(createFrame(0x7e0, fromHex("02 3E 80")));
  assert.equal(binding.sent.length, 1);
  assert.equal(binding.sent[0]?.id, 0x7e0);
  assert.equal(toHex(binding.sent[0]?.data ?? new Uint8Array()), "02 3E 80");
  assert.equal(adapter.counters.tx, 1);
});

test("received frames reach subscribers and honour filters", async () => {
  const binding = new FakeSocketCanBinding();
  const adapter = new SocketCanAdapter({ binding, iface: "vcan0" });
  await adapter.open();
  const received: number[] = [];
  adapter.subscribe((frame) => received.push(frame.id), [{ id: 0x7e8, mask: 0x7ff }]);
  binding.emit({ id: 0x7e8, extended: false, data: fromHex("02 50 03") });
  binding.emit({ id: 0x7e9, extended: false, data: fromHex("02 50 03") });
  assert.deepEqual(received, [0x7e8]);
  assert.equal(adapter.counters.rx, 2);
});

test("sending before open fails with a transport error", async () => {
  const binding = new FakeSocketCanBinding();
  const adapter = new SocketCanAdapter({ binding });
  await assert.rejects(adapter.send(createFrame(0x7e0, fromHex("02 3E 80"))), /not open/);
});

test("CAN-FD frames are rejected unless the interface advertises CAN-FD", async () => {
  const binding = new FakeSocketCanBinding();
  const classic = new SocketCanAdapter({ binding });
  await classic.open();
  await assert.rejects(
    classic.send(createFrame(0x7e0, new Uint8Array(12).fill(1), { fd: true })),
    /CAN-FD/,
  );

  const fd = new SocketCanAdapter({ binding, iface: "can1", canFd: true });
  await fd.open();
  await fd.send(createFrame(0x7e0, new Uint8Array(12).fill(1), { fd: true }));
  assert.equal(binding.sent.length, 1);
});

test("close() releases the channel", async () => {
  const binding = new FakeSocketCanBinding();
  const adapter = new SocketCanAdapter({ binding });
  await adapter.open();
  await adapter.close();
  assert.equal(adapter.isOpen(), false);
  assert.equal(binding.closed, true);
});

test("a missing native binding becomes a typed, actionable error", async () => {
  await assert.rejects(tryLoadSocketCanBinding("definitely-not-installed"), (error: unknown) => {
    assert.ok(error instanceof AdapterUnsupportedError);
    assert.match(error.message, /SocketCAN adapter unavailable/);
    return true;
  });
});

test("interface listing is delegated to the binding", async () => {
  const binding = new FakeSocketCanBinding();
  assert.deepEqual(await binding.listInterfaces?.(), ["can0", "vcan0"]);
});

/* ---------------------------------------------- native module shape loading
 *
 * The hint for a missing SocketCAN path is "npm i socketcan". That module
 * exposes `createChannel`, not this repository's `open()` contract — loading
 * must accept what installing actually delivers, otherwise the hint is the trap.
 */

test("a module with the SocketCanBinding.open() contract loads unchanged", async () => {
  const fake = new FakeSocketCanBinding();
  const binding = await tryLoadSocketCanBinding("anything", async () => fake);
  assert.equal(binding, fake);
});

test("an npm socketcan-shaped module is wrapped into the binding contract", async () => {
  // Fake of the npm `socketcan` package: createChannel returns a channel with
  // start/stop/send/addListener. (Duck-typed — the module is optional native.)
  const received: Array<Record<string, unknown>> = [];
  const messageListeners: Array<(message: unknown) => void> = [];
  let started = false;
  const npmModule = {
    createChannel(_iface: string) {
      return {
        start: () => {
          started = true;
        },
        stop: () => {
          started = false;
        },
        addListener(_event: string, listener: (message: unknown) => void) {
          messageListeners.push(listener);
        },
        removeListener(_event: string, listener: (message: unknown) => void) {
          const index = messageListeners.indexOf(listener);
          if (index >= 0) messageListeners.splice(index, 1);
        },
        send(frame: Record<string, unknown>) {
          received.push(frame);
        },
      };
    },
  };
  const binding = await tryLoadSocketCanBinding("npm-socketcan", async () => npmModule);
  assert.equal(binding.name, "npm-socketcan (npm)");

  const channel = await binding.open("can0");
  assert.equal(started, true, "start() is part of the open contract");

  await channel.send({ id: 0x7e0, extended: false, data: Uint8Array.from([2, 0x3e, 0]) });
  assert.deepEqual(received, [{ id: 0x7e0, ext: false, data: Uint8Array.from([2, 0x3e, 0]) }]);

  const seen: number[] = [];
  const off = channel.onData((frame) => seen.push(frame.id));
  for (const listener of [...messageListeners])
    listener({ id: 0x7e8, ext: false, data: Uint8Array.from([1]) });
  assert.deepEqual(seen, [0x7e8]);
  off();
  for (const listener of [...messageListeners])
    listener({ id: 0x7e9, ext: false, data: Uint8Array.from([1]) });
  assert.deepEqual(seen, [0x7e8], "an unsubscribe stops delivery");

  await channel.close();
  assert.equal(started, false, "stop() is part of the close contract");
});

test("the npm-channel wrapper drops RTR frames instead of attributing empty payloads", async () => {
  const messageListeners: Array<(message: Record<string, unknown>) => void> = [];
  const npmModule = {
    createChannel() {
      return {
        start() {},
        stop() {},
        addListener(_event: string, listener: (message: Record<string, unknown>) => void) {
          messageListeners.push(listener);
        },
        send() {},
      };
    },
  };
  const binding = await tryLoadSocketCanBinding("npm-socketcan", async () => npmModule);
  const channel = await binding.open("can0");
  const seen: number[] = [];
  channel.onData((frame) => seen.push(frame.id));
  messageListeners[0]?.({ id: 0x7e8, rtr: true, data: new Uint8Array() });
  messageListeners[0]?.({ id: 0x7e8, ext: false, data: Uint8Array.from([1]) });
  assert.deepEqual(seen, [0x7e8], "the RTR copy must not land in the rx stream");
  await channel.close();
});

test("a module with neither shape fails with both contracts named", async () => {
  await assert.rejects(
    tryLoadSocketCanBinding("something-else", async () => ({ version: "1.0.0" })),
    (error: unknown) => {
      assert.ok(error instanceof AdapterUnsupportedError);
      assert.match(error.message, /open\(\).*createChannel\(\)|createChannel\(\).*open\(\)/);
      assert.match(error.message, /SocketCAN adapter unavailable/);
      return true;
    },
  );
});
