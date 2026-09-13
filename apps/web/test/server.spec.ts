import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@vdp/shared";
import { test } from "vitest";
import { waitFor } from "../../../tests/helpers/wait.js";
import { WebServer } from "../src/server.js";
import type { VehicleResolutionView } from "../src/vehicle-view.js";

const logger = createLogger("web", { level: "ERROR" });

/** Start a server on an ephemeral port and give back helpers plus a teardown. */
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
): Promise<{ status: number; body: unknown; type: string }> {
  const response = await fetch(`${base}${path}`, init);
  const type = response.headers.get("content-type") ?? "";
  return {
    status: response.status,
    body: type.includes("json") ? await response.json() : await response.text(),
    type,
  };
}

/** Wait until the recording holds at least `count` samples of `signal`. */
async function waitForSamples(base: string, count = 1, signal = "engine.rpm"): Promise<void> {
  await waitFor(
    async () =>
      ((await json(base, "/api/history")).body as { samples: Array<{ signal: string }> }).samples,
    (samples) => samples.filter((sample) => sample.signal === signal).length >= count,
  );
}

test("the index page and every front end asset are served", async () => {
  await withServer(async (base) => {
    for (const path of ["/", "/app.js", "/styles.css", "/chart.js", "/graphs.js", "/vehicle.js"]) {
      const response = await fetch(`${base}${path}`);
      assert.equal(response.status, 200, `${path} should be served`);
      assert.ok((await response.text()).length > 100, `${path} looks empty`);
    }
    const index = await (await fetch(`${base}/`)).text();
    assert.match(index, /yes-you-CAN/);
    assert.match(index, /Roh-Trace/, "the raw trace view must exist (AGENTS 18)");
  });
});

