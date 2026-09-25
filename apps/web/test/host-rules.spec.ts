/**
 * Host rules (CY-01/CY-02): the `?token=` exchange is a document flow, the
 * trusted hosts are an explicit list, and the sandbox preview host is derived
 * from the environment — never a wildcard on the platform's domain.
 */

import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import { isDocumentPath, sandboxPreviewHost, trustedHosts } from "../src/host-rules.js";

describe("isDocumentPath — the token exchange is a document flow", () => {
  test("the panel itself and html pages qualify", () => {
    assert.equal(isDocumentPath("/"), true);
    assert.equal(isDocumentPath("/index.html"), true);
    assert.equal(isDocumentPath("/views/report.html"), true);
  });

  test("api routes, assets and /lib do not", () => {
    assert.equal(isDocumentPath("/api/state"), false);
    assert.equal(isDocumentPath("/api/dtc/clear"), false);
    assert.equal(isDocumentPath("/app.js"), false);
    assert.equal(isDocumentPath("/styles.css"), false);
    assert.equal(isDocumentPath("/lib/chart-core.js"), false);
    assert.equal(isDocumentPath("/favicon.ico"), false);
  });

  test("a token-bearing path that is not a document stays out of the exchange", () => {
    // The query string is not part of the path; the decision is on the path.
    assert.equal(isDocumentPath("/api/state"), false, "…even with ?token=, the API is no document");
  });
});

describe("sandboxPreviewHost — derived from the environment, not wildcarded", () => {
  const previous = process.env.E2B_SANDBOX_ID;

  afterEach(() => {
    if (previous === undefined) delete process.env.E2B_SANDBOX_ID;
    else process.env.E2B_SANDBOX_ID = previous;
  });

  test("outside the sandbox there is no preview host", () => {
    delete process.env.E2B_SANDBOX_ID;
    assert.equal(sandboxPreviewHost(3000), undefined);
  });

  test("inside the sandbox the host carries the bound port and the sandbox id", () => {
    process.env.E2B_SANDBOX_ID = "abc123";
    assert.equal(sandboxPreviewHost(3000), "3000-abc123.e2b.app");
  });
});

describe("trustedHosts — an explicit list, never a wildcard bind", () => {
  test("a named bind host is trusted, a wildcard bind is not", () => {
    assert.deepEqual(trustedHosts("workshop.local"), ["workshop.local"]);
    assert.deepEqual(trustedHosts("0.0.0.0"), [], "0.0.0.0 is a bind address, not a host to trust");
    assert.deepEqual(trustedHosts("::"), []);
  });

  test("no bind host means no entry", () => {
    assert.deepEqual(trustedHosts(undefined), []);
  });

  test("the preview host is appended when known", () => {
    assert.deepEqual(trustedHosts(undefined, "8080-abc123.e2b.app"), ["8080-abc123.e2b.app"]);
    assert.deepEqual(trustedHosts("workshop.local", "8080-abc123.e2b.app"), [
      "workshop.local",
      "8080-abc123.e2b.app",
    ]);
  });
});
