/**
 * The sample stream: *who* listens to poll rounds and *how* a listener attaches
 * to the live engine that exists now — and to every later one.
 *
 * Split out of `MeasurementService` when the service crossed the 800-line module
 * budget (AGENTS 0.E → docs/architecture/backlog.md E15): the service answers "what was measured", while the
 * subscription lifecycle is a separate question with its own failure mode. Two
 * rules live here and are the reason this is not a `Set` in the service:
 *
 * 1. **A subscriber may arrive before the measurement starts.** The listener
 *    survives start/stop cycles and attaches to the next live engine, so a
 *    subscriber can never miss the first round by ordering alone.
 * 2. **Exactly one subscription per listener per run.** Re-subscribing or a
 *    second `start()` must not double-deliver: the detach function of the current
 *    binding is kept per listener, and a listener that already has one is left
 *    alone.
 */

import type { LiveDataEngine } from "@vdp/core";
import type { MeasurementReading } from "@vdp/domain";
import { toMeasurementReading } from "./mappers.js";

/** Readings of one recorded poll round — the payload of the sample stream. */
export interface SampleRound {
  readings: readonly MeasurementReading[];
}

export type SampleListener = (round: SampleRound) => void;

export class SampleStream {
  /**
   * Registered listeners, whether or not a live run is in progress. A listener
   * registered before `start()` is not lost — {@link bind} attaches it.
   */
  private readonly listeners = new Set<SampleListener>();
  /** The detach function of the binding that currently exists, per listener. */
  private readonly detaches = new Map<SampleListener, () => void>();
  private engine: LiveDataEngine | null = null;

  /**
   * Bind the stream to the engine of a live run.
   *
   * Idempotent by construction: listeners that are already attached to *this*
   * engine are skipped, and listeners added beforehand are attached now.
   */
  bind(engine: LiveDataEngine): void {
    this.engine = engine;
    for (const listener of this.listeners) this.attach(listener);
  }

  /**
   * Drop the binding — the engine is gone, the subscriptions stay registered and
   * reattach on the next {@link bind}.
   */
  unbind(): void {
    this.engine = null;
    for (const detach of this.detaches.values()) detach();
    this.detaches.clear();
  }

  /**
   * Subscribe to every recorded poll round. The returned function unsubscribes
   * and is safe to call twice.
   */
  subscribe(listener: SampleListener): () => void {
    this.listeners.add(listener);
    this.attach(listener);
    return () => {
      this.listeners.delete(listener);
      this.detaches.get(listener)?.();
      this.detaches.delete(listener);
    };
  }

  /** Number of registered listeners — the live-run diagnostic, not a guess. */
  get size(): number {
    return this.listeners.size;
  }

  private attach(listener: SampleListener): void {
    const engine = this.engine;
    if (!engine || this.detaches.has(listener)) return;
    this.detaches.set(
      listener,
      engine.onRound((result) => {
        const names = new Map(result.signals.map((signal) => [signal.signalId, signal.name]));
        const readings = result.samples.map(
          (sample): MeasurementReading => toMeasurementReading(sample, names.get(sample.signal)),
        );
        // A round without readings is not a round: an empty push would make every
        // subscriber render a blank frame instead of keeping the last one.
        if (readings.length > 0) listener({ readings });
      }),
    );
  }
}