test("path traversal outside the public directory is refused", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/../../package.json`, { redirect: "manual" });
    assert.ok(response.status === 403 || response.status === 404, `got ${response.status}`);
    const body = await response.text();
    assert.ok(!body.includes('"workspaces"'), "repository files must not leak");
  });
});

test("unknown API routes answer 404 with an error body", async () => {
  await withServer(async (base) => {
    const result = await json(base, "/api/does-not-exist");
    assert.equal(result.status, 404);
    assert.match(String((result.body as { error: string }).error), /no route/);
  });
});

test("start connects to the simulated vehicle and discovers ECUs", async () => {
  await withServer(async (base, server) => {
    const started = await json(base, "/api/start", { method: "POST" });
    assert.equal(started.status, 200);
    const state = started.body as { connected: boolean; ecus: unknown[]; vin?: string };
    assert.equal(state.connected, true);
    assert.ok(state.ecus.length >= 2, `expected several ECUs, got ${state.ecus.length}`);
    assert.equal(state.vin, "1HGCM82633A004352");

    const ecus = state.ecus as Array<{
      name: string;
      identification: Array<{ label: string; value: string }>;
    }>;
    const engine = ecus.find((ecu) => ecu.name.includes("Engine"));
    assert.ok(engine, "the engine ECU must be discovered");
    assert.ok(
      engine.identification.some(
        (entry) => entry.label === "VIN" && entry.value === "1HGCM82633A004352",
      ),
    );
    void server;
  });
});

test("the connected vehicle is resolved from what was read (AGENTS 11)", async () => {
  await withServer(async (base) => {
    await json(base, "/api/start", { method: "POST" });
    await json(base, "/api/identify", { method: "POST" });

    const resolved = await json(base, "/api/vehicle/resolve", { method: "POST" });
    assert.equal(resolved.status, 200);
    const view = (resolved.body as { resolution: VehicleResolutionView }).resolution;
    assert.equal(view.unresolved, false);
    assert.equal(view.headline, "Virtual Simulator vehicle (SIM-1) — 100 % belegt");

    const best = view.best;
    assert.ok(best);
    assert.equal(best.scorePercent, 100);
    assert.deepEqual(best.conflicts, []);
    assert.equal(best.placeholder, false, "the simulator package is own data, not a placeholder");
    assert.deepEqual(
      best.engineIds,
      ["sim-petrol"],
      "the engine code read from the ECU narrows it",
    );
    assert.deepEqual(best.gearboxIds, ["sim-automatic"]);
    assert.equal(best.coverageLabel, "3 von 3 Steuergeräten der Definition gefunden");
    assert.equal(view.vinLookup?.manufacturer, "Honda of America Mfg.");

    const kinds = best.evidence.map((item) => item.kind);
    for (const kind of ["vin-wmi", "part-number", "software-version", "ecu-coverage"])
      assert.ok(kinds.includes(kind), `${kind} must be part of the evidence`);
    assert.equal(
      best.evidence.find((item) => item.kind === "part-number")?.label,
      "Teilenummer",
      "criteria reach the operator in German, not as resolver keys",
    );

    // The state carries the last resolution, so a reloaded page shows it again
    // instead of asking the operator to press the button a second time.
    const state = await json(base, "/api/state");
    assert.equal(
      (state.body as { vehicleResolution?: VehicleResolutionView }).vehicleResolution?.headline,
      view.headline,
    );
  });
});

test("resolving a vehicle is a POST-only read", async () => {
  await withServer(async (base) => {
    const get = await json(base, "/api/vehicle/resolve");
    assert.equal(get.status, 405);
    assert.match((get.body as { error: string }).error, /POST only/);
  });
});

test("the DTC scan returns the seeded fault codes with severity", async () => {
  await withServer(async (base) => {
    await json(base, "/api/start", { method: "POST" });
    const scanned = await json(base, "/api/dtc/scan", { method: "POST" });
    assert.equal(scanned.status, 200);
    const dtcs = (scanned.body as { dtcs: Array<{ code: string; severity: string; ecu: string }> })
      .dtcs;
    assert.ok(dtcs.some((dtc) => dtc.code === "P0420"));
    assert.ok(dtcs.some((dtc) => dtc.code === "P0300"));
    assert.ok(dtcs.every((dtc) => dtc.severity.length > 0));
  });
});

test("live data produces decoded samples with statistics", async () => {
  await withServer(async (base) => {
    await json(base, "/api/start", { method: "POST" });
    const started = await json(base, "/api/live/start", {
      method: "POST",
      body: JSON.stringify({ signalIds: ["engine.rpm"] }),
    });
    assert.equal((started.body as { live: boolean }).live, true);
    // Two rounds so min/max/delta statistics are computed over real data.
    await waitForSamples(base, 2);

    const state = (await json(base, "/api/state")).body as {
      live: boolean;
      samples: Array<{ signal: string; name: string; value: string; rawHex: string }>;
      statistics: Array<{ name: string; samples: number }>;
    };
    assert.equal(state.live, true);
    assert.ok(state.samples.length > 0, "live samples must arrive");
    assert.equal(state.samples[0]?.signal, "engine.rpm");
    assert.equal(
      state.samples[0]?.name,
      "Engine speed",
      "the snapshot must carry the definition name, not the id",
    );
    assert.match(
      state.samples[0]?.rawHex ?? "",
      /^[0-9A-F]{2}( [0-9A-F]{2})*$/,
      "raw bytes stay visible (AGENTS 18)",
    );
    assert.ok((state.statistics.find((stat) => stat.name === "Engine speed")?.samples ?? 0) > 0);

    const stopped = await json(base, "/api/live/stop", { method: "POST" });
    assert.equal((stopped.body as { live: boolean }).live, false);
  });
});

test("SSE delivers the current state immediately on connect", async () => {
  await withServer(async (base) => {
    await json(base, "/api/start", { method: "POST" });
    const controller = new AbortController();
    const response = await fetch(`${base}/api/stream`, { signal: controller.signal });
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    const reader = response.body?.getReader();
    assert.ok(reader);
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    assert.match(text, /event: state/);
    assert.match(text, /"connected":true/);
    controller.abort();
    await reader.cancel().catch(() => undefined);
  });
});

test("exports produce CSV, JSON, HTML and a valid PDF", async () => {
  await withServer(async (base) => {
    await json(base, "/api/start", { method: "POST" });
    await json(base, "/api/dtc/scan", { method: "POST" });
    await json(base, "/api/live/start", {
      method: "POST",
      body: JSON.stringify({ signalIds: ["engine.rpm"] }),
    });
    await waitForSamples(base);
    await json(base, "/api/live/stop", { method: "POST" });

    const csv = await (await fetch(`${base}/api/export/measurements.csv`)).text();
    assert.match(csv, /^timestamp,t_ms,signal,value,raw_value,raw_hex,unit,enum_text,out_of_range/);
    assert.ok(csv.split("\n").length > 2, "the recording must contain samples");

    const trace = await (await fetch(`${base}/api/export/trace.csv`)).text();
    assert.match(trace, /^timestamp,t_ms,can_id,direction,dlc,payload,channel,extended,fd/);
    assert.ok(trace.split("\n").length > 2, "the raw trace must contain frames");

    const session = JSON.parse(await (await fetch(`${base}/api/export/session.json`)).text()) as {
      format: string;
      dtcs: unknown[];
    };
    assert.equal(session.format, "vdp.session");
    assert.ok(session.dtcs.length > 0);

    const html = await (await fetch(`${base}/api/export/report.html`)).text();
    assert.match(html, /<!doctype html>/);
    assert.match(html, /DTC summary/);

    const pdfResponse = await fetch(`${base}/api/export/report.pdf`);
    assert.equal(pdfResponse.headers.get("content-type"), "application/pdf");
    const bytes = new Uint8Array(await pdfResponse.arrayBuffer());
    assert.equal(new TextDecoder().decode(bytes.subarray(0, 8)), "%PDF-1.4");
    assert.ok(bytes.length > 2000);
  });
});

test("analysis returns a labelled result from the local provider", async () => {
  await withServer(async (base) => {
    await json(base, "/api/start", { method: "POST" });
    await json(base, "/api/dtc/scan", { method: "POST" });
    const result = await json(base, "/api/analyze", { method: "POST" });
    assert.equal(result.status, 200);
    const analysis = result.body as {
      provider: string;
      source: string;
      findings: unknown[];
      recommendations: string[];
      summary: string;
    };
    assert.equal(analysis.provider, "heuristic");
    assert.equal(analysis.source, "heuristic");
    assert.ok(analysis.findings.length > 0);
    assert.ok(analysis.recommendations.length > 0);
    assert.ok(analysis.summary.length > 0);
  });
});

test("API calls before start fail with a clear message instead of crashing", async () => {
  const server = new WebServer({ port: 0, liveIntervalMs: 60 });
  const { port } = await server.listen();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/export/measurements.csv`);
    assert.equal(response.status, 500);
    const body = (await response.json()) as { error: string };
    assert.match(body.error, /backend not started/);
  } finally {
    await server.close();
  }
  void logger;
});

