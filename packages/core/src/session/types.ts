/**
 * Determination record types of a session (AGENTS 11/11.1, ADR 0026).
 *
 * A type-only module, like `measurements/types.ts`: nothing here produces runtime
 * code, which is also why the resolver's richer `VehicleCandidate` from the
 * definitions layer is not reused. A session record is written to disk, read by the
 * report builder — which may import `@vdp/core` and nothing else — and quoted by the
 * analysis layer, so the shape has to live where all three can reach it.
 *
 * The rule that keeps this honest: a determination states the share of *evaluated*
 * criteria and the contradictions; it never states certainty. `match` is absent
 * exactly when nothing had positive evidence, and then `reason` carries why — §11.1
 * rule 3: an empty result is a valid answer with a reason, never an empty mask.
 */

/** One criterion that spoke for or against the recorded candidate (§11.1 rule 2). */
export interface VehicleDeterminationEvidence {
  /** Criterion name as the definitions layer reports it, e.g. `part-number`. */
  kind: string;
  /** What was observed on the bus or declared by the operator. */
  observed: string;
  /** What the definition expected. */
  expected: string;
  /** Weight this criterion carried (fractional for coverage ratios). */
  weight: number;
  /** One sentence, shown next to the result in report and analysis. */
  reason: string;
}

/** The candidate a session decided on, with the evidence that produced it. */
export interface VehicleMatch {
  /** Manufacturer key of the package the match comes from. */
  oem: string;
  /** Exact package version, so a report can name what the claim rests on (AGENTS 13). */
  packageVersion: string;
  vehicleId: string;
  brand: string;
  model: string;
  platform?: string;
  /** 0…1 — share of the evaluated weights that support this candidate (§11.1 rule 2). */
  score: number;
  /** 0…1 — provenance trust; placeholder data ranks below real data (§11.1 rule 8). */
  trust: number;
  /** Source type of the winning data (`own`, `standard`, `licensed`, …, AGENTS 24). */
  provenanceType?: string;
  /** Powertrains the evidence narrowed down; empty means "not narrowed". */
  engineIds: readonly string[];
  gearboxIds: readonly string[];
  /** ECU coverage the definition expects against what actually answered. */
  ecus: { expected: number; matched: number; missing: readonly string[] };
  evidence: readonly VehicleDeterminationEvidence[];
  /** Contradictions stay visible — they are not netted into the score (§11.1 rule 4). */
  conflicts: readonly VehicleDeterminationEvidence[];
}

/**
 * One resolution attempt of one session.
 *
 * `resolvedAt` is when the resolver ran, not when the session started: a session can
 * resolve again after the operator supplies a part number, and the report has to be
 * able to say which of the two the record describes.
 *
 * The record never rewrites the measured identity (`VehicleIdentity`): the identity
 * holds what was *read* — VIN, DIDs, the ECUs that answered —, this holds what was
 * *concluded*. A conclusion that appears among its own premises confirms itself; see
 * the regression entry "a resolved vehicle confirmed itself in the next resolution".
 */
export interface VehicleDetermination {
  resolvedAt: string;
  /** Absent when no candidate had positive evidence. */
  match?: VehicleMatch;
  /** Why nothing matched — required by §11.1 rule 3 whenever `match` is absent. */
  reason?: string;
  /** Context to show next to the result (placeholder data, unknown WMI, …). */
  notes: readonly string[];
  /** Observations no registered definition could explain. */
  unexplained: readonly string[];
  /**
   * Candidates ranked below the winner, reduced to what a reader can weigh: a stored
   * session keeps that the answer was a ranking, not a single fact (§11.1 rule 1).
   * The full candidate list is deliberately not persisted — it is recomputable, and a
   * second copy of it would be a second source of truth.
   */
  alternatives: ReadonlyArray<{ vehicleId: string; oem: string; score: number }>;
}
