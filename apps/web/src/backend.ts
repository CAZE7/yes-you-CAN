/**
 * Demo backend (AGENTS 19: simulator instead of a real car).
 *
 * Owns the diagnostic engine and the virtual vehicle, and publishes already
 * decoded values to the UI. The front end never receives a CAN frame it would
 * have to interpret — it gets decoded signals plus raw trace entries that are
 * explicitly labelled raw (AGENTS 5, 34.3, 18).
 */

import { createLogger, type Logger } from '@vdp/shared';
import {
  DiagnosticEngine,
  SessionLogger,
  type DecodedSignal,
  type MeasurementSample,
  type RawTraceEntry,
  type SignalStatistics,
  type VehicleSessionData,
} from '@vdp/core';
import type { DtcRecord } from '@vdp/protocols-uds';
import { genericPackage, type DefinitionPackage } from '@vdp/definitions';
import { DEFAULT_VIN, VirtualVehicle } from '@vdp/simulators';
import { AnalysisService, HeuristicAnalysisProvider, type AnalysisInput, type AnalysisResult } from '@vdp/ai';
import { FileSystemSessionRepository, type SessionRepository, type StoredSessionSummary } from '@vdp/storage';

export interface EcuView {
  id: string;
  name: string;
  txId: string;
  rxId: string;
  extended: boolean;
  reachable: boolean;
  identification: Array<{ label: string; value: string }>;
  services: string[];
  sessionType: number;
  p2Ms: number;
  dtcCount: number;
  lastError?: string;
}

export interface DtcView {
  code: string;
  raw: string;
  description: string;
  severity: string;
  ecu: string;
  status: string;
  confirmed: boolean;
  pending: boolean;
  testFailed: boolean;
}

export interface SampleView {
  signal: string;
  name: string;
  value: string;
  rawHex: string;
  unit?: string;
  outOfRange: boolean;
  t: number;
  timestamp: string;
}

export interface TraceView {
  t: number;
  timestamp: string;
  canId: string;
  direction: 'tx' | 'rx';
  dlc: number;
  data: string;
  channel: string;
  extended: boolean;
}

export interface AppState {
  connected: boolean;
  demo: boolean;
  sessionId: string;
  vin?: string;
  vehicle: string;
  mileageKm?: number;
  adapter: { id: string; name: string; kind: string; channels: string[] };
  transport: { kind: string; channel: string; mtu: number };
  ecus: EcuView[];
  dtcs: DtcView[];
  samples: SampleView[];
  statistics: SignalStatistics[];
  trace: TraceView[];
  live: boolean;
  signals: Array<{ id: string; name: string; unit?: string; critical: boolean }>;
  anomalies: Array<{ signal: string; reason: string; value?: number }>;
  actions: Array<{ timestamp: string; kind: string; ecuId: string; description: string; result: string }>;
}

export interface BackendEvent {
  type: 'sample' | 'trace' | 'dtc' | 'ecu' | 'log' | 'analysis' | 'error';
  payload: unknown;
}

export interface BackendOptions {
  logger?: Logger;
  vin?: string;
  definitions?: readonly DefinitionPackage[];
  liveIntervalMs?: number;
  /** Seed the simulator with fault codes so the DTC view is not empty. */
  seedDtcs?: boolean;
  /** Where sessions are persisted (AGENTS 10, 29). Omitted disables persistence. */
  sessionDir?: string;
  repository?: SessionRepository;
}

const MAX_TRACE = 800;

export class DemoBackend {
  readonly log: Logger;
  readonly analysisService: AnalysisService;
  private vehicle?: VirtualVehicle;
  private engine?: DiagnosticEngine;
  private readonly sessionLogger = new SessionLogger();
  private readonly listeners = new Set<(event: BackendEvent) => void>();
  private unsubscribeBus?: () => void;
  private ecus: EcuView[] = [];
  private dtcs: DtcView[] = [];
  private live = false;
  private connected = false;
  private readonly vin: string;
  private readonly definitions: readonly DefinitionPackage[];
  private readonly repository?: SessionRepository;

