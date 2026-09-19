/**
 * The scenario panel as the operator reads it (AGENTS 32, ADR 0040 §8).
 *
 * The panel exists to answer one question — did the car behave the way the scenario
 * said it would, and can a tester read that off the wire — and every function here
 * carries one way to get that answer quietly wrong:
 *
 *  - a verdict that counts checks but drops the unpredicted latches would call a
 *    contaminated run "bestanden" (the `closedWorld` half of the verdict),
 *  - a run without a single expectation would pass vacuously,
 *  - a model field the projection does not know would vanish from the screen, so a
 *    new signal reads as "nothing happened",
 *  - a refused run (wrong adapter) would show as an empty panel instead of the
 *    server's sentence.
 *
 * These are mapping mistakes, and a mapping mistake in a workbench is worse than in a
 * library: the person looking at it has no reason to doubt it.
 */

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { type FixturePatch, patched } from "../../../tests/helpers/fixture.js";
import { scenarioFiles } from "../../../tests/helpers/scenario-files.js";
import {
  type ScenarioCheckView,
  type ScenarioMemoryView,
  type ScenarioRunView,
  type ScenarioSummary,
  stateWord,
  toCheckRows,
  toMemoryNote,
  toMemoryRows,
  toModelRows,
  toScenarioCatalogView,
  toScenarioOptions,
  toScenarioPanelView,
  toScenarioVerdict,
} from "../src/scenario-view.js";

const summary = (patch: FixturePatch<ScenarioSummary> = {}): ScenarioSummary =>
  patched(
    {
      id: "under-voltage-at-start",
      title: "Unterspannung beim Start",
      summary: "Die Batterie ist leer, bevor die Zündung kommt.",
      durationMs: 4500,
      steps: 3,
      expectations: ["bcm:B1001 → active", "engine:P0300 → active"],
    },
    patch,
  );

const check = (patch: FixturePatch<ScenarioCheckView> = {}): ScenarioCheckView =>
  patched(
    {
      subject: "engine:P0300",
      expected: "active",
      actual: "active",
      passed: true,
      because: "Zylindersäge unter 9,6 V",
      atMs: 1500,
    },
    patch,
  );

const runView = (patch: FixturePatch<ScenarioRunView> = {}): ScenarioRunView =>
  patched(
    {
      scenarioId: "under-voltage-at-start",
      passed: true,
      checks: [check()],
      unexpected: [],
      timeline: ["0 ms: Zündung aus, Spannung 10,7 V"],
      model: {
        timeMs: 4500,
        supplyVoltage: 10.7,
        rpm: 0,
        engineRunning: false,
      },
      memory: [],
    },
    patch,
  );

describe("the scenario picker", () => {
  test("names the three numbers a run costs", () => {
    const [option] = toScenarioOptions([summary()]);
    assert.ok(option);
    assert.equal(option.value, "under-voltage-at-start");
    assert.equal(option.label, "Unterspannung beim Start");
    assert.equal(option.hint, "3 Schritte · ~4.5 s Modellzeit · 2 Erwartungen");
  });

  test("keeps the catalog order, because the catalog is the documentation", () => {
    const options = toScenarioOptions([
      summary({ id: "a", title: "A" }),
      summary({ id: "b", title: "B" }),
    ]);
    assert.deepEqual(
      options.map((entry) => entry.value),
      ["a", "b"],
    );
  });

  test("an empty catalog is no options — the panel says why, the view does not guess", () => {
    assert.deepEqual(toScenarioOptions([]), []);
  });
});

