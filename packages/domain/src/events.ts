/**
 * Domain event catalogue (target architecture §10: "Event-System").
 *
 * Events are how the rest of the platform — UI, logger, session recorder,
 * telemetry, AI — observes diagnostics without the diagnostic code knowing
 * its observers. Payloads carry the correlation ids (§24/§25), so consumers
 * can reconstruct which session, ECU and action an event belongs to.
 *
 * The catalogue is deliberately closed: new event names are a compile-time
 * decision, not a stringly-typed free-for-all.
 */

import type { DiagnosticCapability } from "./capabilities.js";
import type { RiskLevel, WriteOperationKind } from "./risk.js";

export interface VehicleConnectedPayload {
  sessionId: string;
  vin?: string;
  ecuCount: number;
}

export interface VehicleDisconnectedPayload {
  sessionId: string;
  durationMs: number | null;
}

export interface EcuDiscoveredPayload {
  sessionId: string;
  ecuId: string;
  name: string;
  txId: number;
  rxId: number;
  reachable: boolean;
}

export interface EcuCapabilitiesUpdatedPayload {
  ecuId: string;
  capabilities: DiagnosticCapability[];
}

export interface DtcsReadPayload {
  sessionId: string;
  /** Undefined when the scan covered every ECU. */
  ecuId?: string;
  ecuCount: number;
  dtcCount: number;
}

export interface DtcsClearedPayload {
  sessionId: string;
  ecuId: string;
  clearedCount: number;
  remainingCount: number;
  verified: boolean;
}

export interface DidReadPayload {
  sessionId: string;
  ecuId: string;
  did: number;
  byteLength: number;
}

export interface MeasurementsRecordedPayload {
  sessionId: string;
  sampleCount: number;
  signalIds: string[];
}

export interface SafetyApprovalRequestedPayload {
  actionId: string;
  operation: WriteOperationKind;
  risk: RiskLevel;
  ecuId: string;
}

export interface SafetyApprovalGrantedPayload {
  actionId: string;
  permitId: string;
  ecuId: string;
}

export interface SafetyApprovalDeniedPayload {
  actionId: string;
  ecuId: string;
  reasons: string[];
}

export interface ActionExecutedPayload {
  actionId: string;
  operation: WriteOperationKind;
  ecuId: string;
  ok: boolean;
  detail?: string;
}

export interface DiagnosticErrorPayload {
  sessionId?: string;
  ecuId?: string;
  phase: string;
  message: string;
}

export interface DiagnosticEventMap {
  "vehicle-connected": VehicleConnectedPayload;
  "vehicle-disconnected": VehicleDisconnectedPayload;
  "ecu-discovered": EcuDiscoveredPayload;
  "ecu-capabilities-updated": EcuCapabilitiesUpdatedPayload;
  "dtcs-read": DtcsReadPayload;
  "dtcs-cleared": DtcsClearedPayload;
  "did-read": DidReadPayload;
  "measurements-recorded": MeasurementsRecordedPayload;
  "safety-approval-requested": SafetyApprovalRequestedPayload;
  "safety-approval-granted": SafetyApprovalGrantedPayload;
  "safety-approval-denied": SafetyApprovalDeniedPayload;
  "action-executed": ActionExecutedPayload;
  "diagnostic-error": DiagnosticErrorPayload;
}

export type DiagnosticEventName = keyof DiagnosticEventMap;

export const DIAGNOSTIC_EVENT_NAMES: readonly DiagnosticEventName[] = [
  "vehicle-connected",
  "vehicle-disconnected",
  "ecu-discovered",
  "ecu-capabilities-updated",
  "dtcs-read",
  "dtcs-cleared",
  "did-read",
  "measurements-recorded",
  "safety-approval-requested",
  "safety-approval-granted",
  "safety-approval-denied",
  "action-executed",
  "diagnostic-error",
];
