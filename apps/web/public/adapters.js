/**
 * Adapters panel (AGENTS 4, 29).
 *
 * Manages adapter catalog, live probing details, hardware settings form,
 * and selection changes.
 */

import * as api from "/api.js";
import { button, el, input, must, row, select } from "/dom.js";

/** @typedef {import("../src/views.js").AdapterConfig} AdapterConfig */
/** @typedef {import("../src/views.js").AdapterSelection} AdapterSelection */
/** @typedef {import("../src/views.js").AdaptersView} AdaptersView */
/** @typedef {import("../src/views.js").AppState} AppState */

/**
 * Adapter panel state.
 */
export const adapterState = {
  /** @type {AdapterSelection} */
  selected: { id: "simulator", config: {} },
  /** @type {import("../src/views.js").AdapterDescription[]} */
  entries: [],
};

/** @param {AdaptersView} payload */
export function renderAdapters(payload) {
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
  const protocol = input("#adapter-protocol");
  if (protocol) protocol.value = String(payload.selected.config.protocol ?? "");
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

/**
 * @param {(error: unknown) => void} [onError]
 */
export async function loadAdapters(onError) {
  try {
    renderAdapters(await api.fetchAdapters());
  } catch (error) {
    if (onError) onError(error);
  }
}

/**
 * The selection as the form shows it.
 *
 * @returns {AdapterSelection}
 */
export function selectionFromForm() {
  const id = select("#adapter-select").value;
  const entry = adapterState.entries.find((candidate) => candidate.id === id);
  /** @type {AdapterConfig} */
  const config = {};
  const device = input("#adapter-device").value.trim();
  const bitrate = select("#adapter-bitrate").value;
  const baud = Number.parseInt(input("#adapter-baud").value, 10);
  const trace = input("#adapter-trace").value.trim();
  // Only the serial ELM327 speaks ATSP; the field is hidden for every other
  // adapter, and an empty value means "leave it at the default".
  const protocol = input("#adapter-protocol")?.value.trim() ?? "";
  if (device) {
    if (entry?.requires.channel) config.channel = device;
    else config.device = device;
  }
  if (bitrate) config.bitrate = bitrate;
  if (Number.isFinite(baud)) config.baudRate = baud;
  if (trace) config.trace = trace;
  if (entry?.id === "elm327" && /^[0-9]$/.test(protocol))
    config.protocol = Number.parseInt(protocol, 10);
  return { id, config };
}

/**
 * Mount adapter selection listeners.
 *
 * @param {(error: unknown) => void} onError
 * @param {(state: AppState) => void} onApplyState
 */
export function mountAdaptersPanel(onError, onApplyState) {
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
      await loadAdapters(onError);
      if (result.reconnectRequired) onApplyState(await api.startSession());
      else onApplyState(await api.fetchState());
    } catch (error) {
      onError(error);
    }
  });
}