describe("the verdict line", () => {
  test("before a run: idle, and it says so", () => {
    assert.deepEqual(toScenarioVerdict({ kind: "idle" }), {
      tone: "idle",
      headline: "kein Lauf",
      detail: "Szenario wählen und ausführen",
    });
  });

  test("while a run is in flight, the scenario is named", () => {
    const verdict = toScenarioVerdict({ kind: "running", scenarioId: "can-bus-dropouts" });
    assert.equal(verdict.tone, "busy");
    assert.match(verdict.detail, /can-bus-dropouts/);
  });

  test("a refused run shows the server's sentence, unchanged", () => {
    const verdict = toScenarioVerdict({
      kind: "error",
      message:
        'no scenario support on this connection — select the "High-fidelity virtual vehicle" adapter',
    });
    assert.equal(verdict.tone, "error");
    assert.equal(verdict.headline, "Abgelehnt");
    assert.equal(
      verdict.detail,
      'no scenario support on this connection — select the "High-fidelity virtual vehicle" adapter',
    );
  });

  test("a passed run counts its checks", () => {
    const verdict = toScenarioVerdict({
      kind: "done",
      run: runView({
        checks: [check(), check({ subject: "bcm:B1001" }), check({ subject: "engine:P0171" })],
      }),
    });
    assert.equal(verdict.tone, "ok");
    assert.equal(verdict.headline, "bestanden");
    assert.equal(verdict.detail, "3/3 Checks · keine unvorhergesehenen Latches");
  });

  test("a failed check is named by how many failed, not only that one did", () => {
    const verdict = toScenarioVerdict({
      kind: "done",
      run: runView({
        passed: false,
        checks: [check(), check({ subject: "engine:P0171", passed: false, actual: "absent" })],
      }),
    });
    assert.equal(verdict.tone, "bad");
    assert.equal(verdict.headline, "fehlgeschlagen");
    assert.equal(verdict.detail, "1/2 Checks · keine unvorhergesehenen Latches");
  });

  test("a run without expectations has no verdict to sell", () => {
    const verdict = toScenarioVerdict({ kind: "done", run: runView({ checks: [] }) });
    assert.equal(verdict.tone, "bad");
    assert.equal(verdict.headline, "ohne Aussage");
    assert.match(verdict.detail, /keine Checks gemeldet/);
  });

  test("an unpredicted latch turns a green run red, and says why", () => {
    const verdict = toScenarioVerdict({
      kind: "done",
      run: runView({ unexpected: ["transmission:P0700"] }),
    });
    assert.equal(verdict.tone, "bad");
    assert.equal(verdict.headline, "fehlgeschlagen");
    assert.match(verdict.detail, /1 unvorhergesehener Latch/);
    assert.match(verdict.detail, /Modell meldet bestanden/);
  });
});

describe("check rows", () => {
  test("states are read in the operator's words", () => {
    const [row] = toCheckRows([check({ expected: "stored", actual: "absent" })]);
    assert.ok(row);
    assert.equal(row.state, "ok");
    assert.equal(
      row.text,
      "1500 ms · engine:P0300 — erwartet gespeichert, gelesen nicht im Speicher · Zylindersäge unter 9,6 V",
    );
  });

  test("a failed check does not read as a passed one", () => {
    const [row] = toCheckRows([check({ passed: false })]);
    assert.ok(row);
    assert.equal(row.state, "fail");
  });

  test("an undocumented state reads as itself, never as a blank", () => {
    assert.equal(stateWord("active"), "aktiv");
    assert.equal(stateWord("2 x angehoben"), "2 x angehoben");
    const [row] = toCheckRows([check({ expected: "intermittent", actual: "2 x angehoben" })]);
    assert.ok(row);
    assert.match(row.text, /erwartet intermittierend, gelesen 2 x angehoben/);
  });
});

describe("the fault memory rows", () => {
  const memory = (patch: FixturePatch<ScenarioMemoryView> = {}): ScenarioMemoryView =>
    patched({ ecu: "bcm", code: "B1001", status: 0x2e, active: false }, patch);

  test("the word comes from the status byte, not from the row's presence", () => {
    const [row] = toMemoryRows([memory()]);
    assert.ok(row);
    assert.equal(row.active, false, "testFailed is clear — the fault is not current");
    assert.equal(row.stored, true, "confirmedDtc is set — a 0x19 0x02 read would answer it");
    assert.deepEqual(row.cells, ["bcm", "B1001", "0x2E", "bestätigt"]);
  });

  test("a currently failing code reads differently from a stored one", () => {
    const [row] = toMemoryRows([memory({ status: 0x2f, active: true })]);
    assert.ok(row);
    assert.deepEqual(row.cells, ["bcm", "B1001", "0x2F", "jetzt fehlgeschlagen"]);
    assert.equal(row.stored, true);
  });

  test("a documented code that was never reported is not shown as stored", () => {
    // The live finding this row exists for: the high-fidelity vehicle documents 14 codes
    // and reports one. `status 0x00` means the memory is empty for that code, and an
    // unlabelled table of 14 rows says the opposite of what the module holds.
    const [row] = toMemoryRows([memory({ status: 0x00 })]);
    assert.ok(row);
    assert.equal(row.stored, false);
    assert.deepEqual(row.cells, ["bcm", "B1001", "0x00", "nicht gespeichert"]);
  });

  test("pending is its own state, neither of the two above", () => {
    const [row] = toMemoryRows([memory({ status: 0x04 })]);
    assert.ok(row);
    assert.equal(row.cells[3], "pending");
    assert.equal(row.stored, false);
  });

  test("the note gives the table its denominator", () => {
    assert.match(toMemoryNote([]), /keine Speicherabfrage/);
    const fourteen = [
      memory(),
      ...Array.from({ length: 13 }, () => memory({ status: 0x00, code: "B1020" })),
    ];
    assert.equal(
      toMemoryNote(toMemoryRows(fourteen)),
      "1 von 14 dokumentierten Codes sind im Fehlerspeicher gemeldet",
    );
    assert.match(toMemoryNote(toMemoryRows([memory({ status: 0x00 })])), /keiner gemeldet/);
  });
});

