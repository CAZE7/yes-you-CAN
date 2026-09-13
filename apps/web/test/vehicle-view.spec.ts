/**
 * The vehicle resolution as the operator reads it (AGENTS 11, 24).
 *
 * Two things are worth testing here. First the translation: the definitions layer
 * speaks in criterion keys and weights, the screen has to speak in German
 * sentences — and a key nobody translated must still appear, as itself, instead
 * of disappearing. Second the honesty rules: a candidate stays a hypothesis, its
 * contradictions are shown next to its evidence, and placeholder data is labelled
 * as placeholder data.
 */

import assert from "node:assert/strict";
import { EVIDENCE_WEIGHT } from "@vdp/definitions";
import type { VehicleCandidateRef, VehicleResolutionRef } from "@vdp/domain";
import { describe, test } from "vitest";
import {
  criterionLabel,
  knownCriterionKinds,
  provenanceLabel,
  toVehicleResolutionView,
} from "../src/vehicle-view.js";

function candidate(fields: Partial<VehicleCandidateRef> = {}): VehicleCandidateRef {
  return {
    oem: "simulator",
    packageVersion: "1.0.0",
    vehicleId: "virtual-vehicle",
    brand: "Virtual",
    model: "Simulator vehicle",
    platform: "SIM-1",
    provenanceType: "own",
    engineIds: ["sim-petrol"],
    gearboxIds: ["sim-automatic"],
    score: 1,
    trust: 1,
    evidence: [
      {
        kind: "part-number",
        observed: "ENGINE-f187",
        expected: "ENGINE-f187",
        weight: 4,
        reason: "part number read from DID 0xF187 is declared for this vehicle",
      },
    ],
    conflicts: [],
    expectedEcus: 3,
    matchedEcus: 3,
    missingEcus: [],
    ...fields,
  };
}

function resolution(fields: Partial<VehicleResolutionRef> = {}): VehicleResolutionRef {
  const candidates = fields.candidates ?? [candidate()];
  return {
    candidates,
    unresolved: false,
    notes: [],
    unexplained: [],
    ...(candidates[0] !== undefined ? { best: candidates[0] } : {}),
    ...fields,
  };
}

describe("criterion labels", () => {
  test("every criterion the resolver weighs has an operator-facing name", () => {
    const kinds = Object.keys(EVIDENCE_WEIGHT);
    assert.ok(kinds.length > 0);
    for (const kind of kinds) {
      assert.notEqual(criterionLabel(kind), kind, `${kind} would reach the UI untranslated`);
    }
    assert.deepEqual([...knownCriterionKinds()].sort(), [...kinds].sort());
  });

  test("a key nobody translated is shown as itself, never hidden", () => {
    assert.equal(criterionLabel("brand-new-criterion"), "brand-new-criterion");
    assert.equal(provenanceLabel("crowd-sourced"), "crowd-sourced");
  });

  test("provenance is named, and placeholder data says what it is", () => {
    assert.equal(provenanceLabel("own"), "eigene Daten");
    assert.equal(
      provenanceLabel("example-placeholder"),
      "Beispieldaten — kein reales Fahrzeugwissen",
    );
    const view = toVehicleResolutionView(
      resolution({ candidates: [candidate({ provenanceType: "example-placeholder" })] }),
    );
    assert.equal(view.best?.placeholder, true);
    assert.equal(
      toVehicleResolutionView(resolution()).best?.placeholder,
      false,
      "own data is not a placeholder",
    );
  });
});

