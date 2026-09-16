/**
 * Workbench front end (AGENTS 16).
 *
 * Vanilla ESM, no framework, no build step. This file deliberately contains no
 * CAN or UDS logic: it renders what the backend already decoded and labels raw
 * trace data as raw (AGENTS 5, 34.3, 18).
 */

import * as api from "/api.js";
import { $, button, child, el, input, kv, messageOf, must, row, select } from "/dom.js";
import { GraphBoard } from "/graphs.js";
import { mountScenarioPanel, refreshScenarioCatalog } from "/scenario.js";
import { renderVehicleResolution } from "/vehicle.js";

/** @typedef {import("../src/views.js").AppState} AppState */
/** @typedef {import("../src/views.js").DtcClearPrecheck} DtcClearPrecheck */
/** @typedef {import("../src/views.js").DtcView} DtcView */
/** @typedef {import("../src/views.js").DtcKnowledgeView} DtcKnowledgeView */
/** @typedef {import("../src/views.js").DtcPatternView} DtcPatternView */
/** @typedef {import("../src/views.js").EcuView} EcuView */
/** @typedef {import("../src/views.js").SampleView} SampleView */
/** @typedef {import("../src/views.js").SignalStatisticsView} SignalStatisticsView */
/** @typedef {import("../src/views.js").TraceView} TraceView */
/** @typedef {import("../src/views.js").GuidedDiagnosisView} GuidedDiagnosisView */
/** @typedef {import("../src/views.js").CodingResultView} CodingResultView */
/** @typedef {import("../src/views.js").AdaptationResultView} AdaptationResultView */
/** @typedef {import("../src/views.js").AdvancedSignalAnalysisView} AdvancedSignalAnalysisView */
/** @typedef {import("../src/views.js").ChaosStatusView} ChaosStatusView */

/**
 * The little bit of state the front end keeps on its own.
 *
 * Everything else arrives with `AppState` — this object only holds what the
 * backend does not need to know: the checkbox selection the operator made, the
 * samples of the running session and the confirmed preconditions.
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
  /** @type {DtcView[]} */
  dtcs: [],
  /** @type {DtcClearPrecheck | null} */
  clearPrecheck: null,
  /** @type {EcuView[] | undefined} */
  ecusCache: undefined,
};

/**
 * The graph board owns the shared chart state (window, cursor, selection).
 * It is created once and fed from three sources: the signal list, the recorded
 * history and the live SSE stream (AGENTS 16).
 */
const board = new GraphBoard();

/**
 * Report a failure on the page instead of only in the console (rule 34.25: never
 * swallow an error silently).
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
    document
      .querySelectorAll(".tab")
      .forEach((other) => other.classList.toggle("active", other === tab));
    const view = tab.dataset.view;
    document
      .querySelectorAll(".view")
      .forEach((section) => section.classList.toggle("active", section.id === `view-${view}`));
    // A canvas has no layout size while its tab is hidden, so the charts have to
    // be measured and repainted the moment the tab becomes visible.
    if (view === "graphs") {
      board.refresh();
      loadHistory();
    }
    // The scenario catalog belongs to the *selected adapter*, so it is read when the tab
    // is opened rather than once at boot — a boot-time fetch would freeze the answer of
    // whichever adapter happened to be connected when the page loaded (AGENTS 32).
    if (view === "scenarios") void refreshScenarioCatalog();
  });
}

/** Load the recorded history so the graphs can zoom into the past, not just the live window. */
async function loadHistory() {
  try {
    board.setHistory(await api.fetchHistory());
  } catch (error) {
    // No session yet — the graphs simply stay empty until the first samples arrive.
    if (!/500|not started/.test(messageOf(error))) console.warn("history not available", error);
  }
}

/* ----------------------------------------------------------------- state */

/**
 * Connection, adapter, session and vehicle header of the workbench.
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

  button("#btn-live-start").disabled = !data.connected || data.live;
  button("#btn-live-stop").disabled = !data.live;
  must("#live-state").textContent = data.live ? "läuft" : "gestoppt";
}

/** @param {EcuView[]} ecus */
function renderCodingEcuOptions(ecus) {
  const selectNode = $("#ca-ecu");
  if (!(selectNode instanceof HTMLSelectElement)) return;
  const previous = selectNode.value;
  selectNode.replaceChildren(
    ...ecus.map((ecu) => el("option", { value: ecu.rxId, text: `${ecu.name} (${ecu.rxId})` })),
  );
  if (previous && ecus.some((e) => e.rxId === previous)) selectNode.value = previous;
}

/** @param {EcuView[]} ecus */
function renderEcus(ecus) {
  state.ecusCache = ecus;
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

/** @param {DtcView[]} dtcs */
function renderDtcs(dtcs) {
  const body = must("#dtc-rows");
  body.replaceChildren();
  state.dtcs = dtcs;
  for (const dtc of dtcs) {
    body.append(
      row(
        [
          dtc.isNew ? `${dtc.code} (neu)` : dtc.code,
          dtc.description,
          dtc.ecu,
          dtc.status,
          dtc.severity,
          dtc.confirmed ? "ja" : "nein",
          dtc.pending ? "ja" : "nein",
          dtc.hint ?? "—",
          formatSeen(dtc),
        ],
        [0, 3, 8],
      ),
    );
    const severityCell = body.lastElementChild?.children[4];
    if (severityCell) severityCell.className = `sev-${dtc.severity}`;
    if (dtc.isNew) body.lastElementChild?.classList.add("is-new");

    // A code this variant documents says so in the list already; one that is only
    // described package-wide stays unmarked instead of looking equally specific.
    const knowledge = dtc.knowledge;
    if (knowledge?.variant) {
      const descriptionCell = body.lastElementChild?.children[1];
      descriptionCell?.append(
        el("span", { class: "pill pill-online dtc-pill", text: knowledge.scopeShort }),
      );
    }

    // Actions per row: "Details" opens the decoded entry and its freeze frame,
    // "Löschen" fills the guarded write form below. The clear itself stays behind
    // the explicit confirmation, never behind a single click (AGENTS 20, 25/26).
    const actions = el("td", { class: "dtc-actions" }, [
      el("button", { text: "Details", onclick: () => showDtcDetails(dtc) }),
      el("button", { class: "danger", text: "Löschen", onclick: () => prepareClear(dtc) }),
    ]);
    body.lastElementChild?.append(actions);
  }
  renderClearEcuOptions(dtcs);
  /** @type {Record<string, number>} */
  const counts = {};
  for (const dtc of dtcs) counts[dtc.severity] = (counts[dtc.severity] ?? 0) + 1;
  must("#dtc-summary").textContent =
    dtcs.length === 0
      ? "keine Einträge"
      : `${dtcs.length} Einträge · ${Object.entries(counts)
          .map(([severity, count]) => `${severity}: ${count}`)
          .join(", ")}`;
}

/** @param {AppState["signals"]} signals */
function renderAnalysisSignalOptions(signals) {
  const selectNode = $("#analysis-signal-select");
  if (!(selectNode instanceof HTMLSelectElement)) return;
  const previous = selectNode.value;
  selectNode.replaceChildren(
    ...signals.map((s) => el("option", { value: s.id, text: `${s.name} (${s.id})` })),
  );
  if (previous && signals.some((s) => s.id === previous)) selectNode.value = previous;
}

/** @param {AppState["signals"]} signals */
function renderSignals(signals) {
  renderAnalysisSignalOptions(signals);
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
  board.setSignals(signals);
}

/** @param {SampleView[]} samples */
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
 * @param {SignalStatisticsView[]} statistics
 * @param {AppState["anomalies"]} anomalies
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

/** @param {AppState["actions"]} actions */
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
  renderDtcs(data.dtcs);
  renderStatistics(data.statistics, data.anomalies);
  renderActions(data.actions);
  if (data.signals.length > 0 && must("#signal-picker").children.length === 0)
    renderSignals(data.signals);
  must("#trace-rows").replaceChildren();
  state.trace = [];
  for (const entry of data.trace) appendTrace(entry);
}

