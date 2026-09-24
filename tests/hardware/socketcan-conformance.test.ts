/**
 * SocketCAN conformance — the prepared path, honestly gated (ADR 0045,
 * master prompt §20).
 *
 * The conformance vectors are expressed over the `CanBus` contract; this file
 * is the *hardware* arm of the same harness: with a vcan0 interface (or a real
 * SocketCAN device) and a SocketCAN transport installed, the ISO-TP round trips
 * run through the production adapter. Two transports qualify: the optional
 * native `socketcan` module, and the host's can-utils fallback
 * (`candump`/`cansend` — the zero-native-build path a fresh Linux box gets
 * with `sudo apt install can-utils`). Without either, the suite is skipped
 * with the missing precondition in its message — a skip that names its reason
 * is a finding, an unrun test dressed as green is not (AGENTS 34.21).
 *
 * Run:  npm run test:hardware        (with `modprobe vcan && ip link add dev
 * vcan0 type vcan && ip link set up vcan0` and `npm i socketcan` or
 * `sudo apt install can-utils`)
 *
 * CANable and ELM327 sit on the same `CanBus` contract (proven by their own
 * specs); PCAN has no adapter package in this repository yet — preparing it is
 * implementing `CanBus` + `CanAdapterFactory`, then plugging it in here. No
 * vector, transport or IR change would be needed, which is the point.
 */

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ConformancePair,
  parseIsoTpVectorFile,
  runIsoTpVector,
} from "@vdp/formal-conformance";
import type { CanBus, CanFilter, CanFrame, FrameListener } from "@vdp/transport-can";
import { test } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const isoPath = join(repoRoot, "tools/formal-conformance/vectors/isotp.json");

function hasVcan(): boolean {
  try {
    execSync("ip link show vcan0", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function loadSocketCanBinding(): Promise<unknown | null> {
  // Indirect import: the binding is an optional native module that is absent
  // on most machines; resolving it statically would break the build.
  const dynamicImport = new Function("m", "return import(m)") as (m: string) => Promise<unknown>;
  try {
    return await dynamicImport("socketcan");
  } catch {
    // The native module is absent — the host's own fallback chain is the next
    // authority (native → can-utils candump/cansend), so a CI that installs
    // can-utils instead of a node-gyp toolchain still exercises the kernel
    // socket path. Reusing that chain here instead of restating it is the
    // point of the seam (ADR 0031).
    try {
      const { resolveSocketCanBinding } = await import("@vdp/adapter-host");
      const resolution = await resolveSocketCanBinding();
      return resolution.binding ?? null;
    } catch {
      return null;
    }
  }
}

/** Tester and peer on one SocketCAN interface: frames really leave and return. */
class SocketCanPair implements ConformancePair {
  private constructor(
    private readonly tester: CanBus,
    private readonly peer: CanBus,
  ) {}
  readonly sent: number[][] = [];
  private observer: ((index: number) => void) | undefined;
  get testerBus(): CanBus {
    const self = this;
    const t = this.tester;
    return {
      info: t.info,
      capabilities: t.capabilities,
      open: () => t.open(),
      close: () => t.close(),
      getStatus: () => t.getStatus(),
      isOpen: () => t.isOpen(),
      async send(frame: CanFrame): Promise<void> {
        await t.send(frame);
        self.sent.push(Array.from(frame.payload));
        self.observer?.(self.sent.length - 1);
      },
      subscribe: (listener: FrameListener, filters?: readonly CanFilter[]) =>
        t.subscribe(listener, filters),
    };
  }
  feed(bytes: readonly number[]): void {
    void this.peer.send({
      timestamp: Date.now(),
      id: 0x7e8,
      extended: false,
      fd: false,
      dlc: bytes.length,
      payload: Uint8Array.from(bytes),
      channel: "vcan0",
      direction: "tx",
    });
  }
  captured(): number[][] {
    return this.sent;
  }
  setSendObserver(observer: (index: number) => void): void {
    this.observer = observer;
  }
  static async open(iface: string): Promise<SocketCanPair | null> {
    try {
      const { SocketCanAdapter } = await import("@vdp/adapter-socketcan");
      const bindingMod = await loadSocketCanBinding();
      if (bindingMod === null) return null;
      // The adapter’s binding shape comes from the optional `socketcan` module.
      const tester = new SocketCanAdapter({
        iface,
        binding: bindingMod as ConstructorParameters<typeof SocketCanAdapter>[0]["binding"],
      });
      const peer = new SocketCanAdapter({
        iface,
        binding: bindingMod as ConstructorParameters<typeof SocketCanAdapter>[0]["binding"],
      });
      return new SocketCanPair(tester as CanBus, peer as CanBus);
    } catch {
      return null;
    }
  }
}

const ready = hasVcan();

test("socketcan conformance: the ISO-TP vectors survive a real SocketCAN interface", {
  skip: !ready,
}, async () => {
  assert.ok(ready, "vcan0 missing — hardware suite skipped (see file header for setup)");
  const parsed = parseIsoTpVectorFile(readFileSync(isoPath, "utf8"));
  assert.ok(parsed.ok, JSON.stringify("errors" in parsed ? parsed.errors : []));
  if (!parsed.ok) return;
  const pair = await SocketCanPair.open("vcan0");
  assert.ok(
    pair !== null,
    "no SocketCAN transport installed (`npm i socketcan` or `sudo apt install can-utils`) — skipped",
  );
  if (pair === null) return;
  // Yielding sleep only: the runner’s settle loop carries the deadline, so
  // real time is consumed there, not in fixed waits (ADR 0019).
  const time = { sleep: async (): Promise<void> => new Promise((done) => setImmediate(done)) };
  // Only the round-trip vectors make sense against a live peer (frames may
  // be reordered by the socket); the scripted-answer vectors keep their
  // full authority over the virtual bus in the protocol suite.
  for (const vector of parsed.vectors.filter(
    (v) => v.name === "tx-single-frame-answer-delivers-response",
  )) {
    const result = await runIsoTpVector(vector, time, pair);
    assert.deepEqual(result, vector.expect, `hardware deviation in ${vector.name}`);
  }
});
