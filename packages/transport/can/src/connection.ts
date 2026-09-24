/**
 * Adapter connection state — the one vocabulary for "how is the link doing?"
 * (master prompt P1: an adapter must deliver a clear state, no hidden ones).
 *
 * The frame layer had a boolean (`isOpen()`) and, for the byte transports, a
 * four-valued `ConnectionStatus`. Everything a technician needs to distinguish
 * was squeezed into a boolean: a bus that never opened, a link that died
 * mid-session, a device that answers but refuses frames, and a supervisor that
 * is currently trying to revive a pulled cable all read as `false` — the same
 * reading as "the vehicle is silent", which is the one interpretation that must
 * never be guessed (AGENTS 34.21, ADR 0033: an unproven outcome is a failure,
 * and a failure has a reason).
 *
 * {@link AdapterConnectionState} is that vocabulary, and
 * {@link ConnectionTracker} is the one implementation of the transitions —
 * adapters report what they observe, they do not each invent a state machine.
 *
 * | State | Means | Not to be confused with |
 * |---|---|---|
 * | `disconnected` | no link; nothing was opened or it was closed on purpose | an error |
 * | `connecting` | an open/init handshake is in flight | connected |
 * | `connected` | the link carried a completed handshake and is usable | the ECU answers |
 * | `degraded` | the link is up, the adapter reported a link-level failure it survived | an ECU problem |
 * | `recovering` | a bounded reconnect policy is retrying the device | connected |
 * | `error` | the link is unusable and stays so until somebody acts | a retry in progress |
 *
 * `degraded` and `recovering` are deliberately not errors: the first is a link
 * that still carries frames (an ELM327 that answered `BUS BUSY` once), the
 * second is a policy that is still spending its budget. Turning either into
 * `error` would make the UI cry wolf; turning them into `connected` is the
 * silent state this vocabulary exists to remove.
 *
 * The module is dependency-free (ADR 0002) and lives in the frame layer because
 * that is where "is the wire there?" is known — DoIP's byte transport reports
 * through the same type (ISO 13400 has the same failure modes).
 */

import type { ConnectionStatus } from "./transport.js";

/** Every state an adapter link may be in. Exhaustive by type — no "unknown". */
export type AdapterConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "degraded"
  | "recovering"
  | "error";

/** All states, in lifecycle order — the list a UI or a test can enumerate. */
export const ADAPTER_CONNECTION_STATES: readonly AdapterConnectionState[] = [
  "disconnected",
  "connecting",
  "connected",
  "degraded",
  "recovering",
  "error",
];

/** States in which the link may carry a frame right now. */
export const USABLE_CONNECTION_STATES: readonly AdapterConnectionState[] = [
  "connected",
  "degraded",
];

/** One recorded transition; `at` is an epoch millisecond timestamp. */
export interface ConnectionTransition {
  from: AdapterConnectionState;
  to: AdapterConnectionState;
  at: number;
  /** Why the adapter changed state, in the adapter's own words. */
  reason?: string;
}

export interface ConnectionTrackerOptions {
  /** Adapter id the status reports, e.g. "elm327". */
  adapterId: string;
  /** Human readable detail, e.g. "ELM327 v2.1 @ /dev/ttyUSB0". */
  detail?: string;
  /** Clock seam so tests can pin timestamps. */
  now?: () => number;
  /** How many transitions to keep for diagnosis (ring buffer). */
  historyLimit?: number;
}

/**
 * The one connection state machine of the frame and byte layer.
 *
 * Adapters call {@link connect}, {@link connected}, {@link degraded},
 * {@link recovering}, {@link fail} and {@link disconnected} where they observe
 * those things; the tracker keeps the state, the reason, the time it was entered
 * and a bounded history. Repetition is a no-op, so a chatty observer cannot
 * flood a listener with the state it already had.
 */
export class ConnectionTracker {
  private current: AdapterConnectionState = "disconnected";
  private reason: string | undefined;
  private lastError: string | undefined;
  private changedAt: number;
  private readonly transitions: ConnectionTransition[] = [];
  private readonly listeners = new Set<
    (status: ConnectionStatus, change: ConnectionTransition) => void
  >();
  private readonly adapterId: string;
  private detail: string | undefined;
  private readonly now: () => number;
  private readonly historyLimit: number;
  private counters: { txCount: number; rxCount: number; lastActivityAt?: number } = {
    txCount: 0,
    rxCount: 0,
  };
  private listenerFailures = 0;
  private lastListenerFailure: string | undefined;

  constructor(options: ConnectionTrackerOptions) {
    this.adapterId = options.adapterId;
    this.detail = options.detail;
    this.now = options.now ?? Date.now;
    this.historyLimit = options.historyLimit ?? 16;
    this.changedAt = this.now();
  }

  get state(): AdapterConnectionState {
    return this.current;
  }

  /** Reason of the current state, when the adapter gave one. */
  get stateReason(): string | undefined {
    return this.reason;
  }

  /** Why the link last became unusable; cleared when it becomes usable again. */
  get error(): string | undefined {
    return this.lastError;
  }

