/**
 * CAN bus contract (AGENTS 4/5, Master-Backlog P0 #8).
 *
 * Every implementation of the `CanBus` port must behave the same way, because
 * everything above it — ISO-TP, UDS, discovery, the engine — is written against
 * the *port*, not against one adapter. Until now that contract lived implicitly
 * in six spec files that each checked a different subset; the differences only
 * showed up when somebody swapped an adapter.
 *
 * This suite states the contract once and runs it against every implementation:
 * the virtual bus (simulator), the replay transport, generic CAN, ELM327,
 * CANable/slcan and SocketCAN. A new adapter plugs in by adding one entry to
 * `subjects` — and fails if it does not honour the port.
 *
 * What is *not* part of the contract (deliberately): timing, protocol logic
 * above the frame layer, and the device-specific command language. An ELM327
 * sends AT commands, a slcan adapter sends ASCII lines — both are invisible from
 * the port and are covered by their own unit specs.
 */

import assert from "node:assert/strict";
import { CanableAdapter } from "@vdp/adapter-canable";
// One in-memory byte stream for both serial adapters: the CANable spec uses the
// same double, so the contract and the unit specs exercise the same fake.
import { Elm327Adapter, MemoryByteStream } from "@vdp/adapter-elm327";
import { GenericCanAdapter } from "@vdp/adapter-generic-can";
import { FakeSocketCanBinding, SocketCanAdapter } from "@vdp/adapter-socketcan";
import { AdapterUnsupportedError, TransportError, fromHex, toHex } from "@vdp/shared";
import { createLogger } from "@vdp/shared";
import { CanChaosBus, createVirtualCanNetwork } from "@vdp/simulators";
import type { CanBus, CanFrame } from "@vdp/transport-can";
import { ReplayTransport, createFrame } from "@vdp/transport-can";
import { test } from "vitest";

const logger = createLogger("contract", { level: "ERROR" });

/** The identifier every fixture answers with, and a second one it also emits. */
const RESPONSE_ID = 0x7e8;
const OTHER_ID = 0x7e9;

interface CanBusFixture {
  bus: CanBus;
  /**
   * Make the wire deliver frames to this bus, as a real ECU would: one frame
   * with {@link RESPONSE_ID}, then one with {@link OTHER_ID}.
   */
  deliver(): Promise<void>;
  /**
   * The same delivery a second time. A transport that consumes its source (the
   * replay transport, for instance) supplies a second recorded exchange instead
   * of pretending that repetition is free.
   */
  deliverAgain(): Promise<void>;
  /** True when the implementation can carry CAN-FD frames (must match capabilities). */
  canFd: boolean;
  cleanup(): Promise<void>;
}

interface CanBusSubject {
  name: string;
  create(): CanBusFixture | Promise<CanBusFixture>;
}

/** Counts what actually left the port, without changing behaviour. */
function withSendLog(bus: CanBus): { bus: CanBus; sent: CanFrame[] } {
  const sent: CanFrame[] = [];
  return {
    sent,
    bus: {
      info: bus.info,
      capabilities: bus.capabilities,
      open: () => bus.open(),
      close: () => bus.close(),
      isOpen: () => bus.isOpen(),
      subscribe: (listener, filters) => bus.subscribe(listener, filters),
      send: async (frame) => {
        sent.push(frame);
        await bus.send(frame);
      },
    },
  };
}

function virtualFixture(canFd = false): CanBusFixture {
  const network = createVirtualCanNetwork({ channel: "vcan0" });
  const bus = network.createBus("tester", { canFd });
  const peer = network.createBus("ecu", { canFd });
  const respond = async (): Promise<void> => {
    await peer.open();
    for (const [id, payload] of payloads()) await peer.send(createFrame(id, payload));
  };
  return {
    bus,
    canFd,
    deliver: respond,
    deliverAgain: respond,
    async cleanup() {
      await peer.close();
      await bus.close();
    },
  };
}

/** The payloads of the two response frames, in delivery order. */
function payloads(): Array<[number, Uint8Array]> {
  return [
    [RESPONSE_ID, fromHex("02 50 03")],
    [OTHER_ID, fromHex("02 7F 22 31")],
  ];
}

