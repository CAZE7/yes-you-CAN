/**
 * Fault knowledge per vehicle variant (AGENTS 20, 23).
 *
 * A fault code has two very different answers. What `P0420` *means* is standard
 * wording and lives with the ECU definition of a package. What `P0420` *implies
 * for this car* — which causes are plausible with this engine, which measuring
 * points confirm them, whether the code only sets after three cold drive cycles —
 * is variant knowledge, and it is the difference between a fault list and a
 * diagnosis.
 *
 * This module owns the second answer. It never invents one: knowledge is either
 * declared for the resolved vehicle (optionally narrowed to its engine or
 * gearbox), or the answer falls back to the package-wide description and *says*
 * that it did (§24 — an undocumented fault stays visibly undocumented).
 *
 * Patterns are collected from every applicable entry instead of only the most
 * specific one: an engine-specific cause and a variant-wide cause are
 * complementary, not competing, and dropping the wider one would hide documented
 * knowledge just because a narrower entry exists.
 */

import type { VehicleCandidate } from "./resolve.js";
import {
  type DefinitionPackage,
  type DtcKnowledgeDefinition,
  type FailurePatternDefinition,
  indexVehicles,
  type MeasurementCheckDefinition,
  type Provenance,
  type VehicleDefinition,
} from "./schema.js";

/** Where the winning statement about a fault code came from. */
export type DtcKnowledgeScope = "vehicle-engine" | "vehicle-gearbox" | "vehicle" | "package";

export interface DtcKnowledgeQuery {
  /** Character form of the code, e.g. "P0420"; compared case-insensitively. */
  code: string;
  /** Bare ECU id of the package the code was read from (not "<oem>:<id>"). */
  ecu?: string;
  /** Restrict to one manufacturer; absent searches every package. */
  oem?: string;
  /** The resolved vehicle; without it only package-wide descriptions can match. */
  vehicleId?: string;
  /** Engines the resolution narrowed down (AGENTS 11). */
  engineIds?: readonly string[];
  /** Gearboxes the resolution narrowed down. */
  gearboxIds?: readonly string[];
}

/** One documented check of a failure pattern, with the signal name resolved. */
export interface DtcKnowledgeCheck {
  signal: string;
  /** Signal name from the package, so a report needs no second lookup. */
  signalName: string;
  expect: string;
  min?: number;
  max?: number;
  windowMs?: number;
  /** True when `min`/`max` are present — only then is the check machine-evaluable. */
  measurable: boolean;
}

export interface DtcKnowledgePattern {
  id: string;
  name: string;
  explanation?: string;
  likelihood?: FailurePatternDefinition["likelihood"];
  repair?: string;
  checks: DtcKnowledgeCheck[];
  /** Which entry the pattern came from — provenance travels with the statement. */
  scope: DtcKnowledgeScope;
}

export interface DtcKnowledgeHit {
  code: string;
  oem: string;
  packageVersion: string;
  /** Vehicle the knowledge belongs to, when the query named one that exists. */
  vehicleId?: string;
  /** Where the description/severity/hint below came from. */
  scope: DtcKnowledgeScope;
  description?: string;
  severity?: DtcKnowledgeDefinition["severity"];
  hint?: string;
  /** When the code sets — variant knowledge, absent when nobody documented it. */
  conditions?: string;
  /** Most specific first; pattern ids are unique across the whole list. */
  patterns: DtcKnowledgePattern[];
  /** Signal ids of the package that belong to diagnosing this code. */
  relatedSignals: string[];
  /**
   * Where the statement that is *shown* comes from (§24): the variant entry's own
   * provenance when it declares one, the vehicle's when the entry does not, and
   * the package's when only package-wide wording applies. A source is never
   * inherited silently from a narrower layer than the one that spoke.
   */
  knowledgeProvenance?: Provenance;
  /** Provenance of the package-wide description the entry refines. */
  baselineProvenance?: Provenance;
  /** What is missing or only partly documented; shown next to the answer. */
  notes: string[];
}

/** Package-wide description of a code, as the ECU definitions carry it. */
interface BaselineDtc {
  description: string;
  severity?: DtcKnowledgeDefinition["severity"];
  hint?: string;
  relatedSignals: string[];
  /** An entry naming the queried ECU beats one found on another ECU. */
  onQueriedEcu: boolean;
}

