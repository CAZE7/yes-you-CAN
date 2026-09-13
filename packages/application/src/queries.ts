/**
 * Queries — read-only operations (target architecture §9).
 *
 * Queries never change state. Today they are served by reading the live
 * engine/session state; later they can be served from a dedicated read model
 * without changing the query objects or the callers.
 */

import type {
  AnomalyInfo,
  DiagnosticCapability,
  DtcClearPrecheckInfo,
  DtcInfo,
  EcuSummary,
  MarkerInfo,
  MeasurementReading,
  MeasurementStatus,
  RecordingHistory,
  SessionSummary,
  SignalInfo,
  SignalStatisticsInfo,
  VehicleResolutionRef,
  VehicleStateReading,
  VehicleSummary,
} from "@vdp/domain";
import type { ActionDescriptor } from "./actions.js";
import type { Query } from "./command-bus.js";

export const QueryKinds = {
  GetSession: "session.get",
  GetVehicle: "vehicle.get",
  ResolveVehicle: "vehicle.resolve",
  GetEcuList: "ecu.list",
  GetEcu: "ecu.get",
  GetEcuCapabilities: "ecu.capabilities",
  GetDtcList: "dtc.list",
  GetDtcClearPrecheck: "dtc.clear-precheck",
  GetMeasurements: "measurement.list",
  GetMeasurementStatus: "measurement.status",
  GetStatistics: "measurement.statistics",
  GetAnomalies: "measurement.anomalies",
  GetSignalList: "signal.list",
  GetMarkers: "marker.list",
  GetRecordingHistory: "recording.get",
  GetAvailableActions: "actions.available",
} as const;

export type QueryKind = (typeof QueryKinds)[keyof typeof QueryKinds];

export interface GetSessionQuery extends Query<SessionSummary | undefined> {
  readonly kind: typeof QueryKinds.GetSession;
}

export function getSession(): GetSessionQuery {
  return { kind: QueryKinds.GetSession };
}

export interface GetVehicleQuery extends Query<VehicleSummary | undefined> {
  readonly kind: typeof QueryKinds.GetVehicle;
}

export function getVehicle(): GetVehicleQuery {
  return { kind: QueryKinds.GetVehicle };
}

/**
 * What the caller adds to the vehicle resolution on top of what the session
 * already knows (§11). Everything is optional — a resolution without hints uses
 * the VIN, the identification values and the discovered ECUs of the live session.
 */
export interface ResolveVehicleHints {
  /** Use this VIN instead of the one read from the vehicle. */
  vin?: string;
  /** Claims about the car: operator input, a previous session, a work order. */
  declared?: {
    oem?: string;
    brand?: string;
    model?: string;
    platform?: string;
    modelYear?: number;
  };
}

export interface ResolveVehicleQuery extends Query<VehicleResolutionRef> {
  readonly kind: typeof QueryKinds.ResolveVehicle;
  readonly hints?: ResolveVehicleHints;
}

/**
 * Which vehicle is connected — ranked candidates with evidence (§11).
 *
 * A query, not a command: resolving changes nothing on the bus. It answers with
 * hypotheses and the reasons behind them, never with a single asserted fact, so
 * callers cannot mistake a guess for knowledge.
 */
export function resolveVehicle(hints?: ResolveVehicleHints): ResolveVehicleQuery {
  return hints === undefined
    ? { kind: QueryKinds.ResolveVehicle }
    : { kind: QueryKinds.ResolveVehicle, hints };
}

export interface GetEcuListQuery extends Query<readonly EcuSummary[]> {
  readonly kind: typeof QueryKinds.GetEcuList;
}

export function getEcuList(): GetEcuListQuery {
  return { kind: QueryKinds.GetEcuList };
}

export interface GetEcuQuery extends Query<EcuSummary | undefined> {
  readonly kind: typeof QueryKinds.GetEcu;
  readonly ecuId: string;
}

export function getEcu(ecuId: string): GetEcuQuery {
  return { kind: QueryKinds.GetEcu, ecuId };
}

export interface GetEcuCapabilitiesQuery extends Query<readonly DiagnosticCapability[]> {
  readonly kind: typeof QueryKinds.GetEcuCapabilities;
  readonly ecuId: string;
}

