/**
 * Diagnostic Engine (AGENTS 2, 9, 10, 12, 36).
 *
 * The single place that ties a transport, a definition package, the UDS layer,
 * the measurement engine and the session together. It knows nothing about UI and
 * nothing about which transport sits below it — that is what keeps DoIP a
 * drop-in later (AGENTS 5).
 */

import { createId, createLogger, toHex, type Logger } from '@vdp/shared';
import type { AdapterInfo, CanBus, TransportInfo } from '@vdp/transport-can';
import { IsoTpConnection, type IsoTpOptions } from '@vdp/transport-iso-tp';
import { UdsClient, type DtcRecord } from '@vdp/protocols-uds';
import { indexPackage, type DefinitionPackage, type SignalDefinition } from '@vdp/definitions';
import { EcuDiagnosticSession } from './ecu-session.js';
import { EcuDiscovery, deriveTxId, type DiscoveredEcu } from './discovery.js';
import { createSession, VehicleSession, type EcuSession } from '../session/session.js';
import { createIdentityFromVin, describeVehicle, type VehicleIdentity } from '../vehicle/identity.js';
import { MeasurementRecorder } from '../measurements/recorder.js';
import { LiveDataEngine, type EcuReader, type LiveDataStats } from '../measurements/live.js';
import { OemProtocolRegistry, type OemDtcInterpretation, type OemProtocol } from '@vdp/protocols-oem';
import { SignalDecoder, type DecodedSignal } from '../measurements/decoder.js';
import { DtcScanner, type EnrichedDtc } from '../dtc/scanner.js';
import { DtcClearService, type ClearableEcu, type ClearDtcOptions, type ClearDtcResult } from '../dtc/clear.js';
import type { FreezeFrame } from '../dtc/freeze-frame.js';
import { SafetyManager, type VehicleState } from '../safety/safety-manager.js';

export interface DiagnosticEngineOptions {
  bus: CanBus;
  definitions?: readonly DefinitionPackage[];
  logger?: Logger;
  /**
   * Safety manager for write operations. A private instance is created when none
   * is passed in, so every engine has one and no write path can bypass it
   * (AGENTS 26).
   */
  safety?: SafetyManager;
  /** Extra ISO-TP settings (padding, addressing, timing) applied to every ECU. */
  isoTpDefaults?: Partial<IsoTpOptions>;
  /** Poll interval used by startLiveData. */
  pollIntervalMs?: number;
  clock?: () => number;
  /**
   * Manufacturer specific hooks (AGENTS 3, 34.6). They are consulted only where
   * definitions are silent, so OEM knowledge never overrides documented data.
   */
  oemProtocols?: readonly OemProtocol[];
}

export interface ConnectResult {
  session: VehicleSession;
  ecus: DiscoveredEcu[];
}

export interface EcuHandle {
  session: EcuDiagnosticSession;
  reader: EcuReader;
  discovered: DiscoveredEcu;
}

export class DiagnosticEngine {
  readonly recorder: MeasurementRecorder;
  readonly decoder: SignalDecoder;
  readonly oemProtocols: OemProtocolRegistry;
  readonly safety: SafetyManager;

  private readonly log: Logger;
  private readonly dtcScanner: DtcScanner;
  private readonly dtcClear: DtcClearService;
  /** ECU handles by response identifier — the key every UDS operation uses. */
  private readonly handles = new Map<number, EcuHandle>();
  /**
   * Secondary index by request identifier.
   *
   * Traffic in the raw trace and on a functional bus is keyed by the id the
   * *tester* addressed, so `handleForTxId` is on the hot path of the replay and
   * trace tooling. Walking `handles.values()` there is a linear scan per frame;
   * one extra map keeps it O(1) and stays in step with `handles` because both are
   * only written in `attachEcu`/`disconnect`.
   */
  private readonly handlesByTxId = new Map<number, EcuHandle>();
  private session: VehicleSession | null = null;
  private liveEngine: LiveDataEngine | null = null;

