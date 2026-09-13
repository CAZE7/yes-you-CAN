/**
 * Fault knowledge as the operator reads it (AGENTS 20, 23, 24).
 *
 * Two things are worth testing here. First the translation: the definitions layer
 * speaks in scope keys, likelihood keys and numeric bounds, the screen has to
 * speak in German sentences — and a key nobody translated must still appear, as
 * itself, instead of disappearing. Second the honesty rules: package-wide wording
 * is labelled as package-wide wording, a check without a numeric window is
 * labelled as something only a human can judge, and what had to be assumed stays
 * visible as a note.
 */

import assert from "node:assert/strict";
import type { DtcCheckInfo, DtcKnowledgeInfo, DtcPatternInfo } from "@vdp/domain";
import { describe, test } from "vitest";
import {
  checkWindow,
  knowledgeScopeLabel,
  knowledgeScopeShort,
  likelihoodLabel,
  toDtcKnowledgeView,
  toDtcPatternView,
} from "../src/dtc-knowledge-view.js";

function check(fields: Partial<DtcCheckInfo> = {}): DtcCheckInfo {
  return {
    signalId: "engine.long_term_fuel_trim",
    name: "Long term fuel trim",
    expect: "neutral",
    measurable: true,
    ...fields,
  };
}

function pattern(fields: Partial<DtcPatternInfo> = {}): DtcPatternInfo {
  return {
    id: "catalyst-aged",
    name: "Aged catalyst",
    scope: "vehicle-engine",
    checks: [check()],
    ...fields,
  };
}

function knowledge(fields: Partial<DtcKnowledgeInfo> = {}): DtcKnowledgeInfo {
  return {
    scope: "vehicle-engine",
    vehicleId: "virtual-vehicle",
    conditions: "only in closed loop above 80 °C",
    patterns: [pattern()],
    provenanceType: "licensed",
    provenanceSource: "workshop manual",
    notes: [],
    ...fields,
  };
}

describe("scope labels", () => {
  test("every scope the lookup can report has German wording", () => {
    assert.equal(knowledgeScopeLabel("vehicle-engine"), "Varianten-Wissen · Motor");
    assert.equal(knowledgeScopeLabel("vehicle-gearbox"), "Varianten-Wissen · Getriebe");
    assert.equal(knowledgeScopeLabel("vehicle"), "Varianten-Wissen · Fahrzeug");
    assert.equal(
      knowledgeScopeLabel("package"),
      "nur paketweit beschrieben",
      "package wording must not borrow the appearance of variant knowledge",
    );
  });

  test("the short form fits the fault list", () => {
    assert.equal(knowledgeScopeShort("vehicle-engine"), "Motor");
    assert.equal(knowledgeScopeShort("vehicle-gearbox"), "Getriebe");
    assert.equal(knowledgeScopeShort("vehicle"), "Fahrzeug");
    assert.equal(knowledgeScopeShort("package"), "paketweit");
  });

  test("a scope nobody translated stays visible as itself", () => {
    assert.equal(knowledgeScopeLabel("vehicle-platform"), "vehicle-platform");
    assert.equal(knowledgeScopeShort("vehicle-platform"), "vehicle-platform");
  });
});

describe("likelihood labels", () => {
  test("orders the checks without claiming a probability", () => {
    assert.equal(likelihoodLabel("common"), "häufig");
    assert.equal(likelihoodLabel("possible"), "möglich");
    assert.equal(likelihoodLabel("rare"), "selten");
    assert.equal(likelihoodLabel("certain"), "certain", "an unknown value is not translated away");
  });
});

describe("checkWindow", () => {
  test("renders the documented bounds", () => {
    assert.equal(checkWindow(check({ min: -5, max: 5 })), "-5 … 5");
    assert.equal(checkWindow(check({ min: 80 })), "≥ 80");
    assert.equal(checkWindow(check({ max: 250 })), "≤ 250");
  });

  test("a measuring window is part of the sentence", () => {
    assert.equal(checkWindow(check({ min: 60, windowMs: 30000 })), "≥ 60 · 30 s messen");
    assert.equal(checkWindow(check({ windowMs: 1500 })), "2 s messen", "seconds are rounded");
  });

  test("without numbers there is no window to show", () => {
    assert.equal(checkWindow(check({ measurable: false })), "");
  });
});