export function getEcuCapabilities(ecuId: string): GetEcuCapabilitiesQuery {
  return { kind: QueryKinds.GetEcuCapabilities, ecuId };
}

export interface GetDtcListQuery extends Query<readonly DtcInfo[]> {
  readonly kind: typeof QueryKinds.GetDtcList;
  /** Restrict to one ECU; undefined means "all ECUs of the last scan". */
  readonly ecuId?: string;
}

export function getDtcList(ecuId?: string): GetDtcListQuery {
  return ecuId === undefined
    ? { kind: QueryKinds.GetDtcList }
    : { kind: QueryKinds.GetDtcList, ecuId };
}

export interface GetMeasurementsQuery extends Query<readonly MeasurementReading[]> {
  readonly kind: typeof QueryKinds.GetMeasurements;
  readonly signalId?: string;
}

export function getMeasurements(signalId?: string): GetMeasurementsQuery {
  return signalId === undefined
    ? { kind: QueryKinds.GetMeasurements }
    : { kind: QueryKinds.GetMeasurements, signalId };
}

export interface GetAvailableActionsQuery extends Query<readonly ActionDescriptor[]> {
  readonly kind: typeof QueryKinds.GetAvailableActions;
  /** Context ECU; omitted evaluates vehicle-level actions only. */
  readonly ecuId?: string;
}

export function getAvailableActions(ecuId?: string): GetAvailableActionsQuery {
  return ecuId === undefined
    ? { kind: QueryKinds.GetAvailableActions }
    : { kind: QueryKinds.GetAvailableActions, ecuId };
}

export interface GetDtcClearPrecheckQuery extends Query<DtcClearPrecheckInfo> {
  readonly kind: typeof QueryKinds.GetDtcClearPrecheck;
  /** ECU reference: session id, definition id or "0x…" address. */
  readonly ecuId: string;
  readonly vehicleState: VehicleStateReading;
}

/**
 * What the safety chain still requires before a clear is permitted (AGENTS 26).
 * Read-only: nothing is written and no permit is issued.
 */
export function getDtcClearPrecheck(
  ecuId: string,
  vehicleState: VehicleStateReading,
): GetDtcClearPrecheckQuery {
  return { kind: QueryKinds.GetDtcClearPrecheck, ecuId, vehicleState };
}

export interface GetSignalListQuery extends Query<readonly SignalInfo[]> {
  readonly kind: typeof QueryKinds.GetSignalList;
}

/** Every signal the attached ECUs can deliver, per definition package. */
export function getSignalList(): GetSignalListQuery {
  return { kind: QueryKinds.GetSignalList };
}

export interface GetMarkersQuery extends Query<readonly MarkerInfo[]> {
  readonly kind: typeof QueryKinds.GetMarkers;
}

export function getMarkers(): GetMarkersQuery {
  return { kind: QueryKinds.GetMarkers };
}

export interface GetStatisticsQuery extends Query<readonly SignalStatisticsInfo[]> {
  readonly kind: typeof QueryKinds.GetStatistics;
}

export function getStatistics(): GetStatisticsQuery {
  return { kind: QueryKinds.GetStatistics };
}

export interface GetAnomaliesQuery extends Query<readonly AnomalyInfo[]> {
  readonly kind: typeof QueryKinds.GetAnomalies;
}

export function getAnomalies(): GetAnomaliesQuery {
  return { kind: QueryKinds.GetAnomalies };
}

export interface GetRecordingHistoryQuery extends Query<RecordingHistory> {
  readonly kind: typeof QueryKinds.GetRecordingHistory;
  /** Keep only the newest N samples; unlimited when omitted. */
  readonly limit?: number;
}

export function getRecordingHistory(limit?: number): GetRecordingHistoryQuery {
  return limit === undefined
    ? { kind: QueryKinds.GetRecordingHistory }
    : { kind: QueryKinds.GetRecordingHistory, limit };
}

export interface GetMeasurementStatusQuery extends Query<MeasurementStatus> {
  readonly kind: typeof QueryKinds.GetMeasurementStatus;
}

export function getMeasurementStatus(): GetMeasurementStatusQuery {
  return { kind: QueryKinds.GetMeasurementStatus };
}
