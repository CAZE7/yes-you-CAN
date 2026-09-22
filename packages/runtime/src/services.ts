/**
 * Runtime services (target architecture §14/§32 Phase 2).
 *
 * The god-`DiagnosticEngine` is still the implementation below, but clients
 * no longer talk to it directly: each concern is a small service with a
 * domain-shaped API. When the engine is decomposed (ADR 0014 Phase 4) these
 * services keep their signatures and simply receive new implementations.
 */

import type {
  ConnectVehicleOptions,
  ConnectVehicleResult,
  ResolveVehicleHints,
} from "@vdp/application";
export type {
  WriteBinding,
  WriteOperationResult,
  WritePrecheckResult,
  WritePort,
} from "@vdp/core";
import type {
  DiagnosticEngine,
  EcuHandle,
  EcuSession,
  LiveDataEngine,
  Marker,
  MeasurementSample,
  SafetyManager,
  VehicleSessionData,
  VehicleState,
  WriteRequestContext,
} from "@vdp/core";
import type {
  AnomalyInfo,
  DefinitionProvider,
  DiagnosticCapability,
  EcuSummary,
  EventBus,
  MarkerInfo,
  MeasurementReading,
  MeasurementStatus,
  RawDidReading,
  RecordingHistory,
  SessionStore,
  SessionSummary,
  SignalInfo,
  SignalStatisticsInfo,
  VehicleResolutionRef,
  VehicleSummary,
} from "@vdp/domain";
import type { Logger } from "@vdp/shared";
import { UnknownEcuError, messageOf, toHex } from "@vdp/shared";
import { capabilitiesFromServices } from "./capability-map.js";
import {
  decodedToReading,
  toAnomalyInfo,
  toEcuSummary,
  toMarkerInfo,
  toMeasurementReading,
  toSessionSummary,
  toSignalInfo,
  toSignalStatisticsInfo,
  toVehicleSummary,
} from "./mappers.js";
import { type SampleListener, SampleStream } from "./sample-stream.js";
// The stream vocabulary stays importable from the service module: the SSE path
// and the specs reached it here before the split, and a re-export beats a second
// import path for the same type (ADR 0014: outward API unchanged).
export type { SampleListener, SampleRound } from "./sample-stream.js";
import {
  dtcVehicleContextOf,
  resolveVehicleQuery,
  vehicleDeterminationOf,
} from "./vehicle-resolution.js";

export function unknownEcu(ecuId: string): UnknownEcuError {
  return new UnknownEcuError(ecuId);
}