  constructor(private readonly options: DiagnosticEngineOptions) {
    this.log = (options.logger ?? createLogger('uds', { level: 'INFO' })).child('uds');
    this.recorder = new MeasurementRecorder(options.clock);
    this.decoder = new SignalDecoder({ logger: this.log });
    this.oemProtocols = new OemProtocolRegistry(options.oemProtocols ?? []);
    this.safety = options.safety ?? new SafetyManager({ logger: this.log });
    this.dtcScanner = new DtcScanner({ definitions: options.definitions ?? [] });
    this.dtcClear = new DtcClearService({ safety: this.safety, scanner: this.dtcScanner, logger: this.log });
  }

  get vehicleSession(): VehicleSession | null {
    return this.session;
  }

  get ecuHandles(): readonly EcuHandle[] {
    return Array.from(this.handles.values());
  }

  get definitions(): readonly DefinitionPackage[] {
    return this.options.definitions ?? [];
  }

  /** Definition package used for the current session (recorded for provenance). */
  get activePackage(): DefinitionPackage | undefined {
    return this.definitions[0];
  }

  /**
   * Open the session: discover ECUs, attach a UDS client to each responder and
   * read identification. Read-only only (AGENTS 11/34.11).
   */
  async connect(discoveryOptions: { windowMs?: number; candidates?: Array<{ txId: number; rxId: number; extended?: boolean }> } = {}): Promise<ConnectResult> {
    if (!this.options.bus.isOpen()) await this.options.bus.open();

    const transportInfo: TransportInfo = {
      kind: this.options.bus.capabilities.canFd ? 'can-fd' : 'can',
      channel: this.options.bus.info.channels[0] ?? 'can0',
      mtu: this.options.bus.capabilities.canFd ? 64 : 8,
    };
    const data = createSession({
      adapter: this.options.bus.info,
      transport: transportInfo,
      ...(this.activePackage ? { definitionPackage: { oem: this.activePackage.oem, version: this.activePackage.version } } : {}),
      ...(this.options.clock ? { clock: this.options.clock } : {}),
    });
    this.session = new VehicleSession(data);

    const discovery = new EcuDiscovery(this.options.bus, {
      logger: this.log,
      ...(discoveryOptions.windowMs !== undefined ? { windowMs: discoveryOptions.windowMs } : {}),
      ...(discoveryOptions.candidates ? { candidates: discoveryOptions.candidates } : {}),
    });
    const discovered = await discovery.discover(this.definitions);

    for (const ecu of discovered) {
      try {
        const handle = this.attachEcu(ecu);
        await handle.session.readIdentification();
        // Which services an ECU actually answers is discovered, not assumed
        // (AGENTS 12 "Supported Services"). Failing probes only reduce the list.
        const supported = await handle.session.probeSupportedServices();
        this.log.info('ECU services probed', { ecu: handle.session.record.name, supported: supported.length });
        this.session.upsertEcu(handle.session.record);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log.warn('ECU attach failed', { rxId: `0x${ecu.rxId.toString(16)}`, error: message });
        const fallbackIsoTp = this.createIsoTp(ecu.txId, ecu.rxId, ecu.extended);
        const failed = new EcuDiagnosticSession(fallbackIsoTp, this.createClient(fallbackIsoTp, `0x${ecu.rxId.toString(16)}`), {
          txId: ecu.txId,
          rxId: ecu.rxId,
          extended: ecu.extended,
          logger: this.log,
          decoder: this.decoder,
          definitionPackage: this.activePackage,
          definitionEcuId: ecu.definitionEcuId?.split(':')[1],
        });
        failed.record.lastError = message;
        this.session.upsertEcu(failed.record);
      }
    }

    await this.detectVehicleIdentity();
    this.log.info('session opened', {
      session: this.session.id,
      ecus: this.session.data.ecus.length,
      reachable: this.session.data.ecus.filter((e) => e.reachable).length,
      vehicle: describeVehicle(this.session.data.vehicle),
    });
    return { session: this.session, ecus: discovered };
  }

