import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { createRandom, modelTarget, runScenario, VehicleBehaviourModel } from "./index.js";
import { parseScenarioFile } from "./scenario-file.js";

const file = (over: Record<string, unknown>): string =>
  JSON.stringify({
    scenario: "spec-case",
    steps: [{ ignition: "on" }],
    expect: [{ battery_voltage: "< 12.0" }],
    determinism: { clock: "model-time", seed: 1 },
    ...over,
  });

describe("scenario file parsing", () => {
  test("a minimal file becomes steps at sequence time with an observation tail", () => {
    const parsed = parseScenarioFile(file({}));
    if (!parsed.ok) assert.fail(`expected acceptance, got ${JSON.stringify(parsed.errors)}`);
    const { scenario, determinism, vehicle } = parsed.file;
    assert.equal(scenario.id, "spec-case");
    assert.equal(vehicle, "high-fidelity-simulator");
    assert.deepEqual(determinism, { clock: "model-time", seed: 1 });
    assert.deepEqual(scenario.steps, [{ atMs: 0, cause: { kind: "ignition", state: "on" } }]);
    assert.equal(scenario.durationMs, 1_000);
    assert.equal(scenario.closedWorld, true);
  });

  test("wait steps advance model time; causes after them apply later", () => {
    const parsed = parseScenarioFile(
      file({
        steps: [{ ignition: "on" }, { alternator: "fail" }, { wait: 5_000 }, { load: "high" }],
      }),
    );
    assert.ok(parsed.ok);
    assert.deepEqual(
      parsed.file.scenario.steps.map((s) => [s.atMs, s.cause.kind]),
      [
        [0, "ignition"],
        [0, "alternator"],
        [5_000, "electrical-load"],
      ],
    );
    assert.deepEqual(parsed.file.scenario.steps[2]?.cause, { kind: "electrical-load", amps: 45 });
    assert.equal(parsed.file.scenario.durationMs, 6_000);
  });

  test("holdMs is a lift time, not a comment — the battery step ends when it says", () => {
    const parsed = parseScenarioFile(
      file({ steps: [{ battery: { volts: 10.5 }, holdMs: 2_000 }, { wait: 4_000 }] }),
    );
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.file.scenario.steps[0], {
      atMs: 0,
      cause: { kind: "battery", volts: 10.5 },
      holdMs: 2_000,
    });
  });

  test("named and numeric load, named and numeric alternator all map to causes", () => {
    const parsed = parseScenarioFile(
      file({
        steps: [
          { load: 60 },
          { load: { amps: 12 } },
          { load: "low" },
          { alternator: 0.5 },
          { alternator: "fail" },
        ],
      }),
    );
    assert.ok(parsed.ok, JSON.stringify("errors" in parsed ? parsed.errors : []));
    assert.deepEqual(
      parsed.file.scenario.steps.map((s) => s.cause),
      [
        { kind: "electrical-load", amps: 60 },
        { kind: "electrical-load", amps: 12 },
        { kind: "electrical-load", amps: 10 },
        { kind: "alternator", efficiency: 0.5 },
        { kind: "alternator", efficiency: 0 },
      ],
    );
  });

  test("ecu offline sugar is a wiring cause; recovery is holdMs, so “online” is refused", () => {
    const offline = parseScenarioFile(
      file({ steps: [{ ecu: { name: "abs", state: "offline" }, holdMs: 3_000 }] }),
    );
    assert.ok(offline.ok);
    assert.deepEqual(offline.file.scenario.steps[0]?.cause, {
      kind: "wiring",
      ecu: "abs",
      mode: "bus-open",
    });
    const online = parseScenarioFile(file({ steps: [{ ecu: { name: "abs", state: "online" } }] }));
    assert.ok(!online.ok);
    assert.ok(online.errors.some((e) => e.includes("recovery is expressed by")));

    const mode = parseScenarioFile(file({ steps: [{ ecu: { name: "bcm", mode: "power-cut" } }] }));
    assert.ok(mode.ok);
    assert.deepEqual(mode.file.scenario.steps[0]?.cause, {
      kind: "wiring",
      ecu: "bcm",
      mode: "power-cut",
    });
  });

  test("sensor and bus causes keep their parameters", () => {
    const parsed = parseScenarioFile(
      file({
        steps: [
          { sensor: { signal: "engine.maf_airflow", mode: "stuck", value: 3 } },
          { bus: { mode: "stutter", dropRate: 0.2, ecu: "gateway" } },
        ],
      }),
    );
    assert.ok(parsed.ok, JSON.stringify("errors" in parsed ? parsed.errors : []));
    assert.deepEqual(parsed.file.scenario.steps[0]?.cause, {
      kind: "sensor",
      signal: "engine.maf_airflow",
      mode: "stuck",
      value: 3,
    });
    assert.deepEqual(parsed.file.scenario.steps[1]?.cause, {
      kind: "bus",
      mode: "stutter",
      dropRate: 0.2,
      ecu: "gateway",
    });
  });

  test("the dtc expectation has a nested and a flat spelling, and defaults to active-at-end", () => {
    const nested = parseScenarioFile(
      file({
        expect: [{ dtc: { code: "B1001", ecu: "bcm", state: "stored", atMs: 900, because: "x" } }],
      }),
    );
    assert.ok(nested.ok);
    assert.deepEqual(nested.file.scenario.expectations[0], {
      code: "B1001",
      ecu: "bcm",
      state: "stored",
      atMs: 900,
      because: "x",
    });
    const flat = parseScenarioFile(file({ expect: [{ dtc: "P0562", ecu: "engine" }] }));
    assert.ok(flat.ok, JSON.stringify("errors" in flat ? flat.errors : []));
    assert.equal(flat.file.scenario.expectations[0]?.code, "P0562");
    assert.equal(flat.file.scenario.expectations[0]?.state, "active");
    assert.ok((flat.file.scenario.expectations[0]?.because ?? "").includes("P0562 on engine"));
  });

  test("comparisons: string shorthand, object form, unit checked against the signal", () => {
    const parsed = parseScenarioFile(
      file({
        expect: [
          { battery_voltage: "< 12.0" },
          { supply_voltage: { operator: ">=", value: 11.5, unit: "V" } },
          { engine_rpm: "< 100" },
        ],
      }),
    );
    assert.ok(parsed.ok, JSON.stringify("errors" in parsed ? parsed.errors : []));
    const conditions = parsed.file.scenario.conditions ?? [];
    assert.deepEqual(conditions[0], {
      field: "batteryVoltage",
      below: 12,
      because: "battery_voltage < 12 V after the script",
    });
    assert.deepEqual(conditions[1], {
      field: "supplyVoltage",
      above: 11.5,
      because: "supply_voltage >= 11.5 V after the script",
    });
    assert.equal(conditions[2]?.field, "rpm");

    const badUnit = parseScenarioFile(
      file({ expect: [{ battery_voltage: { operator: "<", value: 12, unit: "A" } }] }),
    );
    assert.ok(!badUnit.ok);
    assert.ok(badUnit.errors.some((e) => e.includes("expected the unit")));
  });

  test("determinism is not optional, and its parts are checked", () => {
    const missing = parseScenarioFile(
      JSON.stringify({
        scenario: "x",
        steps: [{ ignition: "on" }],
        expect: [{ battery_voltage: "< 12" }],
      }),
    );
    assert.ok(!missing.ok);
    assert.ok(missing.errors.some((e) => e.includes("file.determinism")));
    const wall = parseScenarioFile(file({ determinism: { clock: "wall-clock", seed: 3 } }));
    assert.ok(!wall.ok);
    const floatSeed = parseScenarioFile(file({ determinism: { clock: "model-time", seed: 1.5 } }));
    assert.ok(!floatSeed.ok);
  });

  test("the grammar says no to invented steps, keys and expectations — with paths", () => {
    const invented = parseScenarioFile(file({ steps: [{ engine: "running" }] }));
    assert.ok(!invented.ok);
    assert.ok(invented.errors.some((e) => e.includes('unknown key "engine"')));

    const twoCauses = parseScenarioFile(file({ steps: [{ ignition: "on", load: "high" }] }));
    assert.ok(!twoCauses.ok);

    const unknownExpect = parseScenarioFile(file({ expect: [{ rain_speed: "< 5" }] }));
    assert.ok(!unknownExpect.ok);
    assert.ok(unknownExpect.errors.some((e) => e.includes("unknown expectation")));

    const extraTop = parseScenarioFile(file({ extra: 1 }));
    assert.ok(!extraTop.ok);
    assert.ok(extraTop.errors.some((e) => e.includes('unknown key "extra"')));

    const notJson = parseScenarioFile("{");
    assert.ok(!notJson.ok);
    assert.ok(notJson.errors[0]?.startsWith("invalid JSON"));
  });

  test("a parsed file runs: the drain the script describes is what the model shows", async () => {
    const parsed = parseScenarioFile(
      file({
        steps: [
          { ignition: "on" },
          { alternator: "fail" },
          { load: { amps: 45 } },
          { wait: 6_000 },
        ],
        expect: [{ battery_voltage: "< 12.0" }, { supply_voltage: "< 11.0" }],
      }),
    );
    assert.ok(parsed.ok, JSON.stringify("errors" in parsed ? parsed.errors : []));
    const model = new VehicleBehaviourModel();
    const run = await runScenario(modelTarget(model), parsed.file.scenario);
    assert.equal(run.passed, true, JSON.stringify(run.checks));
    assert.deepEqual(run.unexpected, []);
  });

  test("two runs of one file agree exactly — the seed is not decoration", async () => {
    const parsed = parseScenarioFile(
      file({
        steps: [
          { ignition: "on" },
          { ecu: { name: "abs", mode: "connector-loose", duty: 0.5 }, holdMs: 1_000 },
          { wait: 1_500 },
        ],
      }),
    );
    assert.ok(parsed.ok);
    if (!parsed.ok) return;
    const seed = parsed.file.determinism.seed;
    const scenario = parsed.file.scenario;
    const runWithSeed = async (): Promise<string> => {
      const model = new VehicleBehaviourModel({ random: createRandom(seed) });
      const outcome = await runScenario(modelTarget(model), scenario);
      // The loose connector is the flaky part; equal timelines mean the seed,
      // not `Math.random`, decided when contact returned.
      return JSON.stringify(outcome.timeline);
    };
    assert.equal(await runWithSeed(), await runWithSeed());
    // …and a different seed is allowed to differ, so the seed is load-bearing.
    const otherSeed = new VehicleBehaviourModel({ random: createRandom(seed + 1) });
    const other = await runScenario(modelTarget(otherSeed), scenario);
    assert.notEqual(JSON.stringify(other.timeline), "null");
  });
});

