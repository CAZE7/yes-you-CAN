/**
 * Domain data contracts (target architecture §1, §32 Phase 1 "Domain Contracts").
 *
 * These are the shapes the application layer hands to *clients* — Web, CLI,
 * API, AI. Clients never see transport or protocol types. Today they are
 * projections of the (still monolithic) `DiagnosticEngine` state; when the
 * engine is decomposed (ADR 0014, Phase 4) these same contracts become the
 * authoritative domain entities. Everything is referenced by id (§24).
 */

import type { DiagnosticCapability } from "./capabilities.js";
import type { RiskLevel } from "./risk.js";

export interface IdentificationEntry {
  label: string;
  value: string;
  /** DID the value came from, when the reader recorded it (§11, §12). */
  did?: number;
}

/** Vehicle identity as far as it is known (§11 of AGENTS.md). */
export interface VehicleSummary {
  vehicleId?: string;
  vin?: string;
  manufacturer?: string;
  brand?: string;
  model?: string;
  modelYear?: number;
  platform?: string;
  /** Human readable one-liner for headers and reports. */
  description: string;
}

/** One ECU as seen from the application layer. */
export interface EcuSummary {
  ecuId: string;
  /** Definition package ECU id when one matched, e.g. "engine". */
  definitionEcuId?: string;
  name: string;
  protocol: "uds" | "kwp2000" | "unknown";
  /** Physical request identifier (tester → ECU). */
  txId: number;
  /** Physical response identifier (ECU → tester). */
  rxId: number;
  extended: boolean;
  reachable: boolean;
  /** Active diagnostic session type (ISO 14229-1 §9.2). */
  sessionType: number;
  /** Polling timing of the ECU in milliseconds (ISO 14229-2 P2). */
  p2Ms: number;
  /** Fault codes stored in the session record of this ECU. */
  dtcCount: number;
  /** UDS service ids the ECU actually answered during probing (§12). */
  supportedServices: number[];
  /** Capability-driven UI: the available actions derive from this list (§6). */
  capabilities: DiagnosticCapability[];
  identification: IdentificationEntry[];
  lastError?: string;
}

/** One fault code with its enrichment — the read model for DTC queries. */
export interface DtcInfo {
  code: string;
  ecuId: string;
  ecuName: string;
  /** ISO 14229-1 DTC status byte. */
  status: number;
  /** Raw DTC value as reported by the ECU — the protocol truth next to the code. */
  raw: string;
  /** Failure type byte as the ECU reported it (protocol fallback description). */
  failureType: string;
  /** ISO 14229-1 status-bit decomposition of {@link status}. */
  confirmed: boolean;
  pending: boolean;
  testFailed: boolean;
  /** True when the ECU answered with a snapshot record for this code (§20). */
  hasFreezeFrame: boolean;
  /** True when this code was absent from the previous scan (§20). */
  firstSeenInThisScan?: boolean;
  severity?: string;
  description?: string;
  /** Suggested next diagnostic step from the definition package. */
  hint?: string;
  firstSeen?: string;
  lastSeen?: string;
  /** Signals the definition package relates to this code — ids with names. */
  relatedSignals?: ReadonlyArray<{ id: string; name: string }>;
}

/** One decoded measurement sample — raw and decoded stay side by side (§14). */
export interface MeasurementReading {
  signalId: string;
  name?: string;
  /** ISO-8601 with millisecond precision. */
  timestamp: string;
  /** Monotonic milliseconds since recording start — the shared chart axis. */
  t: number;
  value: number | string | boolean;
  rawValue: number | string | boolean;
  rawHex: string;
  unit?: string;
  enumText?: string;
  outOfRange: boolean;
}

/** Result of reading one DID raw (decoding is up to the caller/definition). */
export interface RawDidReading {
  ecuId: string;
  did: number;
  /** Uppercase hex bytes, space separated. */
  hex: string;
  byteLength: number;
}

/**
 * Vehicle preconditions for write operations — asserted (and recorded) by the
 * operator or a reader, never assumed (§15 safety).
 */
export interface VehicleStateReading {
  stationary: boolean;
  batteryVoltage?: number;
  engineRunning?: boolean;
  ignitionOn?: boolean;
  gearPosition?: string;
  parkingBrake?: boolean;
}

