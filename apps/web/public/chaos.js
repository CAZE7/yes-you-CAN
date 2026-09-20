/**
 * Chaos-Lab panel (0.E E24) — the switches that act on the live bus.
 *
 * Like `scenario.js`: a plain ES module, DOM helpers from `dom.js`, no bundler
 * (ADR 0012, AGENTS 16). What a burst *does* is a session fact and lives on the
 * server; this file only paints the status the route already computed.
 */

import * as api from "/api.js";
import { button, el, input, must } from "/dom.js";

/** @typedef {import("../src/views.js").ChaosStatusView} ChaosStatusView */

/**
 * @param {ChaosStatusView} status
 * @returns {void}
 */
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

/**
 * @param {string} text
 * @returns {void}
 */
function logChaosEvent(text) {
  const logList = must("#chaos-feedback-log");
  const time = new Date().toLocaleTimeString();
  logList.prepend(el("li", { text: `[${time}] ${text}` }));
}

/**
 * @param {unknown} error
 * @returns {void}
 */
function reportChaosError(error) {
  const reason = error instanceof Error ? error.message : String(error);
  logChaosEvent(`Fehler: ${reason}`);
}

/** @returns {Promise<void>} */
async function refreshChaos() {
  try {
    const { status } = await api.fetchChaosStatus();
    renderChaosStatus(status);
  } catch (error) {
    reportChaosError(error);
  }
}

/**
 * Wire the panel's controls. Called once from `app.js`.
 *
 * @returns {void}
 */
export function mountChaosPanel() {
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
      reportChaosError(error);
    }
  });

  button("#btn-chaos-rate-inject").addEventListener("click", async () => {
    const rate = Number.parseFloat(input("#chaos-rate-input").value);
    try {
      const { status } = await api.injectChaos({ dropRate: Number.isFinite(rate) ? rate : 0.2 });
      renderChaosStatus(status);
      logChaosEvent(`Dauerhafte Drop-Rate auf ${Math.round(rate * 100)} % gesetzt.`);
    } catch (error) {
      reportChaosError(error);
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
      reportChaosError(error);
    }
  });

  button("#btn-chaos-reset-all").addEventListener("click", async () => {
    try {
      const { status } = await api.resetChaos();
      renderChaosStatus(status);
      logChaosEvent("Alle Chaos-Regeln zurückgesetzt. Bus läuft störungsfrei.");
    } catch (error) {
      reportChaosError(error);
    }
  });

  button("#btn-chaos-refresh").addEventListener("click", () => {
    void refreshChaos();
  });
}
