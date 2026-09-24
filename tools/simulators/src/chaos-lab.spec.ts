/**
 * Unit tests for the chaos proxy (AGENTS 0.A → docs/architecture/status.md: tests where the code lives).
 *
 * What injected chaos does to a real diagnostic run is covered by
 * `tests/protocol/chaos-lab.test.ts`. This file covers the rules themselves, because a
 * rule that silently stops firing still leaves a healthy-looking stack: the run passes
 * and nothing was actually stressed. Egress and ingress are checked apart, since the
 * proxy treats them differently — `delay` is a receive-side rule only.
 */

import assert from "node:assert/strict";
import {
  type AdapterCapabilities,
  type AdapterInfo,
  type CanBus,
  type CanFrame,
  type ConnectionStatus,
  connectionStatusOf,
} from "@vdp/transport-can";
import { describe, test } from "vitest";
import { CanChaosBus, ChaosLab } from "./chaos-lab.js";

function frame(id: number, bytes: number[] = []): CanFrame {
  const payload = Uint8Array.from(bytes);
  return {
    timestamp: 0,
    id,
    extended: false,
    fd: false,
    dlc: payload.length,
    payload,
    channel: "test",
  };
}

/** Indexed access narrowed once, so a test reads as an assertion and not as a `!`. */
function nth<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`no entry at index ${index}, the run produced ${items.length}`);
  }
  return item;
}

/** A bus that records what it is sent and can play frames back as arrivals. */
class FakeBus implements CanBus {
  readonly sent: CanFrame[] = [];
  private readonly listeners: Array<(frame: CanFrame) => void> = [];
  private opened = false;

  get info(): AdapterInfo {
    return { id: "fake", kind: "simulator", name: "Fake bus", channels: ["test"] };
  }

  get capabilities(): AdapterCapabilities {
    return { can: true, canFd: false, doip: false, isoTpOffload: false, channels: 1 };
  }

  async open(): Promise<void> {
    this.opened = true;
  }

  async close(): Promise<void> {
    this.opened = false;
  }

  getStatus(): ConnectionStatus {
    return connectionStatusOf(this.opened, "fake");
  }

  isOpen(): boolean {
    return this.opened;
  }

  async send(frame: CanFrame): Promise<void> {
    this.sent.push(frame);
  }

  subscribe(listener: (frame: CanFrame) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index >= 0) this.listeners.splice(index, 1);
    };
  }

  /** A frame as it would arrive from the network. */
  receive(frame: CanFrame): void {
    for (const listener of [...this.listeners]) listener(frame);
  }
}

function chaos(options: { random?: () => number; sleep?: (ms: number) => Promise<void> } = {}) {
  const bus = new FakeBus();
  return { bus, lab: new CanChaosBus(bus, options) };
}

/**
 * A scripted source of randomness that fails when it is asked for more than the test
 * handed it. That exhaustion is itself a measurement: a rule drawing twice per frame
 * would break here instead of showing up as a wrong drop count.
 */
function scripted(values: readonly number[]): () => number {
  let i = 0;
  return () => {
    const value = values[i++];
    if (value === undefined) {
      throw new Error(`random source exhausted after ${values.length} draws`);
    }
    return value;
  };
}

