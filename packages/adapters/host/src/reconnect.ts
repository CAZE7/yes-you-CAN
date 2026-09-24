/**
 * Bounded reconnect supervision for the host's serial adapters (backlog E34).
 *
 * A serial link at the edge of a vehicle dies in ordinary ways — a Bluetooth
 * ELM327 that drops its RFCOMM, a USB tty that disappears. Before this module
 * that death was final for the session: the adapters report it honestly
 * (`onError` → `isOpen()` false, the reason in the status) but nothing ever
 * tried the device again, so the operator restarted the session by hand,
 * live values included. This supervisor is the named, bounded policy that the
 * backlog entry asks for — not an automation with opinions:
 *
 * - **Bounded.** `attempts` is finite (default 1). When the budget is spent,
 *   the bus stays exactly as dead as it is today, with the reason in the log.
 *   A successful revival resets the budget, because a *new* loss of a *new*
 *   link is a new incident — but within one incident the count is hard.
 * - **Only when nothing is in flight, by construction.** The supervisor acts
 *   only after the stream reported its own death, and the adapters already
 *   rejected every pending command at that moment (their stream-error handler
 *   fails the queue synchronously) and refuse new sends while dead. By the
 *   time `delayMs` has passed, no request can be in flight — the delay is the
 *   operator's window to replug the cable, not a race with the protocol.
 * - **Named, never silent.** Every transition is a log entry with the reason:
 *   loss, each attempt, each failure, the revival, the final state.
 * - **A reconnect is a connection setup, not a write.** Reviving means opening
 *   the device again and re-running the adapter's own init (AT commands, the
 *   slcan open sequence) — the supervisor sends no UDS request and touches no
 *   ECU state, so the permit chain (AGENTS 26) is unberührt by design.
 *
 * What the caller sees is the same `CanBus` object before, during and after a
 * revival: subscriptions made through the wrapper are remembered and
 * re-registered on the new adapter, which is why a runtime above it (live
 * values, raw trace) simply continues. `wrappedByCatalog` follows the current
 * adapter so the doctor keeps talking to the device that is actually open.
 */

import {
  AdapterUnsupportedError,
  asError,
  createLogger,
  type Logger,
  messageOf,
} from "@vdp/shared";
import type { CanBus, CanFilter, CanFrame, FrameListener } from "@vdp/transport-can";

/** The reconnect policy of a supervised serial bus. Bounded and named, never a loop. */
export interface ReconnectPolicy {
  /**
   * Reconnect attempts per link loss. `0` disables the supervisor entirely
   * (the final state of today, immediately). Finite by contract: the catalog
   * refuses values above `MAX_RECONNECT_ATTEMPTS`.
   */
  attempts: number;
  /** Wait before each attempt — the operator's window to replug the device. */
  delayMs: number;
}

/** One attempt after two seconds: enough to notice a replug, small enough to stay honest. */
export const DEFAULT_RECONNECT_POLICY: ReconnectPolicy = { attempts: 1, delayMs: 2000 };

/** The policy is bounded by contract; this is the bound (a loop in config is still a loop). */
export const MAX_RECONNECT_ATTEMPTS = 10;
/** Likewise the delay: an hour of "reconnecting" is a dead bus wearing a heartbeat. */
export const MAX_RECONNECT_DELAY_MS = 60_000;

/**
 * The stream surface the supervisor needs — `SerialByteStream` satisfies it.
 * Kept structural so the supervisor is testable with a scripted stream.
 */
export interface SupervisedStream {
  onError(listener: (error: Error) => void): () => void;
  close(): Promise<void>;
}

export interface SupervisedBusOptions {
  /** Adapter id, for log entries that name who lost the link. */
  adapterId: string;
  /**
   * Builds a fresh adapter over a fresh stream — the `create()` path, made
   * re-runnable. Must NOT open the adapter; the supervisor owns the open
   * (first and every revival), so the init sequence runs exactly once per link.
   */
  open: () => Promise<{ bus: CanBus; stream: SupervisedStream }>;
  /** Defaults to {@link DEFAULT_RECONNECT_POLICY}. */
  policy?: ReconnectPolicy;
  logger?: Logger;
}

/** Resolve the policy from adapter config values, refusing unbounded input. */
export function reconnectPolicyOf(config: {
  reconnectAttempts?: number;
  reconnectDelayMs?: number;
}): ReconnectPolicy {
  const attempts = config.reconnectAttempts ?? DEFAULT_RECONNECT_POLICY.attempts;
  const delayMs = config.reconnectDelayMs ?? DEFAULT_RECONNECT_POLICY.delayMs;
  if (!Number.isInteger(attempts) || attempts < 0 || attempts > MAX_RECONNECT_ATTEMPTS) {
    throw new AdapterUnsupportedError(
      `reconnectAttempts must be an integer between 0 and ${MAX_RECONNECT_ATTEMPTS}, got ${String(config.reconnectAttempts)}`,
    );
  }
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > MAX_RECONNECT_DELAY_MS) {
    throw new AdapterUnsupportedError(
      `reconnectDelayMs must be an integer between 0 and ${MAX_RECONNECT_DELAY_MS}, got ${String(config.reconnectDelayMs)}`,
    );
  }
  return { attempts, delayMs };
}

