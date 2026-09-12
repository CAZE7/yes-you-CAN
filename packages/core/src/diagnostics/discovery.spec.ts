/**
 * ECU discovery (AGENTS 12) — the bus-facing scan that has to survive a broken
 * adapter. Discovery runs before anybody can report an error to the user, so every
 * probe path logs instead of throwing, and an echo of our own request must never be
 * mistaken for an ECU.
 */

import assert from "node:assert/strict";
import { fromHex } from "@vdp/shared";
import type {
  AdapterCapabilities,
  AdapterInfo,
  CanBus,
  CanFilter,
  CanFrame,
  FrameListener,
} from "@vdp/transport-can";
import { test } from "vitest";
import { DEFAULT_PROBE_DELAY_MS, EcuDiscovery, deriveTxId } from "./discovery.js";

const INFO: AdapterInfo = { id: "stub", kind: "virtual", name: "Stub CAN", channels: ["vcan0"] };

class StubBus implements CanBus {
  readonly info = INFO;
  capabilities: AdapterCapabilities = {
    can: true,
    canFd: false,
    doip: false,
    isoTpOffload: false,
    channels: 1,
  };
  readonly sent: CanFrame[] = [];
  private listeners: FrameListener[] = [];

  constructor(private readonly options: { failSend?: boolean } = {}) {}

  async open(): Promise<void> {}
  async close(): Promise<void> {}
  isOpen(): boolean {
    return true;
  }
  async send(frame: CanFrame): Promise<void> {
    this.sent.push(frame);
    if (this.options.failSend) throw new Error("ENOBUFS: write buffer full");
  }
  subscribe(listener: FrameListener, _filters?: readonly CanFilter[]): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }
  emit(id: number, payload: Uint8Array, direction: "rx" | "tx" = "rx"): void {
    const frame: CanFrame = {
      timestamp: 0,
      id,
      extended: false,
      fd: false,
      dlc: payload.length,
      payload,
      channel: "vcan0",
      direction,
    };
    for (const listener of [...this.listeners]) listener(frame);
  }
}

test("a functional probe the adapter cannot write is reported, not fatal", async () => {
  // A half-dead serial link must not turn a scan into an exception: the listener is
  // already armed, so answers that do arrive are still worth collecting.
  const bus = new StubBus({ failSend: true });
  const discovery = new EcuDiscovery(bus, {
    windowMs: 1,
    sleep: async () => undefined,
    candidates: [{ txId: 0x7e0, rxId: 0x7e8 }],
  });
  const found = await discovery.discover();
  assert.deepEqual(found, [], "the scan completes with no responders instead of throwing");
  assert.ok(bus.sent.length >= 2, "both the broadcast and the candidate probe were attempted");
});

test("responders come from what the bus reports, and our own echo is not a responder", async () => {
  const bus = new StubBus();
  // Frames are emitted from the injected sleep: that is the moment discovery listens,
  // and it keeps the test free of real time (AGENTS 31).
  const discovery = new EcuDiscovery(bus, {
    windowMs: 1,
    sleep: async () => {
      bus.emit(0x7e8, fromHex("01 7E 00 00 00 00 00 00"));
      bus.emit(0x7e0, fromHex("01 3E 80 00 00 00 00 00"), "tx");
    },
  });
  const found = await discovery.discover();
  assert.equal(found.length, 1, "exactly the answering identifier is reported");
  const ecu = found[0];
  assert.ok(ecu);
  assert.equal(ecu.rxId, 0x7e8);
  assert.equal(ecu.txId, 0x7e0, "the physical request id is derived, not guessed");
  assert.equal(ecu.extended, false);
});

test("the 11-bit and 29-bit conventions map both ways", () => {
  assert.equal(deriveTxId(0x7e8, false), 0x7e0);
  assert.equal(deriveTxId(0x7ef, false), 0x7e7);
  assert.equal(deriveTxId(0x18da00f1, true), 0x18daf100);
  assert.ok(
    deriveTxId(0x700, false) >= 0 || Number.isSafeInteger(deriveTxId(0x700, false)),
    "an unexpected response id still yields a number",
  );
});

/** Collects every requested pause so a test can assert the timing without real time. */
function recordingSleep(): { sleep: (ms: number) => Promise<void>; waited: number[] } {
  const waited: number[] = [];
  return { sleep: async (ms) => void waited.push(ms), waited };
}

const THREE_CANDIDATES = [
  { txId: 0x7e0, rxId: 0x7e8 },
  { txId: 0x7e1, rxId: 0x7e9 },
  { txId: 0x7e2, rxId: 0x7ea },
];

test("the scan waits exactly windowMs plus one probe delay per candidate", async () => {
  // Symptom before the fix: `windowMs` looked like the whole budget, but the
  // inter-probe pause was hard-coded to 15 ms, so a caller asking for a 30 ms
  // window on an 11-candidate package actually waited ~200 ms (measured
  // 2026-09-12) and no option could shorten it.
  const bus = new StubBus();
  const { sleep, waited } = recordingSleep();
  const discovery = new EcuDiscovery(bus, {
    windowMs: 30,
    probeDelayMs: 0,
    candidates: THREE_CANDIDATES,
    sleep,
  });
  await discovery.discover();
  const total = waited.reduce((sum, ms) => sum + ms, 0);
  assert.equal(total, 30, "with probeDelayMs 0 only the two listen phases remain");
  assert.deepEqual(waited, [15, 0, 0, 0, 15], "half the window before and after the probe loop");
});

test("the probe delay defaults to 15 ms per candidate and is configurable", async () => {
  const bus = new StubBus();
  const defaults = recordingSleep();
  await new EcuDiscovery(bus, {
    windowMs: 10,
    candidates: THREE_CANDIDATES,
    sleep: defaults.sleep,
  }).discover();
  assert.equal(DEFAULT_PROBE_DELAY_MS, 15);
  assert.deepEqual(defaults.waited, [5, 15, 15, 15, 5]);

  const tuned = recordingSleep();
  await new EcuDiscovery(bus, {
    windowMs: 10,
    probeDelayMs: 2,
    candidates: THREE_CANDIDATES,
    sleep: tuned.sleep,
  }).discover();
  assert.deepEqual(tuned.waited, [5, 2, 2, 2, 5], "the injected delay replaces the default");
});
