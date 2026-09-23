/**
 * Diagnostic Trouble Code (DTC) & Freeze Frame Panel (AGENTS 20, 23, 26).
 *
 * Renders DTC lists, unread ECUs, decoded freeze frames, variant failure knowledge,
 * and guarded DTC clear workflows.
 */

import * as api from "/api.js";
import { button, child, el, input, messageOf, must, row, select } from "/dom.js";

/** @typedef {import("../src/views.js").DtcClearPrecheck} DtcClearPrecheck */
/** @typedef {import("../src/views.js").DtcKnowledgeView} DtcKnowledgeView */
/** @typedef {import("../src/views.js").DtcPatternView} DtcPatternView */
/** @typedef {import("../src/views.js").DtcView} DtcView */
/** @typedef {import("../src/views.js").FreezeFrameView} FreezeFrameView */
/** @typedef {import("../src/views.js").UnreadEcuView} UnreadEcuView */
/** @typedef {import("../src/views.js").VehicleStateView} VehicleStateView */

/** @type {DtcClearPrecheck | null} */
let clearPrecheck = null;

/**
 * Format timestamp of first/last appearance.
 *
 * @param {DtcView} dtc
 */
export function formatSeen(dtc) {
  if (!dtc.firstSeen) return "—";
  const first = new Date(dtc.firstSeen);
  const last = new Date(dtc.lastSeen ?? dtc.firstSeen);
  const same = Math.abs(last.getTime() - first.getTime()) < 1000;
  return `${first.toLocaleTimeString("de-DE")}${same ? "" : ` → ${last.toLocaleTimeString("de-DE")}`}`;
}

/**
 * Renders the variant knowledge from definition packages.
 *
 * @param {DtcKnowledgeView} [knowledge]
 * @returns {HTMLElement[]}
 */
export function knowledgeNodes(knowledge) {
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

/**
 * One documented failure pattern with verification measurements.
 *
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
 * Render one decoded freeze frame.
 *
 * @param {DtcView} dtc
 */
export async function showFreezeFrame(dtc) {
  const panel = must("#dtc-detail");
  const body = must("#dtc-detail-body");
  must("#dtc-detail-title").textContent = `${dtc.code} · ${dtc.ecu}`;
  panel.hidden = false;
  body.replaceChildren(el("p", { class: "muted small", text: "Freeze Frame wird gelesen …" }));

  /** @type {FreezeFrameView} */
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

/**
 * Show DTC details modal.
 *
 * @param {DtcView} dtc
 */
export async function showDtcDetails(dtc) {
  const panel = must("#dtc-detail");
  await showFreezeFrame(dtc);
  const extra = el("ul", { class: "plain check-list" }, [
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

/**
 * Put a row's ECU into the guarded clear form.
 *
 * @param {DtcView} dtc
 */
export function prepareClear(dtc) {
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

/**
 * Preconditions as asserted by operator.
 *
 * @returns {VehicleStateView}
 */
export function currentVehicleState() {
  const voltage = Number.parseFloat(input("#clear-voltage").value);
  return {
    stationary: input("#clear-stationary").checked,
    ignitionOn: input("#clear-ignition").checked,
    parkingBrake: input("#clear-parking").checked,
    ...(Number.isFinite(voltage) ? { batteryVoltage: voltage } : {}),
  };
}

/**
 * Populate clear-ecu dropdown.
 *
 * @param {readonly DtcView[]} dtcs
 */
export function renderClearEcuOptions(dtcs) {
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
 * Render preconditions verification check list.
 *
 * @param {HTMLElement} target
 * @param {DtcClearPrecheck} checks
 */
export function renderClearChecks(target, checks) {
  target.replaceChildren();
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
  const ready = clearPrecheck?.ok === true && input("#clear-confirm").checked;
  button("#btn-clear-execute").disabled = !ready;
}

/**
 * Render unread ECUs from last scan.
 *
 * @param {readonly UnreadEcuView[]} unread
 */
export function renderUnreadEcus(unread) {
  const host = must("#dtc-unread");
  host.replaceChildren();
  host.hidden = unread.length === 0;
  for (const entry of unread) {
    host.append(el("li", { class: "warn", text: `${entry.ecu} (${entry.rxId}): ${entry.reason}` }));
  }
}

/**
 * Render DTC table rows and summary.
 *
 * @param {readonly DtcView[]} dtcs
 * @param {readonly UnreadEcuView[]} [unread]
 */
export function renderDtcs(dtcs, unread = []) {
  const body = must("#dtc-rows");
  body.replaceChildren();
  renderUnreadEcus(unread);
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

    const knowledge = dtc.knowledge;
    if (knowledge?.variant) {
      const descriptionCell = body.lastElementChild?.children[1];
      descriptionCell?.append(
        el("span", { class: "pill pill-online dtc-pill", text: knowledge.scopeShort }),
      );
    }

    const actions = el("td", { class: "dtc-actions" }, [
      el("button", {
        text: "Details",
        onclick: () => {
          void showDtcDetails(dtc);
        },
      }),
      el("button", { class: "danger", text: "Löschen", onclick: () => prepareClear(dtc) }),
    ]);
    body.lastElementChild?.append(actions);
  }
  renderClearEcuOptions(dtcs);
  /** @type {Record<string, number>} */
  const counts = {};
  for (const dtc of dtcs) counts[dtc.severity] = (counts[dtc.severity] ?? 0) + 1;
  const coverage = unread.length === 0 ? "" : ` · ${unread.length}× nicht gelesen`;
  must("#dtc-summary").textContent =
    dtcs.length === 0
      ? `keine Einträge${coverage}`
      : `${dtcs.length} Einträge${coverage} · ${Object.entries(counts)
          .map(([severity, count]) => `${severity}: ${count}`)
          .join(", ")}`;
}

/**
 * Mount DTC clear event listeners.
 *
 * @param {(error: unknown) => void} onError
 * @param {() => Promise<void>} onScan
 */
export function mountDtcPanel(onError, onScan) {
  button("#btn-dtc-detail-close").addEventListener("click", () => {
    must("#dtc-detail").hidden = true;
  });

  input("#clear-confirm").addEventListener("change", updateClearButton);

  button("#btn-clear-precheck").addEventListener("click", async () => {
    const rxId = select("#clear-ecu").value;
    if (!rxId) {
      onError(new Error("kein Steuergerät ausgewählt"));
      return;
    }
    try {
      const { precheck } = await api.precheckDtcClear({
        rxId,
        vehicleState: currentVehicleState(),
      });
      clearPrecheck = precheck;
      renderClearChecks(must("#clear-status"), precheck);
      input("#clear-confirm").disabled = !precheck.ok;
      if (!precheck.ok) input("#clear-confirm").checked = false;
      updateClearButton();
    } catch (error) {
      onError(error);
    }
  });

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
      clearPrecheck = null;
      input("#clear-confirm").checked = false;
      input("#clear-confirm").disabled = true;
      updateClearButton();
      await onScan();
    } catch (error) {
      result.replaceChildren(
        el("li", { class: "fail", text: `Löschen abgelehnt: ${messageOf(error)}` }),
      );
    }
  });
}
