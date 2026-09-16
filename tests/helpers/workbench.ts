/**
 * The one way a test in this directory reaches the workbench: a real server on an
 * ephemeral port, and a fetch that keeps the content type.
 *
 * Three specs of the workbench need it (`server.spec.ts`, `adapters.spec.ts`,
 * `server-paths.spec.ts`), so it lives with the other shared test helpers in `tests/helpers/`
 * and a harness that exists twice drifts twice — one of them will start to assert on a
 * text/plain body as JSON while the other does not. The server is *not* mocked: the
 * point of these tests is that the HTTP layer, the backend and the simulated vehicle
 * agree through a socket, so the socket is part of the fixture.
 */

import { WebServer } from "../../apps/web/src/server.js";
import { waitFor } from "./wait.js";

/** Start a server on an ephemeral port and give back helpers plus a teardown. */
export async function withServer<T>(
  run: (base: string, server: WebServer) => Promise<T>,
): Promise<T> {
  const server = new WebServer({ port: 0, liveIntervalMs: 60 });
  const { port } = await server.listen();
  try {
    return await run(`http://127.0.0.1:${port}`, server);
  } finally {
    await server.close();
  }
}

/**
 * Fetch and read a response the way the browser would.
 *
 * `type` is kept because several routes answer with text or bytes (exports, the chart
 * module), and a test that only knows `body: string` cannot tell those apart.
 */
export async function json(
  base: string,
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: unknown; type: string }> {
  const response = await fetch(`${base}${path}`, init);
  const type = response.headers.get("content-type") ?? "";
  return {
    status: response.status,
    body: type.includes("json") ? await response.json() : await response.text(),
    type,
  };
}

/** POST a JSON body the way `api.js` does, and read the answer. */
export async function post(
  base: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown; type: string }> {
  return json(base, path, {
    method: "POST",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: { "content-type": "application/json" },
  });
}

/** Wait until the recording holds at least `count` samples of `signal`. */
export async function waitForSamples(
  base: string,
  count = 1,
  signal = "engine.rpm",
): Promise<void> {
  await waitFor(
    async () => (await json(base, "/api/history")).body as { samples: Array<{ signal: string }> },
    (body) => body.samples.filter((sample) => sample.signal === signal).length >= count,
  );
}