  private attachEcu(ecu: DiscoveredEcu): EcuHandle {
    const isoTp = this.createIsoTp(ecu.txId, ecu.rxId, ecu.extended);
    const client = this.createClient(isoTp, `0x${ecu.rxId.toString(16)}`);
    const oemKey = ecu.definitionEcuId?.split(':')[0];
    const pkg = oemKey ? this.definitions.find((p) => p.oem === oemKey) : this.activePackage;
    // Only ask the OEM hooks when the definition packages say nothing about this
    // identifier — documented data always wins over manufacturer heuristics.
    const oemGuess = ecu.definitionEcuId ? undefined : this.oemProtocols.identifyEcu(ecu.rxId, ecu.extended);
    if (oemGuess) {
      this.log.info('ECU role from OEM protocol', {
        rxId: `0x${ecu.rxId.toString(16)}`,
        oem: oemGuess.oem,
        role: oemGuess.role,
      });
    }
    const session = new EcuDiagnosticSession(isoTp, client, {
      txId: ecu.txId,
      rxId: ecu.rxId,
      extended: ecu.extended,
      logger: this.log,
      decoder: this.decoder,
      ...(pkg ? { definitionPackage: pkg } : {}),
      ...(ecu.definitionEcuId ? { definitionEcuId: ecu.definitionEcuId.split(':')[1] } : {}),
      ...(oemGuess ? { name: oemGuess.role } : {}),
    });
    const reader: EcuReader = {
      ecuId: session.id,
      readRaw: (did) => session.readRaw(did),
    };
    const handle: EcuHandle = { session, reader, discovered: ecu };
    this.handles.set(ecu.rxId, handle);
    this.handlesByTxId.set(ecu.txId, handle);
    return handle;
  }

  private createIsoTp(txId: number, rxId: number, extended: boolean): IsoTpConnection {
    return new IsoTpConnection(this.options.bus, {
      txId,
      rxId,
      extended,
      ...this.options.isoTpDefaults,
    }, this.log);
  }

  /**
   * IsoTpConnection satisfies UdsLink structurally, so the UDS layer is bound to
   * the transport without any adapter code — swapping in DoIP means passing a
   * different link here and nothing else changes (AGENTS 5, 36).
   */
  private createClient(link: IsoTpConnection, name: string): UdsClient {
    return new UdsClient(link, { name, logger: this.log });
  }

  /** Read the VIN from the first ECU that answers DID 0xF190 (AGENTS 11). */
  async detectVehicleIdentity(): Promise<VehicleIdentity | undefined> {
    if (!this.session) return undefined;
    for (const handle of this.handles.values()) {
      try {
        const vin = await handle.session.client.readVin();
        if (!vin) continue;
        const identity = createIdentityFromVin(vin, {
          ecus: this.session.data.ecus.map((e) => e.name),
        });
        this.session.data.vehicle = identity;
        this.log.info('vehicle identified', { vin: identity.vin, checkDigit: identity.vinAnalysis?.checkDigit });
        return identity;
      } catch {
        continue;
      }
    }
    return undefined;
  }

  /**
   * Read and decode the freeze frame of one fault code (AGENTS 20 "Snapshot").
   * Returns null when the ECU has no snapshot for that code.
   */
  async readDtcSnapshot(rxId: number, code: string, recordNumber = 0xff): Promise<FreezeFrame | null> {
    const handle = this.handles.get(rxId);
    if (!handle) throw new Error(`no ECU session for 0x${rxId.toString(16)} — call connect() first`);
    return handle.session.readDtcSnapshot(code, recordNumber);
  }

  /**
   * Pre-check a planned clear without writing anything (AGENTS 26).
   * The UI uses it to show which precondition is missing before the operator
   * confirms.
   */
  evaluateDtcClear(rxId: number, options: Pick<ClearDtcOptions, 'userConfirmed' | 'vehicleState'>): { ok: boolean; failed: string[]; warnings: string[] } {
    return this.dtcClear.evaluate(this.clearableEcu(this.requireHandle(rxId)), {
      ...options,
      ...(this.activePackage?.version ? { definitionVersion: this.activePackage.version } : {}),
    });
  }

