/**
 * Workbench front end (AGENTS 16).
 *
 * Vanilla ESM, no framework, no build step. This file coordinates workbench panels,
 * manages shared state and handles the live SSE event stream.
 */

import { loadAdapters, mountAdaptersPanel } from "/adapters.js";
import { renderAnalysis } from "/analysis.js";
import * as api from "/api.js";
import { mountChaosPanel } from "/chaos.js";
import { mountCodingAdaptationPanel, renderCodingEcuOptions } from "/coding-adaptation.js";
import { child, el, kv, messageOf, must, row } from "/dom.js";
import { mountDtcPanel, renderDtcs } from "/dtc.js";
import { GraphBoard } from "/graphs.js";
import { mountGuidedDiagnosisPanel } from "/guided-diagnosis.js";
import { mountScenarioPanel, refreshScenarioCatalog } from "/scenario.js";
import { mountSignalAnalysisPanel, renderAnalysisSignalOptions } from "/signal-analysis.js";
import { renderVehicleResolution } from "/vehicle.js";

/** @typedef {import("../src/views.js").AppState} AppState */
/** @typedef {import("../src/views.js").EcuView} EcuView */
/** @typedef {import("../src/views.js").SampleView} SampleView */
/** @typedef {import("../src/views.js").SignalStatisticsView} SignalStatisticsView */
/** @typedef {import("../src/views.js").TraceView} TraceView */

/**
 * Workbench client state.
 */
const state = {
  connected: false,
  live: false,
  /** @type {SampleView[]} */
  samples: [],
  /** @type {TraceView[]} */
  trace: [],
  /** @type {Set<string>} */
  selectedSignals: new Set(),
  /** @type {AppState["actions"]} */
  actions: [],
  /** @type {EcuView[] | undefined} */
  ecusCache: undefined,
};

/** Shared chart state. */
const board = new GraphBoard();

/**
 * Report a failure on the page.
 *
 * @param {unknown} error
 */
function logError(error) {
  console.error(error);
  const line = must("#vehicle-line");
  line.textContent = `Fehler: ${messageOf(error)}`;
  line.classList.add("out-of-range");
}

/* ------------------------------------------------------------------ tabs */

for (const rawTab of document.querySelectorAll(".tab")) {
  const tab = /** @type {HTMLElement} */ (rawTab);
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((other) => {
      other.classList.toggle("active", other === tab);
    });
    const view = tab.dataset.view;
    document.querySelectorAll(".view").forEach((section) => {
      section.classList.toggle("active", section.id === `view-${view}`);
    });
    if (view === "graphs") {
      board.refresh();
      void loadHistory();
    }
    if (view === "scenarios") void refreshScenarioCatalog();
  });
}

/** Load recorded history into the graph board. */
async function loadHistory() {
  try {
    board.setHistory(await api.fetchHistory());
  } catch (error) {
    if (!/500|not started/.test(messageOf(error))) console.warn("history not available", error);
  }
}

/* ----------------------------------------------------------------- state */

/**
 * Connection, adapter, session and vehicle header.
 *
 * @param {AppState} data
 */
function renderConnection(data) {
  const connection = must("#conn-state");
  connection.textContent = data.connected ? (data.live ? "live" : "verbunden") : "offline";
  connection.className = `pill ${data.connected ? (data.live ? "pill-live" : "pill-online") : "pill-offline"}`;
  const vehicleLine = must("#vehicle-line");
  vehicleLine.classList.remove("out-of-range");
  vehicleLine.textContent = data.connected
    ? `${data.vehicle} · ${data.vin ?? "VIN unbekannt"}`
    : "kein Fahrzeug verbunden";

  kv("#adapter-info", [
    ["Adapter", `${data.adapter.name} (${data.adapter.id})`],
    ["Typ", data.adapter.kind],
    ["Kanäle", data.adapter.channels.join(", ") || "—"],
    ["Transport", `${data.transport.kind} · ${data.transport.channel} · MTU ${data.transport.mtu}`],
  ]);
  kv("#vehicle-info", [
    ["Fahrzeug", data.vehicle],
    ["VIN", data.vin],
    [
      "Laufleistung",
      data.mileageKm != null ? `${data.mileageKm.toLocaleString("de-DE")} km` : null,
    ],
  ]);
  kv("#session-info", [
    ["Session", data.sessionId],
    [
      "Transport",
      data.mode === "simulator" ? "Simulator" : data.mode === "replay" ? "Replay" : "Hardware",
    ],
    [
      "Adapter-Auswahl",
      `${data.adapterSelection.id}${data.adapterSelection.config.device ? ` · ${data.adapterSelection.config.device}` : ""}`,
    ],
    ["ECUs", data.ecus.length],
    ["DTCs", data.dtcs.length],
    ["Messwerte", data.samples.length],
  ]);

  const btnLiveStart = /** @type {HTMLButtonElement} */ (must("#btn-live-start"));
  const btnLiveStop = /** @type {HTMLButtonElement} */ (must("#btn-live-stop"));
  btnLiveStart.disabled = !data.connected || data.live;
  btnLiveStop.disabled = !data.live;
  must("#live-state").textContent = data.live ? "läuft" : "gestoppt";
}

