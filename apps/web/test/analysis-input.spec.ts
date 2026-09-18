/**
 * The analysis input the workbench builds (AGENTS 22, ADR 0026).
 *
 * The provider contract is deliberately blunt about two things: which car the session
 * was determined to be, and where each code's wording came from. Both are assembled
 * here, from the read models the backend already holds — so the rules worth testing are
 * the *omissions*: nothing invented when nothing was determined, no `measure` when no
 * check is documented, and never the VIN (the HTTP provider forwards this object).
 */

import assert from "node:assert/strict";
import { type EvidenceItem, type Hypothesis, proven, unproven } from "@vdp/diagnostic-ir";
import type { VehicleSummary } from "@vdp/domain";
import type { EvidenceSnapshot } from "@vdp/runtime";
import type { VehicleSessionData } from "@vdp/storage";
import { describe, test } from "vitest";
import { type FixturePatch, patched } from "../../../tests/helpers/fixture.js";
import { buildAnalysisInput } from "../src/analysis-input.js";
import { type AnalysisDtcSource, analysisDtcOf, analysisVehicleOf } from "../src/analysis-input.js";

type Determination = VehicleSessionData["determination"];

function determination(patch: FixturePatch<NonNullable<Determination>> = {}): Determination {
  const match = {
    oem: "simulator",
    packageVersion: "1.0.0",
    vehicleId: "virtual-vehicle",
    brand: "Virtual",
    model: "Simulator vehicle",
    score: 1,
    trust: 1,
    provenanceType: "own",
    engineIds: ["sim-petrol"],
    gearboxIds: [],
    ecus: { expected: 3, matched: 3, missing: [] },
    evidence: [],
    conflicts: [],
  };
  // An `undefined` in the patch means "this field never came" — the determination
  // of a car that resolved nothing has no `match` key at all (ADR 0029 §3).
  return patched(
    {
      resolvedAt: "2026-09-14T00:00:00.000Z",
      match,
      notes: [],
      unexplained: [],
      alternatives: [],
    },
    patch,
  );
}

const MATCH_WEAK = {
  oem: "simulator",
  packageVersion: "1.0.0",
  vehicleId: "virtual-vehicle",
  brand: "Virtual",
  model: "Simulator vehicle",
  score: 0.5,
  trust: 0.6,
  provenanceType: "own",
  engineIds: ["sim-petrol"],
  gearboxIds: [],
  ecus: { expected: 3, matched: 3, missing: [] },
  evidence: [],
  conflicts: [],
};

const identity: VehicleSummary = {
  vehicleId: "virtual-vehicle",
  brand: "Virtual",
  model: "Simulator vehicle",
  modelYear: 2003,
  description: "Virtual Simulator vehicle 2003",
};

describe("analysisVehicleOf", () => {
  test("nothing measured and nothing concluded means no vehicle block at all", () => {
    assert.equal(analysisVehicleOf(undefined, undefined), undefined);
  });

  test("the VIN stays out of the object a provider may send off the box", () => {
    const vehicle = analysisVehicleOf({ ...identity, vin: "1HGCM82633A004352" }, determination());
    assert.equal(vehicle?.vin, undefined);
    assert.equal(vehicle?.brand, "Virtual");
    assert.equal(vehicle?.modelYear, 2003);
  });

  test("the strength of the determination travels with the car", () => {
    const vehicle = analysisVehicleOf(identity, determination({ match: { ...MATCH_WEAK } }));
    assert.equal(vehicle?.vehicleId, "virtual-vehicle");
    assert.equal(vehicle?.score, 0.5);
    assert.equal(vehicle?.trust, 0.6);
    assert.equal(vehicle?.provenanceType, "own");
  });

  test("an unresolved determination contributes its reason and nothing else", () => {
    const unresolved = determination({
      match: undefined,
      reason: "no package declares vehicle definitions",
    });
    const vehicle = analysisVehicleOf(undefined, unresolved);
    assert.deepEqual(vehicle, { unresolvedReason: "no package declares vehicle definitions" });
  });

  test("an empty determination object is not turned into an empty vehicle block", () => {
    // A session that never resolved has `determination === undefined`; a determination
    // without a match has a reason. Either way the block is absent rather than a
    // present-but-empty object, which a provider could misread as "known, said nothing".
    assert.equal(analysisVehicleOf({ description: "" } as VehicleSummary, undefined), undefined);
  });
});

