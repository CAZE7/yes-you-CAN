/**
 * The adapter routes of the workbench API (AGENTS 4, 29; backlog E33).
 *
 * Why these three live in their own module instead of `server.ts`: the same
 * reason `route-input.ts` exists — `server.ts` sits at its line budget, and the
 * adapter surface is one seam with one vocabulary (catalog → selection →
 * doctor). A route stays a route (ADR 0014): what moved here is the dispatch,
 * not the decisions — validation stays `selectionFromPayload`, the checklist
 * stays `runAdapterDoctor` from `@vdp/adapter-host`, and the only thing this
 * file owns is the HTTP mapping (status codes and wire shapes).
 *
 * The doctor route is the web arm of the CLI doctor (`npm run adapter:doctor`):
 * the same pre-flight checklist in technician order — settings → availability →
 * open/handshake → vehicle side — answered as a *report*, not as an error. A
 * verdict is data (docs/adapter-checkliste.md); the first failing step names
 * the cause and its hints, so the operator reads the panel instead of a
 * timeout three layers down.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { selectionFromPayload } from "@vdp/adapter-host";
import type { DemoBackend } from "./backend.js";
import { HttpError } from "./route-input.js";
import { sendJson } from "./static-assets.js";

/** Reads and parses one JSON request body — owned by the server, injected here. */
type ReadBody = (request: IncomingMessage) => Promise<Record<string, unknown>>;

/**
 * Serve `/api/adapters`, `/api/adapter/select` and `/api/adapter/doctor`.
 *
 * Returns false for paths that are none of them, so the caller's own 404 stays
 * the one place an unknown route is answered.
 */
export async function handleAdapterApi(
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
  method: string,
  backend: DemoBackend,
  readBody: ReadBody,
): Promise<boolean> {
  // Listing probes the host but never opens a bus, so it is safe while a
  // vehicle is connected.
  if (path === "/api/adapters" && method === "GET") {
    sendJson(response, 200, {
      selected: backend.adapterSelection,
      mode: backend.currentMode,
      adapters: await backend.listAdapters(),
    });
    return true;
  }

  if (path === "/api/adapter/select" && method === "POST") {
    const selection = selectionFromPayload(await readBody(request));
    const result = await backend.selectAdapter(selection);
    sendJson(response, 200, {
      adapter: result.description,
      reconnectRequired: result.reconnectRequired,
      connected: backend.state().connected,
    });
    return true;
  }

  if (path === "/api/adapter/doctor" && method === "POST") {
    const body = await readBody(request);
    // Without an id the doctor examines the *current* selection: the panel's
    // "prüfen" button sends what the form shows, an empty body means "this one".
    const selection =
      typeof body?.id === "string" ? selectionFromPayload(body) : backend.adapterSelection;
    // The doctor opens the adapter to prove it — a second opener on the same
    // wire garbles the running session's conversation (an ELM327 serialises
    // commands per adapter, not per opener). Checking the adapter the session
    // is using requires stopping the session first; a *different* adapter is a
    // different wire and stays checkable.
    if (backend.state().connected && selection.id === backend.adapterSelection.id) {
      throw new HttpError(
        409,
        "the doctor would open the adapter the session is using — stop the session before checking it",
      );
    }
    sendJson(response, 200, { doctor: await backend.doctorAdapter(selection) });
    return true;
  }

  return false;
}