  /** When the current state was entered (epoch ms). */
  get since(): number {
    return this.changedAt;
  }

  /** True while the link may carry a frame. */
  get usable(): boolean {
    return USABLE_CONNECTION_STATES.includes(this.current);
  }

  /** How often a transition listener threw; the reason of the last throw. */
  get listenerHealth(): { failures: number; lastFailure?: string } {
    return {
      failures: this.listenerFailures,
      ...(this.lastListenerFailure !== undefined ? { lastFailure: this.lastListenerFailure } : {}),
    };
  }

  /** Bounded transition history, oldest first. */
  get history(): readonly ConnectionTransition[] {
    return [...this.transitions];
  }

  /** An open/init handshake started. */
  connect(reason?: string): void {
    this.enter("connecting", reason ?? "opening the link");
  }

  /** The handshake completed; the link is usable. Clears the last error. */
  connected(detail?: string, reason?: string): void {
    if (detail !== undefined) this.detail = detail;
    this.lastError = undefined;
    this.enter("connected", reason ?? "link established");
  }

  /**
   * The link is up but reported a failure it survived (a refused frame, a bus
   * error, a full buffer). Stays usable: a degraded link is still a link.
   */
  degraded(reason: string): void {
    this.enter("degraded", reason);
  }

  /** Back to normal after a degraded phase — no error, no drama. */
  healthy(reason?: string): void {
    if (this.current === "degraded") this.enter("connected", reason ?? "link healthy again");
  }

  /** A bounded reconnect policy is spending its budget on this device. */
  recovering(reason: string): void {
    this.enter("recovering", reason);
  }

  /** The link is unusable; `error` says why and stays until somebody acts. */
  fail(error: string): void {
    this.lastError = error;
    this.enter("error", error);
  }

  /** Closed on purpose (or never opened) — not an error. */
  disconnected(reason?: string): void {
    this.enter("disconnected", reason ?? "link closed");
  }

  /** Frame counters, fed by the adapter that owns the wire. */
  report(delta: { tx?: number; rx?: number; at?: number }): void {
    if (delta.tx) this.counters.txCount += delta.tx;
    if (delta.rx) this.counters.rxCount += delta.rx;
    if (delta.at !== undefined) this.counters.lastActivityAt = delta.at;
  }

  /** The status a `CanBus.getStatus()` returns. */
  status(): ConnectionStatus {
    return {
      state: this.current,
      adapterId: this.adapterId,
      ...(this.detail !== undefined ? { detail: this.detail } : {}),
      ...(this.reason !== undefined ? { stateReason: this.reason } : {}),
      txCount: this.counters.txCount,
      rxCount: this.counters.rxCount,
      ...(this.lastError !== undefined ? { lastError: this.lastError } : {}),
      ...(this.counters.lastActivityAt !== undefined
        ? { lastActivityAt: this.counters.lastActivityAt }
        : {}),
      since: this.changedAt,
    };
  }

  /** Observe transitions; the listener is called on every later change. */
  onTransition(
    listener: (status: ConnectionStatus, change: ConnectionTransition) => void,
  ): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private enter(to: AdapterConnectionState, reason: string): void {
    // Repetition is not a transition: the state stays, only the wording of the
    // reason is refreshed (a listener must not be woken by the state it had).
    if (to === this.current) {
      this.reason = reason;
      return;
    }
    const from = this.current;
    const at = this.now();
    this.current = to;
    this.reason = reason;
    this.changedAt = at;
    this.transitions.push({ from, to, at, reason });
    if (this.transitions.length > this.historyLimit) this.transitions.shift();
    const status = this.status();
    for (const listener of this.listeners) {
      try {
        listener(status, { from, to, at, reason });
      } catch (error) {
        // A listener that throws must not break the adapter's own state
        // handling — the state is the contract, the listener is a consumer.
        // Recorded instead of swallowed, because a UI listener that throws on
        // every transition is a bug somebody has to see (AGENTS 34.25).
        this.listenerFailures++;
        this.lastListenerFailure = error instanceof Error ? error.message : String(error);
      }
    }
  }
}

/**
 * The state of something that has only an on/off notion of itself.
 *
 * For a test double or a passthrough that genuinely has no richer state, this is
 * the honest answer: open means connected, closed means disconnected, and there
 * is nothing in between to report. It exists so that a fixture implements the
 * contract in one line instead of inventing a state machine it does not have.
 */
export function connectionStatusOf(
  open: boolean,
  adapterId: string,
  detail?: string,
): ConnectionStatus {
  return {
    state: open ? "connected" : "disconnected",
    adapterId,
    ...(detail !== undefined ? { detail } : {}),
  };
}

/** A tracker for an object that is not an adapter (tests, replay: no link at all). */
export function connectionTrackerFor(
  adapterId: string,
  detail: string | undefined,
  now?: () => number,
): ConnectionTracker {
  return new ConnectionTracker({
    adapterId,
    ...(detail !== undefined ? { detail } : {}),
    ...(now !== undefined ? { now } : {}),
  });
}