/* ------------------------------------------------------- Freeze Frame (20) */

/**
 * Render one decoded freeze frame.
 *
 * The front end renders what it is given and never invents a field: the raw bytes
 * of the record stay visible next to the decoded values, and the notes of the
 * backend (truncated record, undocumented layout, leftover bytes) are shown as
 * notes instead of being swallowed (AGENTS 5, 18, 34.3).
 */
/** @param {DtcView} dtc */
async function showFreezeFrame(dtc) {
  const panel = must("#dtc-detail");
  const body = must("#dtc-detail-body");
  must("#dtc-detail-title").textContent = `${dtc.code} · ${dtc.ecu}`;
  panel.hidden = false;
  body.replaceChildren(el("p", { class: "muted small", text: "Freeze Frame wird gelesen …" }));

  /** @type {import("../src/views.js").FreezeFrameView} */
  let snapshot;
  try {
    ({ snapshot } = await api.readFreezeFrame({ rxId: dtc.rxId, code: dtc.code }));
  } catch (error) {
    body.replaceChildren(
      el("p", { class: "out-of-range", text: `Freeze Frame nicht verfügbar: ${messageOf(error)}` }),
    );
    return;
  }

  /** @type {HTMLElement[]} */
  const nodes = [];
  const list = el("ul", { class: "plain check-list" });
  const documented = snapshot.documented;
  list.append(
    el("li", {
      class: documented ? "ok" : "warn",
      text: documented
        ? "Layout vollständig aus dem Definition-Paket dekodiert"
        : "Layout nicht (vollständig) dokumentiert — Rohdaten bleiben erhalten",
    }),
  );
  for (const note of snapshot.notes) list.append(el("li", { class: "info", text: note }));
  if (snapshot.unassignedHex)
    list.append(
      el("li", { class: "warn", text: `Nicht zugeordnete Bytes: ${snapshot.unassignedHex}` }),
    );
  nodes.push(list);

  for (const field of snapshot.fields) {
    const rows = field.values.map((value) =>
      row(
        [
          value.name,
          `${value.value}${value.unit ? ` ${value.unit}` : ""}`,
          value.rawHex,
          value.outOfRange ? "außerhalb des definierten Bereichs" : "in Ordnung",
        ],
        [2],
      ),
    );
    if (rows.length === 0)
      rows.push(row(["—", "keine definierten Signale", field.rawHex, "—"], [2]));
    const table = el("table", { class: "grid" }, [
      el("thead", {}, [
        el("tr", {}, [
          el("th", { text: "Signal" }),
          el("th", { text: "Wert" }),
          el("th", { text: "Rohbytes" }),
          el("th", { text: "Bewertung" }),
        ]),
      ]),
      el("tbody", {}, rows),
    ]);
    nodes.push(
      el("div", { class: "freeze-field" }, [
        el("h4", { text: `${field.name} · ${field.did}` }),
        el("div", { class: "freeze-raw", text: field.rawHex }),
        table,
      ]),
    );
  }
  if (snapshot.fields.length === 0) {
    nodes.push(
      el("p", {
        class: "muted small",
        text: "Für diesen Datensatz dokumentiert das Definition-Paket kein Layout.",
      }),
    );
  }
  body.replaceChildren(...nodes);
}

/* ------------------------------------------------- DTC-Details (AGENTS 20) */

/** @param {DtcView} dtc */
function formatSeen(dtc) {
  if (!dtc.firstSeen) return "—";
  const first = new Date(dtc.firstSeen);
  const last = new Date(dtc.lastSeen ?? dtc.firstSeen);
  const same = Math.abs(last.getTime() - first.getTime()) < 1000;
  return `${first.toLocaleTimeString("de-DE")}${same ? "" : ` → ${last.toLocaleTimeString("de-DE")}`}`;
}

/* ------------------------------- Wissen pro Fahrzeugvariante (AGENTS 20, 23) */

/**
 * Renders the variant knowledge the backend already translated
 * (`dtc-knowledge-view.ts`): the labels, the numeric windows and the judgement of
 * a check arrive as text, so this file adds no vocabulary of its own (AGENTS 5).
 *
 * Notes are rendered as warnings. They say what had to be assumed or what cannot
 * be measured — hiding them would turn a hypothesis into a fact (§24).
 */
/**
 * @param {DtcKnowledgeView} [knowledge]
 * @returns {HTMLElement[]}
 */
function knowledgeNodes(knowledge) {
  if (!knowledge) return [];
  const nodes = [
    el("div", { class: "knowledge-head" }, [
      el("h4", { text: "Wissen zu diesem Fahrzeug" }),
      el("span", {
        class: knowledge.variant ? "pill pill-online" : "pill pill-offline",
        text: knowledge.scopeLabel,
      }),
    ]),
  ];

  const facts = el("ul", { class: "plain check-list" });
  if (knowledge.conditions)
    facts.append(el("li", { class: "info", text: `Setzt ein: ${knowledge.conditions}` }));
  if (knowledge.vehicleId)
    facts.append(el("li", { class: "info", text: `Fahrzeug-Definition: ${knowledge.vehicleId}` }));
  if (knowledge.provenance)
    facts.append(el("li", { class: "info", text: `Quelle: ${knowledge.provenance}` }));
  for (const note of knowledge.notes ?? []) facts.append(el("li", { class: "warn", text: note }));
  if (facts.childElementCount > 0) nodes.push(facts);

  const patterns = knowledge.patterns ?? [];
  if (patterns.length === 0)
    nodes.push(
      el("p", {
        class: "muted small",
        text: "Für diese Variante sind keine Ausfallmuster hinterlegt.",
      }),
    );
  for (const pattern of patterns) nodes.push(knowledgePattern(pattern));
  return nodes;
}

