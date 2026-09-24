/**
 * The bounded reconnect supervisor (backlog E34), pinned with scripted buses.
 *
 * What must hold — each test is one sentence of the backlog entry:
 * - a dead link is tried again, once, after the named delay, and the revival
 *   re-registers every subscription made through the wrapper;
 * - the policy is bounded: attempts are counted per incident and spent;
 * - a revival resets the budget, because a new loss of a new link is a new
 *   incident;
 * - stopping the session cancels a pending reconnect — no zombie device;
 * - every transition is a log entry with the reason, never silence.
 *
 * The buses here are deliberately fake: the real serial path (open, read loop,
 * EOF on a disappeared device) is exercised on a PTY in
 * `tests/integration/adapter-rehearsal.spec.ts`; this file pins the *policy*,
 * which no PTY can make more visible.
 */

import assert from "node:assert/strict";
import { createLogger, MemorySink, TransportError } from "@vdp/shared";
import type { CanBus, CanFilter, CanFrame, FrameListener } from "@vdp/transport-can";
import { test } from "vitest";
import { settle, waitFor } from "../../../../tests/helpers/wait.js";
import {
  DEFAULT_RECONNECT_POLICY,
  MAX_RECONNECT_ATTEMPTS,
  reconnectPolicyOf,
  type SupervisedStream,
  superviseSerialBus,
} from "./reconnect.js";

/** A bus that answers nothing but records what was asked of it. */
class FakeBus implements CanBus {
  info = { id: "fake", kind: "serial", name: "fake", channels: ["fake0"] };
  capabilities = { can: true, canFd: false, doip: false, isoTpOffload: false, channels: 1 };
  opens = 0;
  closes = 0;
  sentFrames: CanFrame[] = [];
  subscribers: Array<{ listener: FrameListener; filters?: readonly CanFilter[] }> = [];
  openState = false;
  failOnOpen: Error | null = null;

  async open(): Promise<void> {
    if (this.failOnOpen) throw this.failOnOpen;
    this.opens++;
    this.openState = true;
  }
  async close(): Promise<void> {
    this.closes++;
    this.openState = false;
  }
  isOpen(): boolean {
    return this.openState;
  }
  async send(frame: CanFrame): Promise<void> {
    if (!this.openState) throw new TransportError("fake bus is not open");
    this.sentFrames.push(frame);
  }
  subscribe(listener: FrameListener, filters?: readonly CanFilter[]): () => void {
    const entry = { listener, ...(filters ? { filters } : {}) };
    this.subscribers.push(entry);
    return () => {
      this.subscribers = this.subscribers.filter((e) => e !== entry);
    };
  }
  emit(frame: CanFrame): void {
    for (const { listener } of this.subscribers) listener(frame);
  }
  /** What the real adapters do when their stream reports death (their own onError). */
  halt(): void {
    this.openState = false;
    this.subscribers = [];
  }
}

/** A stream whose death is a test decision, not an accident. */
class FakeStream implements SupervisedStream {
  private errorListeners: Array<(error: Error) => void> = [];
  closes = 0;

  onError(listener: (error: Error) => void): () => void {
    this.errorListeners.push(listener);
    return () => {
      this.errorListeners = this.errorListeners.filter((l) => l !== listener);
    };
  }
  async close(): Promise<void> {
    this.closes++;
  }
  die(reason: string): void {
    for (const listener of [...this.errorListeners]) listener(new TransportError(reason));
  }
}

function frame(id: number): CanFrame {
  return {
    timestamp: Date.now(),
    id,
    extended: false,
    fd: false,
    dlc: 1,
    payload: new Uint8Array([id & 0xff]),
    channel: "fake0",
  };
}

/** Builds pairs on demand and records the order the supervisor asked for them. */
function factory() {
  const pairs: Array<{ bus: FakeBus; stream: FakeStream }> = [];
  const state = { failNextOpens: 0 };
  return {
    pairs,
    state,
    open: async () => {
      const pair = { bus: new FakeBus(), stream: new FakeStream() };
      if (state.failNextOpens > 0) {
        state.failNextOpens--;
        pair.bus.failOnOpen = new TransportError("init timed out");
      }
      // The real adapters subscribe to their stream's errors and halt themselves
      // (Elm327Adapter.onStreamError, CanableAdapter ditto); the fake must do
      // the same or it would model an adapter that lies about being open.
      pair.stream.onError(() => pair.bus.halt());
      pairs.push(pair);
      return pair;
    },
  };
}