  constructor(private readonly options: BackendOptions = {}) {
    this.log = (options.logger ?? createLogger('web', { level: 'INFO' })).child('backend');
    this.vin = options.vin ?? DEFAULT_VIN;
    this.definitions = options.definitions ?? [genericPackage];
    this.analysisService = new AnalysisService({ providers: [new HeuristicAnalysisProvider()], logger: this.log });
    // Persistence is opt-in so tests and ephemeral runs stay side-effect free.
    if (options.repository) this.repository = options.repository;
    else if (options.sessionDir) this.repository = new FileSystemSessionRepository({ rootDir: options.sessionDir, logger: this.log });
  }

  /** Persist the current session, its samples and its raw trace (AGENTS 10, 29). */
  async saveSession(): Promise<{ id: string; repository: boolean }> {
    const engine = this.requireEngine();
    const data = engine.vehicleSession?.data;
    if (!data) throw new Error('no session to save — call start() first');
    if (!this.repository) return { id: data.id, repository: false };

    await this.repository.save(data);
    const { samples } = engine.recorder.export();
    await this.repository.appendSamples(data.id, samples);
    const snapshot = this.sessionLogger.snapshot();
    await this.repository.appendLines(
      data.id,
      'trace',
      snapshot.trace.map((entry) => JSON.stringify({ ...entry, payload: entry.payloadHex })),
    );
    await this.repository.appendLines(data.id, 'log', snapshot.log.map((entry) => JSON.stringify(entry)));
    this.log.info('session saved', { id: data.id, samples: samples.length, trace: snapshot.trace.length });
    return { id: data.id, repository: true };
  }

  /** Stored sessions, newest first. */
  async listSessions(): Promise<StoredSessionSummary[]> {
    if (!this.repository) return [];
    return this.repository.list();
  }

  /** ZIP session package for handover to another workstation (AGENTS 17). */
  async sessionPackage(id: string): Promise<Uint8Array> {
    if (!this.repository) throw new Error('session persistence is not enabled');
    return this.repository.exportPackage(id);
  }

