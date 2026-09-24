/**
 * Typed client for the workbench HTTP API (AGENTS 16, 34.3).
 *
 * The front end used to call `fetch` with loose paths and untyped bodies; the
 * calls compiled because nothing was checked (`noImplicitAny: false`, E19). This
 * module is the single place where an endpoint is paired with the shape it
 * answers with — the shapes come from `../src/views.ts`, the same declarations the
 * server fills in, so a renamed field fails the frontend typecheck.
 *
 * Every function maps to one route in `../src/server.ts`; the mapping is written
 * down once, here, instead of being spread over the view code.
 *
 * The JSON body itself is a trust boundary: `request()` returns `unknown` and
 * each exported function declares what it expects. That is a deliberate
 * assertion per endpoint — visible in the code — instead of one unchecked `any`
 * for the whole front end.
 */

/**
 * @template T
 * @param {string} path
 * @param {RequestInit} [options]
 * @returns {Promise<T>}
 */
async function request(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options,
  });
  if (!response.ok) {
    // The body of an error response carries the reason (`HttpError`), so it is
    // part of the message the operator sees.
    const detail = await response.text();
    throw new Error(`${path} → ${response.status} ${detail}`);
  }
  const type = response.headers.get("content-type") ?? "";
  return /** @type {T} */ (type.includes("json") ? await response.json() : await response.text());
}

/** @param {unknown} body */
const post = (body) => ({
  method: "POST",
  body: JSON.stringify(body),
});

/**
 * Full workbench state — the same object the `state` SSE event carries.
 *
 * @returns {Promise<import("../src/views.js").AppState>}
 */
export const fetchState = () => request("/api/state");

/**
 * The whole recording, so the graphs can show the past and not only the live window.
 *
 * @returns {Promise<import("../src/views.js").HistoryView>}
 */
export const fetchHistory = () => request("/api/history");

/**
 * Adapter catalog plus the current selection.
 *
 * @returns {Promise<import("../src/views.js").AdaptersView>}
 */
export const fetchAdapters = () => request("/api/adapters");

/**
 * @param {import("../src/views.js").AdapterSelection} selection
 * @returns {Promise<import("../src/views.js").AdapterSelectView>}
 */
export const selectAdapter = (selection) => request("/api/adapter/select", post(selection));

/**
 * The adapter doctor for a selection: the pre-flight checklist
 * (settings → availability → open/handshake → vehicle side) as a report —
 * the same checklist the CLI doctor walks through.
 *
 * @param {import("../src/views.js").AdapterSelection} selection
 * @returns {Promise<import("../src/views.js").AdapterDoctorView>}
 */
export const runAdapterDoctor = (selection) => request("/api/adapter/doctor", post(selection));

/**
 * Start (or restart) the session on the selected adapter.
 *
 * @returns {Promise<import("../src/views.js").AppState>}
 */
export const startSession = () => request("/api/start", post({}));

/**
 * Read the identification data of every answering ECU (AGENTS 11).
 *
 * @returns {Promise<{ ecus: import("../src/views.js").EcuView[] }>}
 */
export const identify = () => request("/api/identify", post({}));

/**
 * Weigh the known evidence against the installed definitions.
 *
 * @returns {Promise<{ resolution: import("../src/views.js").VehicleResolutionView }>}
 */
export const resolveVehicle = () => request("/api/vehicle/resolve", post({}));

/**
 * Read the fault memory of every reachable ECU.
 *
 * Both halves of the scan (ADR 0049): `dtcs` is what was read, `unread` which modules
 * did not answer. An empty `dtcs` next to a non-empty `unread` means "nobody answered",
 * not "the car has no faults".
 *
 * @returns {Promise<{
 *   dtcs: import("../src/views.js").DtcView[],
 *   unread: import("../src/views.js").UnreadEcuView[],
 * }>}
 */
export const scanDtcs = () => request("/api/dtc/scan", post({}));

/**
 * Freeze frame of one fault code.
 *
 * @param {{ rxId: string, code: string, recordNumber?: number }} query
 * @returns {Promise<{ snapshot: import("../src/views.js").FreezeFrameView }>}
 */
export const readFreezeFrame = (query) => request("/api/dtc/snapshot", post(query));

/**
 * Evaluate the safety preconditions of a clear *without* performing it (AGENTS 26).
 *
 * @param {{ rxId: string, vehicleState: import("../src/views.js").VehicleStateView }} query
 * @returns {Promise<{ precheck: import("../src/views.js").DtcClearPrecheck }>}
 */
export const precheckDtcClear = (query) => request("/api/dtc/clear/precheck", post(query));

/**
 * Perform the clear. The backend re-checks the preconditions and refuses a write
 * that is not confirmed (the UI cannot bypass that, by design).
 *
 * @param {{ rxId: string, confirmed: boolean, vehicleState: import("../src/views.js").VehicleStateView }} query
 * @returns {Promise<{ result: import("../src/views.js").DtcClearView }>}
 */
export const clearDtcs = (query) => request("/api/dtc/clear", post(query));

