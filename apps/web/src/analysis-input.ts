/**
 * Analysis input from the read models the workbench already holds (AGENTS 22, ADR 0026).
 *
 * `analyze()` used to send fault codes and signal statistics and nothing else: the
 * provider could not tell which car it was reasoning about, and a code's description
 * looked like a statement about that car even when the package only documents it
 * manufacturer-wide. This module carries the two things that make the difference
 * visible — the vehicle with the strength of its determination, and, per code, where
 * the wording came from plus the first documented check.
 *
 * What stays out on purpose: the VIN (the HTTP provider forwards this object off the
 * box, AGENTS 27) and the German label fields of the knowledge view (vocabulary belongs
 * to the screen, not to a provider contract — `DtcCheckView.measurable` and its numbers
 * are what a rule engine can act on).
 */

import type { AnalysisCheck, AnalysisDtc, AnalysisInput } from "@vdp/ai";
import type { VehicleSummary } from "@vdp/domain";
import type { VehicleSessionData } from "@vdp/storage";

/** The determination record as the session stores it, without naming core's types. */
type Determination = VehicleSessionData["determination"];

/**
 * The part of a fault-code row the analysis reads.
 *
 * Declared here instead of importing `DtcView` from `backend.ts`: the backend is the
 * caller, and a mapper that depends back on its caller is a cycle. The shape is
 * structural, so the row satisfies it without either side knowing the other's name.
 */
export interface AnalysisDtcSource {
  code: string;
  description: string;
  severity: string;
  ecu: string;
  hint?: string;
  knowledge?: {
    scope: string;
    conditions?: string;
    patterns: ReadonlyArray<{
      checks: ReadonlyArray<{
        signalId: string;
        name: string;
        expect: string;
        measurable: boolean;
        min?: number;
        max?: number;
        windowMs?: number;
      }>;
    }>;
  };
}

/** Which vehicle the session was determined to be, and how solid that was. */
export function analysisVehicleOf(
  identity: VehicleSummary | undefined,
  determination: Determination,
): AnalysisInput["vehicle"] {
  const match = determination?.match;
  const vehicle: NonNullable<AnalysisInput["vehicle"]> = {};
  if (identity?.brand !== undefined) vehicle.brand = identity.brand;
  if (identity?.model !== undefined) vehicle.model = identity.model;
  if (identity?.modelYear !== undefined) vehicle.modelYear = identity.modelYear;
  if (match !== undefined) {
    vehicle.vehicleId = match.vehicleId;
    vehicle.score = match.score;
    vehicle.trust = match.trust;
    if (match.provenanceType !== undefined) vehicle.provenanceType = match.provenanceType;
  }
  // The reason survives even when nothing matched: "no candidate had positive
  // evidence" is information the analysis has to pass on instead of answering about
  // an unnamed car (§11.1 rule 3).
  if (match === undefined && determination?.reason !== undefined) {
    vehicle.unresolvedReason = determination.reason;
  }
  return Object.keys(vehicle).length > 0 ? vehicle : undefined;
}

/**
 * One fault code with the reach of its own wording.
 *
 * The first *evaluable* check is preferred, because that is the one an instrument can
 * run; when only a judgement check is documented, it is passed with `measurable: false`
 * rather than dressed up as a measurement (§22: no false certainty).
 */
export function analysisDtcOf(dtc: AnalysisDtcSource): AnalysisDtc {
  const knowledge = dtc.knowledge;
  const checks = knowledge?.patterns[0]?.checks ?? [];
  const measure = checks.find((check) => check.measurable) ?? checks[0];
  return {
    code: dtc.code,
    description: dtc.description,
    severity: dtc.severity,
    ecu: dtc.ecu,
    ...(dtc.hint !== undefined ? { hint: dtc.hint } : {}),
    ...(knowledge !== undefined ? { scope: knowledge.scope } : {}),
    ...(knowledge?.conditions !== undefined ? { conditions: knowledge.conditions } : {}),
    ...(measure === undefined ? {} : { measure: checkOf(measure) }),
  };
}

function checkOf(
  check: NonNullable<AnalysisDtcSource["knowledge"]>["patterns"][number]["checks"][number],
): AnalysisCheck {
  return {
    signal: check.signalId,
    ...(check.name !== undefined && check.name !== check.signalId ? { name: check.name } : {}),
    expect: check.expect,
    ...(check.min !== undefined ? { min: check.min } : {}),
    ...(check.max !== undefined ? { max: check.max } : {}),
    ...(check.windowMs !== undefined ? { windowMs: check.windowMs } : {}),
    measurable: check.measurable,
  };
}