/** @param {readonly EcuView[]} ecus */
function renderEcus(ecus) {
  state.ecusCache = [...ecus];
  renderCodingEcuOptions(ecus);
  const body = must("#ecu-rows");
  body.replaceChildren();
  for (const ecu of ecus) {
    const identification = ecu.identification
      .map((entry) => `${entry.label}: ${entry.value}`)
      .join(" · ");
    body.append(
      row(
        [
          `${ecu.name}`,
          `${ecu.txId} → ${ecu.rxId}${ecu.extended ? " (29-bit)" : ""}`,
          ecu.reachable ? "ja" : "nein",
          `0x${ecu.sessionType.toString(16)}`,
          `${ecu.p2Ms} ms`,
          ecu.services.join(" "),
          identification || ecu.lastError || "—",
        ],
        [1, 3, 4, 5],
      ),
    );
  }
}

/** @param {readonly AppState["signals"][number][]} signals */
function renderSignals(signals) {
  renderAnalysisSignalOptions(signals.map((s) => s.id));
  const picker = must("#signal-picker");
  picker.replaceChildren();
  for (const signal of signals) {
    const id = `sig-${signal.id}`;
    const checkbox = /** @type {HTMLInputElement} */ (
      el("input", {
        type: "checkbox",
        id,
        checked: signal.critical ? "checked" : "",
      })
    );
    if (signal.critical) state.selectedSignals.add(signal.id);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) state.selectedSignals.add(signal.id);
      else state.selectedSignals.delete(signal.id);
    });
    picker.append(
      el("label", { for: id }, [
        checkbox,
        `${signal.name}${signal.unit ? ` [${signal.unit}]` : ""}`,
      ]),
    );
  }
  board.setSignals([...signals]);
}

/** @param {readonly SampleView[]} samples */
function renderLiveCards(samples) {
  const host = must("#live-cards");
  /** @type {Map<string, SampleView>} */
  const bySignal = new Map();
  for (const sample of samples) bySignal.set(sample.signal, sample);
  /** @type {Map<string | undefined, HTMLElement>} */
  const existing = new Map();
  for (const card of host.children) {
    const node = /** @type {HTMLElement} */ (card);
    existing.set(node.dataset.signal, node);
  }
  for (const [signal, sample] of bySignal) {
    let card = existing.get(signal);
    if (!card) {
      card = el("div", { class: "card" });
      card.dataset.signal = signal;
      card.append(
        el("h3", { text: sample.name }),
        el("div", { class: "live-value" }),
        el("span", { class: "live-unit" }),
        el("div", { class: "live-raw" }),
      );
      host.append(card);
    }
    const value = child(card, ".live-value");
    value.textContent = sample.value;
    value.className = `live-value${sample.outOfRange ? " out-of-range" : ""}`;
    child(card, ".live-unit").textContent = sample.unit ?? "";
    child(card, ".live-raw").textContent = `raw: ${sample.rawHex} · t=${sample.t} ms`;
  }
}

/**
 * @param {readonly SignalStatisticsView[]} statistics
 * @param {readonly AppState["anomalies"][number][]} anomalies
 */
function renderStatistics(statistics, anomalies) {
  const body = must("#stat-rows");
  body.replaceChildren();
  for (const stat of statistics) {
    body.append(
      row([
        stat.name,
        stat.samples,
        stat.min,
        stat.max,
        stat.average,
        stat.delta,
        stat.unit ?? "—",
        stat.outOfRangeCount,
      ]),
    );
  }
  const list = must("#anomaly-list");
  list.replaceChildren();
  if (anomalies.length === 0)
    list.append(el("li", { class: "muted", text: "keine Anomalien im aufgezeichneten Fenster" }));
  for (const anomaly of anomalies)
    list.append(el("li", { text: `${anomaly.signal}: ${anomaly.reason}` }));
}

/** @param {TraceView} entry */
function appendTrace(entry) {
  state.trace.push(entry);
  if (state.trace.length > 300) state.trace.shift();
  const body = must("#trace-rows");
  const tr = row(
    [entry.t, entry.timestamp, entry.canId, entry.direction, entry.dlc, entry.data, entry.channel],
    [2, 5],
  );
  tr.children[3]?.classList.add(`dir-${entry.direction}`);
  body.prepend(tr);
  while (body.children.length > 300) body.lastElementChild?.remove();
}

/** @param {readonly AppState["actions"][number][]} actions */
function renderActions(actions) {
  const body = must("#log-rows");
  body.replaceChildren();
  for (const action of actions) {
    body.append(
      row([action.timestamp, action.kind, action.ecuId, action.description, action.result]),
    );
  }
}

/** @param {AppState} data */
function applyState(data) {
  state.connected = data.connected;
  state.live = data.live;
  renderConnection(data);
  if (data.vehicleResolution) renderVehicleResolution(data.vehicleResolution);
  renderEcus(data.ecus);
  renderDtcs(data.dtcs, data.unreadEcus);
  renderStatistics(data.statistics, data.anomalies);
  renderActions(data.actions);
  if (data.signals.length > 0 && must("#signal-picker").children.length === 0)
    renderSignals(data.signals);
  must("#trace-rows").replaceChildren();
  state.trace = [];
  for (const entry of data.trace) appendTrace(entry);
}