const subjects: CanBusSubject[] = [
  {
    name: "virtual bus (simulator)",
    create: () => virtualFixture(),
  },
  {
    // A chaos run is still a `CanBus`, so the port applies to the proxy and not only to
    // what it wraps. The proxy keeps its own subscriber list, which is exactly where a
    // filter can go missing: it stored the filters and delivered to every listener, so
    // a chaos subscriber saw frames it had excluded. Nothing checked that, because the
    // contract did not run against it — the entry, not the fix, is the finding.
    name: "chaos proxy (simulator)",
    create: () => {
      const inner = virtualFixture();
      return { ...inner, bus: new CanChaosBus(inner.bus) };
    },
  },
  {
    name: "generic CAN adapter",
    create: () => {
      const inner = virtualFixture();
      return {
        ...inner,
        bus: new GenericCanAdapter({
          id: "generic-test",
          displayName: "Generic CAN",
          bus: inner.bus,
          logger,
        }),
      };
    },
  },
  {
    name: "replay transport",
    create: () => {
      const bus = new ReplayTransport(
        {
          channel: "replay0",
          frames: [
            { t: 0, canId: 0x7e0, direction: "tx", payload: fromHex("02 3E 80") },
            { t: 1, canId: RESPONSE_ID, direction: "rx", payload: fromHex("02 50 03") },
            { t: 2, canId: OTHER_ID, direction: "rx", payload: fromHex("02 7F 22 31") },
            // A second recorded exchange: replay answers each request exactly once.
            { t: 3, canId: 0x7e0, direction: "tx", payload: fromHex("02 3E 80") },
            { t: 4, canId: RESPONSE_ID, direction: "rx", payload: fromHex("02 50 03") },
            { t: 5, canId: OTHER_ID, direction: "rx", payload: fromHex("02 7F 22 31") },
          ],
        },
        { immediate: true, logger },
      );
      return {
        bus,
        canFd: true,
        // The recording *is* the wire: sending the recorded request produces the
        // two recorded responses.
        async deliver() {
          await bus.send(createFrame(0x7e0, fromHex("02 3E 80")));
        },
        async deliverAgain() {
          await bus.send(createFrame(0x7e0, fromHex("02 3E 80")));
        },
        async cleanup() {
          await bus.close();
        },
      };
    },
  },
  {
    name: "ELM327 adapter",
    create: () => {
      const stream = new MemoryByteStream();
      stream.open();
      // A device that answers its AT commands: without it every command would sit
      // in its 3 s timeout instead of testing the port.
      stream.responder = (command) =>
        command.startsWith("AT")
          ? command === "ATZ\r"
            ? "ELM327 v2.1\r\n>"
            : "OK\r\n>"
          : "OK\r\n>";
      const bus = new Elm327Adapter({ stream, channel: "elm0", logger, commandTimeoutMs: 50 });
      const respond = async (): Promise<void> => {
        for (const [id, payload] of payloads()) {
          const line = `${id.toString(16).toUpperCase()} ${payload.length.toString(16).padStart(2, "0")} ${toHex(payload)}`;
          stream.emit(`${line}\r\n`);
        }
      };
      return {
        bus,
        canFd: false,
        deliver: respond,
        deliverAgain: respond,
        async cleanup() {
          await bus.close();
          await stream.close();
        },
      };
    },
  },
  {
    name: "CANable / slcan adapter",
    create: () => {
      const stream = new MemoryByteStream();
      stream.open();
      const bus = new CanableAdapter({ stream, channel: "slcan0", logger });
      const respond = async (): Promise<void> => {
        for (const [id, payload] of payloads()) {
          const hex = toHex(payload).replace(/ /g, "");
          stream.emit(
            `t${id.toString(16).toUpperCase().padStart(3, "0")}${payload.length}${hex}\r`,
          );
        }
      };
      return {
        bus,
        canFd: false,
        deliver: respond,
        deliverAgain: respond,
        async cleanup() {
          await bus.close();
          await stream.close();
        },
      };
    },
  },
  {
    name: "SocketCAN adapter",
    create: () => {
      const binding = new FakeSocketCanBinding();
      const bus = new SocketCanAdapter({ binding, iface: "vcan0", logger });
      const respond = async (): Promise<void> => {
        for (const [id, payload] of payloads()) {
          binding.emit({ id, extended: false, data: payload });
        }
      };
      return {
        bus,
        canFd: false,
        deliver: respond,
        deliverAgain: respond,
        async cleanup() {
          await bus.close();
        },
      };
    },
  },
];

