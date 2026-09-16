/**
 * What a module's own wiring does to it — supply, ground and the twisted pair
 * (AGENTS 32; master backlog P0 #16).
 *
 * This is the part of the vehicle model that is *not* physics but the boundary between
 * physics and a module: the rail is one number, the pin is another, and between them sit
 * a connector, a cable and a ground strap. Four failure modes, one decision per flap
 * window, and the answer to three questions a diagnosis asks differently:
 *
 * - **Is the module powered?** Below the brown-out threshold it resets: no UDS answer,
 *   no broadcast, and no fault memory activity either — a dead module does not heal the
 *   statement it last made.
 * - **Does its traffic reach the bus?** A cut pair leaves the module alive and unheard,
 *   which is the one case where "it does not answer" and "it is not there" are the same
 *   observation from outside and a completely different one from inside.
 * - **Is the defect load dependent?** An added resistance in the feed shows a good number
 *   at rest and a bad one under load. That is the whole reason a measurement taken with
 *   everything switched off finds nothing, and the reason this model computes the drop
 *   from the current instead of storing a "faulty" flag.
 *
 * The class owns no time and no rng of its own: it is handed a context per step, so the
 * model stays the single place where model time advances and randomness is drawn
 * (AGENTS 31 — one deterministic source, no second clock to keep in sync).
 */

import type { ModuleWiringFault } from "./vehicle-state.js";

/** What the wiring may ask the vehicle about, at the moment it is asked. */
export interface WiringContext {
  /** The rail every module hangs on, before its own cable. */
  readonly supplyVoltage: number;
  /** Model time, for the cadence of an intermittent contact. */
  readonly timeMs: number;
  /** The model's integration step — a flap window shorter than it cannot be resolved. */
  readonly stepMs: number;
  /** Below this a module resets rather than reports. */
  readonly brownoutV: number;
  /** What the vehicle's consumers draw right now, amperes — what a sag is computed from. */
  readonly electricalLoadA: number;
  /** The model's injected randomness, never `Math.random` (AGENTS 31). */
  random(): number;
}

/** Default added resistance of a corroded feed, ohm. */
const DEFAULT_FEED_RESISTANCE_OHM = 0.6;
/** Default current a module draws on its own, amperes — the baseline the sag is computed from. */
const MODULE_IDLE_CURRENT_A = 0.4;
/** Default share of the time a loose contact holds. */
const DEFAULT_CONTACT_DUTY = 0.4;
/** Default length of one contact window, model ms. */
const DEFAULT_FLAP_MS = 250;

/**
 * The wiring of every module of one vehicle.
 *
 * `ctx` is a function, not a snapshot: the rail and the clock move while the model steps,
 * and a copy taken at construction would freeze exactly the numbers the faults are about.
 */
export class ModuleWiring {
  private readonly faults = new Map<string, ModuleWiringFault>();
  private readonly contact = new Map<string, boolean>();
  private readonly lastFlap = new Map<string, number>();
  private readonly flapOrigin = new Map<string, number>();

  constructor(private readonly ctx: () => WiringContext) {}

  /** Apply a wiring fault to one module, replacing whatever it had. */
  set(fault: ModuleWiringFault): void {
    this.faults.set(fault.ecu, fault);
    this.contact.delete(fault.ecu);
    const now = this.ctx().timeMs;
    this.lastFlap.set(fault.ecu, now);
    this.flapOrigin.set(fault.ecu, now);
  }

  /** Repair it — the module is back to being fed from the rail directly. */
  clear(ecuId: string): void {
    this.faults.delete(ecuId);
    this.contact.delete(ecuId);
    this.lastFlap.delete(ecuId);
    this.flapOrigin.delete(ecuId);
  }

  clearAll(): void {
    this.faults.clear();
    this.contact.clear();
    this.lastFlap.clear();
    this.flapOrigin.clear();
  }

  faultOf(ecuId: string): ModuleWiringFault | undefined {
    return this.faults.get(ecuId);
  }

  /** The modules this vehicle has a defect on, in the order they were applied. */
  affected(): string[] {
    return [...this.faults.keys()];
  }

  /** Called once per integration step, before the monitors read anything. */
  step(): void {
    for (const [ecuId, fault] of this.faults) {
      if (fault.mode !== "connector-loose") continue;
      const context = this.ctx();
      const flapMs = Math.max(context.stepMs, fault.flapMs ?? DEFAULT_FLAP_MS);
      if (context.timeMs - (this.lastFlap.get(ecuId) ?? 0) < flapMs && this.contact.has(ecuId))
        continue;
      this.lastFlap.set(ecuId, context.timeMs);
      if ((fault.pattern ?? "random") === "alternate") {
        // Counted from the moment the fault was applied, never from the last redraw: a
        // window index derived from its own previous update can only ever be "one",
        // which is how this model once held a connector open forever.
        const windows = Math.floor((context.timeMs - (this.flapOrigin.get(ecuId) ?? 0)) / flapMs);
        this.contact.set(ecuId, windows % 2 === 0);
      } else {
        this.contact.set(ecuId, context.random() < (fault.duty ?? DEFAULT_CONTACT_DUTY));
      }
    }
  }

  /** Voltage at one module's pins — the number its own monitors react to. */
  supplyOf(ecuId: string): number {
    const { supplyVoltage } = this.ctx();
    const fault = this.faults.get(ecuId);
    if (fault === undefined) return supplyVoltage;
    switch (fault.mode) {
      case "power-cut":
        return 0;
      case "connector-loose":
        return this.hasContact(ecuId) ? supplyVoltage : 0;
      case "bus-open":
        // Supply untouched: that is the definition of this failure mode.
        return supplyVoltage;
      case "supply-resistance": {
        // The drop is computed, not stored: a corroded feed is invisible at rest and
        // obvious under load, and a model that simply subtracted a constant would
        // report the same fault at every current.
        const drawnA = MODULE_IDLE_CURRENT_A + this.ctx().electricalLoadA;
        return Math.max(0, supplyVoltage - drawnA * (fault.ohm ?? DEFAULT_FEED_RESISTANCE_OHM));
      }
    }
  }

  isPowered(ecuId: string): boolean {
    const fault = this.faults.get(ecuId);
    if (fault?.mode === "power-cut") return false;
    if (fault?.mode === "connector-loose" && !this.hasContact(ecuId)) return false;
    return this.supplyOf(ecuId) >= this.ctx().brownoutV;
  }

  /** Whether a module's frames reach the wire. Alive and unheard is a real state. */
  isBusConnected(ecuId: string): boolean {
    const fault = this.faults.get(ecuId);
    if (fault === undefined) return this.isPowered(ecuId);
    if (!this.isPowered(ecuId)) return false;
    if (fault.mode === "bus-open") return false;
    if (fault.mode === "connector-loose") return this.hasContact(ecuId);
    return true;
  }

  reset(): void {
    this.clearAll();
  }

  private hasContact(ecuId: string): boolean {
    return this.contact.get(ecuId) ?? true;
  }
}
