/**
 * Mappers: engine/core state → domain projections (ADR 0014 Phase 1).
 *
 * Clients of the runtime never see engine internals; they receive the domain
 * contracts from `@vdp/domain`. These functions are the single place where
 * the two worlds meet, so the engine can be decomposed (Phase 4) without
 * changing the outward API.
 */

import type {
  ClearDtcResult,
  DecodedSignal,
  EcuSession,
  EnrichedDtc,
  FreezeFrame,
  Marker,
  MeasurementSample,
  SignalStatistics,
  VehicleIdentity,
  VehicleSession,
} from "@vdp/core";
import { describeVehicle } from "@vdp/core";
import type { SignalDefinition } from "@vdp/definitions";
import type {
  AnomalyInfo,
  ClearDtcOutcome,
  DtcInfo,
  EcuSummary,
  FreezeFrameInfo,
  MarkerInfo,
  MeasurementReading,
  SessionSummary,
  SignalInfo,
  SignalStatisticsInfo,
  VehicleSummary,
} from "@vdp/domain";
import { capabilitiesFromServices } from "./capability-map.js";

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
    p2Ms: record.timing.p2Ms,
    dtcCount: record.dtcs?.length ?? 0,
    supportedServices: [...record.supportedServices],
    capabilities: capabilitiesFromServices(record.supportedServices),
    identification: record.identification.map((entry) => ({ ...entry })),
    ...(record.lastError !== undefined ? { lastError: record.lastError } : {}),
  };
}

export function toVehicleSummary(
  identity: VehicleIdentity | undefined,
): VehicleSummary | undefined {
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
    ...(data.definitionPackage !== undefined
      ? { definitionPackage: { ...data.definitionPackage } }
      : {}),
  };
}

export function toDtcInfo(dtc: EnrichedDtc): DtcInfo {
  return {
    code: dtc.code,
    ecuId: dtc.ecuId,
    ecuName: dtc.ecuName,
    status: dtc.status,
    raw: dtc.raw,
    failureType: dtc.failureType,
    confirmed: dtc.statusBits.confirmedDtc,
    pending: dtc.statusBits.pendingDtc,
    testFailed: dtc.statusBits.testFailed,
    hasFreezeFrame: (dtc.snapshot?.length ?? 0) > 0,
    ...(dtc.firstSeenInThisScan === true ? { firstSeenInThisScan: true } : {}),
    ...(dtc.severity !== undefined ? { severity: dtc.severity } : {}),
    ...(dtc.description !== undefined ? { description: dtc.description } : {}),
    ...(dtc.hint !== undefined ? { hint: dtc.hint } : {}),
    ...(dtc.firstSeen !== undefined ? { firstSeen: dtc.firstSeen } : {}),
    ...(dtc.lastSeen !== undefined ? { lastSeen: dtc.lastSeen } : {}),
    ...(dtc.relatedSignals !== undefined && dtc.relatedSignals.length > 0
      ? { relatedSignals: dtc.relatedSignals.map((signal) => ({ ...signal })) }
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

export function toClearDtcOutcome(
  result: ClearDtcResult,
  warnings: readonly string[] = [],
): ClearDtcOutcome {
  return {
    ok: result.cleared,
    verified: result.verified,
    ecuId: result.ecuId,
    ecuName: result.ecuName,
    beforeCount: result.before.length,
    afterCount: result.after.length,
    remainingCodes: result.after.map((dtc) => dtc.code),
    beforeCodes: result.before.map((dtc) => dtc.code),
    afterCodes: result.after.map((dtc) => dtc.code),
    removedCodes: result.comparison.removed.map((dtc) => dtc.code),
    // Codes whose status changed but which the ECU keeps: the fault condition
    // is still present (same view the operator saw before the runtime move).
    stillFailingCodes: result.comparison.changed.map((dtc) => dtc.code),
    unchangedCodes: result.comparison.unchanged.map((dtc) => dtc.code),
    reasons: [...warnings],
    clearedAt: result.clearedAt,
    permitId: result.permit.id,
  };
}

export function deniedClearOutcome(
  ecuId: string,
  ecuName: string,
  reasons: readonly string[],
): ClearDtcOutcome {
  return {
    ok: false,
    verified: false,
    ecuId,
    ecuName,
    beforeCount: 0,
    afterCount: 0,
    remainingCodes: [],
    beforeCodes: [],
    afterCodes: [],
    removedCodes: [],
    stillFailingCodes: [],
    unchangedCodes: [],
    reasons: [...reasons],
  };
}

export function toMarkerInfo(marker: Marker): MarkerInfo {
  return {
    markerId: marker.id,
    t: marker.t,
    timestamp: marker.timestamp,
    label: marker.label,
    kind: marker.kind,
    ...(marker.detail !== undefined ? { detail: marker.detail } : {}),
  };
}

export function toFreezeFrameInfo(frame: FreezeFrame): FreezeFrameInfo {
  return {
    code: frame.dtcCode,
    recordNumber: frame.recordNumber,
    documented: frame.documented,
    fields: frame.fields.map((field) => ({
      did: field.did,
      name: field.name,
      rawHex: field.rawHex,
      values: field.values.map((value) => ({
        signalId: value.signalId,
        name: value.name,
        value: value.value,
        rawHex: value.rawHex,
        outOfRange: value.outOfRange,
        ...(value.unit !== undefined ? { unit: value.unit } : {}),
      })),
    })),
    unassignedHex: frame.unassignedHex,
    notes: [...frame.notes],
  };
}

export function toSignalStatisticsInfo(stats: SignalStatistics): SignalStatisticsInfo {
  return {
    signalId: stats.signal,
    name: stats.name,
    ...(stats.unit !== undefined ? { unit: stats.unit } : {}),
    samples: stats.samples,
    min: stats.min,
    max: stats.max,
    average: stats.average,
    delta: stats.delta,
    first: stats.first,
    last: stats.last,
    outOfRangeCount: stats.outOfRangeCount,
  };
}

export function toAnomalyInfo(anomaly: {
  signal: string;
  reason: string;
  value?: number;
}): AnomalyInfo {
  return {
    signalId: anomaly.signal,
    reason: anomaly.reason,
    ...(anomaly.value !== undefined ? { value: anomaly.value } : {}),
  };
}

/** Signal catalogue entry from a definition package (read model for pickers). */
export function toSignalInfo(definition: SignalDefinition): SignalInfo {
  return {
    signalId: definition.id,
    name: definition.name,
    ...(definition.unit !== undefined ? { unit: definition.unit } : {}),
    critical: definition.critical ?? false,
  };
}
