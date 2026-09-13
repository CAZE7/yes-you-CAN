/**
 * Vehicle resolution as the operator reads it (AGENTS 11, 24).
 *
 * The definitions layer answers with criterion keys (`vin-wmi`, `part-number`)
 * and weights; a workshop screen has to answer in German sentences and
 * percentages. This module owns that translation, which keeps `backend.ts` a
 * wiring file and makes the rule that matters most testable on its own: a
 * resolution is shown *as* a hypothesis — with the evidence carrying it, the
 * contradictions against it and where the data came from — never as a fact.
 */

import type { EvidenceKind, Provenance } from "@vdp/definitions";
import type { VehicleCandidateRef, VehicleEvidenceRef, VehicleResolutionRef } from "@vdp/domain";

/**
 * German name of every criterion the resolver can report.
 *
 * Typed against the definitions layer, so a new criterion fails the build here
 * instead of silently reaching the operator as a key like `ecu-not-in-vehicle`.
 */
const CRITERION_LABELS: Readonly<Record<EvidenceKind, string>> = {
  "part-number": "Teilenummer",
  "software-version": "Softwarestand",
  "hardware-version": "Hardwarestand",
  "powertrain-code": "Motor- / Getriebekennung",
  "vin-wmi": "VIN · Herstellerkennung (WMI)",
  "vin-vds": "VIN · Fahrzeugbeschreibung (VDS)",
  "vin-model-year": "VIN · Modelljahrzeichen",
  "vin-plant": "VIN · Werk",
  "ecu-coverage": "Steuergeräte im Fahrzeug gefunden",
  "unexpected-ecu": "Steuergerät außerhalb der Definition",
  "ecu-not-in-vehicle": "Steuergerät gehört nicht zu diesem Fahrzeug",
  "declared-oem": "Angabe · Hersteller",
  "declared-brand": "Angabe · Marke",
  "declared-model": "Angabe · Modell",
  "declared-platform": "Angabe · Plattform",
  "declared-model-year": "Angabe · Modelljahr",
};

/** Where the data behind a candidate comes from, in operator language (§24). */
const PROVENANCE_LABELS: Readonly<Record<Provenance["sourceType"], string>> = {
  own: "eigene Daten",
  standard: "Standard (SAE J1979 / ISO 14229)",
  licensed: "lizenzierte Daten",
  community: "Community-Daten",
  "reverse-engineered": "reverse-engineered",
  "example-placeholder": "Beispieldaten — kein reales Fahrzeugwissen",
};

export interface VehicleEvidenceView {
  /** Criterion key as the definitions layer reports it (stable, machine-read). */
  kind: string;
  /** The same criterion in operator language. */
  label: string;
  observed: string;
  expected: string;
  weight: number;
  reason: string;
}

export interface VehicleCandidateView {
  vehicleId: string;
  oem: string;
  packageVersion: string;
  /** One line for lists and headers, e.g. "Virtual Simulator vehicle". */
  title: string;
  platform?: string;
  /** 0…100 — share of the evaluated criteria that speaks for this candidate. */
  scorePercent: number;
  scoreLabel: string;
  /** 0…1 — how far the data behind the candidate can be trusted (§24). */
  trust: number;
  provenanceType: string;
  provenanceLabel: string;
  /** True when the match rests on placeholder data — the UI has to say so. */
  placeholder: boolean;
  engineIds: string[];
  gearboxIds: string[];
  coverageLabel: string;
  missingEcus: string[];
  evidence: VehicleEvidenceView[];
  conflicts: VehicleEvidenceView[];
}

export interface VehicleResolutionView {
  unresolved: boolean;
  /** One line for the vehicle header; honest about not knowing. */
  headline: string;
  candidates: VehicleCandidateView[];
  best?: VehicleCandidateView;
  vinLookup?: { wmi: string; manufacturer?: string; country?: string; known: boolean };
  notes: string[];
  unexplained: string[];
}

/** German name of a criterion; an unknown key is shown as itself, never hidden. */
export function criterionLabel(kind: string): string {
  return isCriterionKind(kind) ? CRITERION_LABELS[kind] : kind;
}

/** German name of a provenance source type; unknown types stay visible. */
export function provenanceLabel(sourceType: string): string {
  return isSourceType(sourceType) ? PROVENANCE_LABELS[sourceType] : sourceType;
}

/** Every criterion this view can name, in the resolver's own keys. */
export function knownCriterionKinds(): EvidenceKind[] {
  return Object.keys(CRITERION_LABELS) as EvidenceKind[];
}

/**
 * Type guards instead of index lookups: the label maps are exhaustive over the
 * definitions layer's unions, and a key from anywhere else (an older package, a
 * hand-written query) must still reach the screen — as itself.
 */
