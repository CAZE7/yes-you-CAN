/**
 * Event bus port (target architecture §10, §32 Phase 3).
 *
 * The domain defines the *contract*; a concrete bus (typed emitter, logger
 * fan-out, session recorder, telemetry, AI) is wired at the composition root.
 * Keeping the port here means the domain never imports an implementation.
 */

import type { DiagnosticEventMap } from "../events.js";

export type Unsubscribe = () => void;

export interface EventBus {
  publish<K extends keyof DiagnosticEventMap>(event: K, payload: DiagnosticEventMap[K]): void;
  subscribe<K extends keyof DiagnosticEventMap>(
    event: K,
    listener: (payload: DiagnosticEventMap[K]) => void,
  ): Unsubscribe;
}

/**
 * Minimal in-memory bus. Default implementation so a runtime can run with no
 * external wiring; production may replace it with a bus that also persists or
 * forwards events.
 */
export class InMemoryEventBus implements EventBus {
  private readonly listeners = new Map<keyof DiagnosticEventMap, Set<(payload: never) => void>>();

  publish<K extends keyof DiagnosticEventMap>(event: K, payload: DiagnosticEventMap[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of Array.from(set))
      (listener as (payload: DiagnosticEventMap[K]) => void)(payload);
  }

  subscribe<K extends keyof DiagnosticEventMap>(
    event: K,
    listener: (payload: DiagnosticEventMap[K]) => void,
  ): Unsubscribe {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as (payload: never) => void);
    return () => {
      set.delete(listener as (payload: never) => void);
    };
  }
}

export interface RecordedEvent<K extends keyof DiagnosticEventMap = keyof DiagnosticEventMap> {
  name: K;
  payload: DiagnosticEventMap[K];
}

/**
 * Test/support bus that captures everything published. Subscriptions are
 * accepted but ignored — recording is the point.
 */
export class RecordingEventBus implements EventBus {
  private readonly recorded: RecordedEvent[] = [];

  publish<K extends keyof DiagnosticEventMap>(event: K, payload: DiagnosticEventMap[K]): void {
    this.recorded.push({ name: event, payload });
  }

  subscribe<K extends keyof DiagnosticEventMap>(
    _event: K,
    _listener: (payload: DiagnosticEventMap[K]) => void,
  ): Unsubscribe {
    return () => undefined;
  }

  get events(): readonly RecordedEvent[] {
    return this.recorded;
  }

  ofType<K extends keyof DiagnosticEventMap>(event: K): Array<DiagnosticEventMap[K]> {
    return this.recorded
      .filter((e): e is RecordedEvent<K> => e.name === event)
      .map((e) => e.payload);
  }

  clear(): void {
    this.recorded.length = 0;
  }
}
