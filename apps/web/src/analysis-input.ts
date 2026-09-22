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

import type {
  AnalysisCheck,
  AnalysisDtc,
  AnalysisEvidence,
  AnalysisInput,
  AnalysisVersions,
} from "@vdp/ai";
import { type EvidenceItem, describeEvidence, itemsOf } from "@vdp/diagnostic-ir";
import type { AnomalyInfo, SignalStatisticsInfo, VehicleSummary } from "@vdp/domain";
import type { EvidenceSnapshot } from "@vdp/runtime";
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
export function analysisDtcOf(
  dtc: AnalysisDtcSource,
  /** The IR item behind this row, when the caller has one (see `buildAnalysisInput`). */
  item?: EvidenceItem,
): AnalysisDtc {
  const knowledge = dtc.knowledge;
  const checks = knowledge?.patterns[0]?.checks ?? [];
  const measure = checks.find((check) => check.measurable) ?? checks[0];
  const evidence = evidenceOf(item);
  return {
    code: dtc.code,
    description: dtc.description,
    severity: dtc.severity,
    ecu: dtc.ecu,
    ...(dtc.hint !== undefined ? { hint: dtc.hint } : {}),
    ...(knowledge !== undefined ? { scope: knowledge.scope } : {}),
    ...(knowledge?.conditions !== undefined ? { conditions: knowledge.conditions } : {}),
    ...(measure === undefined ? {} : { measure: checkOf(measure) }),
    ...(evidence === undefined ? {} : { evidence }),
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

/**
 * The whole analysis input, assembled in one place (P0 #39/#42, ADR 0038).
 *
 * `analyze()` used to build this object field by field in the backend. That had two
 * costs: the backend grew by thirty lines of mapping that no test could reach without
 * a running session, and the evidence the answer rests on was not in it at all. Both
 * are fixed here — the mapping is one exported function, and the IR's evidence set is
 * one of its inputs.
 *
 * What it does **not** do: decide anything. Every field is a projection of a read
 * model the caller already has, and the only judgement left to a provider is which
 * statement it can back.
 */
export interface AnalysisSources {
  session: VehicleSessionData | undefined;
  identity: VehicleSummary | undefined;
  dtcs: readonly AnalysisDtcSource[];
  statistics: readonly SignalStatisticsInfo[];
  anomalies: readonly AnomalyInfo[];
  /** The runtime's evidence snapshot — items to cite, hypotheses to weigh. */
  evidence: EvidenceSnapshot;
  versions: AnalysisVersions;
  /**
   * The scenario the bench script of this session was (master prompt §14). The
   * backend records it when a scenario run completes; without one the field
   * stays absent, and the answer is about field data, not a simulation.
   */
  scenario?: AnalysisInput["scenario"];
  /**
   * The loop state the session was evaluated in (ADR 0050): the leading
   * hypothesis with its for/against evidence and the test that reduces the
   * uncertainty the most. Assembled once by the runtime — the provider cites
   * it, it does not re-derive it.
   */
  diagnosis?: AnalysisInput["diagnosis"];
}

export function buildAnalysisInput(sources: AnalysisSources): AnalysisInput {
  const { session, evidence } = sources;
  const vehicle = analysisVehicleOf(sources.identity, session?.determination);
  const ecuNames = new Map((session?.ecus ?? []).map((ecu) => [ecu.id, ecu.name]));
  return {
    ...(vehicle !== undefined ? { vehicle } : {}),
    // No odometer reading is an absent input, not a present zero: a provider must not
    // read "unknown mileage" as "0 km" (AGENTS 22).
    ...(session?.mileageKm !== undefined ? { mileageKm: session.mileageKm } : {}),
    signals: sources.statistics.map(signalOf),
    dtcs: sources.dtcs.map((dtc) =>
      analysisDtcOf(dtc, evidenceItemFor(evidence.evidence, dtc, ecuNames)),
    ),
    anomalies: sources.anomalies.map((anomaly) => ({
      signal: anomaly.signalId,
      reason: anomaly.reason,
      ...(anomaly.value !== undefined ? { value: anomaly.value } : {}),
    })),
    notes: (session?.notes ?? []).map((note) => note.text),
    evidence: evidence.evidence,
    hypotheses: evidence.hypotheses,
    ...(session?.id !== undefined ? { recordingId: session.id } : {}),
    ...(sources.scenario !== undefined ? { scenario: sources.scenario } : {}),
    ...(sources.diagnosis !== undefined ? { diagnosis: sources.diagnosis } : {}),
    versions: sources.versions,
  };
}

function signalOf(stat: SignalStatisticsInfo): AnalysisInput["signals"][number] {
  return {
    signal: stat.signalId,
    name: stat.name,
    ...(stat.unit !== undefined ? { unit: stat.unit } : {}),
    samples: stat.samples,
    // `null` means "no numeric value was recorded"; a summary type that carries
    // numbers needs a number, and 0 says "no spread" — the sample count next to it
    // is what tells the two apart, which is why it is passed along unrounded.
    min: stat.min ?? 0,
    max: stat.max ?? 0,
    average: stat.average ?? 0,
    delta: stat.delta ?? 0,
    outOfRangeCount: stat.outOfRangeCount,
  };
}

/**
 * The evidence item behind one fault-code row.
 *
 * Matched on code and on the ECU *name the row shows* — the row has no ECU id, and
 * resolving it through the session's ECU list is exact rather than a search for a
 * similar string. No item means the row did not come from this session's scan (an
 * older read model, a hand-built fixture), and the analysis then has nothing to cite
 * for it — which is reported by leaving `evidence` out, not by claiming the row was
 * proven.
 */
function evidenceItemFor(
  set: EvidenceSnapshot["evidence"],
  dtc: AnalysisDtcSource,
  ecuNames: ReadonlyMap<string, string>,
): EvidenceItem | undefined {
  return itemsOf(set, "dtc").find((item) => {
    if (item.subject !== dtc.code) return false;
    if (item.ecuId === undefined) return true;
    return ecuNames.get(item.ecuId) === dtc.ecu;
  });
}

function evidenceOf(item: EvidenceItem | undefined): AnalysisEvidence | undefined {
  if (item === undefined) return undefined;
  return {
    proven: item.evidence.kind === "proven",
    line: describeEvidence(item.evidence),
    itemId: item.id,
  };
}