function isCriterionKind(kind: string): kind is EvidenceKind {
  return Object.hasOwn(CRITERION_LABELS, kind);
}

function isSourceType(sourceType: string): sourceType is Provenance["sourceType"] {
  return Object.hasOwn(PROVENANCE_LABELS, sourceType);
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/**
 * One weighed criterion as a table row.
 *
 * `reason` stays in the language of the definition package — it is data, like a
 * fault description, and translating it would mean inventing wording for
 * somebody else's statement. Coverage is the exception: its observed/expected are
 * a sentence the resolver composes, and the numbers it speaks about are already
 * in the candidate, so the view writes them the way an operator reads them.
 */
function toEvidenceView(
  evidence: VehicleEvidenceRef,
  candidate: VehicleCandidateRef,
): VehicleEvidenceView {
  const view: VehicleEvidenceView = {
    kind: evidence.kind,
    label: criterionLabel(evidence.kind),
    observed: evidence.observed,
    expected: evidence.expected,
    weight: evidence.weight,
    reason: evidence.reason,
  };
  if (evidence.kind === "ecu-coverage") {
    view.observed = `${candidate.matchedEcus} von ${candidate.expectedEcus} ${plural(
      candidate.expectedEcus,
      "Steuergerät",
      "Steuergeräten",
    )}`;
    view.expected = "alle nicht-optionalen Steuergeräte dieses Fahrzeugs";
  }
  return view;
}

function toCandidateView(candidate: VehicleCandidateRef): VehicleCandidateView {
  const scorePercent = Math.round(candidate.score * 100);
  const title = `${candidate.brand} ${candidate.model}`.trim();
  const view: VehicleCandidateView = {
    vehicleId: candidate.vehicleId,
    oem: candidate.oem,
    packageVersion: candidate.packageVersion,
    title,
    scorePercent,
    scoreLabel: `${scorePercent} % der geprüften Kriterien bestätigt`,
    trust: candidate.trust,
    provenanceType: candidate.provenanceType ?? "unknown",
    provenanceLabel: provenanceLabel(candidate.provenanceType ?? "unknown"),
    placeholder: candidate.provenanceType === "example-placeholder",
    engineIds: [...candidate.engineIds],
    gearboxIds: [...candidate.gearboxIds],
    coverageLabel: `${candidate.matchedEcus} von ${candidate.expectedEcus} ${plural(
      candidate.expectedEcus,
      "Steuergerät",
      "Steuergeräten",
    )} der Definition gefunden`,
    missingEcus: [...candidate.missingEcus],
    evidence: candidate.evidence.map((item) => toEvidenceView(item, candidate)),
    conflicts: candidate.conflicts.map((item) => toEvidenceView(item, candidate)),
  };
  if (candidate.platform !== undefined) view.platform = candidate.platform;
  return view;
}

/**
 * The header line for a resolution.
 *
 * It states what was found *and* what speaks against it; when nothing matched it
 * falls back to whatever the VIN alone says about the manufacturer, because an
 * unknown WMI and a known one are different answers (§24).
 */
function headlineOf(view: VehicleResolutionView): string {
  const best = view.best;
  if (best) {
    const named = best.platform ? `${best.title} (${best.platform})` : best.title;
    const against =
      best.conflicts.length > 0
        ? `, ${best.conflicts.length} ${plural(best.conflicts.length, "Widerspruch", "Widersprüche")}`
        : "";
    return `${named} — ${best.scorePercent} % belegt${against}`;
  }
  const manufacturer = view.vinLookup?.manufacturer;
  if (manufacturer) return `Fahrzeug nicht bestimmt — VIN verweist auf ${manufacturer}`;
  return "Fahrzeug nicht bestimmt";
}

/** Narrow a resolution to what the demo UI renders. */
export function toVehicleResolutionView(resolution: VehicleResolutionRef): VehicleResolutionView {
  const candidates = resolution.candidates.map(toCandidateView);
  const view: VehicleResolutionView = {
    unresolved: resolution.unresolved,
    headline: "",
    candidates,
    notes: [...resolution.notes],
    unexplained: [...resolution.unexplained],
  };
  if (resolution.best !== undefined && candidates[0] !== undefined) view.best = candidates[0];
  if (resolution.vinLookup !== undefined) {
    const lookup: VehicleResolutionView["vinLookup"] = {
      wmi: resolution.vinLookup.wmi,
      known: resolution.vinLookup.known,
    };
    if (resolution.vinLookup.manufacturer !== undefined) {
      lookup.manufacturer = resolution.vinLookup.manufacturer;
    }
    if (resolution.vinLookup.country !== undefined) lookup.country = resolution.vinLookup.country;
    view.vinLookup = lookup;
  }
  view.headline = headlineOf(view);
  return view;
}