describe("toDtcPatternView", () => {
  test("translates a complete pattern", () => {
    const view = toDtcPatternView(
      pattern({
        explanation: "Oxygen storage is gone",
        likelihood: "common",
        repair: "Replace it after the checks hold",
      }),
    );
    assert.equal(view.id, "catalyst-aged");
    assert.equal(view.name, "Aged catalyst");
    assert.equal(view.scope, "vehicle-engine");
    assert.equal(view.scopeLabel, "Varianten-Wissen · Motor");
    assert.equal(view.explanation, "Oxygen storage is gone");
    assert.equal(view.likelihood, "common");
    assert.equal(view.likelihoodLabel, "häufig");
    assert.equal(view.repair, "Replace it after the checks hold");
    assert.deepEqual(view.checks[0], {
      signalId: "engine.long_term_fuel_trim",
      name: "Long term fuel trim",
      expect: "neutral",
      window: "",
      measurable: true,
      judgement: "automatisch prüfbar",
    });
  });

  test("a check keeps its numbers next to the sentence", () => {
    const view = toDtcPatternView(
      pattern({ checks: [check({ min: -5, max: 5, windowMs: 2000 })] }),
    );
    assert.deepEqual(view.checks[0], {
      signalId: "engine.long_term_fuel_trim",
      name: "Long term fuel trim",
      expect: "neutral",
      window: "-5 … 5 · 2 s messen",
      measurable: true,
      judgement: "automatisch prüfbar",
      min: -5,
      max: 5,
      windowMs: 2000,
    });
  });

  test("a check without a window is labelled as a human judgement", () => {
    const view = toDtcPatternView(
      pattern({
        checks: [
          check({ name: undefined, measurable: false, expect: "listen for a ticking noise" }),
        ],
      }),
    );
    assert.equal(
      view.checks[0]?.name,
      "engine.long_term_fuel_trim",
      "the id stands in for a missing name",
    );
    assert.equal(view.checks[0]?.window, "");
    assert.equal(view.checks[0]?.judgement, "nur manuell beurteilbar");
  });

  test("what is not documented stays absent", () => {
    const view = toDtcPatternView(pattern({ checks: [], scope: "vehicle" }));
    assert.equal("explanation" in view, false);
    assert.equal("repair" in view, false);
    assert.equal("likelihood" in view, false);
    assert.equal("likelihoodLabel" in view, false);
    assert.equal(view.scopeLabel, "Varianten-Wissen · Fahrzeug");
    assert.deepEqual(view.checks, []);
  });
});

describe("toDtcKnowledgeView", () => {
  test("variant knowledge says which axis it came from", () => {
    const view = toDtcKnowledgeView(knowledge());
    assert.equal(view.variant, true);
    assert.equal(view.scope, "vehicle-engine");
    assert.equal(view.scopeLabel, "Varianten-Wissen · Motor");
    assert.equal(view.scopeShort, "Motor");
    assert.equal(view.vehicleId, "virtual-vehicle");
    assert.equal(view.conditions, "only in closed loop above 80 °C");
    assert.equal(view.patterns.length, 1);
    assert.deepEqual(view.notes, []);
  });

  test("package-wide wording is not presented as variant knowledge", () => {
    const view = toDtcKnowledgeView(
      knowledge({
        scope: "package",
        vehicleId: undefined,
        conditions: undefined,
        patterns: [],
        notes: ["no variant-specific knowledge documented for this code"],
      }),
    );
    assert.equal(view.variant, false);
    assert.equal(view.scopeLabel, "nur paketweit beschrieben");
    assert.equal("vehicleId" in view, false);
    assert.equal("conditions" in view, false);
    assert.deepEqual(view.patterns, []);
    assert.deepEqual(view.notes, ["no variant-specific knowledge documented for this code"]);
  });

  test("the source of a statement is named, in operator language", () => {
    assert.equal(toDtcKnowledgeView(knowledge()).provenance, "workshop manual (lizenzierte Daten)");
    assert.equal(
      toDtcKnowledgeView(knowledge({ provenanceType: undefined })).provenance,
      "workshop manual",
    );
    assert.equal(
      toDtcKnowledgeView(knowledge({ provenanceType: "own", provenanceSource: undefined }))
        .provenance,
      undefined,
      "a source nobody named is not invented",
    );
    assert.equal(
      toDtcKnowledgeView(knowledge({ provenanceType: "copied" })).provenance,
      "workshop manual (copied)",
      "an unknown source type stays visible",
    );
  });

  test("notes travel with the answer, in order", () => {
    const view = toDtcKnowledgeView(
      knowledge({
        notes: [
          'the evidence did not narrow the powertrain, so engine "sim-petrol" is assumed',
          "the documented patterns carry no numeric window",
        ],
      }),
    );
    assert.deepEqual(view.notes, [
      'the evidence did not narrow the powertrain, so engine "sim-petrol" is assumed',
      "the documented patterns carry no numeric window",
    ]);
  });
});
