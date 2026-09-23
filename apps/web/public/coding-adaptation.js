/**
 * Variant Coding and Adaptation Panel (Task 7 & 8).
 *
 * Implements ECU variant coding and parameter adaptation write transactions
 * with preconditions and verification.
 */

import * as api from "/api.js";
import { $, button, el, input, messageOf, must, select } from "/dom.js";

/** @typedef {import("../src/views.js").EcuView} EcuView */
/** @typedef {import("../src/views.js").VehicleStateView} VehicleStateView */

/**
 * Update the ECU dropdown for coding and adaptation.
 *
 * @param {readonly EcuView[]} ecus
 */
export function renderCodingEcuOptions(ecus) {
  const selectNode = $("#ca-ecu");
  if (!selectNode) return;
  selectNode.replaceChildren(
    ...ecus.map((ecu) =>
      el("option", {
        value: ecu.rxId,
        text: `${ecu.name} (${ecu.rxId})`,
      }),
    ),
  );
}

/**
 * Current vehicle state asserted by the operator for coding and adaptation.
 *
 * @returns {VehicleStateView}
 */
export function currentCaVehicleState() {
  const voltage = Number.parseFloat(input("#ca-voltage").value);
  return {
    stationary: input("#ca-stationary").checked,
    ignitionOn: input("#ca-ignition").checked,
    parkingBrake: input("#ca-parking").checked,
    ...(Number.isFinite(voltage) ? { batteryVoltage: voltage } : {}),
  };
}

/**
 * Mount coding and adaptation panel controls.
 *
 * @param {(error: unknown) => void} onError
 */
export function mountCodingAdaptationPanel(onError) {
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
      onError(error);
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
      onError(error);
      box.replaceChildren(el("p", { class: "warn", text: messageOf(error) }));
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
      onError(error);
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
      onError(error);
      box.replaceChildren(el("p", { class: "warn", text: messageOf(error) }));
    }
  });
}