describe("CanChaosBus", () => {
  test("without rules it is a transparent wire in both directions", async () => {
    const { bus, lab } = chaos();
    const seen: CanFrame[] = [];
    lab.subscribe((received) => {
      seen.push(received);
    });
    await lab.open();
    await lab.send(frame(0x100, [1, 2, 3]));
    bus.receive(frame(0x100, [4]));

    assert.equal(lab.isOpen(), true);
    assert.deepEqual([...nth(bus.sent, 0).payload], [1, 2, 3]);
    assert.deepEqual([...nth(seen, 0).payload], [4], "received frames pass through untouched");
    assert.equal(lab.dropped.length, 0);
    assert.equal(lab.corruptedCount, 0);
    assert.equal(lab.delayedCount, 0);
  });

  test("a burst drop spends its budget and leaves the rest of the bus alone", async () => {
    const { bus, lab } = chaos();
    lab.addRule({ kind: "drop-count", id: 0x7e0, count: 2 });
    for (let i = 0; i < 5; i++) await lab.send(frame(0x7e0, [i]));
    await lab.send(frame(0x100, [9]));

    assert.equal(lab.dropped.length, 2, "the third frame passes once the budget is spent");
    assert.equal(bus.sent.filter((sent) => sent.id === 0x7e0).length, 3);
    assert.equal(
      bus.sent.filter((sent) => sent.id === 0x100).length,
      1,
      "another id is never eaten by a burst aimed at 0x7e0",
    );
    assert.equal(lab.remainingBurstDrops, 0, "the budget is reported, not implied");
  });

  test("corruption on egress reaches the wire, once per frame", async () => {
    const { bus, lab } = chaos();
    lab.addRule({
      kind: "corrupt-payload",
      id: 0x6f1,
      modifier: (data) => {
        const next = Uint8Array.from(data);
        const first = next[0];
        if (first !== undefined) next[0] = first ^ 0xff;
        return next;
      },
    });
    await lab.send(frame(0x6f1, [0x00, 0x42]));

    assert.deepEqual([...nth(bus.sent, 0).payload], [0xff, 0x42]);
    assert.equal(lab.corruptedCount, 1);
  });

  test("a delayed frame arrives when time passes, not before", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { bus, lab } = chaos({ sleep: () => gate });
    lab.addRule({ kind: "delay", id: 0x18d, delayMs: 50 });
    const seen: CanFrame[] = [];
    lab.subscribe((received) => {
      seen.push(received);
    });

    bus.receive(frame(0x18d, [1]));
    assert.equal(seen.length, 0, "still in flight");
    assert.deepEqual(lab.dropped, [], "delayed is not dropped");
    release();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(seen.length, 1, "delivered once the wait resolves");
    assert.equal(lab.delayedCount, 1);
  });

  test("injectDropRate drops the frames the random source picks, and only those", async () => {
    // One draw per outgoing frame against a 0.5 threshold (AGENTS 31: no entropy, no
    // wall clock in a test), so the count is a property of the rule.
    const { bus, lab } = chaos({ random: scripted([0.25, 0.75, 0.25, 0.75]) });
    lab.injectDropRate(0.5);
    for (let n = 0; n < 4; n++) await lab.send(frame(0x100, [n]));

    assert.equal(lab.dropped.length, 2);
    assert.equal(bus.sent.length, 2, "the survivors are the ones the source kept");
  });

  test("clearRules returns the wire to transparent", async () => {
    const { bus, lab } = chaos();
    lab.addRule({ kind: "drop-count", id: 0x100, count: 10 });
    lab.clearRules();
    await lab.send(frame(0x100, [1]));

    assert.equal(bus.sent.length, 1);
    assert.equal(lab.dropped.length, 0);
    assert.equal(lab.remainingBurstDrops, 0);
  });

  test("the sequence injector renumbers consecutive frames and nothing else", async () => {
    const { bus, lab } = chaos();
    ChaosLab.injectIsoTpSequenceCorruption(lab, 0x18da);
    await lab.send(frame(0x18da, [0x23, 0xde, 0xad]));
    assert.equal(nth(bus.sent, 0).payload[0], 0x26, "SN 3 becomes 6, the frame stays a CF");
    await lab.send(frame(0x18da, [0x10, 0x00, 0x08]));
    assert.deepEqual(
      [...nth(bus.sent, 1).payload],
      [0x10, 0x00, 0x08],
      "a first frame is not a CF",
    );
    await lab.send(frame(0x18db, [0x20, 0x11]));
    assert.deepEqual(
      [...nth(bus.sent, 2).payload],
      [0x20, 0x11],
      "another id is not this injector's",
    );
    assert.equal(
      lab.corruptedCount,
      2,
      "the counter names frames the rule was aimed at — the third frame had another id, " +
        "and the second one was matched by id without the modifier touching a byte",
    );
  });

  test("the flow-control injector turns CTS into OVFLW on the FC frame only", async () => {
    const { bus, lab } = chaos();
    ChaosLab.injectIsoTpFlowControlOverflow(lab, 0x18da);
    await lab.send(frame(0x18da, [0x30, 0xff, 0xf1]));
    assert.deepEqual([...nth(bus.sent, 0).payload], [0x32, 0xff, 0xf1], "FlowStatus 0 -> 2");
    await lab.send(frame(0x18da, [0x21, 0x11]));
    assert.deepEqual(
      [...nth(bus.sent, 1).payload],
      [0x21, 0x11],
      "a CF is not a flow control frame",
    );
  });

  test("it is still a bus: identity and capabilities come from the adapter it wraps", async () => {
    const { bus, lab } = chaos();
    assert.equal(lab.info.id, bus.info.id);
    assert.equal(lab.info.name, "Fake bus");
    assert.equal(lab.capabilities.can, true);
    assert.equal(lab.capabilities.doip, false);
  });

  test("the ChaosLab presets configure the bus they are handed", async () => {
    const { lab } = chaos();
    const seen: CanFrame[] = [];
    lab.subscribe((received) => {
      seen.push(received);
    });
    ChaosLab.injectDropRate(lab, 1);
    await lab.send(frame(0x100, [1]));

    assert.deepEqual(seen, [], "a rate of one eats every frame, in both directions");
    assert.equal(lab.dropped.length, 1);

    ChaosLab.injectBurstFrameDrop(lab, 0x101, 1);
    assert.equal(lab.remainingBurstDrops, 1, "the preset reports its budget through the bus");
  });

  test("a burst without an id is the next N frames of this bus, whatever they address", async () => {
    // The form a connection-wide switch needs (AGENTS 0.E → docs/architecture/backlog.md E24): aimed at one arbitration id,
    // a burst is a no-op on a vehicle that does not talk on it — and reports itself active.
    const { lab } = chaos();
    ChaosLab.injectBurstFrameDrop(lab, undefined, 2);
    await lab.send(frame(0x100, [1]));
    await lab.send(frame(0x200, [2]));
    await lab.send(frame(0x300, [3]));
    assert.equal(
      lab.dropped.length,
      2,
      "the budget is a count of frames, not of frames per id, when no id is given",
    );
    assert.equal(lab.remainingBurstDrops, 0, "and it is spent afterwards");
  });

  test("drops and corruption bite on the way in as well as on the way out", async () => {
    const { bus, lab } = chaos();
    const seen: CanFrame[] = [];
    lab.subscribe((received) => {
      seen.push(received);
    });
    lab.addRule({ kind: "drop-count", id: 0x18d, count: 1 });
    lab.addRule({ kind: "drop-predicate", match: (received) => received.id === 0x7c0 });
    lab.addRule({
      kind: "corrupt-payload",
      id: 0x7e0,
      modifier: (data) => {
        const next = Uint8Array.from(data);
        const first = next[0];
        if (first !== undefined) next[0] = first ^ 0x01;
        return next;
      },
    });

    bus.receive(frame(0x18d, [1]));
    assert.equal(seen.length, 0, "the inbound burst ate it");
    bus.receive(frame(0x18d, [2]));
    assert.deepEqual(
      [...nth(seen, 0).payload],
      [2],
      "the second arrived after the budget was spent",
    );
    bus.receive(frame(0x7c0, [0x99]));
    assert.equal(seen.length, 1, "a predicate drops what it names, inbound too");

    bus.receive(frame(0x7e0, [0x10]));
    assert.deepEqual([...nth(seen, 1).payload], [0x11], "corrupted before the listener saw it");
    assert.deepEqual([...bus.sent], [], "the network path was never written to");
    assert.equal(lab.corruptedCount, 1);
  });
  test("a filtered subscriber sees only the ids it asked for", async () => {
    // Regression: the proxy stored the filters and delivered to every listener, so a
    // chaos run showed a subscriber frames the real bus would never have handed it.
    const { bus, lab } = chaos();
    const seen: number[] = [];
    lab.subscribe(
      (received) => {
        seen.push(received.id);
      },
      [{ id: 0x100, mask: 0x7ff }],
    );
    bus.receive(frame(0x100, [1]));
    bus.receive(frame(0x200, [2]));

    assert.deepEqual(seen, [0x100]);
  });

  test("unsubscribe stops delivery", async () => {
    const { bus, lab } = chaos();
    const seen: CanFrame[] = [];
    const off = lab.subscribe((received) => {
      seen.push(received);
    });
    bus.receive(frame(0x100, [1]));
    off();
    bus.receive(frame(0x100, [2]));

    assert.equal(seen.length, 1);
  });
});
