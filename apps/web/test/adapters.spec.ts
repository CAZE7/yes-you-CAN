import assert from "node:assert/strict";
import { createLogger } from "@vdp/shared";
import { VirtualVehicle } from "@vdp/simulators";
import { MemorySessionRepository } from "@vdp/storage";
import { test } from "vitest";
import { createWebAdapterCatalog } from "../src/adapters.js";
import { DemoBackend } from "../src/backend.js";
import { WebServer } from "../src/server.js";

const logger = createLogger("web", { level: "ERROR" });

async function withServer<T>(run: (base: string, server: WebServer) => Promise<T>): Promise<T> {
  const server = new WebServer({ port: 0, liveIntervalMs: 60 });
  const { port } = await server.listen();
  try {
    return await run(`http://127.0.0.1:${port}`, server);
  } finally {
    await server.close();
  }
}

async function json(
  base: string,
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${base}${path}`, init);
  const type = response.headers.get("content-type") ?? "";
  return {
    status: response.status,
    body: type.includes("json") ? await response.json() : await response.text(),
  };
}

/* --------------------------------------------------------------- catalog */

test("the workbench catalog offers simulator, replay and the host adapters", async () => {
  const catalog = createWebAdapterCatalog();
  const ids = catalog.ids();
  for (const id of ["simulator", "replay", "elm327", "slcan", "socketcan"]) {
    assert.ok(ids.includes(id), `missing adapter entry ${id}`);
  }
  const described = await catalog.describeAll();
  assert.equal(described.length, ids.length);
  for (const entry of described) {
    assert.ok(entry.probe.detail.length > 0, `${entry.id} must explain its state`);
  }
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
  const vehicle = new VirtualVehicle({ seed: 7, definitions: undefined });
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
    await waitFor(() => backend.state().statistics.length > 0, 5000);
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

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
