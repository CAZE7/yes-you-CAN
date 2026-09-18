import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { json, waitForSamples, withServer } from "../../../tests/helpers/workbench.js";
import type { DtcView } from "../src/backend.js";
import { WebServer } from "../src/server.js";
import type { VehicleResolutionView } from "../src/vehicle-view.js";
import type { AnalysisView } from "../src/views.js";

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
    // Typed against the wire contract, not a copy of it (ADR 0030): a response shape
    // restated in a test is a second source that can silently lag the provider type.
    const analysis = result.body as AnalysisView;
    assert.equal(analysis.provider, "heuristic");
    assert.equal(analysis.source, "heuristic");
    assert.ok(analysis.findings.length > 0);
    assert.ok(analysis.recommendations.length > 0);
    assert.ok(analysis.summary.length > 0);

    // The point of ADR 0026 on this path: the analysis knows which car it is
    // answering about, including which definition the session matched.
    assert.match(analysis.summary, /on Virtual Simulator vehicle 2003 \(virtual-vehicle\)/);
    // The confidence moved 0.4 → 0.3 with the evidence path (P0 #39, ADR 0038): the
    // demo session stores C1234 with no documented wording, and a claim without a
    // source now caps what the heuristic may assert — the same ceiling a missing
    // vehicle determination gets. The number is lower because the answer is honest,
    // not because the car changed.
    assert.equal(analysis.confidence, 0.3);
    assert.deepEqual(analysis.warnings, [
      "Heuristic analysis is rule based — it is a hint, not a diagnosis.",
      "3 question(s) stay open in this session: C1234, fault memory, signals.",
      "1 statement(s) in this session are unproven: C1234 — say so in the answer.",
    ]);

    // Versions and citations (P0 #42): the answer says which prompt, which build and
    // which definition produced it, and cites the evidence items it read.
    assert.equal(analysis.provenance?.promptVersion, "2026-09-16.1");
    assert.equal(analysis.provenance?.runtimeVersion, "0.1.0");
    assert.equal(analysis.provenance?.definitionVersion, "simulator@1.0.0");
    assert.ok((analysis.provenance?.evidence.length ?? 0) > 0);
    // ADR 0046: the answer names the recording it read — the session id, not an
    // invention; the test only demands *a* id, the mapping spec pins the source.
    assert.equal(typeof analysis.provenance?.recordingId, "string");
    assert.ok((analysis.provenance?.recordingId ?? "").length > 0);
    const cited = analysis.findings.find((finding) => finding.id === "dtc-P0420")?.basedOn ?? [];
    assert.ok(
      cited.every((id) => analysis.provenance?.evidence.includes(id)),
      `a finding must cite items the answer lists: ${cited.join(", ")}`,
    );
    assert.ok(
      analysis.recommendations.some((entry) => entry.startsWith("next test for P0420:")),
      analysis.recommendations.join(" | "),
      "the documented window of a pattern is what the next test names (roadmap step 16)",
    );

    // And it says which of its sentences the variant documents: a measuring step the
    // package actually defines, plus the label for wording that is only manufacturer-wide.
    const withWindow = analysis.recommendations.filter((entry) =>
      /measure first: .* · \d+(\.\d+)? s$/.test(entry),
    );
    assert.ok(withWindow.length > 0, analysis.recommendations.join(" | "));
    const undocumented = analysis.findings.find((finding) => finding.id === "dtc-U0121");
    assert.match(undocumented?.detail ?? "", /manufacturer-wide wording only/);

    // A VIN never rides along to a provider (AGENTS 27) — this object may be posted
    // to a model gateway by configuration alone.
    assert.ok(!JSON.stringify(analysis).includes("1HGCM82633A004352"));
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
    const dtcs = (scanned.body as { dtcs: DtcView[] }).dtcs;
    const catalyst = dtcs.find((dtc) => dtc.code === "P0420");
    assert.ok(catalyst, "the seeded catalyst code must be reported");
    // The demo resolves the virtual vehicle on connect, so the wording is the one
    // this variant documents — not the manufacturer-wide text (AGENTS 20, 23).
    assert.match(catalyst.description ?? "", /Catalyst efficiency below threshold/);
    assert.ok((catalyst.hint ?? "").length > 20, "a documented code brings a next diagnostic step");
    const knowledge = catalyst.knowledge;
    assert.ok(knowledge, "the resolved variant documents this code");
    assert.equal(knowledge.scope, "vehicle-engine");
    assert.equal(knowledge.variant, true);
    assert.equal(knowledge.scopeLabel, "Varianten-Wissen · Motor");
    assert.equal(knowledge.scopeShort, "Motor");
    assert.equal(knowledge.vehicleId, "virtual-vehicle");
    assert.match(knowledge.conditions ?? "", /closed loop/);
    assert.match(
      knowledge.provenance ?? "",
      /eigene Daten/,
      "the source of the statement is named",
    );
    assert.deepEqual(
      knowledge.patterns.map((pattern) => pattern.id),
      ["catalyst-aged", "exhaust-leak-before-catalyst"],
    );
    const aged = knowledge.patterns[0];
    assert.equal(aged?.likelihoodLabel, "häufig");
    assert.ok(aged?.repair, "repair advice is labelled and travels with its pattern");
    assert.ok(
      aged?.checks.every(
        (check) => check.measurable && check.window.length > 0 && check.name.length > 0,
      ),
      "every seeded check names a signal and a window a tool can evaluate",
    );
    assert.equal(aged?.checks[0]?.judgement, "automatisch prüfbar");

    // Codes that no definition describes are shown as such, never guessed.
    const undescribed = dtcs.find((dtc) => dtc.code === "C1234");
    assert.match(
      undescribed?.description ?? "",
      /Fehlertyp|Brake/,
      "an undocumented code keeps its raw failure type",
    );

    // Variant knowledge without an engine or gearbox axis: the chassis code.
    const wheelSpeed = dtcs.find((dtc) => dtc.code === "C0035");
    assert.equal(wheelSpeed?.knowledge?.variant, true);
    assert.equal(wheelSpeed?.knowledge?.scopeLabel, "Varianten-Wissen · Fahrzeug");
    assert.equal(wheelSpeed?.knowledge?.scopeShort, "Fahrzeug");
    const straightRun = wheelSpeed?.knowledge?.patterns[0];
    assert.equal(straightRun?.likelihoodLabel, "häufig");
    assert.deepEqual(
      straightRun?.checks.map((check) => check.window),
      ["45 … 55 · 5 s messen", "45 … 55 · 5 s messen", "45 … 55 · 5 s messen"],
      "the corner, the opposite corner and the OBD speed are measured over one window",
    );
    assert.ok(straightRun?.checks.every((check) => check.judgement === "automatisch prüfbar"));
    // A watch that has a window but no bound says so instead of showing a range
    // nobody documented (§24).
    const harnessPattern = wheelSpeed?.knowledge?.patterns[1];
    assert.equal(harnessPattern?.checks[0]?.measurable, false);
    assert.equal(harnessPattern?.checks[0]?.judgement, "nur manuell beurteilbar");
    assert.equal(harnessPattern?.checks[0]?.window, "30 s messen");

    // A pattern no signal in this package can decide carries no check at all.
    const milRequest = dtcs.find((dtc) => dtc.code === "P0700");
    assert.equal(milRequest?.knowledge?.scopeLabel, "Varianten-Wissen · Getriebe");
    assert.deepEqual(milRequest?.knowledge?.patterns[2]?.checks, []);
    assert.ok(
      milRequest?.knowledge?.patterns[2]?.repair,
      "the repair advice is the step, because nothing here is measurable",
    );

    // A code the package describes but this variant deliberately does not stays
    // labelled as package-wide wording instead of borrowing the variant's
    // appearance (§24) — a network code means the same for every variant.
    const network = dtcs.find((dtc) => dtc.code === "U0121");
    assert.equal(network?.knowledge?.variant, false);
    assert.equal(network?.knowledge?.scopeLabel, "nur paketweit beschrieben");
    assert.equal(network?.knowledge?.scopeShort, "paketweit");
    assert.ok(
      network?.knowledge?.notes.some((note) =>
        note.includes("no variant-specific knowledge documented"),
      ),
      network?.knowledge?.notes.join(" | "),
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

test("guided diagnosis, coding/adaptation, signal analysis, and chaos endpoints are operational", async () => {
  await withServer(async (base) => {
    await json(base, "/api/start", { method: "POST" });

    // 1. Guided Diagnosis endpoint & step
    const gd = await json(base, "/api/guided-diagnosis");
    assert.equal(gd.status, 200);
    const gdBody = gd.body as { state: { status: string; hypotheses: unknown[] } };
    assert.ok(["in-progress", "resolved", "inconclusive"].includes(gdBody.state.status));

    const gdStep = await json(base, "/api/guided-diagnosis/step", {
      method: "POST",
      body: JSON.stringify({ signalId: "engine.coolant_temperature", value: 92 }),
      headers: { "content-type": "application/json" },
    });
    assert.equal(gdStep.status, 200);
    const gdStepBody = gdStep.body as { state: { stepsCompleted: number } };
    assert.equal(gdStepBody.state.stepsCompleted, 1);

    // 2. Coding precheck and write endpoints
    const codingPrecheck = await json(base, "/api/coding/precheck", {
      method: "POST",
      body: JSON.stringify({
        rxId: "0x7e8",
        did: 0x0100,
        data: "010203",
        vehicleState: { stationary: true, ignitionOn: true },
      }),
      headers: { "content-type": "application/json" },
    });
    assert.equal(codingPrecheck.status, 200);

    const codingWrite = await json(base, "/api/coding/write", {
      method: "POST",
      body: JSON.stringify({
        rxId: "0x7e8",
        did: 0x0100,
        data: "010203",
        confirmed: true,
        vehicleState: {
          stationary: true,
          ignitionOn: true,
          parkingBrake: true,
          batteryVoltage: 12.6,
        },
      }),
      headers: { "content-type": "application/json" },
    });
    assert.equal(codingWrite.status, 200);
    const codingWriteBody = codingWrite.body as { result: { transactionId: string } };
    assert.ok(codingWriteBody.result.transactionId);

    // 3. Adaptation precheck and write endpoints
    const adaptPrecheck = await json(base, "/api/adaptation/precheck", {
      method: "POST",
      body: JSON.stringify({
        rxId: "0x7e8",
        did: 0x0100,
        value: 42,
        vehicleState: { stationary: true, ignitionOn: true },
      }),
      headers: { "content-type": "application/json" },
    });
    assert.equal(adaptPrecheck.status, 200);

    const adaptWrite = await json(base, "/api/adaptation/write", {
      method: "POST",
      body: JSON.stringify({
        rxId: "0x7e8",
        did: 0x0100,
        value: 42,
        confirmed: true,
        vehicleState: {
          stationary: true,
          ignitionOn: true,
          parkingBrake: true,
          batteryVoltage: 12.6,
        },
      }),
      headers: { "content-type": "application/json" },
    });
    assert.equal(adaptWrite.status, 200);
    const adaptWriteBody = adaptWrite.body as { result: { transactionId: string } };
    assert.ok(adaptWriteBody.result.transactionId);

    // 4. Signal analysis endpoint
    const analysis = await json(base, "/api/analysis/signal?signalId=engine.speed");
    assert.equal(analysis.status, 200);
    const analysisBody = analysis.body as { analysis: { signalId: string; anomalies: unknown[] } };
    assert.equal(analysisBody.analysis.signalId, "engine.speed");

    // 5. Chaos injection and status endpoints
    const chaosInject = await json(base, "/api/chaos/inject", {
      method: "POST",
      body: JSON.stringify({ dropBurst: 5 }),
      headers: { "content-type": "application/json" },
    });
    assert.equal(chaosInject.status, 200);
    const chaosStatus = await json(base, "/api/chaos/status");
    assert.equal(chaosStatus.status, 200);
    const chaosReset = await json(base, "/api/chaos/reset", { method: "POST" });
    assert.equal(chaosReset.status, 200);
  });
});

/**
 * The scenario endpoints on the wire (AGENTS 32, 28).
 *
 * Three statuses are the contract, and each is a different kind of answer: 200 with the
 * catalog (data the app always has), 400 when the request says nothing (an empty `id` is
 * the caller's mistake, not the platform's), 409 when the *connection* cannot do it (a
 * simulator without a behaviour model). A run through the selected 5-ECU vehicle answers
 * 200 with the verdicts of the run and the fault memories it left behind.
 */
test("the scenario endpoints answer by what is missing: nothing, an id, or a model", async () => {
  await withServer(async (base) => {
    const list = await json(base, "/api/simulator/scenarios");
    assert.equal(list.status, 200);
    const scenarios = (list.body as { scenarios: { id: string; steps: number }[] }).scenarios;
    assert.ok(scenarios.length >= 4, "the catalog is served as it is");
    assert.ok(scenarios.every((entry) => entry.steps > 0));

    const noId = await json(base, "/api/simulator/scenario", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(noId.status, 400, "an empty request is the caller's error");

    const noModel = await json(base, "/api/simulator/scenario", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "under-voltage-at-start" }),
    });
    assert.equal(noModel.status, 409, "the default simulator has no behaviour model");
    assert.match(String((noModel.body as { error: string }).error), /High-fidelity/);

    const selected = await json(base, "/api/adapter/select", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "simulator-5ecu" }),
    });
    assert.equal(selected.status, 200, JSON.stringify(selected.body));
    // Selecting does not connect — the workbench starts a run explicitly (AGENTS 28), and
    // a scenario needs the vehicle behind that connection, not just the choice of one.
    const started = await json(base, "/api/start", { method: "POST" });
    assert.equal(started.status, 200, JSON.stringify(started.body));

    const run = await json(base, "/api/simulator/scenario", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "under-voltage-at-start" }),
    });
    assert.equal(run.status, 200, JSON.stringify(run.body));
    const view = (run.body as { run: { passed: boolean; checks: unknown[]; memory: unknown[] } })
      .run;
    assert.equal(view.passed, true);
    assert.ok(view.checks.length > 0, "the run reports its verdicts, not only a boolean");
    assert.ok(Array.isArray(view.memory), "and what the modules hold afterwards");

    const unknown = await json(base, "/api/simulator/scenario", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "no-such-scenario" }),
    });
    assert.equal(unknown.status, 409);
    assert.match(String((unknown.body as { error: string }).error), /known: /);
  });
});