/**
 * Rank weights. A confirmed axis always beats an assumed one, and several
 * confirmed axes together beat each of them alone — so ordering never has to
 * weigh "engine versus gearbox", only "how much of this is evidence".
 */
const CONFIRMED_ENGINE = 16;
const CONFIRMED_GEARBOX = 8;
const CONFIRMED_ECU = 4;
const ASSUMED_ENGINE = 2;
const ASSUMED_GEARBOX = 1;

/** Powertrains the vehicle definition itself declares. */
interface DeclaredPowertrain {
  engineIds: string[];
  gearboxIds: string[];
}

/** How strongly an entry applies, and what had to be assumed to apply it. */
interface Applicability {
  specificity: number;
  assumed: string[];
}

function unique(values: readonly string[]): string[] {
  const result: string[] = [];
  for (const value of values) if (!result.includes(value)) result.push(value);
  return result;
}

function sameCode(a: string, b: string): boolean {
  return a.trim().toUpperCase() === b.trim().toUpperCase();
}

/**
 * Does this entry apply, and how strongly?
 *
 * `undefined` means "does not apply" — an entry scoped to another engine, another
 * gearbox or another ECU is not a weaker match, it is no match at all.
 *
 * One case is deliberately not strict: when the evidence narrowed *nothing* about
 * the powertrain and the variant declares exactly one engine (or gearbox), an
 * entry scoped to it applies — ranked below everything that is certain, and
 * reported in `notes`. Picking between several declared engines without evidence
 * would be a coin flip served as an answer, and is therefore refused.
 */
function applicabilityOf(
  entry: DtcKnowledgeDefinition,
  query: DtcKnowledgeQuery,
  declared: DeclaredPowertrain,
): Applicability | undefined {
  if (!sameCode(entry.code, query.code)) return undefined;
  const result: Applicability = { specificity: 0, assumed: [] };

  if (entry.engine !== undefined) {
    if (query.engineIds !== undefined && query.engineIds.length > 0) {
      if (!query.engineIds.includes(entry.engine)) return undefined;
      result.specificity += CONFIRMED_ENGINE;
    } else if (declared.engineIds.length === 1 && declared.engineIds[0] === entry.engine) {
      result.specificity += ASSUMED_ENGINE;
      result.assumed.push(`engine "${entry.engine}"`);
    } else {
      return undefined;
    }
  }
  if (entry.gearbox !== undefined) {
    if (query.gearboxIds !== undefined && query.gearboxIds.length > 0) {
      if (!query.gearboxIds.includes(entry.gearbox)) return undefined;
      result.specificity += CONFIRMED_GEARBOX;
    } else if (declared.gearboxIds.length === 1 && declared.gearboxIds[0] === entry.gearbox) {
      result.specificity += ASSUMED_GEARBOX;
      result.assumed.push(`gearbox "${entry.gearbox}"`);
    } else {
      return undefined;
    }
  }
  if (entry.ecu !== undefined) {
    // Without a queried ECU an ECU-scoped entry still may apply — the caller
    // asked "what does this code mean", not "what does it mean on this ECU" —
    // but it cannot be confirmed, so it ranks below an unscoped one.
    if (query.ecu !== undefined && entry.ecu !== query.ecu) return undefined;
    if (query.ecu !== undefined) result.specificity += CONFIRMED_ECU;
  }
  return result;
}

function scopeOf(entry: DtcKnowledgeDefinition): DtcKnowledgeScope {
  if (entry.engine !== undefined) return "vehicle-engine";
  if (entry.gearbox !== undefined) return "vehicle-gearbox";
  return "vehicle";
}

function baselineOf(pkg: DefinitionPackage, query: DtcKnowledgeQuery): BaselineDtc | undefined {
  let fallback: BaselineDtc | undefined;
  for (const ecu of pkg.ecus) {
    const onQueriedEcu = query.ecu === undefined || ecu.id === query.ecu;
    for (const dtc of ecu.dtcs ?? []) {
      if (!sameCode(dtc.code, query.code)) continue;
      const found: BaselineDtc = {
        description: dtc.description,
        ...(dtc.severity !== undefined ? { severity: dtc.severity } : {}),
        ...(dtc.hint !== undefined ? { hint: dtc.hint } : {}),
        relatedSignals: [...(dtc.relatedSignals ?? [])],
        onQueriedEcu,
      };
      // The entry on the ECU that actually reported the code wins; anything else
      // is a fallback, because the same code on another ECU can mean less.
      if (onQueriedEcu) return found;
      fallback ??= found;
    }
  }
  return fallback;
}