test("sessions can be saved, listed and downloaded as a package", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vdp-web-sessions-"));
  const server = new WebServer({ port: 0, liveIntervalMs: 60, sessionDir: dir });
  const { port } = await server.listen();
  const base = `http://127.0.0.1:${port}`;
  try {
    await json(base, "/api/start", { method: "POST" });
    await json(base, "/api/dtc/scan", { method: "POST" });
    await json(base, "/api/live/start", {
      method: "POST",
      body: JSON.stringify({ signalIds: ["engine.rpm"] }),
    });
    await waitForSamples(base);
    await json(base, "/api/live/stop", { method: "POST" });

    const saved = await json(base, "/api/session/save", { method: "POST" });
    assert.equal(saved.status, 200);
    const { id, repository } = saved.body as { id: string; repository: boolean };
    assert.equal(
      repository,
      true,
      "persistence must be active when a session directory is configured",
    );
    assert.ok(id.length > 0);

    const listed = await json(base, "/api/sessions");
    const sessions = (listed.body as { sessions: Array<{ id: string; ecus: number }> }).sessions;
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.id, id);
    assert.ok((sessions[0]?.ecus ?? 0) > 0, "the stored session must keep its ECUs");

    const pkg = await fetch(`${base}/api/session/${id}/package`);
    assert.equal(pkg.status, 200);
    assert.equal(pkg.headers.get("content-type"), "application/zip");
    const bytes = new Uint8Array(await pkg.arrayBuffer());
    assert.equal(bytes[0], 0x50, "the package must start with the ZIP local header signature");
    assert.equal(bytes[1], 0x4b);
    assert.ok(bytes.length > 200);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("the graph history carries numeric values and DTC markers (AGENTS 16, 20)", async () => {
  await withServer(async (base) => {
    await json(base, "/api/start", { method: "POST" });
    await json(base, "/api/dtc/scan", { method: "POST" });
    await json(base, "/api/live/start", {
      method: "POST",
      body: JSON.stringify({ signalIds: ["engine.rpm"] }),
    });
    await waitForSamples(base);

    const result = await json(base, "/api/history");
    assert.equal(result.status, 200);
    const history = result.body as {
      startedAt: number;
      live: boolean;
      samples: Array<{
        signal: string;
        numeric: number | null;
        value: string;
        rawValue: number | string | boolean;
        t: number;
      }>;
      markers: Array<{ id: string; t: number; label: string; kind: string; detail?: string }>;
    };
    assert.equal(history.live, true);
    assert.ok(history.samples.length > 0, "the recording must be replayable for the graphs");
    // The front end must never parse a formatted number back (AGENTS 14).
    assert.equal(typeof history.samples[0]?.numeric, "number");
    assert.equal(typeof history.samples[0]?.value, "string");
    assert.ok(history.samples.every((sample) => sample.t >= 0));

    const dtcMarkers = history.markers.filter((marker) => marker.kind === "dtc");
    assert.ok(dtcMarkers.length > 0, "a DTC scan puts the fault codes on the time axis");
    assert.ok(
      dtcMarkers.some((marker) => marker.label === "P0420"),
      "one marker per fault code, not a summary per ECU",
    );
    assert.match(
      dtcMarkers[0]?.detail ?? "",
      /Engine|ABS|Transmission/,
      "the marker names the ECU",
    );
  });
});

test("DTC descriptions come from the definition package, not from invention (AGENTS 13, 24)", async () => {
  await withServer(async (base) => {
    await json(base, "/api/start", { method: "POST" });
    const scanned = await json(base, "/api/dtc/scan", { method: "POST" });
    const dtcs = (
      scanned.body as { dtcs: Array<{ code: string; description?: string; hint?: string }> }
    ).dtcs;
    const catalyst = dtcs.find((dtc) => dtc.code === "P0420");
    assert.ok(catalyst, "the seeded catalyst code must be reported");
    assert.match(catalyst.description ?? "", /Catalyst system efficiency below threshold/);
    assert.ok((catalyst.hint ?? "").length > 20, "a documented code brings a next diagnostic step");

    // Codes that no definition describes are shown as such, never guessed.
    const undescribed = dtcs.find((dtc) => dtc.code === "C1234");
    assert.match(
      undescribed?.description ?? "",
      /Fehlertyp|Brake/,
      "an undocumented code keeps its raw failure type",
    );
  });
});

test("a refused clear is an answer with reasons, not a server error (ADR 0018)", async () => {
  await withServer(async (base) => {
    await json(base, "/api/start", { method: "POST" });
    await json(base, "/api/dtc/scan", { method: "POST" });
    const refused = await json(base, "/api/dtc/clear", {
      method: "POST",
      body: JSON.stringify({
        rxId: "0x7E8",
        confirmed: false,
        vehicleState: { stationary: true, ignitionOn: true, parkingBrake: true },
      }),
      headers: { "content-type": "application/json" },
    });
    assert.equal(refused.status, 200, "the safety rejection is a result, not an HTTP failure");
    const result = (refused.body as { result: { cleared: boolean; reasons?: string[] } }).result;
    assert.equal(result.cleared, false);
    assert.ok(
      (result.reasons ?? []).some((reason) => /confirmation/i.test(reason)),
      "the operator sees which precondition is missing",
    );

    const precheck = await json(base, "/api/dtc/clear/precheck", {
      method: "POST",
      body: JSON.stringify({
        rxId: "0x7E8",
        vehicleState: { stationary: true, ignitionOn: true, parkingBrake: true },
      }),
      headers: { "content-type": "application/json" },
    });
    assert.equal(precheck.status, 200);
    const checks = (precheck.body as { precheck: { ok: boolean; failed: string[] } }).precheck;
    assert.equal(checks.ok, false, "precheck and write evaluate the same chain (AGENTS 26)");
  });
});

test("the tested chart core is served as a module and stays confined to /lib", async () => {
  await withServer(async (base) => {
    for (const path of ["/lib/index.js", "/lib/group.js", "/lib/series.js"]) {
      const response = await fetch(`${base}${path}`);
      assert.equal(response.status, 200, `${path} must be served`);
      assert.match(response.headers.get("content-type") ?? "", /javascript/);
    }

    const traversal = await fetch(`${base}/lib/..%2f..%2fpackage.json`);
    assert.equal(
      traversal.status,
      403,
      "the library directory is confined like the public directory",
    );

    const post = await fetch(`${base}/lib/index.js`, { method: "POST" });
    assert.equal(post.status, 405, "static modules are GET only (ADR 0009)");

    const unknown = await fetch(`${base}/lib/does-not-exist.js`);
    assert.equal(unknown.status, 404);
  });
});

test("without a session directory persistence reports itself as inactive", async () => {
  await withServer(async (base) => {
    await json(base, "/api/start", { method: "POST" });
    const saved = await json(base, "/api/session/save", { method: "POST" });
    assert.equal((saved.body as { repository: boolean }).repository, false);

    const listed = await json(base, "/api/sessions");
    assert.deepEqual((listed.body as { sessions: unknown[] }).sessions, []);

    const pkg = await fetch(`${base}/api/session/whatever/package`);
    assert.equal(pkg.status, 500);
    assert.match(((await pkg.json()) as { error: string }).error, /persistence is not enabled/);
  });
});