test("a dead link is tried again, and the revival carries the subscriptions", async () => {
  const made = factory();
  const sink = new MemorySink();
  const logger = createLogger("can", { level: "DEBUG" }, [sink]);
  const bus = await superviseSerialBus({
    adapterId: "elm327",
    open: made.open,
    policy: { attempts: 1, delayMs: 10 },
    logger,
  });
  await bus.open();
  const seen: number[] = [];
  bus.subscribe((f) => {
    seen.push(f.id);
  });
  // A subscription that is gone before the link dies must stay gone after the
  // revival — re-registration replays the registry, not history.
  const off = bus.subscribe(() => {
    assert.fail("an unsubscribed listener must not be revived");
  });
  off();
  made.pairs[0]?.bus.emit(frame(0x101));
  assert.deepEqual(seen, [0x101]);

  // The link dies with a named reason…
  made.pairs[0]?.stream.die("usb removed");
  assert.equal(bus.isOpen(), false, "a dead link must not claim to be open");
  // …nothing is rebuilt before the delay has elapsed…
  await settle(5, "the reconnect delay (10 ms) must not have elapsed yet");
  assert.equal(made.pairs.length, 1);
  // …and one attempt later the bus answers again, with the same wrapper.
  await waitFor(() => made.pairs.length === 2, Boolean, {
    timeoutMs: 500,
    message: "the supervisor must rebuild the pair once",
  });
  await waitFor(() => bus.isOpen(), Boolean, {
    timeoutMs: 500,
    message: "the revived link is open",
  });
  assert.equal(made.pairs[1]?.bus.opens, 1, "the revival re-runs the adapter init");
  assert.equal(made.pairs[0]?.bus.closes, 1, "the dead adapter is closed, not abandoned");

  // The subscription survived the revival without the caller re-subscribing.
  made.pairs[1]?.bus.emit(frame(0x202));
  assert.deepEqual(seen, [0x101, 0x202], "the wrapper re-registered the subscriber");

  // The doctor's marked passthrough follows the current adapter, so a revived
  // link is the device that gets examined (doctor.ts reads wrappedByCatalog).
  const marked = bus as CanBus & { wrappedByCatalog?: CanBus };
  assert.equal(marked.wrappedByCatalog, made.pairs[1]?.bus);

  // And the log tells the story with reasons, not silence.
  const messages = sink.all().map((record) => record.message);
  assert.ok(messages.includes("adapter link lost — reconnect scheduled"));
  assert.ok(messages.includes("adapter link restored"));
  const lost = sink
    .all()
    .find((record) => record.message === "adapter link lost — reconnect scheduled");
  assert.match(String(lost?.fields?.["reason"] ?? ""), /usb removed/);

  await bus.close();
});

test("the policy is bounded: attempts are spent, then the link stays dead", async () => {
  const made = factory();
  const sink = new MemorySink();
  const logger = createLogger("can", { level: "DEBUG" }, [sink]);
  // The device never comes back: every rebuild fails before a pair exists —
  // exactly what a disappeared /dev path answers.
  let deviceGone = false;
  let openCalls = 0;
  const bus = await superviseSerialBus({
    adapterId: "elm327",
    open: async () => {
      openCalls++;
      if (deviceGone) throw new TransportError("cannot open serial device /dev/ttyUSB0: ENOENT");
      return made.open();
    },
    policy: { attempts: 2, delayMs: 10 },
    logger,
  });
  await bus.open();

  deviceGone = true;
  made.pairs[0]?.stream.die("bluetooth dropped");
  await waitFor(() => openCalls === 3, Boolean, {
    timeoutMs: 500,
    message: "attempts 2 means the initial build plus exactly two rebuild tries",
  });
  assert.equal(made.pairs.length, 1, "the device never came back, so no new pair exists");
  assert.equal(bus.isOpen(), false);
  await settle(50, "the budget is spent, so no further attempt may be scheduled");
  assert.equal(openCalls, 3, "no silent loop");
  assert.ok(
    sink
      .all()
      .some((record) => record.message === "adapter link is down — no reconnect attempt left"),
    "the final state is named, not silent",
  );
  await bus.close();
});

test("a failed rebuild consumes an attempt instead of throwing into the session", async () => {
  const made = factory();
  const bus = await superviseSerialBus({
    adapterId: "elm327",
    open: made.open,
    policy: { attempts: 2, delayMs: 10 },
  });
  await bus.open();
  // The device reappears but does not initialise: the first rebuild builds a
  // pair whose init times out — an attempt spent, descriptor returned, and one
  // more attempt follows (the queue is set before the death, because the
  // rebuild happens after the delay, not synchronously).
  made.state.failNextOpens = 1;
  made.pairs[0]?.stream.die("usb removed");
  await waitFor(() => made.pairs.length === 3, Boolean, {
    timeoutMs: 500,
    message: "the failed open is an attempt, and one more follows",
  });
  await waitFor(() => bus.isOpen(), Boolean, {
    timeoutMs: 500,
    message: "the third pair initialised",
  });
  assert.equal(made.pairs[1]?.stream.closes ?? 0, 1, "a failed rebuild gives its descriptor back");
  assert.equal(made.pairs[2]?.bus.opens, 1, "the third pair initialised cleanly");
  await bus.close();
});

