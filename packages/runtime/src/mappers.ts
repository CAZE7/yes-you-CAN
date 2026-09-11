/**
 * Mappers: engine/core state → domain projections (ADR 0014 Phase 1).
 *
 * Clients of the runtime never see engine internals; they receive the domain
 * contracts from `@vdp/domain`. These functions are the single place where
 * the two worlds meet, so the engine can be decomposed (Phase 4) without
 * changing the outward API.
 */

import type { ClearDtcResult, DecodedSignal, EnrichedDtc, EcuSession, MeasurementSample, VehicleIdentity, VehicleSession } from '@vdp/core';
import { describeVehicle } from '@vdp/core';
import type { ClearDtcOutcome, DtcInfo, EcuSummary, MeasurementReading, SessionSummary, VehicleSummary } from '@vdp/domain';
import { capabilitiesFromServices } from './capability-map.js';

export function toEcuSummary(record: EcuSession): EcuSummary {
  return {
    ecuId: record.id,
    ...(record.definitionEcuId !== undefined ? { definitionEcuId: record.definitionEcuId } : {}),
    name: record.name,
    protocol: record.protocol,
    txId: record.txId,
    rxId: record.rxId,
    extended: record.extended,
    reachable: record.reachable,
    sessionType: record.sessionType,
    capabilities: capabilitiesFromServices(record.supportedServices),
    identification: record.identification.map((entry) => ({ ...entry })),
    ...(record.lastError !== undefined ? { lastError: record.lastError } : {}),
  };
}

export function toVehicleSummary(identity: VehicleIdentity | undefined): VehicleSummary | undefined {
  if (!identity) return undefined;
  return {
    ...(identity.vin !== undefined ? { vin: identity.vin } : {}),
    ...(identity.manufacturer !== undefined ? { manufacturer: identity.manufacturer } : {}),
    ...(identity.brand !== undefined ? { brand: identity.brand } : {}),
    ...(identity.model !== undefined ? { model: identity.model } : {}),
    ...(identity.modelYear !== undefined ? { modelYear: identity.modelYear } : {}),
    ...(identity.platform !== undefined ? { platform: identity.platform } : {}),
    description: describeVehicle(identity),
  };
}

export function toSessionSummary(session: VehicleSession): SessionSummary {
  const data = session.data;
  const counts = session.summary();
  const vehicle = toVehicleSummary(data.vehicle);
  return {
    sessionId: data.id,
    schemaVersion: data.schemaVersion,
    startedAt: data.startedAt,
    ...(data.endedAt !== undefined ? { endedAt: data.endedAt } : {}),
    ...(data.title !== undefined ? { title: data.title } : {}),
    ...(vehicle !== undefined ? { vehicle } : {}),
    ecuCount: counts.ecuCount,
    reachableEcuCount: counts.reachableEcuCount,
    dtcCount: counts.dtcCount,
    actionCount: counts.actionCount,
    measurementCount: counts.signalCount,
    ...(data.definitionPackage !== undefined ? { definitionPackage: { ...data.definitionPackage } } : {}),
  };
}

export function toDtcInfo(dtc: EnrichedDtc): DtcInfo {
  return {
    code: dtc.code,
    ecuId: dtc.ecuId,
    ecuName: dtc.ecuName,
    status: dtc.status,
    ...(dtc.severity !== undefined ? { severity: dtc.severity } : {}),
    ...(dtc.description !== undefined ? { description: dtc.description } : {}),
    ...(dtc.hint !== undefined ? { hint: dtc.hint } : {}),
    ...(dtc.firstSeen !== undefined ? { firstSeen: dtc.firstSeen } : {}),
    ...(dtc.lastSeen !== undefined ? { lastSeen: dtc.lastSeen } : {}),
    ...(dtc.relatedSignals !== undefined && dtc.relatedSignals.length > 0
      ? { relatedSignals: dtc.relatedSignals.map((signal) => signal.id) }
      : {}),
  };
}

export function toMeasurementReading(sample: MeasurementSample, name?: string): MeasurementReading {
  return {
    signalId: sample.signal,
    ...(name !== undefined ? { name } : {}),
    timestamp: sample.timestamp,
    t: sample.t,
    value: sample.value,
    rawValue: sample.rawValue,
    rawHex: sample.rawHex,
    ...(sample.unit !== undefined ? { unit: sample.unit } : {}),
    ...(sample.enumText !== undefined ? { enumText: sample.enumText } : {}),
    outOfRange: sample.outOfRange,
  };
}

/** Fallback for a decoded value that has not hit the recorder yet. */
export function decodedToReading(decoded: DecodedSignal, timestamp: string): MeasurementReading {
  return {
    signalId: decoded.signalId,
    name: decoded.name,
    timestamp,
    t: 0,
    value: decoded.value,
    rawValue: decoded.rawValue,
    rawHex: decoded.rawHex,
    ...(decoded.unit !== undefined ? { unit: decoded.unit } : {}),
    ...(decoded.enumText !== undefined ? { enumText: decoded.enumText } : {}),
    outOfRange: decoded.outOfRange,
  };
}

export function toClearDtcOutcome(result: ClearDtcResult, warnings: readonly string[] = []): ClearDtcOutcome {
  return {
    ok: result.cleared,
    verified: result.verified,
    ecuId: result.ecuId,
    ecuName: result.ecuName,
    beforeCount: result.before.length,
    afterCount: result.after.length,
    remainingCodes: result.after.map((dtc) => dtc.code),
    reasons: [...warnings],
    clearedAt: result.clearedAt,
    permitId: result.permit.id,
  };
}

export function deniedClearOutcome(ecuId: string, ecuName: string, reasons: readonly string[]): ClearDtcOutcome {
  return {
    ok: false,
    verified: false,
    ecuId,
    ecuName,
    beforeCount: 0,
    afterCount: 0,
    remainingCodes: [],
    reasons: [...reasons],
  };
}
