import assert from "node:assert/strict";
import { createLogger } from "@vdp/shared";
import { VirtualVehicle } from "@vdp/simulators";
import { MemorySessionRepository } from "@vdp/storage";
import { test } from "vitest";
import { waitFor } from "../../../tests/helpers/wait.js";
import { json, withServer } from "../../../tests/helpers/workbench.js";
import { createWebAdapterCatalog } from "../src/adapters.js";
import { DemoBackend } from "../src/backend.js";

const logger = createLogger("web", { level: "ERROR" });

/* --------------------------------------------------------------- catalog */

test("the workbench catalog offers simulator, replay and the host adapters", async () => {
  const catalog = createWebAdapterCatalog();
  const ids = catalog.ids();
  for (const id of ["simulator", "simulator-5ecu", "replay", "elm327", "slcan", "socketcan"]) {
    assert.ok(ids.includes(id), `missing adapter entry ${id}`);
  }
  const described = await catalog.describeAll();
  assert.equal(described.length, ids.length);
  for (const entry of described) {
    assert.ok(entry.probe.detail.length > 0, `${entry.id} must explain its state`);
  }
});

test("the high-fidelity 5-ECU vehicle simulator adapter can be selected and connected", async () => {
  const backend = new DemoBackend({
    logger,
    selection: { id: "simulator-5ecu", config: {} },
    discovery: { windowMs: 100, probeDelayMs: 0 },
  });
  try {
    const state = await backend.start();
    assert.equal(state.mode, "simulator");
    assert.equal(state.connected, true);
    assert.equal(state.adapterSelection.id, "simulator-5ecu");
    const ecus = await backend.identify();
    assert.ok(ecus.length >= 1);
  } finally {
    await backend.stop();
  }
});

test("an application-managed bus refuses to be created from the catalog", async () => {
  // The refusal is the whole contract of `managedBy: "application"`: the buses of the
  // simulators and of the replay live and die with the backend that owns their model, so
  // a caller that reaches past the application must not get a second, detached one.
  const catalog = createWebAdapterCatalog();
  for (const id of ["simulator", "simulator-5ecu", "replay"]) {
    const entry = catalog.get(id);
    assert.ok(entry, `${id} is in the catalog`);
    assert.equal(entry.managedBy, "application", `${id} is application-managed`);
    const failure = await entry.create({}, {}).catch((error: unknown) => error);
    assert.ok(failure instanceof Error, `${id} refuses instead of handing out a bus`);
    assert.match(
      (failure as Error).message,
      /created by the application/,
      "the refusal names the way that works",
    );
  }
});

test("the catalog flags decide the sections, not the caller's mood", () => {
  const ids = (options: Parameters<typeof createWebAdapterCatalog>[0]): string[] =>
    createWebAdapterCatalog(options).ids();
  for (const id of ["simulator", "simulator-5ecu"]) {
    assert.ok(ids({}).includes(id), `${id} is in by default`);
    assert.ok(!ids({ simulator: false }).includes(id), `${id} leaves with the simulator flag`);
  }
  assert.ok(ids({}).includes("replay"));
  assert.ok(!ids({ replay: false }).includes("replay"));
  // `--list-adapters` runs on a machine without hardware; the host flag is what makes
  // that list honest instead of a catalogue of devices that are not plugged in.
  assert.deepEqual(ids({ simulator: false, replay: false, host: false }), []);
  const hostOnly = ids({ simulator: false, replay: false });
  assert.ok(hostOnly.length > 0, "the host adapters stay when only they are asked for");
  assert.ok(!hostOnly.includes("simulator"));
});

/* ------------------------------------------------------------------- API */

test("the adapter list reports availability without opening a device", async () => {
  await withServer(async (base, server) => {
    const listed = await json(base, "/api/adapters");
    assert.equal(listed.status, 200);
    const body = listed.body as {
      mode: string;
      selected: { id: string };
      adapters: Array<{
        id: string;
        probe: { available: boolean; detail: string };
        capabilities: { can: boolean };
      }>;
    };
    assert.equal(body.mode, "simulator");
    assert.equal(body.selected.id, "simulator");
    const simulator = body.adapters.find((entry) => entry.id === "simulator");
    assert.equal(simulator?.probe.available, true);
    assert.equal(simulator?.capabilities.can, true);
    // The device is not open yet — listing must never require a connection.
    assert.equal(server.backend.state().connected, false);
  });
});

test("an unknown adapter id is rejected with 400 and a list of valid ids", async () => {
  await withServer(async (base, server) => {
    const result = await json(base, "/api/adapter/select", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "obd-link-9000" }),
    });
    assert.equal(
      result.status,
      400,
      "a configuration mistake is the caller's error, not a server fault",
    );
    assert.match(String((result.body as { error: string }).error), /unknown adapter/);
    assert.equal(
      server.backend.adapterSelection.id,
      "simulator",
      "a rejected selection must not take effect",
    );
  });
});