for (const subject of subjects) {
  test(`${subject.name}: open/close lifecycle is idempotent`, async () => {
    const fixture = await subject.create();
    const { bus } = withSendLog(fixture.bus);
    try {
      assert.equal(bus.isOpen(), false, "a fresh bus is closed");
      await bus.open();
      assert.equal(bus.isOpen(), true);
      await bus.open();
      assert.equal(bus.isOpen(), true, "opening twice is not an error");
      await bus.close();
      assert.equal(bus.isOpen(), false);
      await bus.close();
      assert.equal(bus.isOpen(), false, "closing twice is not an error");
      await bus.open();
      assert.equal(bus.isOpen(), true, "a closed bus can be opened again");
    } finally {
      await fixture.cleanup();
    }
  });

  test(`${subject.name}: sending while closed is a typed transport error`, async () => {
    const fixture = await subject.create();
    const { bus } = withSendLog(fixture.bus);
    try {
      await assert.rejects(
        () => bus.send(createFrame(0x7e0, fromHex("02 3E 80"))),
        TransportError,
        "a frame sent into a closed bus must not be silently dropped",
      );
      await bus.open();
      await bus.close();
      await assert.rejects(() => bus.send(createFrame(0x7e0, fromHex("02 3E 80"))), TransportError);
    } finally {
      await fixture.cleanup();
    }
  });

  test(`${subject.name}: a sent frame carries the payload it was given`, async () => {
    const fixture = await subject.create();
    const { bus, sent } = withSendLog(fixture.bus);
    try {
      await bus.open();
      const payload = fromHex("02 3E 80");
      await bus.send(createFrame(0x7e0, payload));
      assert.equal(sent.length, 1, "exactly one frame left the port");
      assert.equal(sent[0]?.id, 0x7e0);
      assert.deepEqual(Array.from(sent[0]?.payload ?? []), Array.from(payload));
      assert.equal(sent[0]?.dlc, payload.length, "dlc follows the payload");
    } finally {
      await fixture.cleanup();
    }
  });

  test(`${subject.name}: received frames reach subscribers, filters included`, async () => {
    const fixture = await subject.create();
    const { bus } = withSendLog(fixture.bus);
    const all: CanFrame[] = [];
    const filtered: CanFrame[] = [];
    try {
      await bus.open();
      const offAll = bus.subscribe((frame) => all.push(frame));
      const offFiltered = bus.subscribe(
        (frame) => filtered.push(frame),
        [{ id: RESPONSE_ID, mask: 0x7ff }],
      );

      await fixture.deliver();
      assert.deepEqual(
        all.map((frame) => frame.id),
        [RESPONSE_ID, OTHER_ID],
        "every delivered frame arrives, in order",
      );
      assert.deepEqual(
        filtered.map((frame) => frame.id),
        [RESPONSE_ID],
        "the filter keeps the matching frame and only that one",
      );

      offFiltered();
      await fixture.deliverAgain();
      assert.equal(filtered.length, 1, "an unsubscribed listener hears nothing");
      assert.equal(all.length, 4, "the other listener is unaffected");

      offAll();
      offAll();
      assert.doesNotThrow(() => offAll(), "unsubscribing twice must not throw");
    } finally {
      await fixture.cleanup();
    }
  });

  test(`${subject.name}: metadata and CAN-FD behaviour agree with the port`, async () => {
    const fixture = await subject.create();
    const { bus } = withSendLog(fixture.bus);
    try {
      assert.ok(bus.info.id.length > 0, "an adapter names itself");
      assert.ok(bus.info.channels.length > 0, "an adapter names its channel");
      assert.equal(bus.capabilities.can, true, "a CAN bus speaks CAN");
      assert.ok(bus.capabilities.channels >= 1);
      assert.equal(
        bus.capabilities.canFd,
        fixture.canFd,
        "capabilities must state the truth about CAN-FD",
      );

      await bus.open();
      const fd = createFrame(0x7e0, new Uint8Array(12).fill(0x11), { fd: true });
      if (fixture.canFd) {
        await bus.send(fd);
      } else {
        await assert.rejects(
          () => bus.send(fd),
          (error: unknown) =>
            error instanceof TransportError || error instanceof AdapterUnsupportedError,
          "a CAN-FD frame on a classic adapter is refused, not truncated",
        );
      }
    } finally {
      await fixture.cleanup();
    }
  });
}
