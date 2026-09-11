/**
 * Id generator port (target architecture §32 Phase 3).
 *
 * Identity generation is injected, not hard-coded to `Date.now()` — tests and
 * deterministic replays supply a generator that produces stable, reproducible
 * ids (§24: ids travel through the whole system, so they must be trustworthy).
 */

import { createId } from "@vdp/shared";
import { type Clock, systemClock } from "./clock.js";

export interface IdGenerator {
  /** Produce a new id with the given prefix, e.g. `sess_…`, `ecu_…`. */
  next(prefix: string): string;
}

/** Wall-clock based generator — the default at the composition root. */
export class DefaultIdGenerator implements IdGenerator {
  constructor(private readonly clock: Clock = systemClock) {}

  next(prefix: string): string {
    return createId(prefix, () => this.clock.now());
  }
}

/** Deterministic generator for tests and simulation. */
export class FixedIdGenerator implements IdGenerator {
  private counter = 0;

  constructor(private readonly prefix = "id") {}

  next(prefix: string): string {
    this.counter += 1;
    return `${prefix}_${this.prefix}_${this.counter}`;
  }
}