/**
 * @param {{ signalIds: string[] }} query
 * @returns {Promise<{ live: boolean }>}
 */
export const startLive = (query) => request("/api/live/start", post(query));

/** @returns {Promise<{ live: boolean }>} */
export const stopLive = () => request("/api/live/stop", post({}));

/**
 * @param {{ label: string }} query
 * @returns {Promise<{ ok: boolean }>}
 */
export const addMarker = (query) => request("/api/marker", post(query));

/** @returns {Promise<import("../src/views.js").AnalysisView>} */
export const analyze = () => request("/api/analyze", post({}));

/**
 * Guided Diagnosis: retrieve ranked hypotheses and next recommended test (Task 6).
 *
 * @returns {Promise<{ state: import("../src/views.js").GuidedDiagnosisView }>}
 */
export const fetchGuidedDiagnosis = () => request("/api/guided-diagnosis", post({}));

/**
 * @param {{ signalId?: string, value?: number }} query
 * @returns {Promise<{ state: import("../src/views.js").GuidedDiagnosisView }>}
 */
export const stepGuidedDiagnosis = (query) => request("/api/guided-diagnosis/step", post(query));

/**
 * Prechecks variant coding write (Task 8).
 *
 * @param {{ rxId: string, did?: number, data?: string, vehicleState: import("../src/views.js").VehicleStateView }} query
 * @returns {Promise<{ precheck: { ok: boolean, failed: string[], unproven: string[], warnings: string[] } }>}
 */
export const precheckCoding = (query) => request("/api/coding/precheck", post(query));

/**
 * Executes variant coding write with readback verification (Task 8).
 *
 * @param {{ rxId: string, did?: number, data?: string, confirmed: boolean, vehicleState: import("../src/views.js").VehicleStateView }} query
 * @returns {Promise<{ result: import("../src/views.js").CodingResultView }>}
 */
export const writeCoding = (query) => request("/api/coding/write", post(query));

/**
 * Prechecks parameter adaptation write (Task 8).
 *
 * @param {{ rxId: string, did?: number, value?: number, vehicleState: import("../src/views.js").VehicleStateView }} query
 * @returns {Promise<{ precheck: { ok: boolean, failed: string[], unproven: string[], warnings: string[] } }>}
 */
export const precheckAdaptation = (query) => request("/api/adaptation/precheck", post(query));

/**
 * Executes parameter adaptation write with readback verification (Task 8).
 *
 * @param {{ rxId: string, did?: number, value?: number, confirmed: boolean, vehicleState: import("../src/views.js").VehicleStateView }} query
 * @returns {Promise<{ result: import("../src/views.js").AdaptationResultView }>}
 */
export const writeAdaptation = (query) => request("/api/adaptation/write", post(query));

/**
 * Advanced signal analysis: spectral FFT, higher-order stats, anomalies (Task 5).
 *
 * @param {string} signalId
 * @returns {Promise<{ analysis: import("../src/views.js").AdvancedSignalAnalysisView }>}
 */
export const fetchSignalAnalysis = (signalId) =>
  request(`/api/analysis/signal?signalId=${encodeURIComponent(signalId)}`);

/**
 * Injects chaos/faults into the transport layer (Task 4).
 *
 * @param {{ dropBurst?: number, dropBurstCanId?: string | number, dropRate?: number, corruptSequenceCanId?: string | number }} query
 * @returns {Promise<{ status: import("../src/views.js").ChaosStatusView }>}
 */
export const injectChaos = (query) => request("/api/chaos/inject", post(query));

/**
 * Resets chaos rules on the transport layer (Task 4).
 *
 * @returns {Promise<{ status: import("../src/views.js").ChaosStatusView }>}
 */
export const resetChaos = () => request("/api/chaos/reset", post({}));

/**
 * @returns {Promise<{ status: import("../src/views.js").ChaosStatusView }>}
 */
export const fetchChaosStatus = () => request("/api/chaos/status");

/**
 * The scenario catalog of the connected vehicle.
 *
 * `options` and `note` come from the server's projection (`apps/web/src/scenario-view.ts`,
 * spec in `apps/web/test/scenario-view.spec.ts`): the picker shows what it was given and
 * decides nothing of its own, because a front-end module has no test runner here.
 *
 * @returns {Promise<import("../src/views.js").ScenarioCatalogView>}
 */
export const fetchScenarios = () => request("/api/simulator/scenarios");

/**
 * Run one scenario on the connected virtual vehicle.
 *
 * A refused run (no behaviour model on this adapter, unknown id) answers 409 with the
 * sentence the backend chose, and `request` puts that sentence into the thrown error —
 * the panel shows it unchanged rather than rephrasing a fact about the vehicle.
 *
 * @param {{ id: string }} query
 * @returns {Promise<{
 *   run: import("../src/views.js").ScenarioRunView,
 *   panel: import("../src/views.js").ScenarioPanelView,
 * }>}
 */
export const runScenario = (query) => request("/api/simulator/scenario", post(query));