test("a serial adapter without a device is rejected and leaves the selection untouched", async () => {
  await withServer(async (base, server) => {
    const result = await json(base, "/api/adapter/select", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "slcan" }),
    });
    assert.equal(result.status, 400);
    assert.match(String((result.body as { error: string }).error), /--device/);
    assert.equal(server.backend.adapterSelection.id, "simulator");
  });
});

test("selecting an adapter switches the transport mode and probes it", async () => {
  await withServer(async (base, server) => {
    const result = await json(base, "/api/adapter/select", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "slcan", device: "/dev/does-not-exist", bitrate: "250k" }),
    });
    assert.equal(result.status, 200);
    const body = result.body as {
      adapter: { probe: { available: boolean; hints?: string[] } };
      reconnectRequired: boolean;
    };
    assert.equal(body.reconnectRequired, false);
    assert.equal(body.adapter.probe.available, false);
    assert.ok(
      (body.adapter.probe.hints ?? []).length > 0,
      "a missing device must come with a hint",
    );

    const state = server.backend.state();
    assert.equal(state.mode, "hardware");
    assert.equal(state.adapterSelection.config.device, "/dev/does-not-exist");
    assert.equal(state.connected, false);
  });
});

test("switching the adapter while connected drops the old connection instead of mixing transports", async () => {
  await withServer(async (base, server) => {
    await json(base, "/api/start", { method: "POST" });
    assert.equal(server.backend.state().connected, true);

    const result = await json(base, "/api/adapter/select", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "simulator" }),
    });
    assert.equal((result.body as { reconnectRequired: boolean }).reconnectRequired, true);
    assert.equal(
      server.backend.state().connected,
      false,
      "the engine must not keep talking over the replaced transport",
    );

    const restarted = await json(base, "/api/start", { method: "POST" });
    assert.equal((restarted.body as { connected: boolean }).connected, true);
  });
});

/* ------------------------------------------------------------ transports */

/**
 * The hardware path is verified with an injected bus: the backend then uses the
 * *same* engine code as with a real adapter, so the only difference is who built
 * the bus. This is the strongest hardware check that runs without a car.
 */
test("hardware mode runs the full diagnostic path over an injected bus", async () => {
  const vehicle = new VirtualVehicle({ seed: 7 });
  await vehicle.start();
  const backend = new DemoBackend({
    logger,
    bus: vehicle.testerBus,
    selection: { id: "slcan", config: { device: "/dev/fake", bitrate: "500k" } },
    seedDtcs: false,
  });
  try {
    const state = await backend.start();
    assert.equal(state.mode, "hardware");
    assert.equal(state.connected, true);
    assert.ok(
      state.ecus.length >= 2,
      `expected the virtual ECUs over the injected bus, got ${state.ecus.length}`,
    );
    assert.equal(
      state.vin,
      "1HGCM82633A004352",
      "the VIN is read over the transport, not from a constant",
    );

    vehicle.setDtc("engine", "P0420", 0x2f);
    const dtcs = await backend.scanDtcs();
    assert.ok(
      dtcs.some((dtc) => dtc.code === "P0420"),
      "DTCs are read from the ECU over the injected bus",
    );

    await backend.startLive(undefined);
    await waitFor(() => backend.state().statistics.length > 0, undefined, { timeoutMs: 5000 });
    backend.stopLive();
    assert.ok(
      backend.state().statistics.length > 0,
      "live values must be decoded from the injected transport",
    );
  } finally {
    await backend.stop();
    await vehicle.stop();
  }
});

/**
 * Replay is the feature that makes a recorded problem reproducible (AGENTS 19):
 * a session saved from the simulator is opened again and has to yield the same
 * ECU identification — without any vehicle involved.
 */
test("a saved session can be replayed without a vehicle", async () => {
  const repository = new MemorySessionRepository({ logger });
  const origin = new DemoBackend({ logger, repository, seedDtcs: false });
  let sessionId: string;
  try {
    await origin.start();
    await origin.identify();
    await origin.scanDtcs();
    sessionId = (await origin.saveSession()).id;
    assert.ok(sessionId.length > 0);
  } finally {
    await origin.stop();
  }

  const replay = new DemoBackend({
    logger,
    repository,
    selection: { id: "replay", config: { trace: sessionId } },
    seedDtcs: false,
  });
  try {
    const state = await replay.start();
    assert.equal(state.mode, "replay");
    assert.equal(state.connected, true);
    assert.ok(
      state.ecus.length >= 2,
      `replay must expose the recorded ECUs, got ${state.ecus.length}`,
    );
    assert.equal(state.vin, "1HGCM82633A004352", "the recorded VIN response must be replayed");

    const dtcs = await replay.scanDtcs();
    assert.ok(dtcs.length > 0, "the recorded DTC responses must be replayed as well");
  } finally {
    await replay.stop();
  }
});