/** One documented failure pattern with the measurements that would confirm it. */
/**
 * @param {DtcPatternView} pattern
 * @returns {HTMLElement}
 */
function knowledgePattern(pattern) {
  /** @type {Array<HTMLElement | null>} */
  const children = [
    el("h5", { class: "knowledge-pattern-name" }, [
      document.createTextNode(pattern.name),
      pattern.likelihoodLabel
        ? el("span", { class: `pill pill-${pattern.likelihood}`, text: pattern.likelihoodLabel })
        : null,
    ]),
  ];
  if (pattern.explanation) children.push(el("p", { class: "small", text: pattern.explanation }));

  const checks = pattern.checks ?? [];
  if (checks.length === 0) {
    children.push(
      el("p", {
        class: "muted small",
        text: "Kein Messpunkt hinterlegt — dieses Muster lässt sich lesen, aber nicht prüfen.",
      }),
    );
  } else {
    children.push(
      el("table", { class: "grid" }, [
        el("thead", {}, [
          el("tr", {}, [
            el("th", { text: "Messpunkt" }),
            el("th", { text: "Erwartung" }),
            el("th", { text: "Fenster" }),
            el("th", { text: "Bewertung" }),
          ]),
        ]),
        el(
          "tbody",
          {},
          checks.map((check) =>
            row(
              [check.name, check.expect, check.window || "kein Zahlenfenster", check.judgement],
              check.measurable ? [2] : [2, 3],
            ),
          ),
        ),
      ]),
    );
  }
  if (pattern.repair)
    children.push(el("p", { class: "hint", text: `Reparaturhinweis: ${pattern.repair}` }));
  return el("div", { class: "knowledge-pattern" }, children);
}

/**
 * Details of one fault code: definition data, session history and the freeze
 * frame. Everything shown here comes from the backend; the front end adds no
 * interpretation of its own (AGENTS 5, 34.3).
 */
/** @param {DtcView} dtc */
function showDtcDetails(dtc) {
  void showFreezeFrame(dtc);
  const panel = must("#dtc-detail");
  const heading = child(panel, "h3").firstChild;
  if (heading) heading.textContent = `Fehlercode ${dtc.code} `;
  const extra = el("ul", { class: "plain check-list" }, [
    el("li", {
      class: "info",
      text: `ECU: ${dtc.ecu} · Status ${dtc.status} · Schwere ${dtc.severity}`,
    }),
    el("li", {
      class: "info",
      text: `Bestätigt: ${dtc.confirmed ? "ja" : "nein"} · Pending: ${dtc.pending ? "ja" : "nein"} · Test fehlgeschlagen: ${dtc.testFailed ? "ja" : "nein"}`,
    }),
    el("li", {
      class: "info",
      text: `Erstmals gesehen: ${dtc.firstSeen ? new Date(dtc.firstSeen).toLocaleString("de-DE") : "unbekannt"}`,
    }),
    el("li", {
      class: "info",
      text: `Zuletzt gesehen: ${dtc.lastSeen ? new Date(dtc.lastSeen).toLocaleString("de-DE") : "unbekannt"}`,
    }),
    el("li", {
      class: dtc.hint ? "ok" : "warn",
      text: dtc.hint
        ? `Nächster Schritt: ${dtc.hint}`
        : "Kein Hinweis im Definition-Paket dokumentiert",
    }),
    // Herkunft der Aussage (P0 #6, ADR 0037): der Satz stammt aus dem Diagnostic IR
    // und wird hier nur beschriftet. Die Workbench erfindet kein eigenes
    // Provenanz-Vokabular und prüft auch nicht den Wortlaut auf "not proven" —
    // der Satz sagt das selbst (AGENTS 24).
    ...(dtc.provenance
      ? [el("li", { class: "info", text: `Belegt durch: ${dtc.provenance}` })]
      : []),
  ]);
  const related = dtc.relatedSignals ?? [];
  if (related.length > 0) {
    extra.append(
      el("li", {
        class: "info",
        text: `Zugehörige Signale (Definition): ${related.map((entry) => entry.name).join(", ")}`,
      }),
    );
  }
  const detailBody = child(panel, "#dtc-detail-body");
  detailBody.prepend(extra, ...knowledgeNodes(dtc.knowledge));
  if (dtc.isNew)
    detailBody.prepend(
      el("p", { class: "hint", text: "Dieser Code ist im aktuellen Scan neu aufgetreten." }),
    );
}

/** Put a row's ECU into the guarded clear form; the write itself needs the confirmation. */
/** @param {DtcView} dtc */
function prepareClear(dtc) {
  must("#dtc-detail").hidden = true;
  const ecuSelect = select("#clear-ecu");
  if (!Array.from(ecuSelect.options).some((option) => option.value === dtc.rxId)) {
    ecuSelect.append(el("option", { value: dtc.rxId, text: `${dtc.ecu} (${dtc.rxId})` }));
  }
  ecuSelect.value = dtc.rxId;
  must("#dtc-clear").scrollIntoView({ behavior: "smooth", block: "nearest" });
  const status = must("#clear-status");
  status.replaceChildren(
    el("li", {
      class: "info",
      text: `Vorbereitet: Fehlerspeicher von ${dtc.ecu} — Vorbedingungen prüfen und Löschvorgang bestätigen.`,
    }),
  );
  must("#clear-result").replaceChildren();
  input("#clear-confirm").checked = false;
  updateClearButton();
}

/* ------------------------------------------- Fehlerspeicher löschen (20/26) */

/**
 * The preconditions as the operator asserts them (AGENTS 26).
 *
 * @returns {import("../src/views.js").VehicleStateView}
 */
function currentVehicleState() {
  const voltage = Number.parseFloat(input("#clear-voltage").value);
  return {
    stationary: input("#clear-stationary").checked,
    ignitionOn: input("#clear-ignition").checked,
    parkingBrake: input("#clear-parking").checked,
    ...(Number.isFinite(voltage) ? { batteryVoltage: voltage } : {}),
  };
}

/**
 * One ECU option per ECU that currently reports a fault code.
 *
 * @param {DtcView[]} dtcs
 */
