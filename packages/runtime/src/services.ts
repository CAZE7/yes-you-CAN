/**
 * Runtime services (target architecture §14/§32 Phase 2).
 *
 * The god-`DiagnosticEngine` is still the implementation below, but clients
 * no longer talk to it directly: each concern is a small service with a
 * domain-shaped API. When the engine is decomposed (ADR 0014 Phase 4) these
 * services keep their signatures and simply receive new implementations.
 */

import type { Logger } from '@vdp/shared';
import { toHex } from '@vdp/shared';
import type {
  ClearDtcResult,
  DiagnosticEngine,
  EcuHandle,
  EcuSession,
  SafetyManager,
  VehicleSessionData,
  VehicleState,
  WriteRequestContext,
} from '@vdp/core';
import type {
  ClearDtcOutcome,
  DiagnosticCapability,
  DtcInfo,
  EcuSummary,
  EventBus,
  IdGenerator,
  MeasurementReading,
  RawDidReading,
  SessionStore,
  SessionSummary,
  VehicleStateReading,
  VehicleSummary,
} from '@vdp/domain';
import { policyForWriteOperation } from '@vdp/domain';
import type { ConnectVehicleOptions, ConnectVehicleResult } from '@vdp/application';
import { capabilitiesFromServices } from './capability-map.js';
import {
  decodedToReading,
  deniedClearOutcome,
  toClearDtcOutcome,
  toDtcInfo,
  toEcuSummary,
  toMeasurementReading,
  toSessionSummary,
  toVehicleSummary,
} from './mappers.js';

export function unknownEcu(ecuId: string): Error {
  return new Error(`unknown ECU "${ecuId}" — connect first or check the id`);
}

/** Parse an address-form ECU reference like "0x7e8"; undefined otherwise. */
export function parseEcuAddress(value: string): number | undefined {
  if (!value.startsWith('0x')) return undefined;
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

  /** Read one DID raw — decoding is definition knowledge, not engine logic. */
  async readDid(ecuId: string, did: number): Promise<RawDidReading> {
    const session = this.engine.vehicleSession;
    if (!session) throw new Error('no session — call vehicle.connect() first');
    const handle = this.resolveHandle(ecuId);
    if (!handle) throw unknownEcu(ecuId);
    const payload = await handle.session.readRaw(did);
    if (!payload) throw new Error(`ECU "${handle.session.record.name}" returned no data for DID 0x${did.toString(16).toUpperCase()}`);
    const reading: RawDidReading = {
      ecuId: handle.session.record.id,
      did,
      hex: toHex(payload),
      byteLength: payload.byteLength,
    };
    this.events.publish('did-read', { sessionId: session.id, ecuId: reading.ecuId, did, byteLength: payload.byteLength });
    this.log.debug('DID read', { ecu: handle.session.record.name, did: `0x${did.toString(16)}`, bytes: payload.byteLength });
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
    if (address !== undefined) return this.engine.handleFor(address) ?? this.engine.handleForTxId(address);
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
  ) {}

  async connect(options?: ConnectVehicleOptions): Promise<ConnectVehicleResult> {
    const { session } = await this.engine.connect(options?.windowMs !== undefined ? { windowMs: options.windowMs } : {});
    const summaries = this.ecus.list();
    for (const ecu of summaries) {
      this.events.publish('ecu-discovered', {
        sessionId: session.id,
        ecuId: ecu.ecuId,
        name: ecu.name,
        txId: ecu.txId,
        rxId: ecu.rxId,
        reachable: ecu.reachable,
      });
      if (ecu.capabilities.length > 0) {
        this.events.publish('ecu-capabilities-updated', { ecuId: ecu.ecuId, capabilities: ecu.capabilities });
      }
    }
    const vehicle = this.identity();
    this.events.publish('vehicle-connected', {
      sessionId: session.id,
      ...(vehicle?.vin !== undefined ? { vin: vehicle.vin } : {}),
      ecuCount: summaries.length,
    });
    return {
      session: toSessionSummary(session),
      ...(vehicle !== undefined ? { vehicle } : {}),
      ecus: summaries,
    };
  }

  identity(): VehicleSummary | undefined {
    return toVehicleSummary(this.engine.vehicleSession?.data.vehicle);
  }

  async disconnect(): Promise<void> {
    const session = this.engine.vehicleSession;
    if (!session) return;
    await this.engine.disconnect();
    this.events.publish('vehicle-disconnected', { sessionId: session.id, durationMs: session.durationMs() });
    this.log.info('runtime disconnected', { session: session.id });
  }
}

/** Fault memory: scan (all or one ECU), clear via the safety chain. */
export class DtcService {
  private lastScan: DtcInfo[] = [];

  constructor(
    private readonly engine: DiagnosticEngine,
    private readonly ecus: EcuService,
    private readonly events: EventBus,
    private readonly log: Logger,
    private readonly ids: IdGenerator,
  ) {}

  /** Read model: the DTCs of the most recent scan. */
  get lastScanResult(): readonly DtcInfo[] {
    return this.lastScan;
  }