test("replay without a recording fails with a clear message", async () => {
  const backend = new DemoBackend({ logger, selection: { id: "replay", config: {} } });
  await assert.rejects(() => backend.start(), /replay needs a recording/);
  // A failed start must not leave a connection behind.
  assert.equal(backend.state().connected, false);
});

test("a start failure leaves the backend stoppable and restartable", async () => {
  const backend = new DemoBackend({
    logger,
    selection: { id: "elm327", config: { device: "/dev/definitely-not-there" } },
  });
  await assert.rejects(() => backend.start(), /cannot open serial device/);
  assert.equal(backend.state().connected, false);
  // Restarting after a failure has to work, otherwise the user is stuck until a
  // process restart.
  await backend.selectAdapter({ id: "simulator", config: {} });
  const state = await backend.start();
  assert.equal(state.connected, true);
  await backend.stop();
});

test("the state reports which transport is selected", async () => {
  const backend = new DemoBackend({ logger, selection: { id: "simulator", config: {} } });
  const state = await backend.start();
  assert.equal(state.mode, "simulator");
  assert.deepEqual(state.adapterSelection, { id: "simulator", config: {} });
  assert.equal(state.adapterProbe?.available, true);
  await backend.stop();
});

/**
 * The scenario engine through the workbench's own backend (AGENTS 32).
 *
 * `DemoBackend` is the layer the HTTP server talks to, so this is where "the workbench can
 * run a scenario" is decided: the catalog has to come from the simulator's data, a run has
 * to reach the vehicle's modules, and a connection without a behaviour model has to say so
 * as an answer instead of an exception.
 */
test("the 5-ECU vehicle serves the scenario catalog and runs one", async () => {
  const backend = new DemoBackend({
    logger,
    selection: { id: "simulator-5ecu", config: {} },
    discovery: { windowMs: 100, probeDelayMs: 0 },
  });
  try {
    await backend.start();
    const catalog = backend.scenarios();
    assert.ok(
      catalog.scenarios.some((entry) => entry.id === "under-voltage-at-start"),
      "the picker lists the catalog it was built from",
    );
    assert.ok(
      catalog.scenarios.every((entry) => entry.expectations.length > 0),
      "every scenario says in the list what it predicts — a row without a claim is a button with no test",
    );
    // The panel is served projected, not raw: the browser module has no test runner, so
    // the labels and the counts are decided here (ADR 0030 §2).
    assert.equal(catalog.options.length, catalog.scenarios.length);
    assert.match(catalog.options[0]?.hint ?? "", /Schritte · ~/);
    assert.match(catalog.note, /^\d+ Szenarien/);

    const unknown = await backend.runScenario("not-a-scenario");
    assert.equal(unknown.ok, false);
    if (!unknown.ok) {
      assert.match(unknown.error, /known: under-voltage-at-start/, "and names what does exist");
    }

    const result = await backend.runScenario("  under-voltage-at-start  ");
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    const run = result.run;
    assert.equal(run.scenarioId, "under-voltage-at-start");
    assert.equal(run.passed, true, `the run disagreed with itself: ${JSON.stringify(run.checks)}`);
    assert.ok(run.checks.length > 0 && run.checks.every((check) => check.passed));
    assert.ok(
      run.memory.some((entry) => entry.ecu === "bcm" && entry.code === "B1001"),
      "the code has to be in the module the panel reads, not only in the run's report",
    );
    assert.equal(
      typeof run.model.supplyVoltage,
      "number",
      "and the physical number the code was latched on comes along",
    );
    const panel = result.panel;
    assert.equal(panel.verdict.tone, "ok", panel.verdict.detail);
    assert.equal(panel.checks.length, run.checks.length);
    assert.ok(
      panel.memory.some((entry) => entry.cells[1] === "B1001" && entry.cells[3] === "bestätigt"),
      "the same code, spelled the way the table shows it: confirmed, not current",
    );
    assert.match(panel.memoryNote, /^1 von \d+ dokumentierten Codes/, "and the denominator");
    assert.ok(
      panel.model.some((entry) => entry.label === "Versorgung" && / V$/.test(entry.value)),
      "a model row carries its unit — that is the mapping the panel must not get wrong",
    );
  } finally {
    await backend.stop();
  }
});

test("a connection without a behaviour model says so, and does not throw", async () => {
  const backend = new DemoBackend({
    logger,
    selection: { id: "simulator", config: {} },
    discovery: { windowMs: 100, probeDelayMs: 0 },
  });
  try {
    await backend.start();
    // The catalog is data the app can always show; the run is what needs the model.
    const catalog = backend.scenarios();
    assert.ok(catalog.scenarios.length > 0);
    assert.equal(
      catalog.note,
      `${catalog.scenarios.length} Szenarien aus dem Katalog des Fahrzeugs — jede Ursache wird gesetzt, bevor eine Erwartung gilt`,
      "the note counts the same list the picker shows — no second number to drift",
    );
    const refused = await backend.runScenario("can-bus-dropouts");
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.match(refused.error, /High-fidelity/);
  } finally {
    await backend.stop();
  }
});
