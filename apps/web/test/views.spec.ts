/**
 * The view projections `apps/web` puts on screen (AGENTS 12, 14, 18, 20).
 *
 * These mappers used to be private helpers of `DemoBackend`, which had two costs: they
 * could only be reached through a whole HTTP route, and `backend.ts` carried the
 * presentation it is supposed to only wire (0.E E15). The move is a relocation — so
 * this file tests exactly what the move must not have changed: which fields are added,
 * which stay absent, and which formatting is the presentation layer's job.
 *
 * Fixtures are typed through `Parameters<…>` on purpose: a test that names a field the
 * domain does not have would compile against a stale idea of the read model.
 */

import assert from "node:assert/strict";
import { VehicleBehaviourModel } from "@vdp/simulators";
import { describe, test } from "vitest";
import { type FixturePatch, patched, without } from "../../../tests/helpers/fixture.js";
import { type DtcView, toDtcView } from "../src/dtc-view.js";
import { type EcuView, toEcuView, toFreezeFrameView } from "../src/ecu-view.js";
import { summariseScenarios, toScenarioRunView } from "../src/scenario-view.js";
import {
  type SampleView,
  formatCanId,
  formatValue,
  toMarkerView,
  toSampleView,
  toTraceView,
} from "../src/trace-view.js";

/** One model, built once: every view fixture reads its live state instead of a copy. */
const MODEL = new VehicleBehaviourModel({ initial: { ignition: "on" } });

type DtcInput = Parameters<typeof toDtcView>[0];
type EcuInput = Parameters<typeof toEcuView>[0];
type FreezeInput = Parameters<typeof toFreezeFrameView>[0];
type ReadingInput = Parameters<typeof toSampleView>[0];
type TraceInput = Parameters<typeof toTraceView>[0];

function dtc(fields: FixturePatch<DtcInput> = {}): DtcInput {
  return patched(
    {
      code: "P0420",
      raw: "042000",
      ecuId: "ecu_1",
      ecuName: "Engine Control Unit",
      status: 0x24,
      failureType: "00",
      confirmed: true,
      pending: false,
      testFailed: true,
      hasFreezeFrame: true,
      severity: "major",
      description: "Catalyst efficiency below threshold",
    },
    fields,
  );
}

/** The one ECU row the fault mapper looks at: session id in, response id out. */
const ECUS = [{ id: "ecu_1", rxId: "0x7E8" }];

describe("toDtcView", () => {
  test("addresses the row by the ECU that answered, not by its session id", () => {
    const view = toDtcView(dtc(), ECUS);
    assert.equal(view.ecu, "Engine Control Unit");
    assert.equal(view.rxId, "0x7E8");
    assert.equal(view.status, "0x24");
    assert.equal(view.freezeFrame, true);
  });

  test("an ECU that is not in the list still yields a row, addressed by its id", () => {
    const view = toDtcView(dtc({ ecuId: "ecu_9" }), ECUS);
    assert.equal(view.rxId, "ecu_9", "no invented address for an unknown ECU");
  });

  test("an undocumented code shows the raw failure type instead of a guess", () => {
    const view = toDtcView(dtc({ description: undefined, severity: undefined }), ECUS);
    assert.equal(view.description, "Fehlertyp 0x00");
    assert.equal(view.severity, "info", "no severity documented means no severity claimed");
  });

  test("optional columns stay absent until the scan says something", () => {
    const bare = toDtcView(dtc(), ECUS);
    for (const key of ["hint", "firstSeen", "lastSeen", "isNew", "relatedSignals", "knowledge"]) {
      assert.equal(key in bare, false, `${key} must be absent, not empty`);
    }
    const full = toDtcView(
      dtc({
        hint: "Compare before replacing.",
        firstSeen: "2026-09-14T10:00:00.000Z",
        lastSeen: "2026-09-14T10:05:00.000Z",
        firstSeenInThisScan: true,
        relatedSignals: [{ id: "engine.load", name: "Engine load" }],
        knowledge: { scope: "vehicle-engine", patterns: [], notes: [] },
      }),
      ECUS,
    );
    assert.equal(full.hint, "Compare before replacing.");
    assert.equal(full.isNew, true, "only a code new in this scan is marked as new");
    assert.deepEqual(full.relatedSignals, [{ id: "engine.load", name: "Engine load" }]);
    assert.ok(full.knowledge, "the view gains the German scope label, not the raw key alone");
    assert.equal(full.knowledge?.scope, "vehicle-engine");
  });

  test("a second scan that still sees the code does not call it new", () => {
    const view = toDtcView(dtc({ firstSeenInThisScan: false }), ECUS);
    assert.equal("isNew" in view, false);
  });

  test("the row is a copy, so the table cannot be mutated through it", () => {
    const info = dtc({ relatedSignals: [{ id: "a", name: "A" }] });
    const view: DtcView = toDtcView(info, ECUS);
    view.relatedSignals?.push({ id: "b", name: "B" });
    assert.equal(info.relatedSignals?.length, 1, "the read model keeps its own list");
  });
});

