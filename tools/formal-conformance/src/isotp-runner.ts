/**
 * Drives the production ISO-TP connection through one conformance vector.
 *
 * Nothing here reimplements segmentation: the runner wires the real
 * `IsoTpConnection` onto a scripted bus, hands it the vector's frames, and
 * reads back exactly what the vector asserts — the message the application
 * would see, the frames the connection put on the wire, and the counters it
 * recorded. The scripted bus is the only fake, and it fakes *the wire*, never
 * the protocol.
 *
 * Time enters through two seams and nowhere else:
 *
 * - the connection clock (`now`) is a counter the vector advances with
 *   `tickMs`, so the N_Cr guard is testable without wall time;
 * - the N_Bs and response timers inside the connection are real (the class
 *   owns them), so a run waits on the *outcome*, with the caller-injected
 *   `sleep` as the only way to yield — no vector waits for a fixed duration.
 */

import { IsoTpError } from "@vdp/shared";
import {
  type AdapterCapabilities,
  type AdapterInfo,
  type CanBus,
  type CanFilter,
  type CanFrame,
  type FrameListener,
  createFrame,
} from "@vdp/transport-can";
import { IsoTpConnection } from "@vdp/transport-iso-tp";
import { type IsoTpErrorClass, type IsoTpResult, decodeCapturedFrames } from "./canonical.js";
import type { IsoTpTxPeerEntry, IsoTpVector } from "./vectors.js";

const INFO: AdapterInfo = {
  id: "conformance",
  kind: "virtual",
  name: "Conformance bus",
  channels: ["conf0"],
};
const CAPABILITIES: AdapterCapabilities = {
  can: true,
  canFd: false,
  doip: false,
  isoTpOffload: false,
  channels: 1,
};

/**
 * The pair of buses a vector run needs: the tester side the connection is
 * wired onto, a way to deliver peer frames to it, and a capture of every frame
 * the connection put on the wire. The scripted implementation delivers
 * synchronously — like an adapter whose RX callback runs inside the send path;
 * any other `CanBus` pair (the simulator’s virtual CAN, a SocketCAN adapter on
 * vcan0) can implement the same interface, which is what makes the vectors
 * runnable “Virtual CAN ↕ real adapter” without touching the transport (ADR
 * 0045, master prompt §20).
 */
export interface ConformancePair {
  /** The bus the connection is constructed on. */
  readonly testerBus: CanBus;
  /** Deliver one peer frame to the connection, at the run’s model time. */
  feed(bytes: readonly number[], timestampMs: number): void;
  /** Payloads of every frame the connection has sent, in order. */
  captured(): number[][];
  /** Hook called with the (0-based) index after each captured send. */
  setSendObserver(observer: (index: number) => void): void;
}

class ScriptedBus implements CanBus {
  readonly info = INFO;
  readonly capabilities = CAPABILITIES;
  readonly sent: CanFrame[] = [];
  private listeners: Array<{ listener: FrameListener; filters?: readonly CanFilter[] }> = [];
  private opened = false;
  /** Called after every frame the connection sends (the peer-schedule hook). */
  onSent: ((count: number) => void) | undefined;

  async open(): Promise<void> {
    this.opened = true;
  }
  async close(): Promise<void> {
    this.opened = false;
  }
  isOpen(): boolean {
    return this.opened;
  }
  async send(frame: CanFrame): Promise<void> {
    this.sent.push(frame);
    this.onSent?.(this.sent.length - 1);
  }
  subscribe(listener: FrameListener, filters?: readonly CanFilter[]): () => void {
    const entry = { listener, ...(filters ? { filters } : {}) };
    this.listeners.push(entry);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== entry);
    };
  }
  /** Deliver one frame from the peer, timestamped with the vector's model clock. */
  feed(bytes: readonly number[], timestamp: number): void {
    const frame = createFrame(0x7e8, Uint8Array.from(bytes), {
      fd: false,
      channel: "conf0",
      timestamp,
      direction: "rx",
    });
    for (const entry of this.listeners) {
      if (entry.filters && !entry.filters.some((f) => (frame.id & f.mask) === (f.id & f.mask))) {
        continue;
      }
      entry.listener(frame);
    }
  }
}

export interface RunnerTime {
  /** The caller's way to yield: a microtask for tests, a real sleep as fallback. */
  sleep(ms: number): Promise<void>;
}

/**
 * Classify an `IsoTpError` by its *structured* details. An error the mapping
 * does not cover stays `null` and the runner reports it as a tool failure —
 * the one way to keep a prose-based mapping from drifting quietly.
 */
export function classifyIsoTpError(error: unknown): IsoTpErrorClass | null {
  if (!(error instanceof IsoTpError)) return null;
  const details = error.details ?? {};
  if (details.flowControl === "overflow") return "buffer-overflow";
  if (details.timeout === "N_Bs") return "timeout-nBs";
  if (details.timeout === "WFTmax") return "wftmax";
  if (details.timeout === "response") return "timeout-response";
  if (details.payloadLength === 0) return "empty-payload";
  if (details.tooLong === true) return "message-too-long";
  if (details.sequenceError === true) return null; // observed through counters
  return null;
}

