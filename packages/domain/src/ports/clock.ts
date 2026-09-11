/**
 * Clock port (target architecture §32 Phase 3: "Sogar Zeit und IDs würde ich
 * abstrahieren").
 *
 * Real time enters only at the composition root; everything below receives a
 * `Clock`. That is what makes simulations and tests fully deterministic — a
 * replay can feed its own timeline into the same code path.
 */

export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
  /** ISO-8601 string for persisted timestamps. */
  iso(): string;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  iso: () => new Date().toISOString(),
};

/** A clock pinned to one instant; advance it explicitly. */
export class FixedClock implements Clock {
  private currentMs: number;

  constructor(startMs = 0) {
    this.currentMs = startMs;
  }

  now(): number {
    return this.currentMs;
  }

  iso(): string {
    return new Date(this.currentMs).toISOString();
  }

  advance(ms: number): void {
    if (ms < 0) throw new Error("a FixedClock cannot go backwards");
    this.currentMs += ms;
  }

  set(ms: number): void {
    this.currentMs = ms;
  }
}

/** Adapt a bare `() => number` (e.g. the engine's clock option) to the port. */
export function clockFrom(now: () => number): Clock {
  return {
    now,
    iso: () => new Date(now()).toISOString(),
  };
}
