/**
 * Measurement access of the diagnostic engine (AGENTS 12, 15, 16).
 *
 * Three questions belong together and apart from the fault-memory path: which
 * signals an ECU defines (plan), reading them once (snapshot) and reading them
 * continuously (live data). The recorder stays the single sink for every value —
 * the charts, the reports and the CSV export all read what was recorded here, so
 * nothing may bypass it.
 */

import { type DefinitionPackage, type SignalDefinition, indexPackage } from "@vdp/definitions";
import type { Logger } from "@vdp/shared";
import { messageOf } from "@vdp/shared";
import type { DecodedSignal, SignalDecoder } from "../measurements/decoder.js";
import { LiveDataEngine } from "../measurements/live.js";
import type { MeasurementRecorder } from "../measurements/recorder.js";
import type { VehicleSession } from "../session/session.js";
import type { EcuRegistry } from "./ecu-registry.js";

export interface LiveDataOptions {
  signalIds?: readonly string[];
  intervalMs?: number;
  maxRounds?: number;
}

export interface MeasurementAccessOptions {
  registry: EcuRegistry;
  recorder: MeasurementRecorder;
  decoder: SignalDecoder;
  definitions: readonly DefinitionPackage[];
  logger: Logger;
  /** Default poll interval of {@link startLive}, overridable per call. */
  pollIntervalMs?: number | undefined;
}

export class MeasurementAccess {
  private readonly registry: EcuRegistry;
  private readonly recorder: MeasurementRecorder;
  private readonly decoder: SignalDecoder;
  private readonly definitions: readonly DefinitionPackage[];
  private readonly log: Logger;
  private readonly pollIntervalMs: number;
  private liveEngine: LiveDataEngine | null = null;

  constructor(options: MeasurementAccessOptions) {
    this.registry = options.registry;
    this.recorder = options.recorder;
    this.decoder = options.decoder;
    this.definitions = options.definitions;
    this.log = options.logger;
    this.pollIntervalMs = options.pollIntervalMs ?? 100;
  }

  /** ecuSessionId → signals to poll, honouring an optional signal filter. */
  buildPlan(signalIds?: readonly string[]): Map<string, readonly SignalDefinition[]> {
    const plan = new Map<string, readonly SignalDefinition[]>();
    for (const handle of this.registry.all) {
      const all = handle.session.signals;
      const selected = signalIds ? all.filter((s) => signalIds.includes(s.id)) : all;
      if (selected.length > 0) plan.set(handle.session.id, selected);
    }
    return plan;
  }

  /** Resolve a signal definition across all packages. */
  findSignal(signalId: string): SignalDefinition | undefined {
    for (const pkg of this.definitions) {
      const signal = indexPackage(pkg).byId.get(signalId);
      if (signal) return signal;
    }
    return undefined;
  }

  /**
   * Read defined signals of every ECU once (used for a snapshot/report). With a
   * filter only those signals are requested — a two-signal snapshot no longer
   * pays for the whole signal table of every ECU (AGENTS 12).
   */
  async snapshot(
    session: VehicleSession | null,
    signalIds?: readonly string[],
  ): Promise<DecodedSignal[]> {
    const decoded: DecodedSignal[] = [];
    const plan = this.buildPlan(signalIds);
    for (const handle of this.registry.all) {
      const selected = plan.get(handle.session.id);
      const values = selected ? await handle.session.readSignals(selected) : [];
      for (const value of values) {
        decoded.push(value);
        this.recorder.record(value);
      }
    }
    if (session) {
      session.data.measurements = this.recorder
        .signalIds()
        .map((id) => ({ signalId: id, name: id, samples: this.recorder.samplesFor(id).length }));
    }
    return decoded;
  }

  /** Start parallel live data acquisition across all ECUs (AGENTS 15). */
  async startLive(
    session: VehicleSession | null,
    options: LiveDataOptions = {},
  ): Promise<LiveDataEngine> {
    if (!session) throw new Error("no session — call connect() first");
    const plan = this.buildPlan(options.signalIds);
    const engine = new LiveDataEngine(
      (signal, payload) => this.decoder.decode(signal, payload),
      this.recorder,
      {
        intervalMs: options.intervalMs ?? this.pollIntervalMs,
        logger: this.log,
        ...(options.maxRounds !== undefined ? { maxRounds: options.maxRounds } : {}),
      },
    );
    this.liveEngine = engine;
    const readers = this.registry.all
      .filter((handle) => plan.has(handle.session.id))
      .map((handle) => handle.reader);
    void engine.run(readers, plan).catch((error) => {
      this.log.error("live data engine crashed", {
        error: messageOf(error),
      });
    });
    return engine;
  }

  stopLive(): void {
    this.liveEngine?.stop();
    this.liveEngine = null;
  }

  /** The running engine, for callers that want to observe it (tests, tooling). */
  get running(): LiveDataEngine | null {
    return this.liveEngine;
  }
}