describe("toEcuView", () => {
  test("formats addresses and services for the screen", () => {
    const ecu: EcuInput = {
      ecuId: "ecu_1",
      definitionEcuId: "simulator:engine",
      name: "Engine",
      protocol: "uds",
      txId: 0x7e0,
      rxId: 0x7e8,
      extended: false,
      reachable: true,
      identification: [{ label: "VIN", value: "1HGCM82633A004352", did: 0xf190 }],
      supportedServices: [0x10, 0x22, 0x27],
      sessionType: 3,
      p2Ms: 50,
      dtcCount: 2,
      capabilities: ["read-dtc", "clear-dtc"],
    };
    const view: EcuView = toEcuView(ecu);
    assert.equal(view.txId, "0x7E0");
    assert.equal(view.rxId, "0x7E8");
    assert.deepEqual(view.services, ["0x10", "0x22", "0x27"]);
    assert.deepEqual(view.identification, [{ label: "VIN", value: "1HGCM82633A004352" }]);
    assert.equal("lastError" in view, false, "an ECU that answered has no error to show");
  });

  test("a failed ECU carries its reason, and nothing else changes", () => {
    const view = toEcuView({
      ecuId: "ecu_2",
      name: "Gearbox",
      protocol: "unknown",
      txId: 0x7d1,
      rxId: 0x7d9,
      extended: true,
      reachable: false,
      identification: [],
      supportedServices: [],
      sessionType: 1,
      p2Ms: 50,
      dtcCount: 0,
      capabilities: [],
      lastError: "no response within P2",
    });
    assert.equal(view.lastError, "no response within P2");
    assert.deepEqual(view.services, []);
    assert.equal(view.extended, true);
  });
});

describe("toFreezeFrameView", () => {
  test("keeps decoded values next to their bytes and formats numbers for display", () => {
    const info: FreezeInput = {
      code: "P0420",
      recordNumber: 1,
      documented: false,
      unassignedHex: "00 A1",
      notes: ["record is longer than the documented layout"],
      fields: [
        {
          did: 0xf000,
          name: "Snapshot record",
          rawHex: "02 04 1E",
          values: [
            {
              signalId: "engine.coolant_temperature",
              name: "Coolant temperature",
              value: 90.256,
              unit: "°C",
              rawHex: "5A",
              outOfRange: false,
            },
            {
              signalId: "engine.load",
              name: "Engine load",
              value: "idle",
              rawHex: "20",
              outOfRange: false,
            },
          ],
        },
      ],
    };
    const view = toFreezeFrameView(info);
    assert.equal(view.documented, false, "a partial layout says so instead of looking complete");
    assert.deepEqual(view.notes, ["record is longer than the documented layout"]);
    assert.equal(view.unassignedHex, "00 A1");
    const field = view.fields[0];
    assert.equal(field?.did, "0xF000");
    assert.equal(field?.values[0]?.value, "90.26");
    assert.equal(field?.values[0]?.unit, "°C");
    assert.equal(field?.values[1]?.value, "idle");
    assert.equal("unit" in (field?.values[1] ?? {}), false);
  });
});