function renderClearEcuOptions(dtcs) {
  const ecuSelect = select("#clear-ecu");
  const previous = ecuSelect.value;
  /** @type {Map<string, string>} */
  const seen = new Map();
  for (const dtc of dtcs) if (dtc.rxId != null) seen.set(dtc.rxId, dtc.ecu);
  ecuSelect.replaceChildren(
    ...Array.from(seen, ([rxId, name]) => el("option", { value: rxId, text: `${name} (${rxId})` })),
  );
  if (previous && seen.has(previous)) ecuSelect.value = previous;
}

/**
 * @param {HTMLElement} target
 * @param {DtcClearPrecheck} checks
 */
function renderClearChecks(target, checks) {
  target.replaceChildren();
  // A missing proof is not a violation: "die Spannung ist unbekannt" asks the
  // operator to measure, "die Spannung ist zu niedrig" asks to charge. Both
  // block the write (AGENTS 26, P0 #5), so they must not look the same.
  const unproven = new Set(checks.unproven ?? []);
  for (const entry of checks.failed) {
    const cls = unproven.has(entry) ? "unknown" : "fail";
    target.append(el("li", { class: cls, text: entry }));
  }
  for (const entry of checks.warnings) target.append(el("li", { class: "warn", text: entry }));
  if (checks.failed.length === 0)
    target.append(el("li", { class: "info", text: "Alle geprüften Vorbedingungen sind erfüllt." }));
}

function updateClearButton() {
  const ready = state.clearPrecheck?.ok === true && input("#clear-confirm").checked;
  button("#btn-clear-execute").disabled = !ready;
}

button("#btn-clear-precheck").addEventListener("click", async () => {
  const rxId = select("#clear-ecu").value;
  if (!rxId) {
    logError(new Error("kein Steuergerät ausgewählt"));
    return;
  }
  try {
    const { precheck } = await api.precheckDtcClear({
      rxId,
      vehicleState: currentVehicleState(),
    });
    state.clearPrecheck = precheck;
    renderClearChecks(must("#clear-status"), precheck);
    // The confirmation stays disabled until the preconditions are met: the backend
    // refuses a write anyway, and a UI that offers it would be lying (AGENTS 26).
    input("#clear-confirm").disabled = !precheck.ok;
    if (!precheck.ok) input("#clear-confirm").checked = false;
    updateClearButton();
  } catch (error) {
    logError(error);
  }
});

input("#clear-confirm").addEventListener("change", updateClearButton);

button("#btn-clear-execute").addEventListener("click", async () => {
  const rxId = select("#clear-ecu").value;
  if (!rxId || !input("#clear-confirm").checked) return;
  const result = must("#clear-result");
  result.replaceChildren(el("li", { class: "info", text: "Löschvorgang läuft …" }));
  try {
    const { result: cleared } = await api.clearDtcs({
      rxId,
      confirmed: true,
      vehicleState: currentVehicleState(),
    });
    {
      /** @type {HTMLElement[]} */
      const lines = [
        el("li", {
          class: cleared.verified ? "ok" : "warn",
          text: `${cleared.ecu}: ${cleared.verified ? "Löschvorgang durch erneutes Auslesen bestätigt" : "Löschvorgang nicht bestätigt — Status unverändert"}`,
        }),
        el("li", {
          class: "info",
          text: `vorher: ${cleared.before.join(", ") || "keine Einträge"}`,
        }),
        el("li", {
          class: "info",
          text: `nachher: ${cleared.after.join(", ") || "keine Einträge"}`,
        }),
        el("li", { class: "ok", text: `entfernt: ${cleared.removed.join(", ") || "—"}` }),
      ];
      if (cleared.stillFailing.length > 0) {
        lines.push(
          el("li", {
            class: "warn",
            text: `weiterhin gespeichert (Fehler liegt aktuell an): ${cleared.stillFailing.join(", ")}`,
          }),
        );
      }
      if (cleared.unchanged.length > 0) {
        lines.push(
          el("li", {
            class: "fail",
            text: `unverändert (Steuergerät hat nicht gelöscht): ${cleared.unchanged.join(", ")}`,
          }),
        );
      }
      result.replaceChildren(...lines);
    }
    state.clearPrecheck = null;
    input("#clear-confirm").checked = false;
    input("#clear-confirm").disabled = true;
    updateClearButton();
    await scan();
  } catch (error) {
    result.replaceChildren(
      el("li", { class: "fail", text: `Löschen abgelehnt: ${messageOf(error)}` }),
    );
  }
});

button("#btn-dtc-detail-close").addEventListener("click", () => {
  must("#dtc-detail").hidden = true;
});

/* ------------------------------------------------------------------- SSE */

/**
 * Payload of a named SSE event.
 *
 * `EventSource` types every listener argument as `Event`, but a named event
 * carries its data in a `MessageEvent`. The payload is `unknown` on purpose —
 * it arrived over the network — and each listener casts it to the wire type it
 * expects (the same endpoint shapes `views.ts` describes).
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
      renderDtcs(data.dtcs);
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

/** @param {import("../src/views.js").AnalysisView} result */
function renderAnalysis(result) {
  must("#analysis-source").textContent =
    `${result.provider} · Quelle: ${result.source} · Konfidenz ${Math.round(result.confidence * 100)} %`;
  const host = must("#analysis-out");
  host.replaceChildren(el("p", { text: result.summary }));
  // Woher die Antwort kommt (P0 #42, ADR 0038): Versionen und Belege stehen im
  // Ergebnis selbst — die Workbench erfindet keine eigene Herkunftszeile, sie zeigt
  // die des Providers. Fehlt sie (ein Provider ohne Provenienz), fehlt sie sichtbar.
  const provenance = result.provenance;
  if (provenance) {
    const versions = [
      `Prompt ${provenance.promptVersion}`,
      `Plattform ${provenance.runtimeVersion}`,
      provenance.definitionVersion ? `Definition ${provenance.definitionVersion}` : "",
      `${provenance.evidence.length} ${provenance.evidence.length === 1 ? "Beleg" : "Belege"}`,
    ]
      .filter((part) => part !== "")
      .join(" · ");
    host.append(el("p", { class: "muted small", text: versions }));
  }
  for (const finding of result.findings) {
    const cited = finding.basedOn ?? [];
    host.append(
      el("div", { class: `finding sev-${finding.severity}` }, [
        el("h4", { text: `${finding.severity.toUpperCase()} · ${finding.title}` }),
        el("p", { text: finding.detail }),
        el("p", {
          class: "muted small",
          // A finding without citations says so: silence here would read as "of course".
          text: cited.length > 0 ? `gestützt auf: ${cited.join(", ")}` : "ohne einzelnen Beleg",
        }),
      ]),
    );
  }
  host.append(el("h3", { text: "Empfehlungen" }));
  const list = el("ul", { class: "plain" });
  for (const recommendation of result.recommendations)
    list.append(el("li", { text: recommendation }));
  host.append(list);
  if (result.warnings?.length) {
    host.append(el("p", { class: "muted small", text: result.warnings.join(" · ") }));
  }
}

