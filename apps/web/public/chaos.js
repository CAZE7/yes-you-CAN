/**
 * Chaos Lab controls (Task 4).
 *
 * Exposes CAN bus impairment controls (drop rate, drop bursts, sequence corruption)
 * and visualizes active impairment statistics.
 */

import * as api from "/api.js";
import { button, el, input, must } from "/dom.js";

/** @typedef {import("../src/views.js").ChaosStatusView} ChaosStatusView */

/** @param {string} text */
function logChaosEvent(text) {
  const logList = must("#chaos-feedback-log");
  const time = new Date().toLocaleTimeString();
  logList.prepend(el("li", { text: `[${time}] ${text}` }));
}

/** @param {ChaosStatusView} status */
export function renderChaosStatus(status) {
  const activeLabel = must("#chaos-active-label");
  activeLabel.replaceChildren(
    el("span", {
      class: status.active ? "pill pill-offline" : "pill pill-online",
      text: status.active ? "aktiv" : "inaktiv",
    }),
  );
  must("#chaos-drop-rate-label").textContent = `${Math.round(status.dropRate * 100)} %`;
  must("#chaos-burst-remaining-label").textContent = `${status.dropBurstRemaining} Frames`;
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
 * @param {(error: unknown) => void} [onError]
 */
export async function refreshChaos(onError) {
  try {
    const { status } = await api.fetchChaosStatus();
    renderChaosStatus(status);
  } catch (error) {
    if (onError) onError(error);
  }
}

/**
 * Mount chaos lab button listeners.
 *
 * @param {(error: unknown) => void} onError
 */
export function mountChaosPanel(onError) {
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
      onError(error);
    }
  });

  button("#btn-chaos-rate-inject").addEventListener("click", async () => {
    const rate = Number.parseFloat(input("#chaos-rate-input").value);
    try {
      const { status } = await api.injectChaos({ dropRate: Number.isFinite(rate) ? rate : 0.2 });
      renderChaosStatus(status);
      logChaosEvent(`Dauerhafte Drop-Rate auf ${Math.round(rate * 100)} % gesetzt.`);
    } catch (error) {
      onError(error);
    }
  });

  button("#btn-chaos-corrupt-inject").addEventListener("click", async () => {
    const canId = input("#chaos-corrupt-can-id").value.trim();
    if (canId.length === 0) {
      logChaosEvent("Keine CAN-ID eingetragen — es wurde nichts korrumpiert.");
      return;
    }
    try {
      const { status } = await api.injectChaos({ corruptSequenceCanId: canId });
      renderChaosStatus(status);
      logChaosEvent(`Sequenzfehler auf CAN-ID ${canId} injiziert.`);
    } catch (error) {
      onError(error);
    }
  });

  button("#btn-chaos-reset-all").addEventListener("click", async () => {
    try {
      const { status } = await api.resetChaos();
      renderChaosStatus(status);
      logChaosEvent("Alle Chaos-Regeln zurückgesetzt. Bus läuft störungsfrei.");
    } catch (error) {
      onError(error);
    }
  });

  button("#btn-chaos-refresh").addEventListener("click", () => {
    void refreshChaos(onError);
  });
}