describe("toSampleView, toMarkerView and toTraceView", () => {
  test("the chart gets a number, the table gets a string — never the other way round", () => {
    const reading: ReadingInput = {
      signalId: "engine.rpm",
      name: "Engine speed",
      unit: "rpm",
      timestamp: "2026-09-14T10:00:00.000Z",
      t: 1_250,
      value: 812.5,
      rawValue: 3_250,
      rawHex: "0CA0",
      outOfRange: false,
    };
    const sample: SampleView = toSampleView(reading);
    assert.equal(sample.numeric, 812.5);
    assert.equal(sample.value, "812.50");
    assert.equal(sample.rawValue, 3_250, "raw and decoded travel side by side (AGENTS 34.7)");

    const text = toSampleView(without({ ...reading, value: "closed loop" }, "name"));
    assert.equal(text.numeric, null, "a textual signal has no number to plot");
    assert.equal(text.name, "engine.rpm", "an unnamed signal falls back to its id");
    assert.equal(text.value, "closed loop");
  });

  test("formatValue is the single place a number becomes text", () => {
    assert.equal(formatValue(80), "80");
    assert.equal(formatValue(80.5), "80.50");
    assert.equal(formatValue(true), "true");
    assert.equal(formatValue("n/a"), "n/a");
  });

  test("a CAN id has one printed shape, in the ECU table and in the trace panel", () => {
    assert.equal(formatCanId(0x7e8), "0x7E8");
    assert.equal(formatCanId(0x18da00f1), "0x18DA00F1");
  });

  test("a marker without a detail omits it", () => {
    const bare = toMarkerView({
      markerId: "m1",
      t: 10,
      timestamp: "2026-09-14T10:00:00.000Z",
      label: "P0420",
      kind: "dtc",
    });
    const withDetail = toMarkerView({
      markerId: "m2",
      t: 11,
      timestamp: "2026-09-14T10:00:01.000Z",
      label: "clear",
      kind: "action",
      detail: "3 codes removed",
    });
    assert.equal("detail" in bare, false);
    assert.equal(withDetail.detail, "3 codes removed");
    assert.equal(withDetail.id, "m2");
  });

  test("the trace row is passed through, hex as recorded", () => {
    const entry: TraceInput = {
      t: 4,
      timestamp: "2026-09-14T10:00:00.000Z",
      canId: 0x7e0,
      canIdHex: "0x7E0",
      direction: "tx",
      dlc: 3,
      payload: new Uint8Array([2, 0x10, 1]),
      payloadHex: "02 10 01",
      channel: "vcan0",
      extended: false,
      fd: false,
    };
    assert.deepEqual(toTraceView(entry), {
      t: 4,
      timestamp: "2026-09-14T10:00:00.000Z",
      canId: "0x7E0",
      direction: "tx",
      dlc: 3,
      data: "02 10 01",
      channel: "vcan0",
      extended: false,
    });
  });
});

describe("toDtcView — provenance of the description (P0 #6)", () => {
  test("the IR's evidence line reaches the row unchanged", () => {
    const view = toDtcView(
      dtc({
        evidence: "definition · 2026-09-14T09:00:00.000Z · engine · def 1.0.0",
      }),
      ECUS,
    );
    assert.equal(
      view.provenance,
      "definition · 2026-09-14T09:00:00.000Z · engine · def 1.0.0",
      "the row quotes the scan; it does not label the source in its own words (AGENTS 24)",
    );
  });

  test("a record that was never enriched stays without a provenance line", () => {
    const view = toDtcView(dtc({ evidence: undefined }), ECUS);
    assert.equal(
      "provenance" in view,
      false,
      "no evidence is not the same as 'nothing documented' - the field is absent",
    );
  });
});

describe("GuidedDiagnosis and Chaos views", () => {
  test("GuidedDiagnosisView structure conforms to contract", () => {
    const gd: import("../src/views.js").GuidedDiagnosisView = {
      status: "in-progress",
      summary: "Diagnosing misfire",
      stepsCompleted: 1,
      hypotheses: [
        {
          id: "hyp_1",
          claim: "Cylinder 1 ignition coil failure",
          confidence: 0.85,
          outcome: "confirmed",
          checks: [{ signal: "engine.misfire_cyl1", expect: "> 5", outcome: "match" }],
        },
      ],
      nextRecommendedTest: {
        hypothesisId: "hyp_1",
        rationale: "Verify spark plug gap",
        test: { signal: "engine.spark_dwell", expect: "in-range", min: 2.0, max: 4.0 },
      },
    };
    assert.equal(gd.status, "in-progress");
    assert.equal(gd.hypotheses.length, 1);
    assert.equal(gd.hypotheses[0]?.outcome, "confirmed");
  });

  test("ChaosStatusView structure conforms to contract", () => {
    const chaos: import("../src/views.js").ChaosStatusView = {
      active: true,
      dropRate: 0.2,
      dropBurstRemaining: 5,
      droppedFrames: 12,
      corruptedFrames: 3,
      delayedFrames: 1,
    };
    assert.equal(chaos.active, true);
    assert.equal(chaos.droppedFrames, 12);
  });
});