/** One subscription made through the wrapper, so a revival can re-register it. */
interface Registration {
  listener: FrameListener;
  filters?: readonly CanFilter[];
  off: (() => void) | null;
}

/**
 * Wrap a serial adapter in the bounded reconnect policy.
 *
 * The initial build happens here (the caller gets a bus whose stream already
 * exists but whose adapter is still unopened — `open()` stays the caller's
 * move, exactly as with an unsupervised catalog bus).
 */
export async function superviseSerialBus(options: SupervisedBusOptions): Promise<CanBus> {
  const policy = options.policy ?? DEFAULT_RECONNECT_POLICY;
  const log = (options.logger ?? createLogger("can", { level: "INFO" })).child("can");
  let current = await options.open();
  let closing = false;
  let attemptsSpent = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const watchStream = (): void => {
    current.stream.onError((error) => {
      onStreamDeath(error);
    });
  };

  // Failures during the very first build propagate to `create()` — an adapter
  // that cannot be built once is not a reconnect, it is a refusal.
  watchStream();

  const onStreamDeath = (error: Error): void => {
    if (closing) return;
    if (attemptsSpent >= policy.attempts) {
      log.warn("adapter link is down — no reconnect attempt left", {
        adapter: options.adapterId,
        reason: messageOf(error),
        attempts: policy.attempts,
      });
      return;
    }
    attemptsSpent++;
    log.warn("adapter link lost — reconnect scheduled", {
      adapter: options.adapterId,
      reason: messageOf(error),
      attempt: attemptsSpent,
      attempts: policy.attempts,
      delayMs: policy.delayMs,
    });
    timer = setTimeout(() => {
      timer = null;
      void revive(messageOf(error));
    }, policy.delayMs);
  };

  const revive = async (reason: string): Promise<void> => {
    if (closing) return;
    // A pair that was built but not adopted must give its descriptor back —
    // `open()` runs the init sequence and can legitimately fail on a device
    // that reappeared but does not answer yet.
    let built: { bus: CanBus; stream: SupervisedStream } | null = null;
    try {
      const pair = await options.open();
      built = pair;
      if (closing) {
        // The operator stopped the session while the device was being rebuilt;
        // the fresh pair must not outlive the session it was built for.
        await pair.bus.close().catch(() => undefined);
        await pair.stream.close().catch(() => undefined);
        return;
      }
      // The supervisor owns the open: re-running the adapter's init is part of
      // every revival, so a revived link is a *configured* link.
      await pair.bus.open();
      for (const registration of registrations) {
        registration.off = pair.bus.subscribe(registration.listener, registration.filters);
      }
      const previous = current;
      current = pair;
      watchStream();
      attemptsSpent = 0;
      log.info("adapter link restored", {
        adapter: options.adapterId,
        reason,
        adapterInstance: pair.bus.info.id,
      });
      // The old adapter halted itself when its stream died; closing it here is
      // hygiene, and the stream descriptor belongs to the catalog, not the bus.
      await previous.bus.close().catch(() => undefined);
      await previous.stream.close().catch(() => undefined);
    } catch (error) {
      const failure = asError(error);
      if (built !== null) {
        await built.bus.close().catch(() => undefined);
        await built.stream.close().catch(() => undefined);
      }
      log.warn("adapter reconnect attempt failed", {
        adapter: options.adapterId,
        reason: messageOf(failure),
        attempt: attemptsSpent,
        attempts: policy.attempts,
      });
      onStreamDeath(failure);
    }
  };

  const registrations: Registration[] = [];

  const wrapper: CanBus & { wrappedByCatalog?: CanBus } = {
    info: current.bus.info,
    capabilities: current.bus.capabilities,
    // Marked passthrough for the doctor/probe paths, following the current
    // adapter so a revived link is still the one being examined.
    get wrappedByCatalog(): CanBus {
      return current.bus;
    },
    open: () => current.bus.open(),
    isOpen: () => current.bus.isOpen(),
    send: (frame: CanFrame) => current.bus.send(frame),
    subscribe: (listener: FrameListener, filters?: readonly CanFilter[]) => {
      const registration: Registration = {
        listener,
        ...(filters ? { filters } : {}),
        off: current.bus.subscribe(listener, filters),
      };
      registrations.push(registration);
      return () => {
        const index = registrations.indexOf(registration);
        if (index >= 0) registrations.splice(index, 1);
        registration.off?.();
        registration.off = null;
      };
    },
    close: async () => {
      closing = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      try {
        await current.bus.close();
      } finally {
        await current.stream.close();
      }
    },
  };
  return wrapper;
}