  /**
   * Adapt an ECU session to the write contract of the clear service.
   *
   * One place, so the pre-check and the actual clear can never drift apart — a
   * pre-check that validates different conditions than the write is worse than no
   * pre-check at all (AGENTS 26).
   */
  private clearableEcu(handle: EcuHandle): ClearableEcu {
    const { session } = handle;
    return {
      id: session.record.id,
      name: session.record.name,
      sessionType: session.record.sessionType,
      readDtcs: (mask) => session.readDtcs(mask),
      clearDiagnosticInformation: (group) => session.clearDiagnosticInformation(group),
      prepareWrite: () => session.ensureWritableSession(),
    };
  }

  /**
   * Clear the fault memory of one ECU (AGENTS 20).
   *
   * Requires an explicit confirmation and a passing safety check; the previous
   * state is stored as a session snapshot so the result can be compared and, if
   * necessary, audited later (AGENTS 25/26).
   */
  async clearDtcs(rxId: number, options: ClearDtcOptions): Promise<ClearDtcResult> {
    const handle = this.requireHandle(rxId);
    const session = this.session;
    return this.dtcClear.clear(
      this.clearableEcu(handle),
      {
        ...options,
        ...(options.definitionVersion ?? this.activePackage?.version ? { definitionVersion: options.definitionVersion ?? this.activePackage?.version } : {}),
        recordSnapshot: (records, label) => {
          session?.addDtcSnapshot([...records], label);
        },
        recordAction: (action) => {
          session?.recordAction(action);
        },
      },
    );
  }

  /** ECU handle or a clear error — used by the read/write helpers above. */
  private requireHandle(rxId: number): EcuHandle {
    const handle = this.handles.get(rxId);
    if (!handle) throw new Error(`no ECU session for 0x${rxId.toString(16)} — call connect() first`);
    return handle;
  }

  /**
   * Read the fault memory of exactly one ECU — same enrichment and marker
   * path as {@link scanDtcs}, for single-ECU reads from the runtime layer.
   * No session snapshot is recorded here: partial scans must not replace the
   * "last full scan" that reports and summaries are based on (AGENTS 20).
   */
  async scanEcu(rxId: number, statusMask = 0xff): Promise<{ ecu: EcuSession; dtcs: EnrichedDtc[] }> {
    const handle = this.requireHandle(rxId);
    const dtcs = this.dtcScanner.enrich(
      await handle.session.readDtcs(statusMask),
      handle.session.record.name,
      handle.session.record.id,
    );
    this.markDtcs(handle.session.record.name, dtcs);
    return { ecu: handle.session.record, dtcs };
  }

  /** One marker per fault code (AGENTS 16 "DTC-Marker auf Zeitachse", AGENTS 20). */
  private markDtcs(ecuName: string, dtcs: readonly EnrichedDtc[]): void {
    for (const dtc of dtcs) {
      const status = `0x${dtc.status.toString(16).toUpperCase().padStart(2, '0')}`;
      this.recorder.addMarker(dtc.code, 'dtc', `${ecuName} · Status ${status}`);
    }
  }

