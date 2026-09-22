/**
 * Vehicle session model (AGENTS 10).
 *
 * Every vehicle connection is a session. Sessions are serialisable so they can
 * be stored, reopened and compared later; the storage layer owns persistence and
 * migrations (AGENTS 34.13/14), this module owns the shape.
 */

import type { DtcRecord } from "@vdp/protocols-uds";
import { createId, nowIso } from "@vdp/shared";
import type { AdapterInfo, TransportInfo } from "@vdp/transport-can";
import type { EnrichedDtc } from "../dtc/scanner.js";
import type { VehicleIdentity } from "../vehicle/identity.js";
import type { VehicleDetermination } from "./types.js";

export const SESSION_SCHEMA_VERSION = 1;

export interface EcuIdentification {
  label: string;
  value: string;
  /**
   * DID the value was read from (ISO 14229-1 0x22). Optional because older
   * recorded sessions predate it; a session that knows it keeps the value
   * traceable to the exact request that produced it (ADR 0004: raw and decoded
   * stay separable), and vehicle resolution can name the DID in its evidence.
   */
  did?: number;
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
  outcome: "supported" | "unsupported" | "not-probed";
  detail: string;
}

export interface EcuSession {
  id: string;
  /** Definition package ECU id, when one matched. */
  definitionEcuId?: string;
  name: string;
  protocol: "uds" | "kwp2000" | "unknown";
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

/**
 * The scenario a session ran (ADR 0048/0051): the file is the source, so the
 * reference is its id and title plus the seed that ran with it. Written by the
 * host that ran the scenario, never derived from the trace.
 */
export interface SessionScenarioReference {
  id: string;
  title: string;
  seed: number;
}

/**
 * The last AI analysis a session carried (ADR 0057): provider plus the versions
 * the analysis was produced under. Taken from the analysis' own provenance, which
 * is assembled from the request — never from the answer (ADR 0043).
 */
export interface SessionAnalysisReference {
  provider: string;
  promptVersion: string;
  runtimeVersion: string;
}

export interface DiagnosticAction {
  id: string;
  timestamp: string;
  kind: "read" | "write" | "routine" | "clear-dtc" | "session-change" | "security-access";
  ecuId: string;
  description: string;
  /** Present for write operations (AGENTS 25 audit log). */
  previousValue?: string;
  newValue?: string;
  result: "success" | "failed" | "aborted";
  detail?: string;
}

export interface MeasurementReference {
  signalId: string;
  name: string;
  unit?: string;
  samples: number;
}

/**
 * What one fault scan stored, per code.
 *
 * The protocol fields are always present; the enrichment the DTC system adds
 * (AGENTS 20) is optional, because a stored file is a file another build wrote and
 * nothing in it may become a requirement old sessions cannot meet (AGENTS 34.14).
 * `firstSeenInThisScan` is deliberately absent: that flag answers "new in the scan
 * that is running", which is a property of a live scan. Inside a stored snapshot it
 * would read as "new in this session" after a reload, so it never reaches the file
 * and stays only on the read model the workbench renders.
 */
export type StoredDtcRecord = DtcRecord &
  Partial<Omit<EnrichedDtc, keyof DtcRecord | "firstSeenInThisScan">>;

/**
 * What a snapshot write accepts: the stored shape plus the live-scan mark, which
 * {@link VehicleSession.addDtcSnapshot} drops.
 */
export type ScannedDtcRecord = StoredDtcRecord & Pick<EnrichedDtc, "firstSeenInThisScan">;

/** One fault-memory read, kept as the scan produced it (AGENTS 20). */
export interface DtcSnapshot {
  id: string;
  takenAt: string;
  label?: string;
  records: StoredDtcRecord[];
}

export interface VehicleSessionData {
  schemaVersion: number;
  id: string;
  startedAt: string;
  endedAt?: string;
  title?: string;
  vehicle?: VehicleIdentity;
  /**
   * Which vehicle this session was determined to be, with the evidence that
   * decided it (AGENTS 11.1). Written once per resolution, by the runtime — the
   * only place that holds both the resolution and the session.
   */
  determination?: VehicleDetermination;
  adapter: AdapterInfo;
  transport: TransportInfo;
  definitionPackage?: { oem: string; version: string };
  ecus: EcuSession[];
  dtcSnapshots: DtcSnapshot[];
  measurements: MeasurementReference[];
  actions: DiagnosticAction[];
  notes: SessionNote[];
  /** Odometer reading in km, if available. */
  mileageKm?: number;
  tags: string[];
  /**
   * Provenance (ADR 0057) — additive and optional, so a session written by an
   * older platform reads exactly as before: no schema bump, no migration.
   */
  /** Version of the platform that opened the session. */
  platformVersion?: string;
  /** The scenario this session ran, with the seed that ran with it. */
  scenario?: SessionScenarioReference;
  /** The last AI analysis carried by this session, with its versions. */
  ai?: SessionAnalysisReference;
  /**
   * Content-addressed identity of the raw-trace witness: `t-` + the first 16
   * hex of the manifest's SHA-256. The same recording carries the same id, and
   * a session whose manifest no longer matches its id is checkably wrong.
   */
  traceId?: string;
}

export interface CreateSessionOptions {
  adapter: AdapterInfo;
  transport: TransportInfo;
  title?: string;
  definitionPackage?: { oem: string; version: string };
  id?: string;
  clock?: () => number;
  /** Version of the platform opening the session (ADR 0057). */
  platformVersion?: string;
}

export function createSession(options: CreateSessionOptions): VehicleSessionData {
  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    id: options.id ?? createId("session"),
    startedAt: nowIso(options.clock),
    ...(options.title ? { title: options.title } : {}),
    adapter: options.adapter,
    transport: options.transport,
    ...(options.definitionPackage ? { definitionPackage: options.definitionPackage } : {}),
    ...(options.platformVersion ? { platformVersion: options.platformVersion } : {}),
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
  protocol?: EcuSession["protocol"];
  txId: number;
  rxId: number;
  extended?: boolean;
  definitionEcuId?: string;
}): EcuSession {
  return {
    id: createId("ecu"),
    ...(options.definitionEcuId ? { definitionEcuId: options.definitionEcuId } : {}),
    name: options.name,
    protocol: options.protocol ?? "unknown",
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

/** Derived lookup tables for the ECU list of a session. */
interface EcuLookup {
  /** Session id and definition package ECU id → record. */
  byId: Map<string, EcuSession>;
  /** `txId:rxId` → record, so re-attaching the same ECU updates instead of duplicating. */
  byAddress: Map<string, EcuSession>;
}

/** Live view over a session, owned by the diagnostic engine. */
export class VehicleSession {
  readonly data: VehicleSessionData;

  /**
   * Derived lookup index over `data.ecus`.
   *
   * `data.ecus` stays the single source of truth — it is what gets serialised,
   * and the storage layer may hand back a session whose array was filled
   * directly. So the index is not maintained on every mutation, it is rebuilt on
   * demand and reused while the array is untouched, which turns the per-attach
   * `upsertEcu` scan and the id lookups into map hits for a session with dozens
   * of ECUs (AGENTS 10/12).
   */
  private ecuIndex: EcuLookup | null = null;
  private indexedEcuCount = -1;

  constructor(data: VehicleSessionData) {
    this.data = data;
  }

  /** Id → record (session id and definition package id) plus address → record. */
  private index(): EcuLookup {
    if (this.ecuIndex === null || this.indexedEcuCount !== this.data.ecus.length) {
      const lookup: EcuLookup = { byId: new Map(), byAddress: new Map() };
      for (const ecu of this.data.ecus) {
        lookup.byId.set(ecu.id, ecu);
        if (ecu.definitionEcuId) lookup.byId.set(ecu.definitionEcuId, ecu);
        lookup.byAddress.set(`${ecu.txId}:${ecu.rxId}`, ecu);
      }
      this.ecuIndex = lookup;
      this.indexedEcuCount = this.data.ecus.length;
    }
    return this.ecuIndex;
  }

  get id(): string {
    return this.data.id;
  }

  get startedAt(): string {
    return this.data.startedAt;
  }

  upsertEcu(ecu: EcuSession): EcuSession {
    const lookup = this.index();
    // Same preference as the lookup order of `findEcu`: a record that is already
    // known under this id is updated, otherwise the ECU on the same address is.
    const existing = lookup.byId.get(ecu.id) ?? lookup.byAddress.get(`${ecu.txId}:${ecu.rxId}`);
    if (existing) {
      Object.assign(existing, ecu);
      // Identity fields may have moved (an upsert under a new session id for a
      // known address), so the derived view is dropped and rebuilt on next use.
      this.ecuIndex = null;
      return existing;
    }
    this.data.ecus.push(ecu);
    return ecu;
  }

  findEcu(id: string): EcuSession | undefined {
    return this.index().byId.get(id);
  }

  recordAction(
    action: Omit<DiagnosticAction, "id" | "timestamp"> & { timestamp?: string },
  ): DiagnosticAction {
    const entry: DiagnosticAction = {
      id: createId("act"),
      timestamp: action.timestamp ?? nowIso(),
      ...action,
    };
    this.data.actions.push(entry);
    return entry;
  }

  addNote(text: string, author?: string): SessionNote {
    const note: SessionNote = {
      id: createId("note"),
      timestamp: nowIso(),
      text,
      ...(author ? { author } : {}),
    };
    this.data.notes.push(note);
    return note;
  }

  addDtcSnapshot(records: readonly ScannedDtcRecord[], label?: string): DtcSnapshot {
    const snapshot: DtcSnapshot = {
      id: createId("dtc"),
      takenAt: nowIso(),
      ...(label ? { label } : {}),
      // Drop the live-scan mark here, rather than storing it and hoping no reader
      // mistakes it for a session-scoped fact. The mark is *omitted by
      // construction* (rest destructuring) instead of copied and deleted: `delete`
      // is an error in production code (ADR 0029 §1), and an omit cannot leave a
      // hole behind. A copy is also what keeps a future `EnrichedDtc` field from
      // being forgotten in a list.
      records: records.map(({ firstSeenInThisScan: _liveScanMark, ...stored }) => stored),
    };
    this.data.dtcSnapshots.push(snapshot);
    return snapshot;
  }

  /**
   * Store which vehicle this session was determined to be (AGENTS 11.1).
   *
   * Last resolution wins: an operator who supplies a part number has the session
   * re-resolve, and the stored record then describes that attempt — `resolvedAt`
   * is what makes the two distinguishable later.
   *
   * {@link VehicleIdentity} is deliberately left alone. The identity holds what was
   * *read* (VIN, DIDs, the ECUs that answered); the determination holds what was
   * *concluded*. Merging the conclusion into the measurement would let the next
   * resolution treat its own answer as declared evidence and confirm itself — the
   * reader that wants the whole picture composes both (see `toVehicleSummary`).
   */
  recordDetermination(
    determination: Omit<VehicleDetermination, "resolvedAt">,
    at: string = nowIso(),
  ): VehicleDetermination {
    const stored: VehicleDetermination = { resolvedAt: at, ...determination };
    this.data.determination = stored;
    return stored;
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
      criticalDtcCount: allDtcs.filter((d) => d.severity === "critical").length,
      actionCount: this.data.actions.length,
      signalCount: this.data.measurements.length,
    };
  }
}