/** Parse an address-form ECU reference like "0x7e8"; undefined otherwise. */
export function parseEcuAddress(value: string): number | undefined {
  if (!value.startsWith("0x")) return undefined;
  const parsed = Number.parseInt(value.slice(2), 16);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/** Lookup and addressing for ECUs of the current session. */
export class EcuService {
  constructor(
    private readonly engine: DiagnosticEngine,
    private readonly events: EventBus,
    private readonly log: Logger,
  ) {}

  list(): EcuSummary[] {
    const session = this.engine.vehicleSession;
    if (!session) return [];
    return session.data.ecus.map(toEcuSummary);
  }

  get(ecuId: string): EcuSummary | undefined {
    const record = this.resolveRecord(ecuId);
    return record ? toEcuSummary(record) : undefined;
  }

  capabilities(ecuId: string): DiagnosticCapability[] {
    const record = this.resolveRecord(ecuId);
    return record ? capabilitiesFromServices(record.supportedServices) : [];
  }

  /**
   * Re-read the identification DIDs of every attached ECU (AGENTS 12) and
   * merge the answers into the session record. One unresponsive ECU must not
   * hide the others, so failures are logged per ECU and the run continues
   * (AGENTS 34.25 — logged, not swallowed).
   */
  async identifyAll(): Promise<EcuSummary[]> {
    for (const handle of this.engine.ecuHandles) {
      try {
        await handle.session.readIdentification();
      } catch (error) {
        const message = messageOf(error);
        // The failure stays visible on the ECU record instead of disappearing
        // into the log (AGENTS 34.25).
        handle.session.record.lastError = message;
        this.log.warn("identification failed", {
          ecu: handle.session.record.name,
          error: message,
        });
      }
    }
    return this.list();
  }

  /** Read one DID raw — decoding is definition knowledge, not engine logic. */
  async readDid(ecuId: string, did: number): Promise<RawDidReading> {
    const session = this.engine.vehicleSession;
    if (!session) throw new Error("no session — call vehicle.connect() first");
    const handle = this.resolveHandle(ecuId);
    if (!handle) throw unknownEcu(ecuId);
    const payload = await handle.session.readRaw(did);
    if (!payload)
      throw new Error(
        `ECU "${handle.session.record.name}" returned no data for DID 0x${did.toString(16).toUpperCase()}`,
      );
    const reading: RawDidReading = {
      ecuId: handle.session.record.id,
      did,
      hex: toHex(payload),
      byteLength: payload.byteLength,
    };
    this.events.publish("did-read", {
      sessionId: session.id,
      ecuId: reading.ecuId,
      did,
      byteLength: payload.byteLength,
    });
    this.log.debug("DID read", {
      ecu: handle.session.record.name,
      did: `0x${did.toString(16)}`,
      bytes: payload.byteLength,
    });
    return reading;
  }

  /** Session record by id, definition id or "0x…" address. */
  resolveRecord(ecuId: string): EcuSession | undefined {
    const session = this.engine.vehicleSession;
    if (!session) return undefined;
    const direct = session.findEcu(ecuId);
    if (direct) return direct;
    const address = parseEcuAddress(ecuId);
    if (address !== undefined) {
      return session.data.ecus.find((ecu) => ecu.rxId === address || ecu.txId === address);
    }
    return undefined;
  }

  /** Live ECU handle by the same reference forms as {@link resolveRecord}. */
  resolveHandle(ecuId: string): EcuHandle | undefined {
    const record = this.resolveRecord(ecuId);
    if (record) return this.engine.handleFor(record.rxId);
    const address = parseEcuAddress(ecuId);
    if (address !== undefined)
      return this.engine.handleFor(address) ?? this.engine.handleForTxId(address);
    return undefined;
  }
}

/** Vehicle-level operations: connect, identity, disconnect. */
export class VehicleService {
  constructor(
    private readonly engine: DiagnosticEngine,
    private readonly ecus: EcuService,
    private readonly events: EventBus,
    private readonly log: Logger,
    private readonly definitions: DefinitionProvider,
  ) {}

  async connect(options?: ConnectVehicleOptions): Promise<ConnectVehicleResult> {
    const { session } = await this.engine.connect(
      options === undefined
        ? {}
        : {
            ...(options.windowMs !== undefined ? { windowMs: options.windowMs } : {}),
            ...(options.probeDelayMs !== undefined ? { probeDelayMs: options.probeDelayMs } : {}),
          },
    );
    const summaries = this.ecus.list();
    for (const ecu of summaries) {
      this.events.publish("ecu-discovered", {
        sessionId: session.id,
        ecuId: ecu.ecuId,
        name: ecu.name,
        txId: ecu.txId,
        rxId: ecu.rxId,
        reachable: ecu.reachable,
      });
      if (ecu.capabilities.length > 0) {
        this.events.publish("ecu-capabilities-updated", {
          ecuId: ecu.ecuId,
          capabilities: ecu.capabilities,
        });
      }
    }
    const vehicle = this.identity();
    this.events.publish("vehicle-connected", {
      sessionId: session.id,
      ...(vehicle?.vin !== undefined ? { vin: vehicle.vin } : {}),
      ecuCount: summaries.length,
    });
    // Connect already read the VIN and every identification value, so the car can
    // be resolved without another bus access — and the first fault scan then
    // carries the knowledge of this variant instead of the manufacturer-wide
    // wording (AGENTS 11 → 20). An explicit `resolve(hints)` rebinds with the
    // operator's claims.
    this.engine.setVehicleContext(dtcVehicleContextOf(this.resolve().best));
    return {
      session: toSessionSummary(session),
      ...(vehicle !== undefined ? { vehicle } : {}),
      ecus: summaries,
    };
  }

  identity(): VehicleSummary | undefined {
    const data = this.engine.vehicleSession?.data;
    return data === undefined ? undefined : toVehicleSummary(data.vehicle, data.determination);
  }

  /**
   * Which vehicle is connected (AGENTS 11).
   *
   * Collects everything the session already knows — the VIN, the identification
   * values every ECU reported and the addresses that answered discovery — and
   * hands it to the definitions layer, which ranks candidates and states its
   * evidence. Nothing is written, nothing is asserted: the result is a list of
   * hypotheses, and an empty one is a legitimate answer.
   */
  resolve(hints?: ResolveVehicleHints): VehicleResolutionRef {
    const data = this.engine.vehicleSession?.data;
    // Declared evidence is what the bus answered and what the operator claims —
    // never what a previous resolution concluded. Handing the determination back
    // in here would let a candidate confirm itself through `declared-brand` and
    // `declared-model`, and the score would rise without one new fact on the bus.
    const identity = data === undefined ? undefined : toVehicleSummary(data.vehicle);
    const query = resolveVehicleQuery({
      ...(identity !== undefined ? { identity } : {}),
      ecus: this.ecus.list(),
      ...(hints !== undefined ? { hints } : {}),
    });
    const resolution = this.definitions.resolveVehicle(query);
    // From here on the DTC system enriches with what this variant documents
    // (AGENTS 20/23); an unresolved car keeps the manufacturer-wide wording.
    this.engine.setVehicleContext(dtcVehicleContextOf(resolution.best));
    // The same answer is written into the session, so the stored file, the report
    // and the analysis all know which car this was and how far the evidence
    // reached (AGENTS 11.1, ADR 0026). An unresolved attempt is recorded too — a
    // session that never asked is different from one that asked and found nothing.
    this.engine.vehicleSession?.recordDetermination(vehicleDeterminationOf(resolution));
    this.log.info("vehicle resolved", {
      candidates: resolution.candidates.length,
      best: resolution.best?.vehicleId,
      score: resolution.best?.score,
      unresolved: resolution.unresolved,
    });
    return resolution;
  }

  async disconnect(): Promise<void> {
    const session = this.engine.vehicleSession;
    if (!session) return;
    await this.engine.disconnect();
    this.events.publish("vehicle-disconnected", {
      sessionId: session.id,
      durationMs: session.durationMs(),
    });
    this.log.info("runtime disconnected", { session: session.id });
  }
}

/** Measurements: snapshots, live polling, recorded samples. */
export class MeasurementService {
  private liveEngine: LiveDataEngine | null = null;
  /**
   * Who listens to poll rounds, and how a listener follows start/stop cycles —
   * its own class, see `sample-stream.ts` for the two rules it enforces.
   */
  private readonly sampleStream = new SampleStream();

  constructor(
    private readonly engine: DiagnosticEngine,
    private readonly events: EventBus,
    private readonly log: Logger,
  ) {}

  /** True while the engine polls ECUs for live data. */
  get live(): boolean {
    return this.liveEngine?.isRunning ?? false;
  }

  /** Read every (or the selected) defined signal once and record the samples. */
  async snapshot(signalIds?: readonly string[]): Promise<MeasurementReading[]> {
    const session = this.engine.vehicleSession;
    if (!session) throw new Error("no session — call vehicle.connect() first");
    // The filter is pushed into the engine so a two-signal snapshot only requests
    // those two signals instead of every DID of every ECU (AGENTS 12).
    const decoded = await this.engine.snapshotSignals(signalIds);
    const selected = signalIds
      ? decoded.filter((signal) => signalIds.includes(signal.signalId))
      : decoded;
    const readings: MeasurementReading[] = [];
    for (const signal of selected) {
      const samples = this.engine.recorder.samplesFor(signal.signalId);
      const latest = samples.at(-1);
      readings.push(
        latest
          ? toMeasurementReading(latest, signal.name)
          : decodedToReading(signal, session.data.startedAt),
      );
    }
    const recordedIds = Array.from(new Set(readings.map((reading) => reading.signalId)));
    this.events.publish("measurements-recorded", {
      sessionId: session.id,
      sampleCount: readings.length,
      signalIds: recordedIds,
    });
    return readings;
  }

  /**
   * Start parallel live polling across all ECUs (AGENTS 15).
   *
   * The engine's `startLiveData` already runs the poll loop internally — the
   * service only keeps the reference for the live flag and the sample stream
   * (AGENTS 34.25: a second `run()` would throw and was a double-start bug).
   */
  async start(options: { signalIds?: readonly string[]; intervalMs?: number } = {}): Promise<void> {
    if (!this.engine.vehicleSession) throw new Error("no session — call vehicle.connect() first");
    this.liveEngine = await this.engine.startLiveData(options);
    this.liveEngine.onError((error) => this.reportLiveFailure(error));
    this.sampleStream.bind(this.liveEngine);
    this.log.info("live measurements started", {
      intervalMs: options.intervalMs ?? 100,
      listeners: this.sampleStream.size,
    });
  }

  stop(): void {
    this.engine.stopLiveData();
    this.liveEngine = null;
    // The engine is gone; the subscriptions stay registered and reattach on
    // the next start.
    this.sampleStream.unbind();
  }

  /** Recorded samples, optionally restricted to one signal. */
  samples(signalId?: string): MeasurementReading[] {
    const recorder = this.engine.recorder;
    const ids = signalId !== undefined ? [signalId] : recorder.signalIds();
    return ids.flatMap((id) =>
      recorder.samplesFor(id).map((sample) => toMeasurementReading(sample)),
    );
  }

  /** Event markers on the shared time axis (AGENTS 16). */
  markers(): MarkerInfo[] {
    return this.engine.recorder.markers.map(toMarkerInfo);
  }

  /** Record one event marker into the running measurement (AGENTS 16). */
  addMarker(label: string, kind: MarkerInfo["kind"] = "user", detail?: string): MarkerInfo {
    // The recorder stores the kind verbatim; "anomaly" is part of the domain
    // vocabulary even though the core marker type predates it.
    return toMarkerInfo(this.engine.recorder.addMarker(label, kind as Marker["kind"], detail));
  }

  /** Window statistics for every recorded signal (AGENTS 16, §16). */
  statistics(): SignalStatisticsInfo[] {
    return this.engine.recorder.statisticsForAll().map(toSignalStatisticsInfo);
  }

  /** Signals that left their declared range (AGENTS 14). */
  anomalies(): AnomalyInfo[] {
    return this.engine.recorder.anomalies().map(toAnomalyInfo);
  }

  /**
   * The signal catalogue of the attached ECUs — deduplicated across ECUs, in
   * definition order (read model for pickers and the signal list).
   */
  signals(): SignalInfo[] {
    const seen = new Set<string>();
    const list: SignalInfo[] = [];
    for (const signals of this.engine.buildPlan().values()) {
      for (const signal of signals) {
        if (seen.has(signal.id)) continue;
        seen.add(signal.id);
        list.push(toSignalInfo(signal));
      }
    }
    return list;
  }

  /**
   * Export seam for raw persistence formats (CSV/JSON, AGENTS 17/18).
   *
   * Deliberately returns the core recording types: file formats serialize the
   * stored bytes verbatim, and re-encoding them through domain readings would
   * lose raw fidelity. Everything above this seam speaks domain contracts.
   */
  rawExport(): { startedAt: number; samples: MeasurementSample[]; markers: Marker[] } {
    return this.engine.recorder.export();
  }

  /**
   * The complete recording: samples plus markers and the recording start
   * (AGENTS 16/17). `limit` trims the sample list to the newest N entries —
   * the recording itself is never shortened by reading it.
   */
  history(limit?: number): RecordingHistory {
    const { startedAt, samples, markers } = this.engine.recorder.export();
    const capped = limit === undefined ? samples : samples.slice(-limit);
    return {
      startedAt,
      samples: capped.map((sample) =>
        toMeasurementReading(sample, this.engine.findSignal(sample.signal)?.name),
      ),
      markers: markers.map(toMarkerInfo),
    };
  }

  status(): MeasurementStatus {
    return { live: this.live };
  }

  /**
   * Subscribe to every recorded poll round — the stream source for push
   * consumers (SSE, WebSocket). The readings are the samples the recorder
   * already stored for the round: exactly one per signal per round, no second
   * recording (AGENTS 16/34.25).
   *
   * May be called before the measurement starts; the listener then receives
   * the rounds of the next (and every later) live run until unsubscribed.
   */
  onSample(listener: SampleListener): () => void {
    return this.sampleStream.subscribe(listener);
  }

  /** A crashed poll loop must stay visible — as an event, not only a log line. */
  private reportLiveFailure(error: Error): void {
    const sessionId = this.engine.vehicleSession?.id;
    this.events.publish("diagnostic-error", {
      ...(sessionId !== undefined ? { sessionId } : {}),
      phase: "measurement.live",
      message: error.message,
    });
  }
}

/** Session access and persistence via the injected store port. */
export class SessionService {
  constructor(
    private readonly engine: DiagnosticEngine,
    private readonly store?: SessionStore<VehicleSessionData>,
  ) {}

  current(): SessionSummary | undefined {
    const session = this.engine.vehicleSession;
    return session ? toSessionSummary(session) : undefined;
  }

  /** The full session data — for exports and the storage layer. */
  data(): VehicleSessionData | undefined {
    return this.engine.vehicleSession?.data;
  }

  /** Persist the current session through the configured store port. */
  async save(): Promise<string> {
    const data = this.data();
    if (!data) throw new Error("no session — call vehicle.connect() first");
    if (!this.store) throw new Error("no session store configured on this runtime");
    await this.store.save(data);
    return data.id;
  }
}

/** Safety access — evaluation and the audit trail stay in one place. */
export class SafetyService {
  constructor(private readonly engine: DiagnosticEngine) {}

  get manager(): SafetyManager {
    return this.engine.safety;
  }

  get audit(): ReadonlyArray<{ timestamp: string; action: string; ecuId: string; detail: string }> {
    return this.engine.safety.audit;
  }

  /** Pre-check any write context without issuing a permit (UI pre-check). */
  evaluate(context: WriteRequestContext, state: VehicleState) {
    return this.engine.safety.evaluate(context, state);
  }
}
