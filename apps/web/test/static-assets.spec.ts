/**
 * What the workbench serves before it says anything about a car.
 *
 * These branches are the security edge of the panel, and until the static-asset code
 * had a module of its own they were reachable only through a real HTTP request —
 * which is why they were never reached: a browser or a `fetch` normalises `..` away
 * and strips a NUL byte long before the path arrives here. Called directly, the
 * refusal is a one-line assertion (ADR 0049).
 *
 * The rule under test is the one `paths.ts` states: containment is compared in path
 * *segments*, and anything that cannot be resolved inside the root is refused with a
 * status and a sentence rather than served or thrown.
 */

import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import { test } from "vitest";
import { PUBLIC_DIR, serveLibraryFile, serveStaticFile } from "../src/static-assets.js";

/** What a response recorder keeps — the three things these functions touch. */
interface Recorded {
  status: number;
  headers: Record<string, string | number>;
  body: string;
}

/**
 * A `ServerResponse` that records instead of sending.
 *
 * Only `writeHead` and `end` are used by the code under test; the cast is in a test,
 * and standing up a real socket to assert a 403 would measure the socket.
 */
function stubResponse(): { response: ServerResponse; recorded: Recorded } {
  const recorded: Recorded = { status: 0, headers: {}, body: "" };
  const response = {
    writeHead(status: number, headers: Record<string, string | number>) {
      recorded.status = status;
      recorded.headers = headers;
      return response;
    },
    end(chunk?: unknown) {
      recorded.body =
        typeof chunk === "string" ? chunk : Buffer.from(String(chunk ?? "")).toString("utf8");
      return response;
    },
  };
  return { response: response as unknown as ServerResponse, recorded };
}

test("the panel itself is served, with the policy headers attached", async () => {
  const { response, recorded } = stubResponse();
  await serveStaticFile(response, "/");
  assert.equal(recorded.status, 200);
  assert.equal(recorded.headers["content-type"], "text/html; charset=utf-8");
  assert.equal(recorded.headers["x-frame-options"], "DENY");
  assert.match(recorded.body, /id="dtc-summary"/, "the served document is the real panel");
});

test("a file the MIME table does not know is still served under a declared type", async () => {
  // `.d.ts` is not in the table — the chart core ships its declarations next to the
  // code — so the fallback decides what the browser is told, and it must be a type
  // and not `undefined`.
  const { response, recorded } = stubResponse();
  await serveLibraryFile(response, "index.d.ts");
  assert.equal(recorded.status, 200);
  assert.equal(recorded.headers["content-type"], "text/javascript; charset=utf-8");
});

test("a path that cannot be resolved inside the root is refused, not served", async () => {
  const cases: Array<[string, string]> = [
    ["", "an empty path is not the root"],
    ["/a\0b", "a NUL byte truncates paths in the syscalls below"],
  ];
  for (const [path, why] of cases) {
    const { response, recorded } = stubResponse();
    await serveStaticFile(response, path);
    assert.equal(recorded.status, 403, `${path || "(empty)"} — ${why}`);
    assert.match(recorded.body, /forbidden/);
  }
});

test("a missing file is a 404 with the path in it, not a stack trace", async () => {
  const { response, recorded } = stubResponse();
  await serveStaticFile(response, "/no-such-panel.html");
  assert.equal(recorded.status, 404);
  assert.match(recorded.body, /no-such-panel\.html/);
});

test("the chart core is served from /lib/ — the module the tests run against", async () => {
  const { response, recorded } = stubResponse();
  await serveLibraryFile(response, "index.js");
  assert.equal(recorded.status, 200, "the compiled chart core is reachable");
  assert.equal(recorded.headers["content-type"], "text/javascript; charset=utf-8");
});

test("the chart core refuses the same escapes the panel does", async () => {
  const cases: Array<[string, string]> = [
    ["../package.json", "one hop up leaves the library directory"],
    ["", "an empty path is not the library root"],
  ];
  for (const [relative, why] of cases) {
    const { response, recorded } = stubResponse();
    await serveLibraryFile(response, relative);
    assert.equal(recorded.status, 403, `${relative || "(empty)"} — ${why}`);
    assert.match(recorded.body, /forbidden/);
  }
});

test("the public directory really contains the panel it serves", async () => {
  // The resolver picks whichever candidate holds index.html; this is the check that
  // the pick was the right one, made on the same constant the routes serve from.
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const html = await readFile(join(PUBLIC_DIR, "index.html"), "utf8");
  assert.match(html, /id="dtc-unread"/, "the served panel is the one with the DTC gap list");
});
