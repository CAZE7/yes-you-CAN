/**
 * The vectors, on another bus (ADR 0045, master prompt §20).
 *
 * The conformance harness defines a pair interface over the `CanBus` contract
 * only — no ISO-TP or UDS code knows which wire sits below it. This suite runs
 * the checked-in ISO-TP vectors over the simulator’s *virtual CAN network*
 * instead of the harness’s own scripted bus, and every vector must hold with
 * the identical expectation. That is the machine-checked form of “Virtual CAN ↕
 * real adapter, without changes to UDS or the diagnostic IR”: what would be
 * different on a real adapter is the frame *source*, never the protocol.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ConformancePair,
  parseIsoTpVectorFile,
  runIsoTpVector,
} from "@vdp/formal-conformance";
import { createVirtualCanNetwork } from "@vdp/simulators";
import {
  type CanBus,
  type CanFilter,
  type CanFrame,
  createFrame,
  type FrameListener,
} from "@vdp/transport-can";
import { test } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const isoPath = join(repoRoot, "tools/formal-conformance/vectors/isotp.json");

const yield0 = (): Promise<void> => new Promise((done) => setImmediate(done));
const time = { sleep: async (): Promise<void> => yield0() };

/**
 * Two nodes on the virtual CAN wire: the connection lives on the tester node,
 * peer frames are sent by the peer node like on a real bus — through the wire,
 * with filters, direction labels and all.
 */
class VirtualCanPair implements ConformancePair {
  private readonly net = createVirtualCanNetwork();
  private readonly tester = this.net.createBus("conformance-tester");
  private readonly peer = this.net.createBus("conformance-peer");
  private readonly sent: number[][] = [];
  private observer: ((index: number) => void) | undefined;
  readonly testerBus: CanBus;

  /** Both nodes must be open before the wire carries anything (real-bus rule). */
  async start(): Promise<void> {
    await this.tester.open();
    await this.peer.open();
  }

  constructor() {
    const inner = this.tester;
    this.testerBus = {
      info: inner.info,
      capabilities: inner.capabilities,
      open: () => inner.open(),
      close: () => inner.close(),
      getStatus: () => inner.getStatus(),
      isOpen: () => inner.isOpen(),
      send: async (frame: CanFrame): Promise<void> => {
        await inner.send(frame);
        this.sent.push(Array.from(frame.payload));
        this.observer?.(this.sent.length - 1);
      },
      subscribe: (listener: FrameListener, filters?: readonly CanFilter[]) =>
        inner.subscribe(listener, filters),
    };
  }

  feed(bytes: readonly number[], timestampMs: number): void {
    void this.peer.send(
      createFrame(0x7e8, Uint8Array.from(bytes), {
        channel: "vcan0",
        timestamp: timestampMs,
        direction: "tx",
      }),
    );
  }

  captured(): number[][] {
    return this.sent;
  }

  setSendObserver(observer: (index: number) => void): void {
    this.observer = observer;
  }
}

const parsed = parseIsoTpVectorFile(readFileSync(isoPath, "utf8"));
test("the vector file parses for the bus conformance run too", () => {
  assert.ok(parsed.ok, JSON.stringify("errors" in parsed ? parsed.errors : []));
});
if (!parsed.ok) throw new Error("vector file does not parse");

for (const vector of parsed.vectors) {
  test(`vector ${vector.name}: the same result over the virtual CAN wire`, async () => {
    const pair = new VirtualCanPair();
    await pair.start();
    const result = await runIsoTpVector(vector, time, pair);
    assert.deepEqual(result, vector.expect, `bus deviation in ${vector.name}`);
  });
}
