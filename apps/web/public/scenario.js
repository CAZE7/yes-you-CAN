/**
 * Szenario-Panel (AGENTS 32, ADR 0040 §8) — der Katalog als Klick, nicht als curl.
 *
 * The engine was reachable for a while through the API only: the routes existed, the
 * catalog was typed, and no panel used them (0.E E21). This module is that half, and it is
 * deliberately without opinions. Everything the panel *shows about the vehicle* — which
 * options exist, what a verdict means, how a state word reads, which unit belongs to a
 * number — is projected server-side in `../src/scenario-view.ts` and pinned by
 * `apps/web/test/scenario-view.spec.ts`. The three sentences this module owns are about
 * the fetch: no run yet, a run in flight, a refused run.
 *
 * Like `vehicle.js` and `graphs.js`: a plain ES module, DOM helpers from `dom.js`, no
 * bundler and no framework (ADR 0012, AGENTS 16).
 */

import * as api from "/api.js";
import { $, button, el, kv, messageOf, row, select } from "/dom.js";

/** @typedef {import("../src/views.js").ScenarioCatalogView} ScenarioCatalogView */
/** @typedef {import("../src/views.js").ScenarioPanelView} ScenarioPanelView */
/** @typedef {import("../src/views.js").ScenarioVerdictView} ScenarioVerdictView */

/**
 * The last catalog the page fetched. Kept so a repaint of the verdict does not need the
 * network — and so an empty picker can still say what its emptiness means.
 *
 * @type {ScenarioCatalogView}
 */
let catalog = { scenarios: [], options: [], note: "kein Lauf — Katalog wird geladen" };

/** @returns {void} */
function renderPicker() {
  const picker = select("#scenario-picker");
  const run = button("#btn-scenario-run");
  const previous = picker.value;
  picker.replaceChildren(
    ...catalog.options.map((option) =>
      el("option", { value: option.value, text: option.label, title: option.hint }),
    ),
  );
  const empty = catalog.options.length === 0;
  if (empty) picker.append(el("option", { value: "", text: "— kein Katalog —" }));
  picker.disabled = empty;
  run.disabled = empty;
  // A refresh of the catalog must not jump the selection to its first row: the operator
  // who pressed "Katalog neu laden" wants the same scenario, if it is still there.
  if (!empty && catalog.options.some((option) => option.value === previous)) {
    picker.value = previous;
  }
  const note = $("#scenario-note");
  if (note) note.textContent = catalog.note;
}

/** @param {ScenarioVerdictView} verdict @returns {void} */
function renderVerdict(verdict) {
  const pill = $("#scenario-verdict");
  if (pill) {
    pill.textContent = verdict.headline;
    // `pill-idle|busy|error|ok|bad` are the panel's own; the online/offline pair carries
    // the colour, because inventing a second success idiom for one card is how a page
    // ends up with two meanings of green (AGENTS 18).
    pill.className = `pill ${
      verdict.tone === "ok"
        ? "pill-online"
        : verdict.tone === "bad" || verdict.tone === "error"
          ? "pill-offline"
          : "pill-untested"
    }`;
  }
  const detail = $("#scenario-verdict-detail");
  if (detail) detail.textContent = verdict.detail;
}

/**
 * Lay out one finished run. The rows arrive as text; the only decision here is which
 * existing list idiom they belong to (`check-list` for verdicts, table for the memory).
 *
 * @param {ScenarioPanelView} panel
 * @param {string[]} unexpected
 * @returns {void}
 */
function renderRun(panel, unexpected) {
  const card = $("#scenario-run");
  if (card) card.hidden = false;

  const checks = $("#scenario-checks");
  if (checks) {
    checks.replaceChildren(
      ...(panel.checks.length === 0
        ? [el("li", { class: "warn", text: "dieses Szenario meldet keine Erwartungen" })]
        : panel.checks.map((check) => el("li", { class: check.state, text: check.text }))),
    );
  }

  const memory = $("#scenario-memory-rows");
  if (memory) {
    memory.replaceChildren(
      ...(panel.memory.length === 0
        ? [row(["—", "keine Einträge", "", ""])]
        : panel.memory.map((entry) => row(entry.cells, [1, 2]))),
    );
  }
  const memoryNote = $("#scenario-memory-note");
  if (memoryNote) memoryNote.textContent = panel.memoryNote;
  kv(
    "#scenario-model-rows",
    panel.model.map((entry) => [entry.label, entry.value]),
  );

  const timeline = $("#scenario-timeline");
  if (timeline)
    timeline.replaceChildren(
      ...panel.timeline.map((line) => el("li", { class: "mono small", text: line })),
    );

  const surprises = $("#scenario-unexpected");
  if (surprises)
    surprises.replaceChildren(
      ...(unexpected.length === 0
        ? [el("span", { class: "muted small", text: "keine" })]
        : unexpected.map((code) => el("span", { class: "pill pill-offline", text: code }))),
    );
}

/** Hide the run card again — after a new pick, so a stale verdict never outlives its run. @returns {void} */
function clearRun() {
  const card = $("#scenario-run");
  if (card) card.hidden = true;
}

/**
 * Fetch the catalog and repaint the picker.
 *
 * The catalog is a property of the *adapter*, not of the page: the virtual vehicle answers
 * with six scenarios and a serial interface answers with an error, so this runs on tab open
 * and after `Neu laden` — not once at boot, which would freeze whatever adapter was
 * selected when the page loaded.
 *
 * @returns {Promise<void>}
 */
export async function refreshScenarioCatalog() {
  try {
    catalog = await api.fetchScenarios();
  } catch (error) {
    // A refused catalog is a state of the connection. The sentence stays the server's:
    // it names the adapter that would answer, and rephrasing it here would lose that.
    catalog = { scenarios: [], options: [], note: `Katalog nicht verfügbar: ${messageOf(error)}` };
  }
  renderPicker();
}

/**
 * Wire the panel's controls and paint the first state. Called once from `app.js`.
 *
 * @returns {void}
 */
export function mountScenarioPanel() {
  renderVerdict({ tone: "idle", headline: "kein Lauf", detail: "Szenario wählen und ausführen" });
  renderPicker();
  select("#scenario-picker").addEventListener("change", clearRun);
  button("#btn-scenario-refresh").addEventListener("click", () => {
    void refreshScenarioCatalog();
  });
  button("#btn-scenario-run").addEventListener("click", () => {
    void runSelectedScenario();
  });
}

/**
 * One run, start to verdict.
 *
 * `running` and `error` are the panel's own two states — the first because a run models
 * seconds of vehicle time, the second because a 409 has a message and it belongs on the
 * screen. Neither says anything about the car, which is why neither needs a projection.
 *
 * @returns {Promise<void>}
 */
async function runSelectedScenario() {
  const id = select("#scenario-picker").value;
  if (id === "") return;
  const run = button("#btn-scenario-run");
  run.disabled = true;
  clearRun();
  renderVerdict({ tone: "busy", headline: "Läuft", detail: `${id} — Modellzeit läuft` });
  try {
    const result = await api.runScenario({ id });
    renderVerdict(result.panel.verdict);
    renderRun(result.panel, result.run.unexpected);
  } catch (error) {
    renderVerdict({ tone: "error", headline: "Abgelehnt", detail: messageOf(error) });
  } finally {
    run.disabled = false;
  }
}