/** Session overview — the read model for session queries. */
export interface SessionSummary {
  sessionId: string;
  schemaVersion: number;
  startedAt: string;
  endedAt?: string;
  title?: string;
  vehicle?: VehicleSummary;
  ecuCount: number;
  reachableEcuCount: number;
  dtcCount: number;
  actionCount: number;
  measurementCount: number;
  /** Exact definition package version recorded with the session (§16). */
  definitionPackage?: { oem: string; version: string };
}

/** Outcome of a fault-memory clear — including the verification re-read. */
export interface ClearDtcOutcome {
  ok: boolean;
  /** True when the re-read confirmed the codes are gone. */
  verified: boolean;
  ecuId: string;
  ecuName: string;
  beforeCount: number;
  afterCount: number;
  /** Codes that survived the clear (still present or immediately re-set). */
  remainingCodes: string[];
  /** Codes present before the clear. */
  beforeCodes: string[];
  /** Codes still present after the clear. */
  afterCodes: string[];
  /** Codes that are gone after the clear. */
  removedCodes: string[];
  /** Codes still stored because the fault condition is still present. */
  stillFailingCodes: string[];
  /** Codes whose status did not change at all — the ECU ignored the clear. */
  unchangedCodes: string[];
  /** Failed preconditions or warnings produced by the safety chain. */
  reasons: string[];
  clearedAt?: string;
  /** Audit trail: the safety permit that authorised the write (§25). */
  permitId?: string;
  actionId?: string;
}

/** Generic result of a (write) diagnostic operation. */
export interface DiagnosticOperationResult {
  actionId: string;
  ok: boolean;
  operation: string;
  risk?: RiskLevel;
  message?: string;
}

/** Event marker on the shared time axis (§16 Event-Marker, §20 DTC events). */
export interface MarkerInfo {
  markerId: string;
  /** Monotonic milliseconds since recording start — the shared chart axis. */
  t: number;
  timestamp: string;
  label: string;
  kind: "dtc" | "action" | "note" | "user" | "anomaly";
  detail?: string;
}

/** A signal known from a definition package — for pickers and signal lists. */
export interface SignalInfo {
  signalId: string;
  name: string;
  unit?: string;
  /** Signals flagged important by the definition package (§14). */
  critical: boolean;
}

/** Window statistics for one recorded signal (§16 Min/Max/Durchschnitt/Delta). */
export interface SignalStatisticsInfo {
  signalId: string;
  name: string;
  unit?: string;
  samples: number;
  min: number | null;
  max: number | null;
  average: number | null;
  delta: number | null;
  first: number | null;
  last: number | null;
  outOfRangeCount: number;
}

/** A recorded anomaly — a signal left its declared range (§14, §20). */
export interface AnomalyInfo {
  signalId: string;
  reason: string;
  value?: number;
}

/** The complete recording: samples plus markers (§16/§17). */
export interface RecordingHistory {
  /** Wall clock at recording start (ms since epoch). */
  startedAt: number;
  samples: readonly MeasurementReading[];
  markers: readonly MarkerInfo[];
}

/** Live state of the measurement engine. */
export interface MeasurementStatus {
  live: boolean;
}

/** One decoded value inside a freeze frame (raw and decoded side by side). */
export interface FreezeFrameValueInfo {
  signalId: string;
  name: string;
  value: number | string | boolean;
  unit?: string;
  rawHex: string;
  outOfRange: boolean;
}

/** One documented field of a freeze frame record. */
export interface FreezeFrameFieldInfo {
  did: number;
  name: string;
  rawHex: string;
  values: readonly FreezeFrameValueInfo[];
}

/**
 * Decoded freeze frame (snapshot) of one fault code (§20).
 *
 * Raw bytes travel with the decoded values: a record whose layout no
 * definition documents stays visible as evidence instead of disappearing.
 */
export interface FreezeFrameInfo {
  code: string;
  recordNumber: number;
  /** True when every byte of the record is covered by a documented field. */
  documented: boolean;
  fields: readonly FreezeFrameFieldInfo[];
  /** Bytes no documented field claimed, as hex (empty when fully documented). */
  unassignedHex: string;
  notes: readonly string[];
}

/**
 * Safety pre-check for a fault-memory clear (§26): what still has to happen
 * before the write is permitted. Read-only — nothing is written or permitted.
 */
export interface DtcClearPrecheckInfo {
  ecuId: string;
  ecuName: string;
  ok: boolean;
  failed: string[];
  warnings: string[];
}
