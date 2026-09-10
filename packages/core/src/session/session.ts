/**
 * Vehicle session model (AGENTS 10).
 *
 * Every vehicle connection is a session. Sessions are serialisable so they can
 * be stored, reopened and compared later; the storage layer owns persistence and
 * migrations (AGENTS 34.13/14), this module owns the shape.
 */

import { createId, nowIso } from '@vdp/shared';
import type { AdapterInfo, TransportInfo } from '@vdp/transport-can';
import type { DtcRecord } from '@vdp/protocols-uds';
import type { VehicleIdentity } from '../vehicle/identity.js';

export const SESSION_SCHEMA_VERSION = 1;

export interface EcuIdentification {
  label: string;
  value: string;
}

/**
 * Outcome of probing one UDS service on an ECU (AGENTS 12 "Supported Services").
 *
 * `not-probed` is a first-class outcome: some services cannot be interrogated
 * without side effects (clearing fault memory, security access), and reporting
 * them as "supported" would be a guess while reporting them as "unsupported"
 * would be wrong (AGENTS 24).
 */
export interface ServiceProbeResult {
  service: number;
  outcome: 'supported' | 'unsupported' | 'not-probed';
  detail: string;
}

export interface EcuSession {
  id: string;
  /** Definition package ECU id, when one matched. */
  definitionEcuId?: string;
  name: string;
  protocol: 'uds' | 'kwp2000' | 'unknown';
  txId: number;
  rxId: number;
  extended: boolean;
  identification: EcuIdentification[];
  /** Services the ECU positively answers for, derived from `serviceProbes`. */
  supportedServices: number[];
  /** Per-service probe outcome, including the ones deliberately not probed. */
  serviceProbes?: ServiceProbeResult[];
  sessionType: number;
  timing: { p2Ms: number; p2StarMs: number };
  dtcs?: DtcRecord[];
  /** True once identification was read successfully. */
  reachable: boolean;
  lastError?: string;
}

export interface SessionNote {
  id: string;
  timestamp: string;
  text: string;
  author?: string;
}

export interface DiagnosticAction {
  id: string;
  timestamp: string;
  kind: 'read' | 'write' | 'routine' | 'clear-dtc' | 'session-change' | 'security-access';
  ecuId: string;
  description: string;
  /** Present for write operations (AGENTS 25 audit log). */
  previousValue?: string;
  newValue?: string;
  result: 'success' | 'failed' | 'aborted';
  detail?: string;
}

export interface MeasurementReference {
  signalId: string;
  name: string;
  unit?: string;
  samples: number;
}

export interface VehicleSessionData {
  schemaVersion: number;
  id: string;
  startedAt: string;
  endedAt?: string;
  title?: string;
  vehicle?: VehicleIdentity;
  adapter: AdapterInfo;
  transport: TransportInfo;
  definitionPackage?: { oem: string; version: string };
  ecus: EcuSession[];
  dtcSnapshots: Array<{ id: string; takenAt: string; label?: string; records: DtcRecord[] }>;
  measurements: MeasurementReference[];
  actions: DiagnosticAction[];
  notes: SessionNote[];
  /** Odometer reading in km, if available. */
  mileageKm?: number;
  tags: string[];
}

export interface CreateSessionOptions {
  adapter: AdapterInfo;
  transport: TransportInfo;
  title?: string;
  definitionPackage?: { oem: string; version: string };
  id?: string;
  clock?: () => number;
}

export function createSession(options: CreateSessionOptions): VehicleSessionData {
  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    id: options.id ?? createId('session'),
    startedAt: nowIso(options.clock),
    ...(options.title ? { title: options.title } : {}),
    adapter: options.adapter,
    transport: options.transport,
    ...(options.definitionPackage ? { definitionPackage: options.definitionPackage } : {}),
    ecus: [],
    dtcSnapshots: [],
    measurements: [],
    actions: [],
    notes: [],
    tags: [],
  };
}

export function createEcuSession(options: {
  name: string;
  protocol?: EcuSession['protocol'];
  txId: number;
  rxId: number;
  extended?: boolean;
  definitionEcuId?: string;
}): EcuSession {
  return {
    id: createId('ecu'),
    ...(options.definitionEcuId ? { definitionEcuId: options.definitionEcuId } : {}),
    name: options.name,
    protocol: options.protocol ?? 'unknown',
    txId: options.txId,
    rxId: options.rxId,
    extended: options.extended ?? false,
    identification: [],
    supportedServices: [],
    sessionType: 0x01,
    timing: { p2Ms: 50, p2StarMs: 5000 },
    reachable: false,
  };
}

/** Live view over a session, owned by the diagnostic engine. */
export class VehicleSession {
  readonly data: VehicleSessionData;

  constructor(data: VehicleSessionData) {
    this.data = data;
  }

  get id(): string {
    return this.data.id;
  }

  get startedAt(): string {
    return this.data.startedAt;
  }

  upsertEcu(ecu: EcuSession): EcuSession {
    const existing = this.data.ecus.find((e) => e.id === ecu.id || (e.txId === ecu.txId && e.rxId === ecu.rxId));
    if (existing) {
      Object.assign(existing, ecu);
      return existing;
    }
    this.data.ecus.push(ecu);
    return ecu;
  }

  findEcu(id: string): EcuSession | undefined {
    return this.data.ecus.find((e) => e.id === id || e.definitionEcuId === id);
  }

  recordAction(action: Omit<DiagnosticAction, 'id' | 'timestamp'> & { timestamp?: string }): DiagnosticAction {
    const entry: DiagnosticAction = { id: createId('act'), timestamp: action.timestamp ?? nowIso(), ...action };
    this.data.actions.push(entry);
    return entry;
  }

  addNote(text: string, author?: string): SessionNote {
    const note: SessionNote = { id: createId('note'), timestamp: nowIso(), text, ...(author ? { author } : {}) };
    this.data.notes.push(note);
    return note;
  }

  addDtcSnapshot(records: DtcRecord[], label?: string): { id: string; takenAt: string; records: DtcRecord[] } {
    const snapshot = { id: createId('dtc'), takenAt: nowIso(), ...(label ? { label } : {}), records };
    this.data.dtcSnapshots.push(snapshot);
    return snapshot;
  }

  close(): void {
    this.data.endedAt = nowIso();
  }

  durationMs(): number | null {
    if (!this.data.endedAt) return null;
    return new Date(this.data.endedAt).getTime() - new Date(this.data.startedAt).getTime();
  }

  /** Summary used by reports (AGENTS 21). */
  summary(): {
    ecuCount: number;
    reachableEcuCount: number;
    dtcCount: number;
    criticalDtcCount: number;
    actionCount: number;
    signalCount: number;
  } {
    const allDtcs = this.data.dtcSnapshots.at(-1)?.records ?? [];
    return {
      ecuCount: this.data.ecus.length,
      reachableEcuCount: this.data.ecus.filter((e) => e.reachable).length,
      dtcCount: allDtcs.length,
      criticalDtcCount: allDtcs.filter((d) => d.severity === 'critical').length,
      actionCount: this.data.actions.length,
      signalCount: this.data.measurements.length,
    };
  }
}
