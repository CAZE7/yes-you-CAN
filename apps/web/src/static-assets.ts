/**
 * The workbench's own bytes — everything the browser is served *before* a diagnostic
 * answer exists: the panel, its scripts, the chart core, and the header policy all of
 * them travel under.
 *
 * Its own module because it is a different question from the API. `server.ts` answers
 * "what does this vehicle say"; this one answers "what is this program made of", and
 * the two share nothing but the response object. Keeping them apart is also what keeps
 * the route table reviewable: the file that decides a status code should not also carry
 * the MIME table (ADR 0049 — the size budget in `tests/architecture/hygiene.test.ts`
 * asked for the split, and this is the seam that was already there).
 *
 * Security lives here on purpose. Two rules are worth restating where the code is:
 *
 * - **Containment, not prefix.** `resolveContained` compares path segments, so a
 *   sibling directory whose name merely starts with the served directory's name is
 *   still refused. A `startsWith` test would let `/../secrets` through.
 * - **The headers are sent with every response**, static asset, JSON, SSE stream and
 *   download alike — a policy that only covers the HTML page is a policy with a hole
 *   in it.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveContained } from "./paths.js";

/** What the workbench serves, by extension. Everything else is opaque bytes. */
export const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".csv": "text/csv; charset=utf-8",
  ".pdf": "application/pdf",
  ".ico": "image/x-icon",
};

/**
 * Sent with every response — static assets, JSON, SSE and downloads alike.
 * The CSP can be strict because the front end is fully static: external
 * CSS/JS only, no inline handlers, same-origin fetch and EventSource.
 */
export const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cross-origin-resource-policy": "same-origin",
};

// Compiled files live at apps/web/dist/src/, so the public directory is two levels
// up. When the module runs from TypeScript sources (vitest), the layout differs —
// resolve whichever candidate actually contains index.html. Overridable for packaged
// installs.
function resolvePublicDir(): string {
  if (process.env.VDP_PUBLIC_DIR) return process.env.VDP_PUBLIC_DIR;
  const candidates = [
    fileURLToPath(new URL("../../public/", import.meta.url)), // apps/web/dist/src/static-assets.js
    fileURLToPath(new URL("../public/", import.meta.url)), // apps/web/src/static-assets.ts
  ];
  return (
    candidates.find((candidate) => existsSync(join(candidate, "index.html"))) ??
    (candidates[0] as string)
  );
}

/** The panel: `apps/web/public`, or whatever `VDP_PUBLIC_DIR` names. */
export const PUBLIC_DIR = resolvePublicDir();

/**
 * Directory served as `/lib/` — the compiled, unit-tested chart core
 * (`@vdp/charts`). The browser imports the very module the tests run against,
 * so zoom, cursor and statistics rules cannot drift apart between backend and
 * front end (AGENTS 16, 34.8; ADR 0002 keeps it dependency-free).
 *
 * Resolved through the package name so the same code works in the workspace and
 * in an installed dependency.
 */
function resolveChartLibDir(): string {
  try {
    return dirname(createRequire(import.meta.url).resolve("@vdp/charts"));
  } catch {
    return fileURLToPath(new URL("../../packages/charts/dist/src/", import.meta.url));
  }
}

/** The chart core as the browser loads it, or whatever `VDP_LIB_DIR` names. */
export const LIB_DIR = process.env.VDP_LIB_DIR ? process.env.VDP_LIB_DIR : resolveChartLibDir();

/** A JSON answer, with the policy headers and no caching. */
export function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    "content-type": MIME[".json"] ?? "application/json",
    "cache-control": "no-cache",
  });
  response.end(body);
}

/** A download: the bytes, their type, and the filename the browser should suggest. */
export function sendBytes(
  response: ServerResponse,
  filename: string,
  contentType: string,
  bytes: Uint8Array,
): void {
  response.writeHead(200, {
    ...SECURITY_HEADERS,
    "content-type": contentType,
    "content-length": String(bytes.length),
    "content-disposition": `attachment; filename="${filename}"`,
  });
  response.end(bytes);
}

/** A text download — the same thing with the encoding done here. */
export function sendTextFile(
  response: ServerResponse,
  filename: string,
  contentType: string,
  content: string,
): void {
  sendBytes(response, filename, contentType, new TextEncoder().encode(content));
}

/**
 * Serves the compiled chart core as `/lib/<file>` (AGENTS 16).
 *
 * Same rules as the public directory — same-origin, GET only, no traversal —
 * because this is just another static asset that happens to be compiled from
 * a workspace package instead of living in `public/`.
 */
export async function serveLibraryFile(response: ServerResponse, relative: string): Promise<void> {
  if (relative.includes("..")) {
    sendJson(response, 403, { error: "forbidden" });
    return;
  }
  const resolved = resolveContained(LIB_DIR, relative);
  if (resolved === null) {
    sendJson(response, 403, { error: "forbidden" });
    return;
  }
  try {
    const content = await readFile(resolved);
    response.writeHead(200, {
      ...SECURITY_HEADERS,
      "content-type": MIME[extname(resolved)] ?? "text/javascript; charset=utf-8",
      "cache-control": "no-cache",
    });
    response.end(content);
  } catch {
    sendJson(response, 404, { error: `not found: /lib/${relative}` });
  }
}

/** Serve the panel itself. `/` is `index.html`; everything else is a file under it. */
export async function serveStaticFile(response: ServerResponse, path: string): Promise<void> {
  const relative = path === "/" ? "index.html" : path.replace(/^\/+/, "");
  // Reject anything that would escape the public directory. The containment
  // test compares path segments — a plain prefix test would also accept a
  // sibling whose name merely starts with the directory name (SECURITY).
  const resolved = resolveContained(PUBLIC_DIR, relative);
  if (resolved === null) {
    sendJson(response, 403, { error: "forbidden" });
    return;
  }
  try {
    const content = await readFile(resolved);
    response.writeHead(200, {
      ...SECURITY_HEADERS,
      "content-type": MIME[extname(resolved)] ?? "application/octet-stream",
      "cache-control": "no-cache",
    });
    response.end(content);
  } catch {
    sendJson(response, 404, { error: `not found: ${path}` });
  }
}