/* ---------------------------------------------------------------- actions */

const btnStart = must("#btn-start");
btnStart.addEventListener("click", async () => {
  try {
    const data = await api.startSession();
    applyState(data);
    state.ecusCache = data.ecus;
    await loadHistory();
  } catch (error) {
    logError(error);
  }
});

async function resolve() {
  try {
    const { resolution } = await api.resolveVehicle();
    renderVehicleResolution(resolution);
  } catch (error) {
    logError(error);
  }
}
must("#btn-resolve").addEventListener("click", () => {
  void resolve();
});

must("#btn-identify").addEventListener("click", async () => {
  try {
    const { ecus } = await api.identify();
    state.ecusCache = ecus;
    renderEcus(ecus);
    await resolve();
  } catch (error) {
    logError(error);
  }
});

async function scan() {
  try {
    const { dtcs, unread } = await api.scanDtcs();
    renderDtcs(dtcs, unread);
  } catch (error) {
    logError(error);
  }
}
must("#btn-scan").addEventListener("click", () => {
  void scan();
});
must("#btn-scan-2").addEventListener("click", () => {
  void scan();
});

must("#btn-live-start").addEventListener("click", async () => {
  const signalIds = Array.from(state.selectedSignals);
  try {
    await api.startLive({ signalIds });
    applyState(await api.fetchState());
  } catch (error) {
    logError(error);
  }
});

must("#btn-live-stop").addEventListener("click", async () => {
  try {
    const { live } = await api.stopLive();
    state.live = live;
    must("#live-state").textContent = "gestoppt";
  } catch (error) {
    logError(error);
  }
});

must("#btn-marker").addEventListener("click", async () => {
  const label = window.prompt("Marker-Label", "Lastwechsel");
  if (!label) return;
  try {
    await api.addMarker({ label });
  } catch (error) {
    logError(error);
  }
});

must("#btn-analyze").addEventListener("click", async () => {
  try {
    renderAnalysis(await api.analyze());
  } catch (error) {
    logError(error);
  }
});

/* ------------------------------------------------------------------- SSE */

/**
 * Payload of a named SSE event.
 *
 * @param {Event} event
 * @returns {unknown}
 */
const payloadOf = (event) => JSON.parse(String(/** @type {MessageEvent} */ (event).data));

function connectStream() {
  const source = new EventSource("/api/stream");
  source.addEventListener("state", (event) =>
    applyState(/** @type {AppState} */ (payloadOf(event))),
  );
  source.addEventListener("sample", (event) => {
    const sample = /** @type {SampleView} */ (payloadOf(event));
    state.samples.push(sample);
    if (state.samples.length > 4000) state.samples = state.samples.slice(-4000);
    renderLiveCards([sample]);
    board.pushSample(sample);
  });
  source.addEventListener("trace", (event) =>
    appendTrace(/** @type {TraceView} */ (payloadOf(event))),
  );
  source.addEventListener("marker", (event) =>
    board.addMarker(/** @type {import("/lib/index.js").Marker} */ (payloadOf(event))),
  );
  source.addEventListener("markers", (event) =>
    board.setMarkers(/** @type {import("/lib/index.js").Marker[]} */ (payloadOf(event))),
  );
  source.addEventListener("dtc", async () => {
    try {
      const data = await api.fetchState();
      renderDtcs(data.dtcs, data.unreadEcus);
    } catch (error) {
      logError(error);
    }
  });
  source.addEventListener("ecu", (event) => {
    const ecu = /** @type {EcuView} */ (payloadOf(event));
    const ecus = state.ecusCache ?? [];
    const index = ecus.findIndex((candidate) => candidate.rxId === ecu.rxId);
    if (index >= 0) ecus[index] = ecu;
    else ecus.push(ecu);
    state.ecusCache = ecus;
    renderEcus(ecus);
  });
  source.addEventListener("analysis", (event) =>
    renderAnalysis(/** @type {import("../src/views.js").AnalysisView} */ (payloadOf(event))),
  );
  source.addEventListener("vehicle", (event) =>
    renderVehicleResolution(
      /** @type {import("../src/views.js").VehicleResolutionView} */ (payloadOf(event)),
    ),
  );
  source.addEventListener("error", (event) => {
    const data = /** @type {MessageEvent} */ (event).data;
    if (data) logError(new Error(JSON.parse(data).message ?? "SSE Fehler"));
  });
  return source;
}

/* ----------------------------------------------------------- initialization */

mountDtcPanel(logError, scan);
mountChaosPanel(logError);
mountGuidedDiagnosisPanel(logError);
mountCodingAdaptationPanel(logError);
mountSignalAnalysisPanel(logError);
mountAdaptersPanel(logError, applyState);
mountScenarioPanel();
connectStream();
void loadAdapters(logError);