/* --------------------------------------------------------------- adapters */

/**
 * Adapter panel (AGENTS 4, 29).
 *
 * The list comes from the backend, which probes the host without opening a bus.
 * The form therefore shows exactly which settings an adapter needs and why it is
 * (not) usable — no silent fallback to the simulator if a device is missing.
 */
const adapterState = {
  /** @type {import("../src/views.js").AdapterSelection | null} */
  selected: null,
  /** @type {import("../src/views.js").AdapterDescription[]} */
  entries: [],
};

/** @param {import("../src/views.js").AdaptersView} payload */
function renderAdapters(payload) {
  adapterState.selected = payload.selected;
  adapterState.entries = payload.adapters;
  const adapterSelect = select("#adapter-select");
  adapterSelect.replaceChildren();
  for (const entry of payload.adapters) {
    const option = /** @type {HTMLOptionElement} */ (
      el("option", { value: entry.id, text: entry.displayName })
    );
    if (entry.id === payload.selected.id) option.selected = true;
    adapterSelect.append(option);
  }
  const selected = payload.adapters.find((entry) => entry.id === payload.selected.id);
  const bitrates = select("#adapter-bitrate");
  bitrates.replaceChildren(el("option", { value: "", text: "Standard" }));
  for (const bitrate of selected?.supportedBitrates ?? [])
    bitrates.append(el("option", { value: bitrate, text: bitrate }));
  bitrates.value = payload.selected.config.bitrate ?? "";

  const device = input("#adapter-device");
  device.value = payload.selected.config.device ?? payload.selected.config.channel ?? "";
  input("#adapter-baud").value = String(payload.selected.config.baudRate ?? "");
  input("#adapter-trace").value = payload.selected.config.trace ?? "";
  device.placeholder = selected?.requires.channel ? "can0" : "/dev/ttyUSB0";

  const probe = must("#adapter-probe");
  probe.textContent = `${payload.mode} · ${selected?.probe.detail ?? ""}`;
  probe.classList.toggle("out-of-range", selected?.probe.available === false);
  const hints = must("#adapter-hints");
  hints.replaceChildren();
  for (const hint of selected?.probe.hints ?? []) hints.append(el("li", { text: hint }));

  const body = must("#adapter-rows");
  body.replaceChildren();
  for (const entry of payload.adapters) {
    const capabilities = Object.entries(entry.capabilities)
      .filter(([, value]) => value === true)
      .map(([key]) => key)
      .join(", ");
    const channels = entry.capabilities.channels;
    const tr = row([
      entry.displayName,
      entry.kind,
      entry.probe.available ? "ja" : "nein",
      entry.probe.detail,
      `${capabilities}${channels > 1 ? `, ${channels} Kanäle` : ""}`,
    ]);
    if (entry.probe.available) tr.classList.add("ok-row");
    body.append(tr);
  }
}

async function loadAdapters() {
  try {
    renderAdapters(await api.fetchAdapters());
  } catch (error) {
    logError(error);
  }
}

/**
 * The selection as the form shows it.
 *
 * @returns {import("../src/views.js").AdapterSelection}
 */
function selectionFromForm() {
  const id = select("#adapter-select").value;
  const entry = adapterState.entries.find((candidate) => candidate.id === id);
  /** @type {import("../src/views.js").AdapterConfig} */
  const config = {};
  const device = input("#adapter-device").value.trim();
  const bitrate = select("#adapter-bitrate").value;
  const baud = Number.parseInt(input("#adapter-baud").value, 10);
  const trace = input("#adapter-trace").value.trim();
  if (device) {
    if (entry?.requires.channel) config.channel = device;
    else config.device = device;
  }
  if (bitrate) config.bitrate = bitrate;
  if (Number.isFinite(baud)) config.baudRate = baud;
  if (trace) config.trace = trace;
  return { id, config };
}

select("#adapter-select").addEventListener("change", () => {
  const id = select("#adapter-select").value;
  const entry = adapterState.entries.find((candidate) => candidate.id === id);
  must("#adapter-probe").textContent = entry?.description ?? "";
  if (entry?.defaults?.device) input("#adapter-device").value = entry.defaults.device;
  if (entry?.defaults?.channel && entry.requires.channel)
    input("#adapter-device").value = entry.defaults.channel;
});

button("#btn-adapter-apply").addEventListener("click", async () => {
  try {
    const result = await api.selectAdapter(selectionFromForm());
    await loadAdapters();
    // A selection change drops a running connection on purpose: the engine
    // must never keep talking over a transport the operator just replaced.
    if (result.reconnectRequired) applyState(await api.startSession());
    else applyState(await api.fetchState());
  } catch (error) {
    logError(error);
  }
});

/* ---------------------------------------------------------------- actions */

button("#btn-start").addEventListener("click", async () => {
  try {
    const data = await api.startSession();
    applyState(data);
    state.ecusCache = data.ecus;
    await loadHistory();
  } catch (error) {
    logError(error);
  }
});

/**
 * Determine the connected vehicle (AGENTS 11).
 *
 * Read-only: it weighs what is already known — VIN, identification values, the
 * addresses that answered — against the installed definitions.
 *
 * @returns {Promise<void>}
 */
async function resolve() {
  try {
    const { resolution } = await api.resolveVehicle();
    renderVehicleResolution(resolution);
  } catch (error) {
    logError(error);
  }
}
button("#btn-resolve").addEventListener("click", resolve);

button("#btn-identify").addEventListener("click", async () => {
  try {
    const { ecus } = await api.identify();
    state.ecusCache = ecus;
    renderEcus(ecus);
    // The identification values are the evidence a resolution weighs, so the
    // vehicle panel is refreshed with them instead of waiting for a click.
    await resolve();
  } catch (error) {
    logError(error);
  }
});

/** @returns {Promise<void>} */
async function scan() {
  try {
    const { dtcs } = await api.scanDtcs();
    renderDtcs(dtcs);
  } catch (error) {
    logError(error);
  }
}
button("#btn-scan").addEventListener("click", scan);
button("#btn-scan-2").addEventListener("click", scan);

button("#btn-live-start").addEventListener("click", async () => {
  const signalIds = Array.from(state.selectedSignals);
  try {
    await api.startLive({ signalIds });
    // The backend owns the session state; the front end asks it instead of
    // assembling a half-filled `AppState` of its own (which is what this handler
    // used to do — `renderConnection` then read `data.adapter.name` of a state
    // that had no adapter in it).
    applyState(await api.fetchState());
  } catch (error) {
    logError(error);
  }
});