describe("scenario views", () => {
  type RunInput = Parameters<typeof toScenarioRunView>[0];
  type MemoryInput = Parameters<typeof toScenarioRunView>[1];

  function run(fields: FixturePatch<RunInput> = {}): RunInput {
    return patched(
      {
        scenarioId: "under-voltage-at-start",
        passed: true,
        checks: [
          {
            kind: "dtc" as const,
            subject: "bcm:B1001",
            expected: "active",
            actual: "active",
            passed: true,
            because: "cranking holds the supply below the window",
            atMs: 1_500,
          },
        ],
        unexpected: [],
        timeline: ["1000 ms: ignition → start"],
        // The real state object of a fresh model, not a hand-written subset: the view
        // reads nine fields of it, and a fixture that named its own would test a shape
        // the simulator does not produce.
        finalState: MODEL.state,
      },
      fields,
    );
  }

  test("the run view keeps both verdicts: what the model latched and what it predicted", () => {
    const memory: MemoryInput = [
      { ecu: "bcm", code: "B1001", status: 0x2f, active: true },
      { ecu: "engine", code: "P0300", status: 0x08, active: false },
    ];
    const view = toScenarioRunView(run(), memory);
    assert.equal(view.scenarioId, "under-voltage-at-start");
    assert.equal(view.passed, true);
    assert.deepEqual(
      view.checks.map((check) => `${check.subject}=${check.actual}/${check.passed}`),
      ["bcm:B1001=active/true"],
    );
    assert.equal(view.checks[0]?.because, "cranking holds the supply below the window");
    assert.equal(view.timeline.length, 1);
    assert.equal(view.model.supplyVoltage, MODEL.state.supplyVoltage);
    assert.equal(
      view.model.engineRunning,
      MODEL.state.engineRunning,
      "the physical state travels with the verdict, and it is the model's own number",
    );
    assert.deepEqual(
      Object.keys(view.model).sort(),
      [
        "coolantC",
        "engineRunning",
        "ignition",
        "longTermTrimPct",
        "operationCycles",
        "rpm",
        "speedKph",
        "supplyVoltage",
        "timeMs",
      ].sort(),
      "the panel gets nine fields and no more — a wide object on the wire is an undocumented one",
    );
    assert.deepEqual(
      view.memory.map((entry) => `${entry.ecu}:${entry.code}=${entry.active}`),
      ["bcm:B1001=true", "engine:P0300=false"],
      "0x2f reads as active and 0x08 as stored — the distinction the panel is for",
    );
  });

  test("the projection copies its lists, so a later run cannot rewrite a shown one", () => {
    const memory: MemoryInput = [{ ecu: "bcm", code: "B1001", status: 0x2f, active: true }];
    const view = toScenarioRunView(run(), memory);
    const first = memory[0];
    assert.ok(first);
    first.status = 0x00;
    assert.equal(
      view.memory[0]?.status,
      0x2f,
      "the rows a response was built from stay as they were",
    );
  });

  test("the catalog projection names what a picker has to show", () => {
    const summaries = summariseScenarios([
      {
        id: "demo",
        title: "A demo scenario",
        summary: "One cause, one code.",
        durationMs: 5_000,
        steps: [
          { atMs: 0, cause: { kind: "battery", volts: 10 } },
          { atMs: 1_000, cause: { kind: "ignition", state: "start" }, holdMs: 500 },
        ],
        expectations: [
          { ecu: "bcm", code: "B1001", state: "active", because: "the supply is down" },
          { ecu: "gateway", code: "U0100", state: "absent", because: "the engine still answers" },
        ],
      },
    ]);
    assert.equal(summaries.length, 1);
    const summary = summaries[0];
    assert.equal(summary?.steps, 2, "a run of 5 s with two causes, said in the row");
    assert.deepEqual(summary?.expectations, ["bcm:B1001 → active", "gateway:U0100 → absent"]);
    assert.equal(summary?.durationMs, 5_000);
    assert.equal(summary?.title, "A demo scenario");
  });
});
