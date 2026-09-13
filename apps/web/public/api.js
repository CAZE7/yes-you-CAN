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
 * @returns {Promise<{ dtcs: import("../src/views.js").DtcView[] }>}
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