button("#btn-live-stop").addEventListener("click", async () => {
  try {
    const { live } = await api.stopLive();
    state.live = live;
    must("#live-state").textContent = "gestoppt";
  } catch (error) {
    logError(error);
  }
});

button("#btn-marker").addEventListener("click", async () => {
  const label = window.prompt("Marker-Label", "Lastwechsel");
  if (!label) return;
  try {
    await api.addMarker({ label });
  } catch (error) {
    logError(error);
  }
});

button("#btn-analyze").addEventListener("click", async () => {
  try {
    renderAnalysis(await api.analyze());
  } catch (error) {
    logError(error);
  }
});

/* ------------------------------------------- Geführte Diagnose (Task 6) */

/** @type {GuidedDiagnosisView | null} */
let guidedDiagnosisState = null;

/** @param {GuidedDiagnosisView} view */
function renderGuidedDiagnosis(view) {
  guidedDiagnosisState = view;
  const badge = must("#guided-status-badge");
  badge.textContent = view.status;
  badge.className = "pill";
  if (view.status === "resolved") badge.classList.add("pill-online");
  else if (view.status === "in-progress") badge.classList.add("pill-live");
  else badge.classList.add("pill-possible");

  must("#guided-summary-text").textContent =
    `${view.summary} · ${view.stepsCompleted} Schritte abgeschlossen`;

  const testContent = must("#guided-next-test-content");
  const testActions = must("#guided-next-test-actions");

  if (view.nextRecommendedTest) {
    const next = view.nextRecommendedTest;
    testContent.replaceChildren(
      el("p", {}, [el("strong", { text: "Warum dieser Test: " }), next.rationale]),
      el("p", {
        class: "mono small",
        text: `Signal: ${next.test.signal} | Erwartung: ${next.test.expect} (Min: ${next.test.min ?? "—"}, Max: ${next.test.max ?? "—"}, Fenster: ${next.test.windowMs ?? 1000} ms)`,
      }),
      next.discriminatesAgainst && next.discriminatesAgainst.length > 0
        ? el("p", {
            class: "muted small",
            text: `Grenzt ab gegen: ${next.discriminatesAgainst.join(", ")}`,
          })
        : el("span"),
    );
    testActions.hidden = false;
  } else {
    testContent.replaceChildren(
      el("p", {
        class: "muted",
        text: "Kein weiterer diskriminierender Prüfschritt erforderlich (Diagnose abgeschlossen oder keine weiteren Tests definiert).",
      }),
    );
    testActions.hidden = true;
  }

  const rows = must("#guided-hypotheses-rows");
  rows.replaceChildren();
  if (view.hypotheses.length === 0) {
    rows.append(row(["Keine Hypothesen formuliert."]));
    return;
  }

  for (const hyp of view.hypotheses) {
    const tr = el("tr");

    // Hypothese
    const tdClaim = el("td", {}, [
      el("strong", { text: hyp.claim }),
      el("div", { class: "muted small mono", text: `ID: ${hyp.id}` }),
    ]);

    // Konfidenz
    const pct = Math.round(hyp.confidence * 100);
    const scoreFill = el("div", {
      class: hyp.confidence >= 0.7 ? "score-fill" : "score-fill score-fill-weak",
    });
    scoreFill.style.width = `${pct}%`;
    const tdConf = el("td", {}, [
      el("span", { class: "mono small", text: `${pct} %` }),
      el("div", { class: "score" }, [scoreFill]),
    ]);

    // Status
    const statusPill = el("span", {
      class: `pill pill-${hyp.outcome}`,
      text:
        hyp.outcome === "confirmed"
          ? "bestätigt"
          : hyp.outcome === "refuted"
            ? "widerlegt"
            : "offen",
    });
    const tdStatus = el("td", {}, [statusPill]);

    // Prüfungen
    const checksList = hyp.checks.map((c) => `${c.signal}: ${c.expect} → ${c.outcome}`).join(" · ");
    const tdChecks = el("td", {
      class: "small",
      text: checksList || "Noch keine Prüfschritte ausgeführt",
    });

    tr.append(tdClaim, tdConf, tdStatus, tdChecks);
    rows.append(tr);
  }
}

async function refreshGuidedDiagnosis() {
  try {
    const { state: gdState } = await api.fetchGuidedDiagnosis();
    renderGuidedDiagnosis(gdState);
  } catch (error) {
    logError(error);
  }
}

button("#btn-guided-refresh").addEventListener("click", refreshGuidedDiagnosis);

button("#btn-guided-step").addEventListener("click", async () => {
  if (!guidedDiagnosisState?.nextRecommendedTest) return;
  const next = guidedDiagnosisState.nextRecommendedTest;
  try {
    const { state: gdState } = await api.stepGuidedDiagnosis({
      signalId: next.test.signal,
      value:
        next.test.min !== undefined
          ? next.test.min
          : next.test.max !== undefined
            ? next.test.max
            : 1.0,
    });
    renderGuidedDiagnosis(gdState);
  } catch (error) {
    logError(error);
  }
});

/* --------------------------------- Codierung & Anpassung (Task 7 & 8) */

function currentCaVehicleState() {
  const voltage = Number.parseFloat(input("#ca-voltage").value);
  return {
    stationary: input("#ca-stationary").checked,
    ignitionOn: input("#ca-ignition").checked,
    parkingBrake: input("#ca-parking").checked,
    ...(Number.isFinite(voltage) ? { batteryVoltage: voltage } : {}),
  };
}

// Codierung
button("#btn-coding-precheck").addEventListener("click", async () => {
  const rxId = select("#ca-ecu").value;
  const did = Number.parseInt(input("#coding-did").value, 16);
  const data = input("#coding-data").value.trim();
  const status = must("#coding-precheck-status");
  status.replaceChildren();

  try {
    const { precheck } = await api.precheckCoding({
      rxId,
      did: Number.isFinite(did) ? did : 0x0100,
      data,
      vehicleState: currentCaVehicleState(),
    });

    if (precheck.ok) {
      status.append(
        el("li", {
          class: "info",
          text: "Vorprüfung erfolgreich: Alle Sicherheitsbedingungen für Codierung erfüllt.",
        }),
      );
      input("#coding-confirm").disabled = false;
    } else {
      for (const f of precheck.failed) {
        status.append(el("li", { class: "warn", text: `Fehlgeschlagen: ${f}` }));
      }
      for (const u of precheck.unproven) {
        status.append(el("li", { class: "warn", text: `Nicht nachgewiesen: ${u}` }));
      }
      input("#coding-confirm").checked = false;
      input("#coding-confirm").disabled = true;
    }
    button("#btn-coding-execute").disabled = !input("#coding-confirm").checked || !precheck.ok;
  } catch (error) {
    logError(error);
  }
});