describe("the end state rows", () => {
  test("in reading order, with the unit that belongs to the number", () => {
    const rows = toModelRows({ timeMs: 4500, supplyVoltage: 10.7, rpm: 0, engineRunning: false });
    assert.deepEqual(rows, [
      { label: "Modellzeit", value: "4500 ms" },
      // `10.70 V` and not `10.7 V`: the workbench formats every number with
      // `formatValue`, and one voltage with a trailing zero is the price of one
      // formatter for the whole page (AGENTS 14 — ein Ort für eine Regel).
      { label: "Versorgung", value: "10.70 V" },
      { label: "Drehzahl", value: "0 min⁻¹" },
      { label: "Motor läuft", value: "false" },
    ]);
  });

  test("a field the model gained is shown under its own name — never dropped", () => {
    const rows = toModelRows({ supplyVoltage: 12.6, absRearLeftKph: 0 });
    assert.deepEqual(rows, [
      { label: "Versorgung", value: "12.60 V" },
      { label: "absRearLeftKph", value: "0" },
    ]);
  });

  test("a listed field the run did not report leaves no row with an empty value", () => {
    const rows = toModelRows({ supplyVoltage: 11.9 });
    assert.deepEqual(
      rows.map((entry) => entry.label),
      ["Versorgung"],
    );
  });
});

describe("the catalog view", () => {
  test("serves every scenario file as an option — a dropped scenario is the silent bug", () => {
    const catalog = scenarioFiles();
    const view = toScenarioCatalogView(catalog.map((file) => file.scenario));
    assert.equal(view.options.length, catalog.length);
    assert.ok(view.options.length >= 4, "the shipped catalog has scenarios to pick");
    assert.deepEqual(
      view.options.map((option) => option.value),
      catalog.map((file) => file.id),
      "and in the catalog's order, because the catalog is the documentation",
    );
    assert.match(view.note, new RegExp(`^${catalog.length} Szenarien`));
  });

  test("every option says what a run costs", () => {
    const view = toScenarioCatalogView(scenarioFiles().map((file) => file.scenario));
    for (const option of view.options) {
      assert.match(option.hint, /\d+ Schritte · ~\d+(\.\d)? s Modellzeit · \d+ Erwartungen/);
      assert.notEqual(option.label, option.value, "a picker reads titles, not ids");
    }
  });

  test("an empty catalog says what it means", () => {
    const view = toScenarioCatalogView([]);
    assert.deepEqual(view.scenarios, []);
    assert.deepEqual(view.options, []);
    assert.match(view.note, /kein Szenario-Katalog auf dieser Verbindung/);
  });
});

describe("the panel view of a run", () => {
  test("assembles verdict, rows and timeline from one run", () => {
    const run = runView({
      checks: [check(), check({ subject: "bcm:B1001" })],
      memory: [{ ecu: "bcm", code: "B1001", status: 0x2e, active: false }],
    });
    const view = toScenarioPanelView(run);
    assert.equal(view.verdict.tone, "ok");
    assert.equal(view.checks.length, 2);
    assert.deepEqual(view.memory[0]?.cells, ["bcm", "B1001", "0x2E", "bestätigt"]);
    assert.equal(view.memoryNote, "1 von 1 dokumentierten Codes sind im Fehlerspeicher gemeldet");
    assert.equal(view.model[0]?.label, "Modellzeit");
    assert.deepEqual(view.timeline, run.timeline);
    assert.notEqual(view.timeline, run.timeline, "rows are copied, not handed through");
  });

  test("an empty run has an empty list, and the verdict says it is no verdict", () => {
    const view = toScenarioPanelView(runView({ checks: [], memory: [], timeline: [] }));
    assert.deepEqual(view.checks, []);
    assert.equal(view.verdict.tone, "bad");
    assert.equal(view.verdict.headline, "ohne Aussage");
  });
});
