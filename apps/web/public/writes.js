/**
 * Coding & adaptation panel (AGENTS 25/26, ADR 0032).
 *
 * The write itself is a Safety-gated `WritePort` operation. This file only
 * collects the operator's assertions and paints the result the route already
 * computed — like `scenario.js`, no bundler, no second vocabulary (ADR 0012).
 */

import * as api from "/api.js";
import { button, el, input, must, select } from "/dom.js";

/**
 * @returns {import("../src/views.js").VehicleStateView}
 */
function currentCaVehicleState() {
  const voltage = Number.parseFloat(input("#ca-voltage").value);
  return {
    stationary: input("#ca-stationary").checked,
    ignitionOn: input("#ca-ignition").checked,
    parkingBrake: input("#ca-parking").checked,
    ...(Number.isFinite(voltage) ? { batteryVoltage: voltage } : {}),
  };
}

/**
 * @param {HTMLElement} status
 * @param {unknown} error
 * @returns {void}
 */
function reportWriteError(status, error) {
  const reason = error instanceof Error ? error.message : String(error);
  status.replaceChildren(el("li", { class: "warn", text: reason }));
}

/**
 * Wire the panel's controls. Called once from `app.js`.
 *
 * @returns {void}
 */
export function mountWritesPanel() {
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
        for (const failed of precheck.failed) {
          status.append(el("li", { class: "warn", text: `Fehlgeschlagen: ${failed}` }));
        }
        for (const unproven of precheck.unproven) {
          status.append(el("li", { class: "warn", text: `Nicht nachgewiesen: ${unproven}` }));
        }
        input("#coding-confirm").checked = false;
        input("#coding-confirm").disabled = true;
      }
      button("#btn-coding-execute").disabled = !input("#coding-confirm").checked || !precheck.ok;
    } catch (error) {
      reportWriteError(status, error);
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
      const reason = error instanceof Error ? error.message : String(error);
      box.replaceChildren(el("p", { class: "warn", text: reason }));
    }
  });

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
        for (const failed of precheck.failed) {
          status.append(el("li", { class: "warn", text: `Fehlgeschlagen: ${failed}` }));
        }
        for (const unproven of precheck.unproven) {
          status.append(el("li", { class: "warn", text: `Nicht nachgewiesen: ${unproven}` }));
        }
        input("#adapt-confirm").checked = false;
        input("#adapt-confirm").disabled = true;
      }
      button("#btn-adapt-execute").disabled = !input("#adapt-confirm").checked || !precheck.ok;
    } catch (error) {
      reportWriteError(status, error);
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
      const reason = error instanceof Error ? error.message : String(error);
      box.replaceChildren(el("p", { class: "warn", text: reason }));
    }
  });
}
