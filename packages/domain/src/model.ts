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
  severity?: string;
  description?: string;
  /** Suggested next diagnostic step from the definition package. */
  hint?: string;
  firstSeen?: string;
  lastSeen?: string;
  relatedSignals?: string[];
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
