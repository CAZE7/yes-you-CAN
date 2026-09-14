/**
 * Fault injection on the wire between a UDS client and an ECU (master backlog P0 #12;
 * AGENTS 9, 29).
 *
 * Everything else in this repository tests what happens when an ECU answers. This link
 * answers *wrong* — on a schedule, reproducibly, with the healthy side still being a
 * real `UdsServer` — so the client's failure behaviour is a tested contract instead of
 * an assumption: silence, a reply for a service nobody asked about, a payload cut off
 * mid-record, a frame that arrives too late to be usable, an NRC 0x78 loop that never
 * ends.
 *
 * Two rules keep the harness honest:
 *
 * 1. **It only injects what a bus can really do.** Every fault below is a frame-level
 *    event: drop it, cut it, replace it, deliver it late. A fault no transport can
 *    produce would test the harness instead of the client.
 * 2. **It never fixes anything up.** No retry, no padding, no helpful default. A frame
 *    that arrives after its transaction was given up on is parked in
 *    {@link FaultyLink.unanswered} instead of being handed to the next request — which
 *    is what the real link's slot rule does (`IsoTpConnection.awaitResponse`: one slot
 *    per connection, "a timeout can tell whether the slot still belongs to it").
 *
 * Time is injected (`sleep`), so a timeout costs no real P2 — the same seam the
 * protocol tests use for the NRC 0x78 loop (AGENTS 34.7: conditions, not fixed sleeps).
 */

import type { UdsLink } from "@vdp/protocols-uds";
import { IsoTpError } from "@vdp/shared";

/** What the wire does wrong, once, for the request at a given index. */
export type InjectedFault =
  /** The ECU answers and the answer is swallowed on the way (a bus that loses frames). */
  | { kind: "never-answer" }
  /** The request never reaches the ECU (a bus break in front of it). */
  | { kind: "no-forward" }
  /** A well-formed reply for a different service id — crossed wiring, a stale bridge. */
  | { kind: "wrong-sid"; sid: number }
  /** A negative response instead of the positive one, with this NRC. */
  | { kind: "negative"; nrc: number }
  /**
   * The positive response, cut to `keep` bytes. `keep: 1` leaves only the response SID:
   * formally positive, informationally empty — the shape that must never read as
   * "no faults stored" (ADR 0033).
   */
  | { kind: "truncated"; keep: number }
  /** Right response SID, arbitrary body. */
  | { kind: "garbage"; body: readonly number[] }
  /** Every NRC 0x78 gets through; the final answer is swallowed (an ECU that resets). */
  | { kind: "swallow-final" }
  /** The ECU pends forever: each answer, including the real one, becomes a 0x78. */
  | { kind: "pending-forever" }
  /**
   * A frame arrives unasked, before the answer. The client may not take it for the
   * answer — and may not lose the real one behind it either.
   */
  | { kind: "stray-before-answer"; payload: readonly number[] }
  /**
   * The ECU answers only after the client's timeout has fired. The frame is still on
   * the wire afterwards; handing it to the *next* transaction would attribute one
   * request's answer to another.
   */
  | { kind: "answer-late" };

export interface FaultStep {
  /** Which request (0-based, in the order the client sends them) this fault applies to. */
  at: number;
  fault: InjectedFault;
}

export interface FaultyLinkOptions {
  faults?: readonly FaultStep[];
  /** Injected wait, so a timeout case does not cost real P2 (AGENTS 34.7). */
  sleep?: (ms: number) => Promise<void>;
  /** Response window when the caller does not pass one. */
  defaultTimeoutMs?: number;
}

/** One line of the wire log: what crossed, in which direction, and what became of it. */
export interface WireEntry {
  dir: "client→ecu" | "ecu→client";
  payload: Uint8Array;
  outcome: "sent" | "swallowed" | "not-forwarded" | "cut" | "replaced" | "parked" | "injected";
  fault?: InjectedFault["kind"];
}

