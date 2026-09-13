/**
 * Fault knowledge as the operator reads it (AGENTS 20, 23, 24).
 *
 * The definitions layer answers with scope keys (`vehicle-engine`), likelihood
 * keys (`common`) and numeric windows (`min`/`max`/`windowMs`); a workshop screen
 * has to answer in German sentences. This module owns that translation, the same
 * way `vehicle-view.ts` owns the translation of a resolution — which keeps
 * `backend.ts` a wiring file, keeps `public/app.js` free of vocabulary, and makes
 * the rule that matters most testable on its own:
 *
 * A code that only the package describes is shown *as* package-wide wording. It
 * never borrows the appearance of variant knowledge, and what had to be assumed
 * (an engine nobody identified) stays visible as a note (§24).
 */

import type { DtcKnowledgeScope, FailurePatternDefinition } from "@vdp/definitions";
import type { DtcCheckInfo, DtcKnowledgeInfo, DtcPatternInfo } from "@vdp/domain";
import { provenanceLabel } from "./vehicle-view.js";

type Likelihood = NonNullable<FailurePatternDefinition["likelihood"]>;

/**
 * German name of every scope the knowledge lookup can report.
 *
 * Typed against the definitions layer, so a new scope fails the build here
 * instead of reaching the operator as a key like `vehicle-platform`.
 */
const SCOPE_LABELS: Readonly<Record<DtcKnowledgeScope, string>> = {
  "vehicle-engine": "Varianten-Wissen · Motor",
  "vehicle-gearbox": "Varianten-Wissen · Getriebe",
  vehicle: "Varianten-Wissen · Fahrzeug",
  package: "nur paketweit beschrieben",
};

/** Short form for the fault list, where a long pill does not fit. */
const SCOPE_SHORT: Readonly<Record<DtcKnowledgeScope, string>> = {
  "vehicle-engine": "Motor",
  "vehicle-gearbox": "Getriebe",
  vehicle: "Fahrzeug",
  package: "paketweit",
};

/** `likelihood` orders the checks; it is not a probability and never reads as one. */
const LIKELIHOOD_LABELS: Readonly<Record<Likelihood, string>> = {
  common: "häufig",
  possible: "möglich",
  rare: "selten",
};

/** What a check without a numeric window means for the person reading it. */
const JUDGEMENT_AUTOMATIC = "automatisch prüfbar";
const JUDGEMENT_MANUAL = "nur manuell beurteilbar";

export interface DtcCheckView {
  signalId: string;
  /** Signal name from the definition package, or the id when it has none. */
  name: string;
  /** What the pattern predicts, in the words the knowledge was written in. */
  expect: string;
  /** Numeric window in operator language; empty when there is none. */
  window: string;
  /** True when a tool can evaluate the window instead of a human reading it. */
  measurable: boolean;
  judgement: string;
  /** The documented bounds themselves — the sentence never replaces the numbers. */
  min?: number;
  max?: number;
  windowMs?: number;
}

export interface DtcPatternView {
  id: string;
  name: string;
  explanation?: string;
  /** Likelihood key as documented ("common"), for filtering and tests. */
  likelihood?: string;
  likelihoodLabel?: string;
  /** Repair information, labelled as such — documentation, not a result (§24). */
  repair?: string;
  /** Which knowledge entry the pattern came from. */
  scope: string;
  scopeLabel: string;
  checks: DtcCheckView[];
}

export interface DtcKnowledgeView {
  /** Scope key as the definitions layer reports it (stable, machine-read). */
  scope: string;
  scopeLabel: string;
  scopeShort: string;
  /** True when the wording comes from the resolved variant, not from the package. */
  variant: boolean;
  vehicleId?: string;
  /** When the code sets — only variant knowledge documents this. */
  conditions?: string;
  patterns: DtcPatternView[];
  /** Where the statement comes from, in operator language; absent when unknown. */
  provenance?: string;
  /** What is missing or had to be assumed; shown next to the answer. */
  notes: string[];
}