describe("toVehicleResolutionView", () => {
  test("the best candidate is named, scored and traced to its package", () => {
    const view = toVehicleResolutionView(resolution());
    assert.equal(view.unresolved, false);
    assert.equal(view.headline, "Virtual Simulator vehicle (SIM-1) — 100 % belegt");
    assert.equal(view.candidates.length, 1);
    assert.equal(view.best?.title, "Virtual Simulator vehicle");
    assert.equal(view.best?.scorePercent, 100);
    assert.equal(view.best?.scoreLabel, "100 % der geprüften Kriterien bestätigt");
    assert.equal(view.best?.oem, "simulator");
    assert.equal(view.best?.packageVersion, "1.0.0");
    assert.equal(view.best?.provenanceLabel, "eigene Daten");
    assert.equal(view.best?.trust, 1);
    assert.deepEqual(view.best?.engineIds, ["sim-petrol"]);
    assert.deepEqual(view.best?.gearboxIds, ["sim-automatic"]);
  });

  test("coverage is a sentence, with the German plural it needs", () => {
    assert.equal(
      toVehicleResolutionView(resolution()).best?.coverageLabel,
      "3 von 3 Steuergeräten der Definition gefunden",
    );
    const single = toVehicleResolutionView(
      resolution({
        candidates: [
          candidate({ expectedEcus: 1, matchedEcus: 0, missingEcus: ["engine"], score: 0.4 }),
        ],
      }),
    );
    assert.equal(single.best?.coverageLabel, "0 von 1 Steuergerät der Definition gefunden");
    assert.deepEqual(single.best?.missingEcus, ["engine"]);
    assert.equal(single.best?.scorePercent, 40);
  });

  test("evidence keeps the key and gains the label, the observed and the expected", () => {
    const evidence = toVehicleResolutionView(resolution()).best?.evidence[0];
    assert.deepEqual(evidence, {
      kind: "part-number",
      label: "Teilenummer",
      observed: "ENGINE-f187",
      expected: "ENGINE-f187",
      weight: 4,
      reason: "part number read from DID 0xF187 is declared for this vehicle",
    });
  });

  test("coverage is rendered from the numbers, not forwarded as a sentence", () => {
    const view = toVehicleResolutionView(
      resolution({
        candidates: [
          candidate({
            expectedEcus: 3,
            matchedEcus: 2,
            missingEcus: ["abs"],
            evidence: [
              {
                kind: "ecu-coverage",
                observed: "2 of 3 expected ECU(s) answered",
                expected: "every non-optional ECU of this vehicle answers",
                weight: 2,
                reason: "1 expected ECU(s) did not answer: abs",
              },
            ],
          }),
        ],
      }),
    );
    const coverage = view.best?.evidence[0];
    assert.equal(coverage?.label, "Steuergeräte im Fahrzeug gefunden");
    assert.equal(coverage?.observed, "2 von 3 Steuergeräten");
    assert.equal(coverage?.expected, "alle nicht-optionalen Steuergeräte dieses Fahrzeugs");
    assert.equal(
      coverage?.reason,
      "1 expected ECU(s) did not answer: abs",
      "the reason stays the definition package's own wording",
    );
  });

  test("a contradiction travels with the candidate and into the headline", () => {
    const view = toVehicleResolutionView(
      resolution({
        candidates: [
          candidate({
            score: 0.39,
            conflicts: [
              {
                kind: "vin-wmi",
                observed: "WVW",
                expected: "1HG",
                weight: 3,
                reason: "WMI WVW is not one this Virtual definition claims",
              },
              {
                kind: "part-number",
                observed: "03C906000AA",
                expected: "ENGINE-f187",
                weight: 4,
                reason: "part number does not match",
              },
            ],
          }),
        ],
      }),
    );
    assert.equal(view.best?.scorePercent, 39);
    assert.equal(view.headline, "Virtual Simulator vehicle (SIM-1) — 39 % belegt, 2 Widersprüche");
    assert.deepEqual(
      view.best?.conflicts.map((item) => item.label),
      ["VIN · Herstellerkennung (WMI)", "Teilenummer"],
      "contradictions are named like the evidence, not summarised away",
    );
  });

  test("one contradiction is singular", () => {
    const view = toVehicleResolutionView(
      resolution({
        candidates: [
          candidate({
            conflicts: [
              { kind: "vin-plant", observed: "B", expected: "A", weight: 1, reason: "plant" },
            ],
          }),
        ],
      }),
    );
    assert.match(view.headline, /1 Widerspruch$/);
  });

  test("notes, unexplained observations and the VIN lookup are carried through", () => {
    const view = toVehicleResolutionView(
      resolution({
        notes: ["the definition rests on example data"],
        unexplained: ["DID 0xF1A0 answered on engine"],
        vinLookup: {
          wmi: "1HG",
          manufacturer: "Honda of America Mfg.",
          country: "US",
          known: true,
        },
      }),
    );
    assert.deepEqual(view.notes, ["the definition rests on example data"]);
    assert.deepEqual(view.unexplained, ["DID 0xF1A0 answered on engine"]);
    assert.deepEqual(view.vinLookup, {
      wmi: "1HG",
      manufacturer: "Honda of America Mfg.",
      country: "US",
      known: true,
    });
  });

  test("nothing matched says so — and falls back to what the VIN alone knows", () => {
    const unknown = toVehicleResolutionView({
      candidates: [],
      unresolved: true,
      notes: ["none of the 1 registered package(s) declares vehicle definitions"],
      unexplained: [],
    });
    assert.equal(unknown.headline, "Fahrzeug nicht bestimmt");
    assert.equal(unknown.best, undefined);
    assert.equal(unknown.candidates.length, 0);

    const knownVin = toVehicleResolutionView({
      candidates: [],
      unresolved: true,
      notes: [],
      unexplained: [],
      vinLookup: { wmi: "WVW", manufacturer: "Volkswagen AG", country: "DE", known: true },
    });
    assert.equal(
      knownVin.headline,
      "Fahrzeug nicht bestimmt — VIN verweist auf Volkswagen AG",
      "an unresolved vehicle is an answer, not a blank field",
    );
  });

  test("a candidate without a platform is not decorated with an empty one", () => {
    const view = toVehicleResolutionView(
      resolution({ candidates: [candidate({ platform: undefined })] }),
    );
    assert.equal(view.best?.platform, undefined);
    assert.equal(view.headline, "Virtual Simulator vehicle — 100 % belegt");
  });
});