describe("analysisDtcOf", () => {
  const bare: AnalysisDtcSource = {
    code: "P0420",
    description: "Catalyst efficiency below threshold",
    severity: "major",
    ecu: "Engine",
  };

  test("a code without knowledge stays without scope or measure", () => {
    const dtc = analysisDtcOf(bare);
    assert.deepEqual(dtc, {
      code: "P0420",
      description: "Catalyst efficiency below threshold",
      severity: "major",
      ecu: "Engine",
    });
    assert.equal("scope" in dtc, false, "absent, not empty");
    assert.equal("measure" in dtc, false);
  });

  test("the evaluable check is preferred over the first one listed", () => {
    const dtc = analysisDtcOf({
      ...bare,
      hint: "Rule out leaks first.",
      knowledge: {
        scope: "vehicle-engine",
        conditions: "closed loop, above 80 °C",
        patterns: [
          {
            checks: [
              { signalId: "engine.load", name: "Engine load", expect: "steady", measurable: false },
              {
                signalId: "cat.temp",
                name: "Catalyst temperature",
                expect: "above 600",
                min: 600,
                windowMs: 5000,
                measurable: true,
              },
            ],
          },
        ],
      },
    });
    assert.equal(dtc.scope, "vehicle-engine");
    assert.equal(dtc.conditions, "closed loop, above 80 °C");
    assert.equal(dtc.hint, "Rule out leaks first.");
    assert.deepEqual(dtc.measure, {
      signal: "cat.temp",
      name: "Catalyst temperature",
      expect: "above 600",
      min: 600,
      windowMs: 5000,
      measurable: true,
    });
  });

  test("a judgement check is still handed over, marked as not measurable", () => {
    const dtc = analysisDtcOf({
      ...bare,
      knowledge: {
        scope: "package",
        patterns: [
          {
            checks: [
              {
                signalId: "abs.speed_left",
                name: "Wheel speed front left",
                expect: "plausible",
                min: 45,
                max: 55,
                measurable: false,
              },
            ],
          },
        ],
      },
    });
    assert.equal(dtc.measure?.measurable, false);
    assert.equal(dtc.measure?.max, 55);
  });

  test("a name equal to the signal id is not repeated", () => {
    const dtc = analysisDtcOf({
      ...bare,
      knowledge: {
        scope: "vehicle",
        patterns: [
          { checks: [{ signalId: "oil.t", name: "oil.t", expect: "warm", measurable: true }] },
        ],
      },
    });
    assert.equal("name" in (dtc.measure ?? {}), false);
    assert.equal(dtc.measure?.signal, "oil.t");
  });

  test("a pattern list without checks yields scope but no measure", () => {
    const dtc = analysisDtcOf({
      ...bare,
      knowledge: { scope: "vehicle", patterns: [{ checks: [] }] },
    });
    assert.equal(dtc.scope, "vehicle");
    assert.equal(dtc.measure, undefined);
  });
});

/**
 * The whole provider input, assembled once (P0 #39/#42, ADR 0038).
 *
 * `analyze()` used to build this in the backend, field by field, with no evidence in
 * it. The rules that matter are the ones a projection can get wrong: a row that has
 * no item must not claim a source, and a statistic without numbers must not become a
 * confident zero.
 */
