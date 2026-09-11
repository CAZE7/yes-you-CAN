/**
 * Queries — read-only operations (target architecture §9).
 *
 * Queries never change state. Today they are served by reading the live
 * engine/session state; later they can be served from a dedicated read model
 * without changing the query objects or the callers.
 */

import type { DiagnosticCapability, DtcInfo, EcuSummary, MeasurementReading, SessionSummary, VehicleSummary } from '@vdp/domain';
import type { Query } from './command-bus.js';
import type { ActionDescriptor } from './actions.js';

export const QueryKinds = {
  GetSession: 'session.get',
  GetVehicle: 'vehicle.get',
  GetEcuList: 'ecu.list',
  GetEcu: 'ecu.get',
  GetEcuCapabilities: 'ecu.capabilities',
  GetDtcList: 'dtc.list',
  GetMeasurements: 'measurement.list',
  GetAvailableActions: 'actions.available',
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
  return ecuId === undefined ? { kind: QueryKinds.GetDtcList } : { kind: QueryKinds.GetDtcList, ecuId };
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