/**
 * A peer entry is due when the frame it waits for has left the connection:
 * `after: n` feeds right after our n-th emission (0-based).
 */
function dueNow(entry: IsoTpTxPeerEntry, sentSoFar: number): boolean {
  return entry.after < sentSoFar;
}

/** The default pair: a one-node scripted wire, synchronous in both directions. */
export class ScriptedPair implements ConformancePair {
  private readonly bus = new ScriptedBus();
  get testerBus(): CanBus {
    return this.bus;
  }
  feed(bytes: readonly number[], timestampMs: number): void {
    this.bus.feed(bytes, timestampMs);
  }
  captured(): number[][] {
    return this.bus.sent.map((frame) => Array.from(frame.payload));
  }
  setSendObserver(observer: (index: number) => void): void {
    this.bus.onSent = observer;
  }
}

/**
 * Run one ISO-TP vector against the production connection and return the
 * canonical result. `pair` defaults to the scripted one-node wire; passing a
 * different `ConformancePair` is how the same vectors reach virtual CAN and
 * real adapters without any change to the vectors or the transport.
 */
export async function runIsoTpVector(
  vector: IsoTpVector,
  time: RunnerTime,
  pair: ConformancePair = new ScriptedPair(),
): Promise<IsoTpResult> {
  let clockMs = 0;
  const connection = new IsoTpConnection(pair.testerBus, {
    txId: 0x7e0,
    rxId: 0x7e8,
    timing: {
      nAsMs: 0,
      sendTimeoutMs: 0, // the scripted bus accepts synchronously
      nBsMs: vector.config.nBsMs,
      nCrMs: vector.config.nCrMs,
      stMinMs: vector.config.stMinMs,
      stMinTxMs: 0,
      blockSize: vector.config.blockSize,
      wftMax: vector.config.wftMax,
      maxRetries: vector.config.maxRetries,
    },
    sleep: (ms) => (ms > 0 ? time.sleep(ms) : time.sleep(0)),
    now: () => clockMs,
  });
  const countersBefore = {
    sequenceErrors: connection.stats.sequenceErrors,
    timeouts: connection.stats.timeouts,
    retries: connection.stats.retries,
  };

  let delivered: number[] | null = null;
  let error: IsoTpErrorClass | null = null;

  connection.onUnsolicited((payload) => {
    if (delivered === null) delivered = Array.from(payload);
  });

  /** Let queued microtasks (FC emission on the receive path) reach the bus. */
  const settle = async (): Promise<void> => {
    for (let round = 0; round < 4; round++) await time.sleep(0);
  };
  const finishError = (cause: unknown): void => {
    const classified = classifyIsoTpError(cause);
    if (classified === null) {
      // An error no class covers is a tool finding, not a vector outcome: it
      // rejects the run so the record says why nothing was claimed.
      const raw = cause instanceof Error ? cause.message : String(cause);
      throw new Error(
        `vector "${vector.name}": unmapped transport error "${raw}" — extend the class table deliberately, never guess`,
      );
    }
    error = classified;
  };

  if (vector.side === "rx") {
    connection.open();
    for (const event of vector.input) {
      if (event.in !== undefined) {
        pair.feed(event.in, clockMs);
        await settle();
      }
      if (event.tickMs !== undefined) clockMs += event.tickMs;
      if (event.checkCr === true && connection.checkCrTimeout()) error = "timeout-nCr";
    }
    await settle();
  } else {
    const pending = [...vector.peer];
    const deliverDue = (sentCount: number): void => {
      while (
        pending.length > 0 &&
        dueNow(pending[0] ?? { after: Number.POSITIVE_INFINITY, frame: [] }, sentCount)
      ) {
        const entry = pending.shift();
        if (entry) pair.feed(entry.frame, clockMs);
      }
    };
    pair.setSendObserver((index) => deliverDue(index + 1));
    const done = connection.request(Uint8Array.from(vector.payload), vector.config.budgetMs).then(
      (payload) => {
        delivered = Array.from(payload);
      },
      (cause: unknown) => finishError(cause),
    );
    // The request starts inside `enqueue` — one yield before the first frame
    // leaves the connection is enough to let the transmit path begin, which is
    // what arms the peer schedule.
    await settle();
    const deadlineMs = vector.config.budgetMs + 5_000;
    const startedAt = Date.now();
    let finished = false;
    void done.then(() => {
      finished = true;
    });
    while (!finished) {
      await time.sleep(1);
      if (Date.now() - startedAt > deadlineMs) {
        connection.close();
        throw new Error(
          `vector "${vector.name}" did not settle within ${deadlineMs} ms — stuck, not slow`,
        );
      }
    }
    await done;
  }

  connection.close();
  return {
    delivered,
    error,
    sentFrames: decodeCapturedFrames(pair.captured()),
    counters: {
      sequenceErrors: connection.stats.sequenceErrors - countersBefore.sequenceErrors,
      timeouts: connection.stats.timeouts - countersBefore.timeouts,
      retries: connection.stats.retries - countersBefore.retries,
    },
  };
}