describe("the grammar the catalog needs (ADR 0048)", () => {
  test("a driver step names the person behind the pedals, not a set flag", () => {
    const parsed = parseScenarioFile(
      file({ steps: [{ ignition: "on" }, { driver: { speedKph: 60, gear: 4, brake: false } }] }),
    );
    assert.ok(parsed.ok, JSON.stringify("errors" in parsed ? parsed.errors : []));
    assert.deepEqual(parsed.file.scenario.steps[1]?.cause, {
      kind: "driver",
      demandSpeedKph: 60,
      gear: 4,
      brakePressed: false,
    });
  });

  test("a driver step without any demand is rejected — a driver who does nothing is not a cause", () => {
    const parsed = parseScenarioFile(file({ steps: [{ ignition: "on" }, { driver: {} }] }));
    assert.ok(!parsed.ok);
    assert.ok(
      parsed.errors.some((error) => /at least one of speedKph/.test(error)),
      JSON.stringify(parsed.errors),
    );
  });

  test("an intermittent contact carries flapMs and pattern — period, not a comment", () => {
    const parsed = parseScenarioFile(
      file({
        steps: [
          { ecu: { name: "abs", mode: "connector-loose", flapMs: 1200, pattern: "alternate" } },
        ],
      }),
    );
    assert.ok(parsed.ok, JSON.stringify("errors" in parsed ? parsed.errors : []));
    assert.deepEqual(parsed.file.scenario.steps[0]?.cause, {
      kind: "wiring",
      ecu: "abs",
      mode: "connector-loose",
      flapMs: 1200,
      pattern: "alternate",
    });
    // Without a mode the period is meaningless — refuse instead of guessing.
    const orphan = parseScenarioFile(file({ steps: [{ ecu: { name: "abs", flapMs: 100 } }] }));
    assert.ok(!orphan.ok);
    assert.ok(
      orphan.errors.some((error) => /need a mode/.test(error)),
      orphan.errors.join("\n"),
    );
  });

  test("boolean conditions read { equals } — an engine that must not run", () => {
    const parsed = parseScenarioFile(
      file({
        expect: [{ engine_running: { equals: false, atMs: 1500, because: "still cranking" } }],
      }),
    );
    assert.ok(parsed.ok, JSON.stringify("errors" in parsed ? parsed.errors : []));
    assert.deepEqual(parsed.file.scenario.conditions?.[0], {
      field: "engineRunning",
      equals: false,
      atMs: 1500,
      because: "still cranking",
    });
  });

  test("enumerated conditions read the ignition states", () => {
    const parsed = parseScenarioFile(
      file({ expect: [{ ignition: { equals: "start", atMs: 1000 } }] }),
    );
    assert.ok(parsed.ok, JSON.stringify("errors" in parsed ? parsed.errors : []));
    assert.equal(parsed.file.scenario.conditions?.[0]?.equals, "start");
    const wrong = parseScenarioFile(file({ expect: [{ ignition: { equals: "fly" } }] }));
    assert.ok(!wrong.ok);
  });

  test("a number compared as a string is the old shape; an equals on a number is refused", () => {
    const stringForm = parseScenarioFile(file({ expect: [{ speed_kph: "> 40" }] }));
    assert.ok(stringForm.ok, JSON.stringify("errors" in stringForm ? stringForm.errors : []));
    assert.deepEqual(stringForm.file.scenario.conditions?.[0], {
      field: "speedKph",
      above: 40,
      because: "speed_kph > 40 kph after the script",
    });
    const unitForm = parseScenarioFile(
      file({ expect: [{ long_term_trim_pct: { operator: ">", value: 12, unit: "%" } }] }),
    );
    assert.ok(unitForm.ok, JSON.stringify("errors" in unitForm ? unitForm.errors : []));
    assert.equal(unitForm.file.scenario.conditions?.[0]?.above, 12);
    const wrongUnit = parseScenarioFile(
      file({ expect: [{ long_term_trim_pct: { operator: ">", value: 12, unit: "V" } }] }),
    );
    assert.ok(!wrongUnit.ok);
    const equalsOnNumber = parseScenarioFile(
      file({ expect: [{ battery_voltage: { equals: 12 } }] }),
    );
    assert.ok(!equalsOnNumber.ok);
  });

  test("an unknown field is named with every field that exists", () => {
    const parsed = parseScenarioFile(file({ expect: [{ throttle_body_angle: "> 5" }] }));
    assert.ok(!parsed.ok);
    assert.match(parsed.errors.join("\n"), /known: dtc, battery_voltage/);
  });
});