/**
 * A `UdsLink` for the client that is also the `UdsServerLink` for the ECU: wire
 * `new UdsServer(faulty, options)` and `new UdsClient(faulty)` back to back and the
 * healthy path runs real ECU code — only the wire lies.
 */
export class FaultyLink implements UdsLink {
  /** Every request the client sent, in order, including the ones that failed. */
  readonly requests: Uint8Array[] = [];
  /** Every frame that crossed, with what the harness did to it. */
  readonly wire: WireEntry[] = [];
  /** Frames that arrived after their transaction was over. */
  readonly unanswered: Uint8Array[] = [];

  private readonly faults: ReadonlyMap<number, InjectedFault>;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly defaultTimeoutMs: number;
  private readonly queued: Uint8Array[] = [];
  private ecuListener: ((payload: Uint8Array) => void) | null = null;
  private waiter: ((payload: Uint8Array) => void) | null = null;
  /** SID of the request on the wire, so a replacement still answers *something*. */
  private pendingRequestSid = 0;
  private fault: InjectedFault | undefined;

  constructor(options: FaultyLinkOptions = {}) {
    this.faults = new Map((options.faults ?? []).map((step) => [step.at, step.fault]));
    this.sleep =
      options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 5_000;
  }

  // ------------------------------------------------------------- as the client's link

  async request(payload: Uint8Array, timeoutMs?: number): Promise<Uint8Array> {
    const limit = timeoutMs ?? this.defaultTimeoutMs;
    this.fault = this.faults.get(this.requests.length);
    this.requests.push(payload);
    this.pendingRequestSid = payload[0] ?? 0;

    if (this.fault?.kind === "no-forward") {
      this.wire.push({ dir: "client→ecu", payload, outcome: "not-forwarded", fault: "no-forward" });
      return this.timeoutAfter(limit);
    }

    // The waiter exists before the request goes out, so an ECU that answers
    // synchronously is delivered like one that answers later.
    const waiting = this.timeoutAfter(limit);
    this.wire.push({ dir: "client→ecu", payload, outcome: "sent" });
    this.ecuListener?.(payload);
    return waiting;
  }

  /**
   * One-way traffic: nothing is awaited, so only a fault that removes the *request*
   * can show here. A suppressed 0x10 that never reaches the ECU is invisible to the
   * client by design — which is exactly why the wire log records it.
   */
  async sendOnly(payload: Uint8Array): Promise<void> {
    this.fault = this.faults.get(this.requests.length);
    this.requests.push(payload);
    this.pendingRequestSid = payload[0] ?? 0;
    if (this.fault?.kind === "no-forward") {
      this.wire.push({ dir: "client→ecu", payload, outcome: "not-forwarded", fault: "no-forward" });
      return;
    }
    this.wire.push({ dir: "client→ecu", payload, outcome: "sent" });
    this.ecuListener?.(payload);
  }

  /**
   * The follow-up read of an NRC 0x78 loop. A swallowed final answer leaves this with
   * `null` — which is how a real link reports "nothing came within the window", and
   * what makes the client's P2* timeout a tested path.
   */
  async receive(timeoutMs?: number): Promise<Uint8Array | null> {
    // An ECU that is still working answers every P2* with another pending — that is
    // what `pending-forever` models, and the only way to reach the client's own
    // iteration limit instead of its timeout.
    if (this.fault?.kind === "pending-forever") {
      const frame = new Uint8Array([0x7f, this.pendingRequestSid, 0x78]);
      this.wire.push({
        dir: "ecu→client",
        payload: frame,
        outcome: "replaced",
        fault: "pending-forever",
      });
      return frame;
    }
    const queued = this.queued.shift();
    if (queued !== undefined) return queued;
    try {
      return await this.timeoutAfter(timeoutMs ?? this.defaultTimeoutMs);
    } catch {
      return null;
    }
  }

  // --------------------------------------------------------------- as the ECU's link