function vehicleOf(
  pkg: DefinitionPackage,
  vehicleId: string | undefined,
): VehicleDefinition | undefined {
  if (vehicleId === undefined) return undefined;
  return indexVehicles(pkg).get(vehicleId);
}

function checkOf(
  check: MeasurementCheckDefinition,
  signalNames: Map<string, string>,
): DtcKnowledgeCheck | undefined {
  const signalName = signalNames.get(check.signal);
  // A check against a signal the package does not define cannot be measured; the
  // validator rejects such a package, and at runtime the check is dropped rather
  // than shown as a step that can never run.
  if (signalName === undefined) return undefined;
  const result: DtcKnowledgeCheck = {
    signal: check.signal,
    signalName,
    expect: check.expect,
    measurable: check.min !== undefined || check.max !== undefined,
  };
  if (check.min !== undefined) result.min = check.min;
  if (check.max !== undefined) result.max = check.max;
  if (check.windowMs !== undefined) result.windowMs = check.windowMs;
  return result;
}

/**
 * What is known about one fault code for one vehicle.
 *
 * Returns `undefined` when nothing is documented at all — not even a package-wide
 * description. Callers show that as "undocumented" instead of falling back to a
 * generic text (§24).
 */
export function findDtcKnowledge(
  packages: readonly DefinitionPackage[],
  query: DtcKnowledgeQuery,
): DtcKnowledgeHit | undefined {
  for (const pkg of packages) {
    if (query.oem !== undefined && pkg.oem !== query.oem) continue;

    const vehicle = vehicleOf(pkg, query.vehicleId);
    const declared: DeclaredPowertrain = {
      engineIds: (vehicle?.engines ?? []).map((engine) => engine.id),
      gearboxIds: (vehicle?.gearboxes ?? []).map((gearbox) => gearbox.id),
    };
    const applicable = (vehicle?.dtcKnowledge ?? [])
      .map((entry) => ({ entry, applies: applicabilityOf(entry, query, declared) }))
      .filter(
        (candidate): candidate is { entry: DtcKnowledgeDefinition; applies: Applicability } =>
          candidate.applies !== undefined,
      )
      .sort((a, b) => b.applies.specificity - a.applies.specificity);
    const entries = applicable.map(({ entry }) => ({ entry }));

    const baseline = baselineOf(pkg, query);
    if (entries.length === 0 && baseline === undefined) continue;

    const signalNames = new Map<string, string>();
    for (const signal of pkg.signals ?? []) signalNames.set(signal.id, signal.name);

    const winner = applicable[0]?.entry;
    const assumed = unique(applicable.flatMap((candidate) => candidate.applies.assumed));
    const scope: DtcKnowledgeScope = winner ? scopeOf(winner) : "package";

    // Patterns from every applicable entry, most specific first, ids unique.
    const patterns: DtcKnowledgePattern[] = [];
    const seenPatterns = new Set<string>();
    for (const { entry } of entries) {
      const entryScope = scopeOf(entry);
      for (const pattern of entry.patterns ?? []) {
        if (seenPatterns.has(pattern.id)) continue;
        seenPatterns.add(pattern.id);
        const checks: DtcKnowledgeCheck[] = [];
        for (const check of pattern.checks ?? []) {
          const mapped = checkOf(check, signalNames);
          if (mapped) checks.push(mapped);
        }
        const result: DtcKnowledgePattern = {
          id: pattern.id,
          name: pattern.name,
          checks,
          scope: entryScope,
        };
        if (pattern.explanation !== undefined) result.explanation = pattern.explanation;
        if (pattern.likelihood !== undefined) result.likelihood = pattern.likelihood;
        if (pattern.repair !== undefined) result.repair = pattern.repair;
        patterns.push(result);
      }
    }

    const relatedSignals: string[] = [];
    for (const id of [
      ...(baseline?.relatedSignals ?? []),
      ...entries.flatMap(({ entry }) => entry.relatedSignals ?? []),
    ]) {
      if (!signalNames.has(id) || relatedSignals.includes(id)) continue;
      relatedSignals.push(id);
    }

    const hit: DtcKnowledgeHit = {
      code: query.code.trim().toUpperCase(),
      oem: pkg.oem,
      packageVersion: pkg.version,
      scope,
      patterns,
      relatedSignals,
      notes: [],
    };
    if (vehicle !== undefined) hit.vehicleId = vehicle.id;

    // Wording: the narrowest declared statement wins, the package description is
    // the fallback — and which of the two it was stays visible through `scope`.
    const description = winner?.description ?? baseline?.description;
    const severity = winner?.severity ?? baseline?.severity;
    const hint = winner?.hint ?? baseline?.hint;
    if (description !== undefined) hit.description = description;
    if (severity !== undefined) hit.severity = severity;
    if (hint !== undefined) hit.hint = hint;
    if (winner?.conditions !== undefined) hit.conditions = winner.conditions;
    if (winner?.provenance !== undefined) {
      hit.knowledgeProvenance = winner.provenance;
    } else if (winner !== undefined && vehicle?.provenance !== undefined) {
      // No entry-level provenance: the vehicle's own provenance still says where
      // the statement came from (§23: every source carries its rights).
      hit.knowledgeProvenance = vehicle.provenance;
    } else if (winner === undefined) {
      // Only package-wide wording is shown, so the package is its source — naming
      // the vehicle here would credit a variant with a statement it never made.
      hit.knowledgeProvenance = pkg.provenance;
    }
    if (baseline !== undefined) hit.baselineProvenance = pkg.provenance;

    if (assumed.length > 0) {
      hit.notes.push(
        `the evidence did not narrow the powertrain, so ${assumed.join(" and ")} is ` +
          "assumed — it is the only one this variant declares",
      );
    }
    if (query.vehicleId !== undefined && vehicle === undefined) {
      hit.notes.push(
        `vehicle "${query.vehicleId}" is not declared in package ${pkg.oem} ${pkg.version} — only package-wide statements apply`,
      );
    }
    if (winner === undefined && hit.notes.length === 0) {
      hit.notes.push(
        "no variant-specific knowledge documented for this code — description, severity and hint are the package-wide ones",
      );
    } else if (winner !== undefined && patterns.length === 0) {
      hit.notes.push(
        "the variant entry documents wording only — no failure patterns, so there is nothing to check against the bus",
      );
    } else if (
      patterns.length > 0 &&
      !patterns.some((pattern) => pattern.checks.some((check) => check.measurable))
    ) {
      hit.notes.push(
        "the documented patterns carry no numeric window — a check has to be read by a human instead of being evaluated",
      );
    }
    return hit;
  }
  return undefined;
}