test("a revival resets the budget — a new loss of a new link is a new incident", async () => {
  const made = factory();
  const bus = await superviseSerialBus({
    adapterId: "elm327",
    open: made.open,
    policy: { attempts: 1, delayMs: 10 },
  });
  await bus.open();
  made.pairs[0]?.stream.die("first loss");
  await waitFor(() => bus.isOpen(), Boolean, {
    timeoutMs: 500,
    message: "restored after the first incident",
  });
  made.pairs[1]?.stream.die("second loss");
  await waitFor(() => made.pairs.length === 3, Boolean, {
    timeoutMs: 500,
    message: "the second incident gets its own attempt",
  });
  await waitFor(() => bus.isOpen(), Boolean, {
    timeoutMs: 500,
    message: "restored after the second incident",
  });
  await bus.close();
});

test("stopping the session cancels a pending reconnect — no zombie device", async () => {
  const made = factory();
  const bus = await superviseSerialBus({
    adapterId: "elm327",
    open: made.open,
    policy: { attempts: 1, delayMs: 40 },
  });
  await bus.open();
  made.pairs[0]?.stream.die("usb removed");
  await bus.close();
  // 40 ms delay, closed at ~0: if close() failed to cancel the timer, the
  // rebuild would have happened by the time this quiet period is over.
  await settle(50, "close() must cancel the scheduled rebuild");
  assert.equal(made.pairs.length, 1, "close() must cancel the scheduled rebuild");
  assert.equal(made.pairs[0]?.bus.closes, 1);
});

test("sends during the dead window fail with the adapter's own refusal", async () => {
  const made = factory();
  const bus = await superviseSerialBus({
    adapterId: "elm327",
    open: made.open,
    policy: { attempts: 1, delayMs: 10 },
  });
  await bus.open();
  await bus.send(frame(0x7e0));
  made.pairs[0]?.stream.die("usb removed");
  await assert.rejects(() => bus.send(frame(0x7e0)), /not open/);
  await bus.close();
});

test("the default policy is one attempt after two seconds, and the bounds are enforced", () => {
  assert.deepEqual(DEFAULT_RECONNECT_POLICY, { attempts: 1, delayMs: 2000 });
  assert.deepEqual(reconnectPolicyOf({}), { attempts: 1, delayMs: 2000 });
  assert.deepEqual(reconnectPolicyOf({ reconnectAttempts: 0 }), { attempts: 0, delayMs: 2000 });
  assert.deepEqual(reconnectPolicyOf({ reconnectAttempts: 3, reconnectDelayMs: 500 }), {
    attempts: 3,
    delayMs: 500,
  });
  assert.throws(
    () => reconnectPolicyOf({ reconnectAttempts: MAX_RECONNECT_ATTEMPTS + 1 }),
    /reconnectAttempts must be an integer between 0 and 10/,
  );
  assert.throws(() => reconnectPolicyOf({ reconnectAttempts: -1 }), /reconnectAttempts/);
  assert.throws(() => reconnectPolicyOf({ reconnectDelayMs: 1.5 }), /reconnectDelayMs/);
});

test("a rebuild that finishes after close() is discarded, not adopted", async () => {
  const made = factory();
  // A holder instead of a bare variable: the release callback is assigned
  // inside a promise executor, which TypeScript's control-flow analysis cannot
  // see, and a bare `let` would narrow to `null` at the call site.
  const gate: { release: (() => void) | null } = { release: null };
  const bus = await superviseSerialBus({
    adapterId: "elm327",
    // The first build is ordinary; the rebuild hangs until the test lets it
    // go — the operator stops the session while the device is coming back.
    open: async () => {
      if (made.pairs.length === 0) return made.open();
      await new Promise<void>((resolve) => {
        gate.release = resolve;
      });
      return made.open();
    },
    policy: { attempts: 1, delayMs: 10 },
  });
  await bus.open();
  made.pairs[0]?.stream.die("usb removed");
  await waitFor(() => gate.release !== null, Boolean, {
    timeoutMs: 500,
    message: "the rebuild must start after the delay",
  });
  await bus.close();
  gate.release?.();
  await waitFor(() => made.pairs.length === 2, Boolean, {
    timeoutMs: 500,
    message: "the hanging build resolves and builds its pair",
  });
  await waitFor(() => (made.pairs[1]?.bus.closes ?? 0) === 1, Boolean, {
    timeoutMs: 500,
    message: "a pair built after close() is closed, not adopted",
  });
  assert.equal(bus.isOpen(), false, "the session is over; no zombie link");
});
