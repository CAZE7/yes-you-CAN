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
  DtcVariantKnowledge,
  EcuSession,
  EnrichedDtc,
  FreezeFrame,
  Marker,
  MeasurementSample,
  SignalStatistics,
  VehicleDetermination,
  VehicleIdentity,
  VehicleSession,
} from "@vdp/core";
import { type StageReport, describeVehicle } from "@vdp/core";
import type { SignalDefinition } from "@vdp/definitions";
import type {
  AnomalyInfo,
  ClearDtcOutcome,
  DtcInfo,
  DtcKnowledgeInfo,
  EcuSummary,
  FreezeFrameInfo,
  MarkerInfo,
  MeasurementReading,
  SessionSummary,
  SignalInfo,
  SignalStatisticsInfo,
  VehicleSummary,
  WriteStageInfo,
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
  determination?: VehicleDetermination,
): VehicleSummary | undefined {
  const match = determination?.match;
  if (!identity && !match) return undefined;
  // The determination fills what the bus did not answer: brand and model are the
  // resolver's facts just as much as the VIN is, and a session that resolved a car
  // must not report it as "unknown vehicle" because no ECU answered 0xF190.
  const known: VehicleIdentity = identity ?? {};
  const brand = known.brand ?? match?.brand;
  const model = known.model ?? match?.model;
  const platform = known.platform ?? match?.platform;
  // Under `exactOptionalPropertyTypes` (ADR 0029 §3) an absent field is an absent
  // property, not one that holds `undefined`: the description is built with
  // conditional spreads so a car without a brand string stays a car without that
  // field, exactly like the summary above it.
  const described: VehicleIdentity = {
    ...known,
    ...(brand !== undefined ? { brand } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(platform !== undefined ? { platform } : {}),
  };
  return {
    ...(match !== undefined ? { vehicleId: match.vehicleId } : {}),
    ...(known.vin !== undefined ? { vin: known.vin } : {}),
    ...(known.manufacturer !== undefined ? { manufacturer: known.manufacturer } : {}),
    ...(brand !== undefined ? { brand } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(known.modelYear !== undefined ? { modelYear: known.modelYear } : {}),
    ...(platform !== undefined ? { platform } : {}),
    description: describeVehicle(described),
  };
}

export function toSessionSummary(session: VehicleSession): SessionSummary {
  const data = session.data;
  const counts = session.summary();
  const vehicle = toVehicleSummary(data.vehicle, data.determination);
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

/**
 * Variant knowledge → read model (§20, §23).
 *
 * Field names follow the domain's (`signalId`/`name` like every other reading),
 * and nothing is added: what the definitions layer could not document stays
 * absent, so the UI cannot show a completeness the data does not have.
 */
export function toDtcKnowledge(knowledge: DtcVariantKnowledge): DtcKnowledgeInfo {
  const result: DtcKnowledgeInfo = {
    scope: knowledge.scope,
    patterns: knowledge.patterns.map((pattern) => ({
      id: pattern.id,
      name: pattern.name,
      scope: pattern.scope,
      checks: pattern.checks.map((check) => ({
        signalId: check.signal,
        name: check.signalName,
        expect: check.expect,
        measurable: check.measurable,
        ...(check.min !== undefined ? { min: check.min } : {}),
        ...(check.max !== undefined ? { max: check.max } : {}),
        ...(check.windowMs !== undefined ? { windowMs: check.windowMs } : {}),
      })),
      ...(pattern.explanation !== undefined ? { explanation: pattern.explanation } : {}),
      ...(pattern.likelihood !== undefined ? { likelihood: pattern.likelihood } : {}),
      ...(pattern.repair !== undefined ? { repair: pattern.repair } : {}),
    })),
    notes: [...knowledge.notes],
    ...(knowledge.vehicleId !== undefined ? { vehicleId: knowledge.vehicleId } : {}),
    ...(knowledge.conditions !== undefined ? { conditions: knowledge.conditions } : {}),
    ...(knowledge.provenanceType !== undefined ? { provenanceType: knowledge.provenanceType } : {}),
    ...(knowledge.provenanceSource !== undefined
      ? { provenanceSource: knowledge.provenanceSource }
      : {}),
  };
  return result;
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
    ...(dtc.knowledge !== undefined ? { knowledge: toDtcKnowledge(dtc.knowledge) } : {}),
    ...(dtc.evidence !== undefined ? { evidence: dtc.evidence } : {}),
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

/**
 * A write stage as domain data (AGENTS 26).
 *
 * The core reports stages with timestamps and details; the domain keeps the
 * three things a caller reasons about — which stage, how it ended, and why.
 */
export function toWriteStageInfo(stage: StageReport): WriteStageInfo {
  return {
    stage: stage.stage,
    state: stage.state,
    reasons: [...stage.reasons],
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