/**
 * Every fault code a vehicle has variant knowledge for.
 *
 * Used by reports and by the guided diagnosis to say up front what is documented
 * for this car, instead of discovering it code by code.
 */
export function documentedDtcCodes(
  packages: readonly DefinitionPackage[],
  vehicleId: string,
  oem?: string,
): string[] {
  const codes: string[] = [];
  for (const pkg of packages) {
    if (oem !== undefined && pkg.oem !== oem) continue;
    const vehicle = indexVehicles(pkg).get(vehicleId);
    for (const entry of vehicle?.dtcKnowledge ?? []) {
      const code = entry.code.trim().toUpperCase();
      if (!codes.includes(code)) codes.push(code);
    }
  }
  return codes;
}

/**
 * Knowledge query for a scanned code, taken straight from a resolution candidate.
 *
 * The candidate already carries the narrowing the resolution established — its
 * engines and gearboxes — so callers must not unpack it by hand and risk asking
 * for a narrower engine than the evidence allows (AGENTS 11).
 */
export function dtcKnowledgeQuery(
  candidate: VehicleCandidate | undefined,
  code: string,
  ecu?: string,
): DtcKnowledgeQuery {
  const query: DtcKnowledgeQuery = { code };
  if (ecu !== undefined) query.ecu = ecu;
  if (candidate === undefined) return query;
  query.oem = candidate.oem;
  query.vehicleId = candidate.vehicleId;
  if (candidate.engineIds.length > 0) query.engineIds = [...candidate.engineIds];
  if (candidate.gearboxIds.length > 0) query.gearboxIds = [...candidate.gearboxIds];
  return query;
}