input("#coding-confirm").addEventListener("change", () => {
  button("#btn-coding-execute").disabled = !input("#coding-confirm").checked;
});

button("#btn-coding-execute").addEventListener("click", async () => {
  const rxId = select("#ca-ecu").value;
  const did = Number.parseInt(input("#coding-did").value, 16);
  const data = input("#coding-data").value.trim();
  const box = must("#coding-result-box");
  box.replaceChildren(
    el("p", { class: "muted", text: "Codierung wird ausgeführt und verifiziert …" }),
  );

  try {
    const { result } = await api.writeCoding({
      rxId,
      did: Number.isFinite(did) ? did : 0x0100,
      data,
      confirmed: input("#coding-confirm").checked,
      vehicleState: currentCaVehicleState(),
    });

    box.replaceChildren(
      el("div", {
        class: result.verified ? "pill pill-online" : "pill pill-offline",
        text: result.verified ? "VERIFIZIERT" : "FEHLGESCHLAGEN",
      }),
      el("p", {}, [
        el("strong", {
          text: `ECU: ${result.ecuId} | DID: 0x${result.did.toString(16).toUpperCase()}`,
        }),
      ]),
      el("p", {
        class: "mono small",
        text: `Vorher: ${result.originalHex ?? "—"} → Geschrieben: ${result.writtenHex ?? "—"}`,
      }),
      el("p", { class: "muted small mono", text: `Transaktions-ID: ${result.transactionId}` }),
    );
    if (result.warnings && result.warnings.length > 0) {
      box.append(el("p", { class: "warn small", text: result.warnings.join(" · ") }));
    }
  } catch (error) {
    logError(error);
    box.replaceChildren(el("p", { class: "warn", text: messageOf(error) }));
  }
});

// Anpassung (Adaptation)
button("#btn-adapt-precheck").addEventListener("click", async () => {
  const rxId = select("#ca-ecu").value;
  const did = Number.parseInt(input("#adapt-did").value, 16);
  const value = Number.parseFloat(input("#adapt-value").value);
  const status = must("#adapt-precheck-status");
  status.replaceChildren();

  try {
    const { precheck } = await api.precheckAdaptation({
      rxId,
      did: Number.isFinite(did) ? did : 0x2100,
      value: Number.isFinite(value) ? value : 0,
      vehicleState: currentCaVehicleState(),
    });

    if (precheck.ok) {
      status.append(
        el("li", {
          class: "info",
          text: "Vorprüfung erfolgreich: Alle Sicherheitsbedingungen für Anpassung erfüllt.",
        }),
      );
      input("#adapt-confirm").disabled = false;
    } else {
      for (const f of precheck.failed) {
        status.append(el("li", { class: "warn", text: `Fehlgeschlagen: ${f}` }));
      }
      for (const u of precheck.unproven) {
        status.append(el("li", { class: "warn", text: `Nicht nachgewiesen: ${u}` }));
      }
      input("#adapt-confirm").checked = false;
      input("#adapt-confirm").disabled = true;
    }
    button("#btn-adapt-execute").disabled = !input("#adapt-confirm").checked || !precheck.ok;
  } catch (error) {
    logError(error);
  }
});

input("#adapt-confirm").addEventListener("change", () => {
  button("#btn-adapt-execute").disabled = !input("#adapt-confirm").checked;
});

button("#btn-adapt-execute").addEventListener("click", async () => {
  const rxId = select("#ca-ecu").value;
  const did = Number.parseInt(input("#adapt-did").value, 16);
  const value = Number.parseFloat(input("#adapt-value").value);
  const box = must("#adapt-result-box");
  box.replaceChildren(
    el("p", { class: "muted", text: "Parameteranpassung wird ausgeführt und verifiziert …" }),
  );

  try {
    const { result } = await api.writeAdaptation({
      rxId,
      did: Number.isFinite(did) ? did : 0x2100,
      value: Number.isFinite(value) ? value : 0,
      confirmed: input("#adapt-confirm").checked,
      vehicleState: currentCaVehicleState(),
    });

    box.replaceChildren(
      el("div", {
        class: result.verified ? "pill pill-online" : "pill pill-offline",
        text: result.verified ? "VERIFIZIERT" : "FEHLGESCHLAGEN",
      }),
      el("p", {}, [
        el("strong", {
          text: `ECU: ${result.ecuId} | DID: 0x${result.did.toString(16).toUpperCase()}`,
        }),
      ]),
      el("p", {
        class: "mono small",
        text: `Vorher: ${result.originalValue ?? "—"} → Geschrieben: ${result.writtenValue ?? "—"} ${result.unit ?? ""}`,
      }),
      el("p", { class: "muted small mono", text: `Transaktions-ID: ${result.transactionId}` }),
    );
    if (result.warnings && result.warnings.length > 0) {
      box.append(el("p", { class: "warn small", text: result.warnings.join(" · ") }));
    }
  } catch (error) {
    logError(error);
    box.replaceChildren(el("p", { class: "warn", text: messageOf(error) }));
  }
});

/* ------------------------------------------- Chaos Lab (Task 4) */

/** @param {ChaosStatusView} status */
function renderChaosStatus(status) {
  const activeLabel = must("#chaos-active-label");
  activeLabel.replaceChildren(
    el("span", {
      class: status.active ? "pill pill-offline" : "pill pill-online",
      text: status.active ? "aktiv" : "inaktiv",
    }),
  );
  must("#chaos-drop-rate-label").textContent = `${Math.round(status.dropRate * 100)} %`;
  must("#chaos-burst-remaining-label").textContent = `${status.dropBurstRemaining} Frames`;
  // Was der Burst adressiert, kommt als Satzteil der Projektion — nicht als Rat des
  // Browsers: ein Burst auf einer Id, über die niemand spricht, nimmt nichts weg, und
  // das muss hier zu lesen sein (AGENTS 0.E E24).
  must("#chaos-burst-target-label").textContent =
    status.dropBurstScope === "none"
      ? "nichts"
      : status.dropBurstScope === "bus-wide"
        ? "alle Rahmen"
        : (status.dropBurstTarget ?? "unbekannt");
  must("#chaos-dropped-count").textContent = String(status.droppedFrames);
  must("#chaos-corrupted-count").textContent = String(status.corruptedFrames);
  must("#chaos-delayed-count").textContent = String(status.delayedFrames);
}

/** @param {string} text */
function logChaosEvent(text) {
  const logList = must("#chaos-feedback-log");
  const time = new Date().toLocaleTimeString();
  logList.prepend(el("li", { text: `[${time}] ${text}` }));
}