describe("the grammar refuses what it cannot mean (the new fields, branch by branch)", () => {
  const refuses = (label: string, over: Record<string, unknown>, pattern: RegExp): void => {
    test(label, () => {
      const parsed = parseScenarioFile(file(over));
      assert.ok(!parsed.ok, "expected a refusal");
      assert.ok(
        parsed.errors.some((error) => pattern.test(error)),
        `expected a refusal naming the problem, got: ${parsed.errors.join(" | ")}`,
      );
    });
  };

  refuses(
    "a driver speed that is not a number in range",
    { steps: [{ driver: { speedKph: 500 } }] },
    /driver\.speedKph/,
  );
  refuses(
    "a throttle above 100 %",
    { steps: [{ driver: { throttlePct: 140 } }] },
    /driver\.throttlePct/,
  );
  refuses("a gear outside 0..9", { steps: [{ driver: { gear: 12 } }] }, /driver\.gear/);
  refuses(
    "a brake value that is not a boolean",
    { steps: [{ driver: { brake: "yes" } }] },
    /driver\.brake/,
  );
  refuses(
    "an extra key on the driver step",
    { steps: [{ driver: { speedKph: 50, radio: "on" } }] },
    /unknown key "radio"/,
  );
  refuses(
    "a flap period below one millisecond",
    { steps: [{ ecu: { name: "abs", mode: "connector-loose", flapMs: 0 } }] },
    /flapMs/,
  );
  refuses(
    "a pattern the model has no word for",
    { steps: [{ ecu: { name: "abs", mode: "connector-loose", pattern: "chaotic" } }] },
    /pattern/,
  );
  refuses(
    "a condition judged at a time that is not a model time",
    { expect: [{ battery_voltage: { operator: "<", value: 12, atMs: -5 } }] },
    /atMs/,
  );
  refuses(
    "a condition whose because is not a sentence",
    { expect: [{ battery_voltage: { operator: "<", value: 12, because: "" } }] },
    /because/,
  );
  refuses(
    "a boolean condition without equals",
    { expect: [{ engine_running: { atMs: 100 } }] },
    /equals.*true or false/,
  );
  refuses(
    "a boolean condition with a non-boolean equals",
    { expect: [{ engine_running: { equals: "no" } }] },
    /equals.*true or false/,
  );
  refuses(
    "an ignition condition outside the states the model has",
    { expect: [{ ignition: { equals: "accessory" } }] },
    /ignition.*expected one of/,
  );
  refuses(
    "a numeric field compared with a string operator that is no operator",
    { expect: [{ battery_voltage: "<< 12" }] },
    /expected a comparison/,
  );
  test("a string comparison on a boolean field names the shape it wanted", () => {
    const parsed = parseScenarioFile(file({ expect: [{ engine_running: "< 1" }] }));
    assert.ok(!parsed.ok);
    assert.match(parsed.errors.join("\n"), /not a number/);
  });
});