  /** What `UdsServer` calls to subscribe to requests. */
  onMessage(listener: (payload: Uint8Array) => void): () => void {
    this.ecuListener = listener;
    return () => {
      this.ecuListener = null;
    };
  }

  /** What `UdsServer` calls to answer. */
  async send(payload: Uint8Array): Promise<void> {
    const frame = this.transform(payload);
    if (frame === undefined) return;
    if (this.waiter !== null) {
      this.deliverNow(frame);
      return;
    }
    this.queued.push(frame);
  }

  // ------------------------------------------------------------------------ internals

  private deliverNow(frame: Uint8Array): void {
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.(frame);
  }

  /** The fault's effect on an answer, or `undefined` when the frame must not arrive. */
  private transform(payload: Uint8Array): Uint8Array | undefined {
    const fault = this.fault;
    if (fault === undefined) return this.record(payload, "sent");
    switch (fault.kind) {
      case "never-answer":
        // The frame is logged and then dropped: an outside reader must be able to see
        // that the ECU *did* answer and the wire lost it (that is the difference to
        // `no-forward`, where the ECU never hears about the request at all).
        this.record(payload, "swallowed", fault.kind);
        return undefined;
      case "answer-late": {
        // Recorded as parked, and never delivered: the transaction has already been
        // given up on, which is exactly what the client has to survive.
        const parked = this.record(payload, "parked", fault.kind);
        if (parked !== undefined) this.unanswered.push(parked);
        return undefined;
      }
      case "swallow-final": {
        // A pending frame is not the final answer, so it passes: that is the
        // difference between "the ECU is slow" and "the ECU is gone".
        if (isPending(payload)) return this.record(payload, "sent");
        this.record(payload, "swallowed", fault.kind);
        return undefined;
      }
      case "wrong-sid":
        return this.record(new Uint8Array([fault.sid]), "replaced", fault.kind);
      case "negative":
        return this.record(
          new Uint8Array([0x7f, this.pendingRequestSid, fault.nrc]),
          "replaced",
          fault.kind,
        );
      case "truncated":
        return this.record(payload.slice(0, Math.max(1, fault.keep)), "cut", fault.kind);
      case "garbage":
        return this.record(
          new Uint8Array([positiveOf(this.pendingRequestSid), ...fault.body]),
          "replaced",
          fault.kind,
        );
      case "pending-forever":
        // The real answer becomes another pending: the loop only ends at the client's
        // own limit, which is the behaviour worth pinning.
        return this.record(
          new Uint8Array([0x7f, this.pendingRequestSid, 0x78]),
          "replaced",
          fault.kind,
        );
      case "stray-before-answer": {
        const stray = new Uint8Array(fault.payload);
        this.wire.push({
          dir: "ecu→client",
          payload: stray,
          outcome: "injected",
          fault: fault.kind,
        });
        // The stray takes the slot and the real answer is parked behind it, so a test
        // can see both halves of the mistake at once.
        this.unanswered.push(payload);
        return stray;
      }
      case "no-forward":
        return this.record(payload, "sent");
    }
  }

  private record(
    payload: Uint8Array,
    outcome: WireEntry["outcome"],
    fault?: InjectedFault["kind"],
  ): Uint8Array | undefined {
    this.wire.push({
      dir: "ecu→client",
      payload,
      outcome,
      ...(fault === undefined ? {} : { fault }),
    });
    return payload;
  }

  private timeoutAfter(limit: number): Promise<Uint8Array> {
    return new Promise<Uint8Array>((resolve, reject) => {
      this.waiter = resolve;
      void this.sleep(limit).then(() => {
        if (this.waiter !== resolve) return;
        this.waiter = null;
        reject(new IsoTpError(`no response within ${limit} ms`, { timeoutMs: limit }));
      });
    });
  }
}

function isPending(payload: Uint8Array): boolean {
  return payload[0] === 0x7f && payload[2] === 0x78;
}

function positiveOf(sid: number): number {
  return sid + 0x40;
}