async function refreshChaos() {
  try {
    const { status } = await api.fetchChaosStatus();
    renderChaosStatus(status);
  } catch (error) {
    logError(error);
  }
}

button("#btn-chaos-burst-inject").addEventListener("click", async () => {
  const count = Number.parseInt(input("#chaos-burst-input").value, 10);
  if (!Number.isFinite(count) || count < 1) {
    logChaosEvent("Burst-Anzahl fehlt — eine Zahl ab 1 nötig, es wurde nichts injiziert.");
    return;
  }
  const target = input("#chaos-burst-can-id").value.trim();
  try {
    const { status } = await api.injectChaos({
      dropBurst: count,
      // Leeres Feld ist die bus-weite Form; die Id selbst prüft der Server, damit
      // „7e8xyz“ hier nicht zu einem anderen Steuergerät wird.
      ...(target.length > 0 ? { dropBurstCanId: target } : {}),
    });
    renderChaosStatus(status);
    logChaosEvent(
      `Drop-Burst von ${count} Frames injiziert — ` +
        (status.dropBurstScope === "targeted"
          ? `auf ${status.dropBurstTarget}.`
          : "auf jeden Rahmen dieser Verbindung."),
    );
  } catch (error) {
    logError(error);
  }
});

button("#btn-chaos-rate-inject").addEventListener("click", async () => {
  const rate = Number.parseFloat(input("#chaos-rate-input").value);
  try {
    const { status } = await api.injectChaos({ dropRate: Number.isFinite(rate) ? rate : 0.2 });
    renderChaosStatus(status);
    logChaosEvent(`Dauerhafte Drop-Rate auf ${Math.round(rate * 100)} % gesetzt.`);
  } catch (error) {
    logError(error);
  }
});

button("#btn-chaos-corrupt-inject").addEventListener("click", async () => {
  const canId = input("#chaos-corrupt-can-id").value.trim();
  if (canId.length === 0) {
    logChaosEvent("Keine CAN-ID eingetragen — es wurde nichts korrumpiert.");
    return;
  }
  try {
    // Die Id geht als Text, der Server prüft die Grammatik; ein stiller Default wie das
    // vorige `?? 0x7e8` adressiert im Tippfall ein Steuergerät, das niemand gemeint hat.
    const { status } = await api.injectChaos({ corruptSequenceCanId: canId });
    renderChaosStatus(status);
    logChaosEvent(`Sequenzfehler auf CAN-ID ${canId} injiziert.`);
  } catch (error) {
    logError(error);
  }
});

button("#btn-chaos-reset-all").addEventListener("click", async () => {
  try {
    const { status } = await api.resetChaos();
    renderChaosStatus(status);
    logChaosEvent("Alle Chaos-Regeln zurückgesetzt. Bus läuft störungsfrei.");
  } catch (error) {
    logError(error);
  }
});

button("#btn-chaos-refresh").addEventListener("click", refreshChaos);

/* --------------------------------- Erweiterte Signalanalyse (Task 5) */

button("#btn-signal-analyze").addEventListener("click", async () => {
  const signalId = select("#analysis-signal-select").value;
  const out = must("#signal-analysis-out");
  out.replaceChildren(
    el("p", { class: "muted", text: "Berechne FFT, Spektrum und statistische Momente …" }),
  );

  try {
    const { analysis } = await api.fetchSignalAnalysis(signalId);
    out.replaceChildren();

    // Statistics card
    if (analysis.statistics) {
      const stats = analysis.statistics;
      const statsCard = el("div", { class: "card", style: "margin-top: 0.75rem;" }, [
        el("h4", { text: `Statistische Momente (${analysis.sampleCount} Samples)` }),
        el("dl", { class: "kv" }, [
          el("dt", { text: "Min / Max" }),
          el("dd", { text: `${stats.min.toFixed(2)} / ${stats.max.toFixed(2)}` }),
          el("dt", { text: "Mittelwert (Ø) / Median" }),
          el("dd", { text: `${stats.mean.toFixed(2)} / ${stats.median.toFixed(2)}` }),
          el("dt", { text: "Standardabweichung (σ)" }),
          el("dd", { text: `${stats.stdDev.toFixed(3)} (Varianz: ${stats.variance.toFixed(3)})` }),
          el("dt", { text: "Schiefe (Skewness)" }),
          el("dd", { text: stats.skewness.toFixed(3) }),
          el("dt", { text: "Wölbung (Kurtosis)" }),
          el("dd", { text: stats.kurtosis.toFixed(3) }),
          el("dt", { text: "Perzentile (P5 / P50 / P95)" }),
          el("dd", {
            text: `${stats.p5.toFixed(2)} / ${stats.p50.toFixed(2)} / ${stats.p95.toFixed(2)}`,
          }),
        ]),
      ]);
      out.append(statsCard);
    }

    // Spectrum card
    if (analysis.spectrum) {
      const spec = analysis.spectrum;
      const specCard = el("div", { class: "card", style: "margin-top: 0.75rem;" }, [
        el("h4", { text: "Frequenzspektrum (Hann-FFT)" }),
        el("dl", { class: "kv" }, [
          el("dt", { text: "Dominante Frequenz" }),
          el("dd", { text: `${spec.dominantFrequency.toFixed(2)} Hz` }),
          el("dt", { text: "Dominante Amplitude" }),
          el("dd", { text: spec.dominantMagnitude.toFixed(2) }),
          el("dt", { text: "Signal-Rausch-Verhältnis (SNR)" }),
          el("dd", { text: `${spec.snrDb.toFixed(1)} dB` }),
        ]),
      ]);
      out.append(specCard);
    }

    // Anomalies card
    const anomalyCard = el("div", { class: "card", style: "margin-top: 0.75rem;" }, [
      el("h4", { text: `Erkannte Anomalien (${analysis.anomalies.length})` }),
    ]);
    if (analysis.anomalies.length === 0) {
      anomalyCard.append(
        el("p", {
          class: "muted small",
          text: "Keine physikalischen Anomalien erkannt (Signal stationär und fehlerfrei).",
        }),
      );
    } else {
      const ul = el("ul", { class: "plain small" });
      for (const anom of analysis.anomalies) {
        ul.append(
          el("li", {}, [
            el("span", { class: "pill pill-offline", text: anom.kind }),
            ` Schwere: ${anom.severity} | Wert: ${anom.value.toFixed(2)} — ${anom.description}`,
          ]),
        );
      }
      anomalyCard.append(ul);
    }
    out.append(anomalyCard);
  } catch (error) {
    logError(error);
    out.replaceChildren(el("p", { class: "warn", text: messageOf(error) }));
  }
});

connectStream();
void loadAdapters();
mountScenarioPanel();
