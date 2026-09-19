/**
 * The scenario library (ADR 0048).
 *
 * `scenarios/*.json` is the only catalog the platform has, so the loader that turns the
 * directory into scenarios is worth its own specs: a broken file must fail the library
 * with the file named, a duplicated id must fail with both files named, and a good set
 * must come out in the caller's order with its determinism intact — because every
 * consumer (workbench, suites, replay) reads the directory through exactly this path.
 */

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { type ScenarioFileInput, loadScenarioLibrary, scenariosOf } from "./scenario-library.js";

const good = (id: string): ScenarioFileInput => ({
  file: `${id}.json`,
  text: JSON.stringify({
    scenario: id,
    steps: [{ ignition: "on" }],
    expect: [{ battery_voltage: "< 12.0" }],
    determinism: { clock: "model-time", seed: 7 },
  }),
});

describe("loadScenarioLibrary", () => {
  test("a good set comes out in the caller's order, with seed and vehicle", () => {
    const library = loadScenarioLibrary([good("b-second"), good("a-first")]);
    assert.ok(library.ok);
    assert.deepEqual(
      library.files.map((file) => [file.file, file.id]),
      [
        ["b-second.json", "b-second"],
        ["a-first.json", "a-first"],
      ],
      "the caller's order is the catalog's order",
    );
    assert.deepEqual(library.files[0]?.determinism, { clock: "model-time", seed: 7 });
    assert.equal(library.files[0]?.vehicle, "high-fidelity-simulator");
  });

  test("a broken file fails the whole library, with every problem and its path", () => {
    const library = loadScenarioLibrary([
      good("fine"),
      {
        file: "broken.json",
        text: JSON.stringify({
          scenario: "broken",
          steps: [{ ignition: "on" }],
          expect: [{ battery_voltage: "< 12.0" }],
          determinism: { clock: "model-time", seed: 1 },
          engine: "off",
        }),
      },
    ]);
    assert.ok(!library.ok);
    assert.equal(library.issues.length, 1);
    assert.equal(library.issues[0]?.file, "broken.json");
    assert.ok(
      library.issues[0]?.problems.some((problem) => /unknown key "engine"/.test(problem)),
      library.issues[0]?.problems.join("; "),
    );
  });

  test("one id in two files is a conflict, and both files are named", () => {
    const library = loadScenarioLibrary([good("same"), good("same")]);
    assert.ok(!library.ok);
    assert.equal(library.issues.length, 1);
    assert.match(library.issues[0]?.file ?? "", /same\.json/);
    assert.match(library.issues[0]?.problems[0] ?? "", /already defined by same\.json/);
  });

  test("several broken files are all reported, not just the first", () => {
    const library = loadScenarioLibrary([
      { file: "a.json", text: "{not json" },
      { file: "b.json", text: "{}" },
    ]);
    assert.ok(!library.ok);
    assert.deepEqual(
      library.issues.map((issue) => issue.file),
      ["a.json", "b.json"],
    );
  });

  test("scenariosOf refuses to hand out scenarios from a broken library", () => {
    assert.throws(
      () => scenariosOf({ ok: false, issues: [{ file: "x.json", problems: ["boom"] }] }),
      /x.json: boom/,
    );
    const scenarios = scenariosOf(loadScenarioLibrary([good("fine")]));
    assert.equal(scenarios.length, 1);
    assert.equal(scenarios[0]?.id, "fine");
  });
});