  /** Read DTCs from every reachable ECU (AGENTS 20 "Scan all ECUs"). */
  async scanDtcs(statusMask = 0xff): Promise<Array<{ ecu: EcuSession; dtcs: EnrichedDtc[]; interpretations: OemDtcInterpretation[] }>> {
    if (!this.session) throw new Error('no session — call connect() first');
    const results: Array<{ ecu: EcuSession; dtcs: EnrichedDtc[]; interpretations: OemDtcInterpretation[] }> = [];
    for (const handle of this.handles.values()) {
      try {
        // Enrichment (description, severity, first/last seen, related signals)
        // happens once per scan and per ECU, so the tracker sees one scan of one
        // ECU at a time and cannot mistake a response order for a history.
        const dtcs = this.dtcScanner.enrich(await handle.session.readDtcs(statusMask), handle.session.record.name, handle.session.record.id);
        // Manufacturer hints are attached next to the codes, never merged into
        // them: a hint is interpretation, the code is the measured fact.
        const interpretations = dtcs
          .map((dtc) => this.oemProtocols.interpretDtc(this.activePackage?.oem, dtc.code))
          .filter((interpretation): interpretation is OemDtcInterpretation => interpretation !== undefined);
        results.push({ ecu: handle.session.record, dtcs, interpretations });
        // One marker per fault code, not one per ECU: the time axis should show
        // *which* fault appeared, and a code is what the operator filters by.
        this.markDtcs(handle.session.record.name, dtcs);
      } catch (error) {
        this.log.warn('DTC scan failed for ECU', {
          ecu: handle.session.record.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const all = results.flatMap((r) => r.dtcs);
    if (all.length > 0) this.session.addDtcSnapshot(all, 'scan');
    this.log.info('DTC scan complete', { ecus: results.length, codes: all.length });
    return results;
  }

  /** Read every defined signal of every ECU once (used for a snapshot/report). */
  async snapshotSignals(): Promise<DecodedSignal[]> {
    const decoded: DecodedSignal[] = [];
    for (const handle of this.handles.values()) {
      const values = await handle.session.readAllSignals();
      for (const value of values) {
        decoded.push(value);
        this.recorder.record(value);
      }
    }
    if (this.session) {
      this.session.data.measurements = this.recorder
        .signalIds()
        .map((id) => ({ signalId: id, name: id, samples: this.recorder.samplesFor(id).length }));
    }
    return decoded;
  }

  /** Start parallel live data acquisition across all ECUs (AGENTS 15). */
  async startLiveData(options: { signalIds?: readonly string[]; intervalMs?: number; maxRounds?: number } = {}): Promise<LiveDataEngine> {
    if (!this.session) throw new Error('no session — call connect() first');
    const plan = this.buildPlan(options.signalIds);
    const engine = new LiveDataEngine(
      (signal, payload) => this.decoder.decode(signal, payload),
      this.recorder,
      { intervalMs: options.intervalMs ?? this.options.pollIntervalMs ?? 100, logger: this.log, ...(options.maxRounds !== undefined ? { maxRounds: options.maxRounds } : {}) },
    );
    this.liveEngine = engine;
    const readers = Array.from(this.handles.values())
      .filter((handle) => plan.has(handle.session.id))
      .map((handle) => handle.reader);
    void engine.run(readers, plan).catch((error) => {
      this.log.error('live data engine crashed', { error: error instanceof Error ? error.message : String(error) });
    });
    return engine;
  }

  stopLiveData(): void {
    this.liveEngine?.stop();
    this.liveEngine = null;
  }

  /** ecuSessionId → signals to poll, honouring an optional signal filter. */
  buildPlan(signalIds?: readonly string[]): Map<string, readonly SignalDefinition[]> {
    const plan = new Map<string, readonly SignalDefinition[]>();
    for (const handle of this.handles.values()) {
      const all = handle.session.signals;
      const selected = signalIds ? all.filter((s) => signalIds.includes(s.id)) : all;
      if (selected.length > 0) plan.set(handle.session.id, selected);
    }
    return plan;
  }

  /** Resolve a signal definition across all packages. */
  findSignal(signalId: string): SignalDefinition | undefined {
    for (const pkg of this.definitions) {
      const index = indexPackage(pkg);
      const signal = index.byId.get(signalId);
      if (signal) return signal;
    }
    return undefined;
  }

  /** ECU handle by response identifier — used by the UI and the replay tooling. */
  handleFor(rxId: number): EcuHandle | undefined {
    return this.handles.get(rxId);
  }

  /** ECU handle by physical request identifier. */
  handleForTxId(txId: number): EcuHandle | undefined {
    return this.handlesByTxId.get(txId);
  }

  async disconnect(): Promise<void> {
    this.stopLiveData();
    for (const handle of this.handles.values()) {
      handle.session.client.stopTesterPresent();
      handle.session.isoTp.close();
    }
    this.handles.clear();
    this.handlesByTxId.clear();
    this.session?.close();
    await this.options.bus.close();
    this.log.info('session closed', { session: this.session?.id });
  }

  /** Convenience for tooling: derive the request id for a response id. */
  static deriveTxId(rxId: number, extended = false): number {
    return deriveTxId(rxId, extended);
  }

  /** Stable id helper re-exported for session/trace correlation. */
  static newTraceId(): string {
    return createId('trace');
  }

  /** Hex helper so callers do not need to import shared directly. */
  static hex(data: Uint8Array): string {
    return toHex(data);
  }
}