describe("buildAnalysisInput", () => {
  const AT = "2026-09-14T09:00:00.000Z";

  function session(fields: FixturePatch<VehicleSessionData> = {}): VehicleSessionData {
    return patched(
      {
        schemaVersion: 1,
        id: "session_web",
        startedAt: AT,
        adapter: { id: "virtual", kind: "virtual", name: "Virtual CAN", channels: ["vcan0"] },
        transport: { kind: "virtual", channel: "vcan0", mtu: 8 },
        ecus: [
          {
            id: "engine",
            name: "Engine",
            protocol: "uds",
            txId: 0x7e0,
            rxId: 0x7e8,
            extended: false,
            identification: [],
            supportedServices: [0x19],
            sessionType: 1,
            timing: { p2Ms: 50, p2StarMs: 5_000 },
            reachable: true,
          },
        ],
        dtcSnapshots: [],
        measurements: [],
        actions: [],
        notes: [{ id: "n1", timestamp: AT, text: "rough idle under load" }],
        tags: [],
        mileageKm: 90_000,
      },
      fields,
    ) as VehicleSessionData;
  }

  function evidence(
    items: readonly EvidenceItem[],
    hypotheses: readonly Hypothesis[] = [],
  ): EvidenceSnapshot {
    return {
      evidence: {
        kind: "evidence",
        sessionId: "session_web",
        collectedAt: AT,
        items: [...items],
        conflicts: [],
      },
      hypotheses: [...hypotheses],
    };
  }

  const dtcItem: EvidenceItem = {
    id: "dtc:P0420@engine",
    kind: "dtc",
    subject: "P0420",
    statement: "Catalyst efficiency below threshold (Engine, severity major)",
    at: AT,
    ecuId: "engine",
    evidence: proven({ origin: "definition", at: AT, definitionVersion: "1.4.0" }),
  };

  test("the evidence set, the hypotheses and the versions reach the provider", () => {
    const set = evidence([dtcItem]);
    const input = buildAnalysisInput({
      session: session(),
      identity: { vin: "1HGCM82633A004352", brand: "Honda" } as VehicleSummary,
      dtcs: [dtcRow({})],
      statistics: [],
      anomalies: [],
      evidence: set,
      versions: { promptVersion: "2026-09-14.1", runtimeVersion: "0.1.0" },
    });
    assert.equal(input.evidence, set.evidence);
    assert.deepEqual(input.hypotheses, []);
    assert.deepEqual(input.versions, { promptVersion: "2026-09-14.1", runtimeVersion: "0.1.0" });
    assert.deepEqual(input.notes, ["rough idle under load"]);
    assert.equal(input.mileageKm, 90_000);
    // The VIN stays out of the vehicle block unless a caller puts it in: the HTTP
    // provider forwards this object off the box (AGENTS 27).
    assert.equal(input.vehicle?.vin, undefined);
  });

  test("a code is linked to its item by code and by the ECU the row shows", () => {
    const input = buildAnalysisInput({
      session: session(),
      identity: undefined,
      dtcs: [dtcRow({}), dtcRow({ code: "U0121", ecu: "ABS" })],
      statistics: [],
      anomalies: [],
      evidence: evidence([dtcItem]),
      versions: { promptVersion: "p", runtimeVersion: "r" },
    });
    assert.deepEqual(input.dtcs[0]?.evidence, {
      proven: true,
      line: `definition · ${AT} · def 1.4.0`,
      itemId: "dtc:P0420@engine",
    });
    assert.equal(
      "evidence" in (input.dtcs[1] ?? {}),
      false,
      "the ABS row has no item in this set - an absent source stays absent",
    );
  });

  test("an unproven item reaches the provider as unproven, with its sentence", () => {
    const gap: EvidenceItem = {
      ...dtcItem,
      evidence: unproven("no description is documented for this code", { at: AT }),
    };
    const input = buildAnalysisInput({
      session: session(),
      identity: undefined,
      dtcs: [dtcRow({ description: "Fehlertyp 0x00" })],
      statistics: [],
      anomalies: [],
      evidence: evidence([gap]),
      versions: { promptVersion: "p", runtimeVersion: "r" },
    });
    assert.equal(input.dtcs[0]?.evidence?.proven, false);
    assert.match(input.dtcs[0]?.evidence?.line ?? "", /^not proven: no description is documented/);
    assert.equal(
      input.dtcs[0]?.evidence?.itemId,
      "dtc:P0420@engine",
      "the citation survives an unproven statement",
    );
  });

  test("a session that never resolved nothing still answers, with empty parts", () => {
    const input = buildAnalysisInput({
      session: undefined,
      identity: undefined,
      dtcs: [],
      statistics: [],
      anomalies: [],
      evidence: evidence([]),
      versions: { promptVersion: "p", runtimeVersion: "r" },
    });
    assert.equal(input.vehicle, undefined);
    assert.equal("mileageKm" in input, false, "no session is not a session with 0 km");
    assert.deepEqual(input.signals, []);
    assert.deepEqual(input.notes, []);
  });

  test("statistics keep their sample count when their numbers are absent", () => {
    const input = buildAnalysisInput({
      session: session({ mileageKm: undefined }),
      identity: undefined,
      dtcs: [],
      statistics: [
        {
          signalId: "engine.rpm",
          name: "Engine speed",
          samples: 0,
          min: null,
          max: null,
          average: null,
          delta: null,
          first: null,
          last: null,
          outOfRangeCount: 0,
        },
      ],
      anomalies: [{ signalId: "engine.rpm", reason: "no value in the window" }],
      evidence: evidence([]),
      versions: { promptVersion: "p", runtimeVersion: "r" },
    });
    assert.deepEqual(input.signals[0], {
      signal: "engine.rpm",
      name: "Engine speed",
      samples: 0,
      min: 0,
      max: 0,
      average: 0,
      delta: 0,
      outOfRangeCount: 0,
    });
    assert.deepEqual(input.anomalies, [{ signal: "engine.rpm", reason: "no value in the window" }]);
  });

  test("the recording and the run scenario travel with the input (master prompt §14)", () => {
    const input = buildAnalysisInput({
      session: session(),
      identity: undefined,
      dtcs: [],
      statistics: [],
      anomalies: [],
      evidence: evidence([]),
      versions: { promptVersion: "p", runtimeVersion: "r" },
      scenario: { id: "alternator_failure", title: "Lichtmaschinen-Ausfall", seed: 4242 },
    });
    // The id is the session's own id — provenance has to point at the file a human
    // can reopen, not at a copy with a invented name.
    assert.equal(input.recordingId, "session_web");
    assert.deepEqual(input.scenario, {
      id: "alternator_failure",
      title: "Lichtmaschinen-Ausfall",
      seed: 4242,
    });
  });

  test("no session and no scenario leave both fields absent, not empty", () => {
    const input = buildAnalysisInput({
      session: undefined,
      identity: undefined,
      dtcs: [],
      statistics: [],
      anomalies: [],
      evidence: evidence([]),
      versions: { promptVersion: "p", runtimeVersion: "r" },
    });
    assert.equal("recordingId" in input, false, "no session is not a recording with no id");
    assert.equal("scenario" in input, false, "a field measurement is not a simulated scenario");
  });
});

function dtcRow(fields: FixturePatch<AnalysisDtcSource>): AnalysisDtcSource {
  return patched(
    {
      code: "P0420",
      description: "Catalyst efficiency below threshold",
      severity: "major",
      ecu: "Engine",
    },
    fields,
  );
}