/** German name of a knowledge scope; an unknown scope stays visible as itself. */
export function knowledgeScopeLabel(scope: string): string {
  return isScope(scope) ? SCOPE_LABELS[scope] : scope;
}

/** Short German name of a knowledge scope, for the fault list. */
export function knowledgeScopeShort(scope: string): string {
  return isScope(scope) ? SCOPE_SHORT[scope] : scope;
}

/** German name of a likelihood; an unknown value stays visible as itself. */
export function likelihoodLabel(likelihood: string): string {
  return isLikelihood(likelihood) ? LIKELIHOOD_LABELS[likelihood] : likelihood;
}

/**
 * The numeric window of a check, as an operator reads it.
 *
 * Returns an empty string when the knowledge carries no numbers: the view then
 * says "only a human can judge this" instead of showing a range that was never
 * documented (§24).
 */
export function checkWindow(check: DtcCheckInfo): string {
  const parts: string[] = [];
  if (check.min !== undefined && check.max !== undefined) {
    parts.push(`${check.min} … ${check.max}`);
  } else if (check.min !== undefined) {
    parts.push(`≥ ${check.min}`);
  } else if (check.max !== undefined) {
    parts.push(`≤ ${check.max}`);
  }
  if (check.windowMs !== undefined) {
    parts.push(`${Math.round(check.windowMs / 1000)} s messen`);
  }
  return parts.join(" · ");
}

/** One failure pattern with its measurements, in operator language. */
export function toDtcPatternView(pattern: DtcPatternInfo): DtcPatternView {
  const view: DtcPatternView = {
    id: pattern.id,
    name: pattern.name,
    scope: pattern.scope,
    scopeLabel: knowledgeScopeLabel(pattern.scope),
    checks: pattern.checks.map((check) => ({
      signalId: check.signalId,
      name: check.name ?? check.signalId,
      expect: check.expect,
      window: checkWindow(check),
      measurable: check.measurable,
      judgement: check.measurable ? JUDGEMENT_AUTOMATIC : JUDGEMENT_MANUAL,
      ...(check.min !== undefined ? { min: check.min } : {}),
      ...(check.max !== undefined ? { max: check.max } : {}),
      ...(check.windowMs !== undefined ? { windowMs: check.windowMs } : {}),
    })),
    ...(pattern.explanation !== undefined ? { explanation: pattern.explanation } : {}),
    ...(pattern.repair !== undefined ? { repair: pattern.repair } : {}),
  };
  if (pattern.likelihood !== undefined) {
    view.likelihood = pattern.likelihood;
    view.likelihoodLabel = likelihoodLabel(pattern.likelihood);
  }
  return view;
}

/** Everything the resolved vehicle documents about one fault code. */
export function toDtcKnowledgeView(knowledge: DtcKnowledgeInfo): DtcKnowledgeView {
  const view: DtcKnowledgeView = {
    scope: knowledge.scope,
    scopeLabel: knowledgeScopeLabel(knowledge.scope),
    scopeShort: knowledgeScopeShort(knowledge.scope),
    variant: knowledge.scope !== "package",
    patterns: knowledge.patterns.map(toDtcPatternView),
    notes: [...knowledge.notes],
    ...(knowledge.vehicleId !== undefined ? { vehicleId: knowledge.vehicleId } : {}),
    ...(knowledge.conditions !== undefined ? { conditions: knowledge.conditions } : {}),
  };
  if (knowledge.provenanceSource !== undefined) {
    view.provenance =
      knowledge.provenanceType !== undefined
        ? `${knowledge.provenanceSource} (${provenanceLabel(knowledge.provenanceType)})`
        : knowledge.provenanceSource;
  }
  return view;
}

/**
 * Type guards instead of index lookups: the label maps are exhaustive over the
 * definitions layer's unions, and a key from anywhere else (an older package, a
 * hand-written query) must still reach the screen — as itself.
 */
function isScope(scope: string): scope is DtcKnowledgeScope {
  return Object.hasOwn(SCOPE_LABELS, scope);
}

function isLikelihood(likelihood: string): likelihood is Likelihood {
  return Object.hasOwn(LIKELIHOOD_LABELS, likelihood);
}
