import assert from "node:assert/strict";
import { TransportClosedError } from "@vdp/shared";
import type { CanBus, CanFilter, CanFrame, FrameListener } from "@vdp/transport-can";
import { describe, test } from "vitest";
import { ChaosSession } from "../src/chaos-session.js";

class SilentBus implements CanBus {
  readonly info = { id: "silent", kind: "virtual", name: "silent", channels: ["vcan0"] };
  readonly capabilities = {
    can: true,
    canFd: false,
    doip: false,
    isoTpOffload: false,
    channels: 1,
  };
  async open(): Promise<void> {
    /* no-op double */
  }
  async close(): Promise<void> {
    /* no-op double */
  }
  isOpen(): boolean {
    return true;
  }
  async send(_frame: CanFrame): Promise<void> {
    /* no-op double */
  }
  subscribe(_listener: FrameListener, _filters?: readonly CanFilter[]): () => void {
    return () => {
      /* unsubscribe */
    };
  }
}

describe("ChaosSession", () => {
  test("inject without a connection is a refusal, not a silent counter", () => {
    const session = new ChaosSession();
    assert.throws(() => session.inject({ dropRate: 1 }), TransportClosedError);
    const idle = session.status();
    assert.equal(idle.active, false);
    assert.equal(idle.dropBurstScope, "none");
  });

  test("a wrapped bus reports a bus-wide burst, then a targeted one, then a reset", () => {
    const session = new ChaosSession();
    session.wrap(new SilentBus(), "simulator");
    session.inject({ dropBurst: 3 });
    const wide = session.status();
    assert.equal(wide.active, true);
    assert.equal(wide.dropBurstScope, "bus-wide");
    assert.equal(wide.dropBurstTarget, null);
    assert.equal(wide.dropBurstRemaining, 3);

    session.inject({ dropBurst: 2, dropBurstCanId: 0x7e8 });
    const aimed = session.status();
    assert.equal(aimed.dropBurstScope, "targeted");
    assert.equal(aimed.dropBurstTarget, "0x7E8");

    session.reset();
    const cleared = session.status();
    assert.equal(cleared.active, false);
    assert.equal(cleared.dropBurstScope, "none");
    assert.equal(cleared.dropRate, 0);

    session.inject({ dropRate: 0.5, corruptSequenceCanId: 0x7e0 });
    assert.equal(session.status().dropRate, 0.5);
    session.dispose();
    assert.throws(() => session.inject({ dropRate: 1 }), /start the vehicle first/);
  });
});