  subscribe(listener: (event: BackendEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(type: BackendEvent['type'], payload: unknown): void {
    for (const listener of this.listeners) {
      try {
        listener({ type, payload });
      } catch (error) {
        this.log.warn('event listener failed', { error: messageOf(error) });
      }
    }
  }

  /** Start the virtual vehicle and run ECU discovery. */
  async start(): Promise<AppState> {
    if (this.connected) return this.state();
    this.log.info('starting demo backend', { vin: this.vin });
    this.vehicle = new VirtualVehicle({
      vin: this.vin,
      // The simulator takes a single package; the first one is the baseline.
      definitions: this.definitions[0] ?? genericPackage,
      logger: this.log,
      dynamic: true,
      // Echo our own frames back so the raw trace records requests *and*
      // responses; a trace with only rx frames cannot be replayed or paired.
      networkOptions: { echoToSender: true },
      ...(this.options.seedDtcs === false
        ? {}
        : {
            dtcs: {
              engine: [
                { code: 'P0420', status: 0x2f },
                { code: 'P0300', status: 0x2f },
              ],
              abs: [{ code: 'C1234', status: 0x08 }],
            },
          }),
    });
    await this.vehicle.start();

    // Raw trace: every frame on the tester bus is recorded verbatim (AGENTS 18).
    this.unsubscribeBus = this.vehicle.testerBus.subscribe((frame) => {
      const entry = this.sessionLogger.recordFrame(frame);
      this.emit('trace', toTraceView(entry));
    });

    this.engine = new DiagnosticEngine({ bus: this.vehicle.testerBus, definitions: this.definitions, logger: this.log });
    const result = await this.engine.connect();
    this.connected = true;
    this.ecus = result.ecus.map((discovered) => this.toEcuView(discovered.rxId));
    this.sessionLogger.log('backend', 'connected', { ecus: result.ecus.length });
    this.log.info('backend connected', { ecus: result.ecus.length });
    await this.identify();
    return this.state();
  }

  /** Read identification DIDs from every discovered ECU (read-only, AGENTS 34.11). */
  async identify(): Promise<EcuView[]> {
    const engine = this.requireEngine();
    for (const view of this.ecus) {
      const handle = engine.handleFor(Number.parseInt(view.rxId, 16));
      if (!handle) continue;
      try {
        await handle.session.readIdentification();
        const record = this.session()?.ecus.find((ecu) => ecu.rxId === handle.discovered.rxId);
        if (record) {
          view.id = record.id;
          view.name = record.name;
          view.identification = record.identification.map((entry) => ({ label: entry.label, value: entry.value }));
          view.services = record.supportedServices.map((sid) => `0x${sid.toString(16).toUpperCase()}`);
          view.sessionType = record.sessionType;
          view.p2Ms = record.timing.p2Ms;
          view.reachable = record.reachable;
        }
        this.emit('ecu', view);
      } catch (error) {
        view.lastError = messageOf(error);
        this.log.warn('identification failed', { ecu: view.rxId, error: messageOf(error) });
      }
    }
    return this.ecus;
  }

  /** Read fault codes from all ECUs. */
  async scanDtcs(): Promise<DtcView[]> {
    const engine = this.requireEngine();
    const scanned = await engine.scanDtcs();
    this.dtcs = [];
    for (const entry of scanned) {
      for (const dtc of entry.dtcs) {
        const view = toDtcView(dtc, entry.ecu.name);
        this.dtcs.push(view);
        this.emit('dtc', view);
      }
    }
    this.sessionLogger.log('dtc', 'scan complete', { count: this.dtcs.length });
    this.log.info('DTC scan complete', { count: this.dtcs.length });
    return this.dtcs;
  }

  /** Start polling the selected signals. */
  async startLive(signalIds?: readonly string[]): Promise<void> {
    const engine = this.requireEngine();
    if (this.live) return;
    this.live = true;
    const readers = this.liveReaders(engine);
    const live = await engine.startLiveData({ signalIds, intervalMs: this.options.liveIntervalMs ?? 250 });
    live.onRound((round) => {
      for (const decoded of round.signals) {
        const sample = engine.recorder.record(decoded);
        const view = toSampleView(sample, decoded.name);
        this.emit('sample', view);
      }
      for (const error of round.errors) {
        this.log.warn('live poll error', { ecu: round.ecuId, did: error.did, message: error.message });
      }
    });
    void live.run(readers, engine.buildPlan(signalIds)).catch((error) => {
      this.log.error('live data run failed', { error: messageOf(error) });
      this.emit('error', { message: messageOf(error) });
    });
    this.log.info('live data started', { signals: signalIds?.length ?? 'all', intervalMs: this.options.liveIntervalMs ?? 250 });
  }

  stopLive(): void {
    this.engine?.stopLiveData();
    this.live = false;
    this.log.info('live data stopped');
  }

  private liveReaders(engine: DiagnosticEngine): Array<{ ecuId: string; readRaw(did: number): Promise<Uint8Array | null> }> {
    const readers: Array<{ ecuId: string; readRaw(did: number): Promise<Uint8Array | null> }> = [];
    for (const view of this.ecus) {
      const handle = engine.handleFor(Number.parseInt(view.rxId, 16));
      if (handle) readers.push(handle.reader);
    }
    return readers;
  }

  /** Record a user marker into the measurement recording. */
  addMarker(label: string): void {
    this.engine?.recorder.addMarker(label);
    this.sessionLogger.log('marker', label);
  }

  async analyze(): Promise<AnalysisResult> {
    const engine = this.requireEngine();
    const input: AnalysisInput = {
      mileageKm: this.session()?.mileageKm,
      signals: engine.recorder.statisticsForAll().map((stat) => ({
        signal: stat.signal,
        name: stat.name,
        ...(stat.unit ? { unit: stat.unit } : {}),
        samples: stat.samples,
        min: stat.min ?? 0,
        max: stat.max ?? 0,
        average: stat.average ?? 0,
        delta: stat.delta ?? 0,
        outOfRangeCount: stat.outOfRangeCount,
      })),
      dtcs: this.dtcs.map((dtc) => ({ code: dtc.code, description: dtc.description, severity: dtc.severity, ecu: dtc.ecu })),
      anomalies: engine.recorder.anomalies(),
      notes: (this.session()?.notes ?? []).map((note) => note.text),
    };
    const result = await this.analysisService.analyze({ input });
    this.emit('analysis', result);
    return result;
  }

  /** Export the recording as CSV. */
  exportCsv(): string {
    const engine = this.requireEngine();
    const { samples, markers } = engine.recorder.export();
    return SessionLogger.toCsv(samples, markers);
  }

  /** Export the raw trace as CSV — raw stays raw (AGENTS 18). */
  exportTraceCsv(): string {
    return SessionLogger.traceToCsv(this.sessionLogger.snapshot().trace);
  }

  exportJson(): string {
    const engine = this.requireEngine();
    const { samples, markers } = engine.recorder.export();
    const snapshot = this.sessionLogger.snapshot();
    return SessionLogger.toJson({
      meta: {
        sessionId: this.session()?.id ?? 'unknown',
        vin: this.session()?.vehicle?.vin,
        demo: true,
      },
      samples,
      markers,
      dtcs: this.allDtcRecords(),
      trace: snapshot.trace,
      log: snapshot.log,
    });
  }

  private allDtcRecords(): DtcRecord[] {
    return (this.session()?.ecus ?? []).flatMap((ecu) => ecu.dtcs ?? []);
  }

  state(): AppState {
    const engine = this.engine;
    const session = this.session();
    const identity = session?.vehicle;
    const trace = this.sessionLogger.snapshot().trace.slice(-200);
    return {
      connected: this.connected,
      demo: true,
      sessionId: session?.id ?? 'not-started',
      ...(identity?.vin ? { vin: identity.vin } : {}),
      vehicle: describe(identity),
      ...(session?.mileageKm !== undefined ? { mileageKm: session.mileageKm } : {}),
      adapter: session
        ? { id: session.adapter.id, name: session.adapter.name, kind: session.adapter.kind, channels: session.adapter.channels }
        : { id: 'none', name: 'not connected', kind: 'none', channels: [] },
      transport: session ? { kind: session.transport.kind, channel: session.transport.channel, mtu: session.transport.mtu } : { kind: 'none', channel: '-', mtu: 0 },
      ecus: this.ecus,
      dtcs: this.dtcs,
      samples: this.recentSamples(engine),
      statistics: engine ? engine.recorder.statisticsForAll() : [],
      trace: trace.map(toTraceView),
      live: this.live,
      signals: this.signalList(engine),
      anomalies: engine ? engine.recorder.anomalies() : [],
      actions: (session?.actions ?? []).map((action) => ({
        timestamp: action.timestamp,
        kind: action.kind,
        ecuId: action.ecuId,
        description: action.description,
        result: action.result,
      })),
    };
  }

  private recentSamples(engine: DiagnosticEngine | undefined): SampleView[] {
    if (!engine) return [];
    const { samples } = engine.recorder.export();
    // A recorded sample carries only the signal id; the human readable name comes
    // from the definition so the snapshot and the live stream agree.
    return samples.slice(-200).map((sample) => toSampleView(sample, engine.findSignal(sample.signal)?.name ?? sample.signal));
  }

  private signalList(engine: DiagnosticEngine | undefined): AppState['signals'] {
    if (!engine) return [];
    const seen = new Set<string>();
    const list: AppState['signals'] = [];
    for (const signals of engine.buildPlan().values()) {
      for (const signal of signals) {
        if (seen.has(signal.id)) continue;
        seen.add(signal.id);
        list.push({ id: signal.id, name: signal.name, ...(signal.unit ? { unit: signal.unit } : {}), critical: signal.critical ?? false });
      }
    }
    return list;
  }

  /**
   * The underlying session record. Exposed because the report builder consumes a
   * VehicleSessionData (AGENTS 21) — the UI itself never needs it.
   */
  sessionData(): VehicleSessionData {
    const session = this.engine?.vehicleSession?.data;
    if (!session) throw new Error('backend not started — call start() first');
    return session;
  }

  private session() {
    return this.engine?.vehicleSession?.data;
  }

  private toEcuView(rxId: number): EcuView {
    const engine = this.engine;
    const record = engine?.vehicleSession?.data.ecus.find((ecu) => ecu.rxId === rxId);
    const discovered = engine?.handleFor(rxId)?.discovered;
    return {
      id: record?.id ?? `ecu_0x${rxId.toString(16)}`,
      name: record?.name ?? `ECU 0x${rxId.toString(16)}`,
      txId: `0x${(discovered?.txId ?? 0).toString(16).toUpperCase()}`,
      rxId: `0x${rxId.toString(16).toUpperCase()}`,
      extended: discovered?.extended ?? false,
      reachable: record?.reachable ?? false,
      identification: (record?.identification ?? []).map((entry) => ({ label: entry.label, value: entry.value })),
      services: (record?.supportedServices ?? []).map((sid) => `0x${sid.toString(16).toUpperCase()}`),
      sessionType: record?.sessionType ?? 0,
      p2Ms: record?.timing.p2Ms ?? 0,
      dtcCount: record?.dtcs?.length ?? 0,
      ...(record?.lastError ? { lastError: record.lastError } : {}),
    };
  }

  private requireEngine(): DiagnosticEngine {
    if (!this.engine) throw new Error('backend not started — call start() first');
    return this.engine;
  }

  async stop(): Promise<void> {
    this.stopLive();
    this.unsubscribeBus?.();
    await this.engine?.disconnect();
    await this.vehicle?.stop();
    this.connected = false;
    this.log.info('backend stopped');
  }
}

function toSampleView(sample: MeasurementSample, name: string): SampleView {
  return {
    signal: sample.signal,
    name,
    value: formatValue(sample.value),
    rawHex: sample.rawHex,
    ...(sample.unit ? { unit: sample.unit } : {}),
    outOfRange: sample.outOfRange,
    t: sample.t,
    timestamp: sample.timestamp,
  };
}

function toTraceView(entry: RawTraceEntry): TraceView {
  return {
    t: entry.t,
    timestamp: entry.timestamp,
    canId: entry.canIdHex,
    direction: entry.direction,
    dlc: entry.dlc,
    data: entry.payloadHex,
    channel: entry.channel,
    extended: entry.extended,
  };
}

function toDtcView(dtc: DtcRecord, ecuName: string): DtcView {
  return {
    code: dtc.code,
    raw: dtc.raw,
    description: dtc.failureType,
    severity: dtc.severity,
    ecu: ecuName,
    status: `0x${dtc.status.toString(16).toUpperCase().padStart(2, '0')}`,
    confirmed: dtc.statusBits.confirmedDtc,
    pending: dtc.statusBits.pendingDtc,
    testFailed: dtc.statusBits.testFailed,
  };
}

function formatValue(value: number | string | boolean): string {
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(2);
  return String(value);
}

function describe(identity: { brand?: string; model?: string; modelYear?: number } | undefined): string {
  if (!identity) return 'unknown vehicle';
  const parts = [identity.brand, identity.model, identity.modelYear].filter((part): part is string | number => Boolean(part));
  return parts.length > 0 ? parts.join(' ') : 'unknown vehicle';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type { DecodedSignal };