  /**
   * Scan every reachable ECU (no `ecuId`) or exactly one. A full scan
   * replaces the read model; a single-ECU scan updates that ECU's entries.
   */
  async scan(ecuId?: string, statusMask?: number): Promise<DtcInfo[]> {
    const session = this.engine.vehicleSession;
    if (!session) throw new Error('no session — call vehicle.connect() first');
    const mask = statusMask ?? 0xff;

    if (ecuId === undefined) {
      const results = await this.engine.scanDtcs(mask);
      const infos = results.flatMap((result) => result.dtcs.map(toDtcInfo));
      this.lastScan = infos;
      this.events.publish('dtcs-read', { sessionId: session.id, ecuCount: results.length, dtcCount: infos.length });
      return infos;
    }

    const handle = this.ecus.resolveHandle(ecuId);
    if (!handle) throw unknownEcu(ecuId);
    const { dtcs } = await this.engine.scanEcu(handle.discovered.rxId, mask);
    const infos = dtcs.map(toDtcInfo);
    const targetId = handle.session.record.id;
    this.lastScan = [...this.lastScan.filter((dtc) => dtc.ecuId !== targetId), ...infos];
    this.events.publish('dtcs-read', { sessionId: session.id, ecuId: targetId, ecuCount: 1, dtcCount: infos.length });
    return infos;
  }

  /**
   * Clear one ECU's fault memory — the full safety chain applies (AGENTS 26):
   * pre-check → permit → write → verification → audit events.
   */
  async clear(
    ecuId: string,
    input: { userConfirmed: boolean; vehicleState: VehicleStateReading; definitionVersion?: string },
  ): Promise<ClearDtcOutcome> {
    const session = this.engine.vehicleSession;
    if (!session) throw new Error('no session — call vehicle.connect() first');
    const handle = this.ecus.resolveHandle(ecuId);
    if (!handle) throw unknownEcu(ecuId);
    const record = handle.session.record;

    const actionId = this.ids.next('act');
    const policy = policyForWriteOperation('clear-dtc');
    this.events.publish('safety-approval-requested', { actionId, operation: 'clear-dtc', risk: policy.risk, ecuId: record.id });

    const precheck = this.engine.evaluateDtcClear(handle.discovered.rxId, {
      userConfirmed: input.userConfirmed,
      vehicleState: input.vehicleState,
    });
    if (!precheck.ok) {
      this.events.publish('safety-approval-denied', { actionId, ecuId: record.id, reasons: precheck.failed });
      this.log.warn('DTC clear denied by safety pre-check', { ecu: record.name, failed: precheck.failed });
      return deniedClearOutcome(record.id, record.name, precheck.failed);
    }

    try {
      const definitionVersion = input.definitionVersion ?? this.engine.activePackage?.version;
      const result: ClearDtcResult = await this.engine.clearDtcs(handle.discovered.rxId, {
        userConfirmed: input.userConfirmed,
        vehicleState: input.vehicleState,
        ...(definitionVersion !== undefined ? { definitionVersion } : {}),
      });
      const outcome = toClearDtcOutcome(result, precheck.warnings);
      this.events.publish('safety-approval-granted', { actionId, permitId: result.permit.id, ecuId: record.id });
      this.events.publish('dtcs-cleared', {
        sessionId: session.id,
        ecuId: record.id,
        clearedCount: result.comparison.removed.length,
        remainingCount: result.after.length,
        verified: result.verified,
      });
      this.events.publish('action-executed', {
        actionId,
        operation: 'clear-dtc',
        ecuId: record.id,
        ok: result.cleared,
        ...(result.verified ? {} : { detail: 'verification re-read found remaining codes' }),
      });
      this.log.info('DTC clear finished', { ecu: record.name, cleared: result.cleared, verified: result.verified });
      return { ...outcome, actionId };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.events.publish('action-executed', { actionId, operation: 'clear-dtc', ecuId: record.id, ok: false, detail: message });
      this.events.publish('diagnostic-error', { sessionId: session.id, ecuId: record.id, phase: 'dtc.clear', message });
      throw error;
    }
  }
}

/** Measurements: snapshots, live polling, recorded samples. */
export class MeasurementService {
  constructor(
    private readonly engine: DiagnosticEngine,
    private readonly events: EventBus,
    private readonly log: Logger,
  ) {}

  /** Read every (or the selected) defined signal once and record the samples. */
  async snapshot(signalIds?: readonly string[]): Promise<MeasurementReading[]> {
    const session = this.engine.vehicleSession;
    if (!session) throw new Error('no session — call vehicle.connect() first');
    const decoded = await this.engine.snapshotSignals();
    const selected = signalIds ? decoded.filter((signal) => signalIds.includes(signal.signalId)) : decoded;
    const readings: MeasurementReading[] = [];
    for (const signal of selected) {
      const samples = this.engine.recorder.samplesFor(signal.signalId);
      const latest = samples.at(-1);
      readings.push(latest ? toMeasurementReading(latest, signal.name) : decodedToReading(signal, session.data.startedAt));
    }
    const recordedIds = Array.from(new Set(readings.map((reading) => reading.signalId)));
    this.events.publish('measurements-recorded', { sessionId: session.id, sampleCount: readings.length, signalIds: recordedIds });
    return readings;
  }

  /** Start parallel live polling across all ECUs (AGENTS 15). */
  async start(options: { signalIds?: readonly string[]; intervalMs?: number } = {}): Promise<void> {
    if (!this.engine.vehicleSession) throw new Error('no session — call vehicle.connect() first');
    await this.engine.startLiveData(options);
    this.log.info('live measurements started', { intervalMs: options.intervalMs ?? 100 });
  }

  stop(): void {
    this.engine.stopLiveData();
  }

  /** Recorded samples, optionally restricted to one signal. */
  samples(signalId?: string): MeasurementReading[] {
    const recorder = this.engine.recorder;
    const ids = signalId !== undefined ? [signalId] : recorder.signalIds();
    return ids.flatMap((id) => recorder.samplesFor(id).map((sample) => toMeasurementReading(sample)));
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
    if (!data) throw new Error('no session — call vehicle.connect() first');
    if (!this.store) throw new Error('no session store configured on this runtime');
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
