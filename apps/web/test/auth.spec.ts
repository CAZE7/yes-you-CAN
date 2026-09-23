/**
 * Authentication on the workbench API (ISO 21434 direction; CY-01/CY-02).
 *
 * The measurement that produced this file: **37** routes under `/api/` and
 * `grep -c "authoriz\|bearer\|token" apps/web/src/server.ts` → **0**. Anyone who
 * could reach the port could read the vehicle and trigger a write; the `WritePort`
 * permit decides *when* a write is allowed, not *who* asks.
 *
 * Both levels are pinned here: the decision function (constant-time compare, cookie
 * parsing, the disabled case) and the same decision reached through a real socket —
 * because a `401` that only exists in a unit test is not a protected route.
 */

import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { afterAll, describe, test } from "vitest";
import {
  AUTH_COOKIE,
  cookieValue,
  createAuthenticator,
  generateEphemeralToken,
  secretsEqual,
  validateRequestOrigin,
} from "../src/auth.js";
import { WebServer } from "../src/server.js";

/** The two fields the authenticator reads — the rest of the request is irrelevant. */
function requestWith(headers: Record<string, string>): IncomingMessage {
  return { headers } as IncomingMessage;
}

describe("secretsEqual — the comparison is constant-time by construction", () => {
  test("equal secrets match, unequal ones do not", () => {
    assert.equal(secretsEqual("s3cret", "s3cret"), true);
    assert.equal(secretsEqual("s3cret", "s3cref"), false);
    assert.equal(secretsEqual("s3cret", ""), false);
  });

  test("different lengths are a refusal, not a crash", () => {
    // `timingSafeEqual` throws on unequal buffers; the digests are fixed width, so
    // the length of the *secret* never reaches the comparison.
    assert.equal(secretsEqual("short", "a-much-longer-secret-value"), false);
    assert.equal(secretsEqual("a-much-longer-secret-value", "short"), false);
  });
});

describe("cookieValue — reading one cookie without a parser dependency", () => {
  test("finds the named cookie among others", () => {
    assert.equal(cookieValue("a=1; vdp_session=t0ken; b=2", AUTH_COOKIE), "t0ken");
  });

  test("a missing header or a missing cookie is undefined, not an empty string", () => {
    assert.equal(cookieValue(undefined, AUTH_COOKIE), undefined);
    assert.equal(cookieValue("a=1; b=2", AUTH_COOKIE), undefined);
    assert.equal(cookieValue("malformed; =x", AUTH_COOKIE), undefined);
  });

  test("an encoded value comes back decoded", () => {
    assert.equal(cookieValue("vdp_session=to%2Fken", AUTH_COOKIE), "to/ken");
  });
});

describe("createAuthenticator — the decision", () => {
  test("without a token the API stays open, and says so", () => {
    const auth = createAuthenticator(undefined);
    assert.equal(auth.enabled, false, "the bench case: no network, no credential");
    assert.equal(auth.isAuthorized(requestWith({})), true);
    assert.equal(auth.cookieFor("anything"), undefined, "nothing to exchange without a token");
  });

  test("an empty token is no token", () => {
    assert.equal(createAuthenticator("").enabled, false);
  });

  test("with a token, only the token gets through", () => {
    const auth = createAuthenticator("s3cret");
    assert.equal(auth.enabled, true);
    assert.equal(auth.isAuthorized(requestWith({})), false, "no credential");
    assert.equal(auth.isAuthorized(requestWith({ authorization: "Bearer wrong" })), false);
    assert.equal(
      auth.isAuthorized(requestWith({ authorization: "bearer s3cret" })),
      true,
      "case-insensitive scheme",
    );
    assert.equal(auth.isAuthorized(requestWith({ cookie: "vdp_session=s3cret" })), true);
    assert.equal(auth.isAuthorized(requestWith({ cookie: "vdp_session=wrong" })), false);
    assert.equal(
      auth.isAuthorized(requestWith({ authorization: "Basic s3cret" })),
      false,
      "only bearer",
    );
  });

  test("the token exchange sets an httpOnly, same-site, path-scoped cookie", () => {
    const auth = createAuthenticator("s3cret");
    const cookie = auth.cookieFor("s3cret");
    assert.ok(cookie !== undefined);
    assert.match(cookie, /^vdp_session=s3cret;/);
    assert.match(cookie, /HttpOnly/, "script must not be able to read it back");
    assert.match(cookie, /SameSite=Strict/, "no cross-site ride-along");
    assert.match(cookie, /Path=\//);
    assert.equal(cookie.includes("Max-Age"), false, "the session ends with the browser");
  });

  test("a wrong or absent token in the URL exchanges for nothing", () => {
    const auth = createAuthenticator("s3cret");
    assert.equal(auth.cookieFor("wrong"), undefined);
    assert.equal(auth.cookieFor(null), undefined);
    assert.equal(auth.cookieFor(""), undefined);
  });
});

describe("over a real socket — a route that is only protected in a unit test is not protected", () => {
  const servers: WebServer[] = [];

  async function withToken<T>(run: (base: string) => Promise<T>): Promise<T> {
    const server = new WebServer({ port: 0, liveIntervalMs: 60, token: "s3cret" });
    servers.push(server);
    const { port } = await server.listen();
    return run(`http://127.0.0.1:${port}`);
  }

  afterAll(async () => {
    for (const server of servers) await server.close();
  });

  test("every /api route answers 401 with a sentence, not with data", async () => {
    await withToken(async (base) => {
      const response = await fetch(`${base}/api/state`);
      assert.equal(response.status, 401);
      const body = (await response.json()) as { error: string };
      assert.match(body.error, /not authenticated/);
      assert.match(body.error, /Bearer/, "the refusal says how to authenticate");

      const write = await fetch(`${base}/api/dtc/clear`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(write.status, 401, "the write path is gated too, not only the reads");
    });
  });

  test("the bearer token opens the same route", async () => {
    await withToken(async (base) => {
      const response = await fetch(`${base}/api/state`, {
        headers: { authorization: "Bearer s3cret" },
      });
      assert.equal(response.status, 200);
      const body = (await response.json()) as { connected: boolean };
      assert.equal(typeof body.connected, "boolean", "the answer is the state, not a refusal");
    });
  });

  test("a wrong bearer token is refused", async () => {
    await withToken(async (base) => {
      const response = await fetch(`${base}/api/state`, {
        headers: { authorization: "Bearer s3cref" },
      });
      assert.equal(response.status, 401);
    });
  });

  test("the ?token= exchange sets the cookie and redirects without it in the URL", async () => {
    await withToken(async (base) => {
      const exchange = await fetch(`${base}/?token=s3cret`, { redirect: "manual" });
      assert.equal(exchange.status, 302);
      const setCookie = exchange.headers.getSetCookie();
      assert.equal(setCookie.length, 1);
      assert.match(setCookie[0] ?? "", /^vdp_session=s3cret;/);
      assert.match(setCookie[0] ?? "", /HttpOnly/);
      assert.equal(new URL(exchange.headers.get("location") ?? "", base).pathname, "/");

      // With the cookie, the same route that answered 401 before answers 200.
      const withCookie = await fetch(`${base}/api/state`, {
        headers: { cookie: "vdp_session=s3cret" },
      });
      assert.equal(withCookie.status, 200);
    });
  });

  test("a wrong token in the URL is refused instead of quietly ignored", async () => {
    await withToken(async (base) => {
      const response = await fetch(`${base}/?token=nope`, { redirect: "manual" });
      assert.equal(response.status, 401);
      assert.equal(response.headers.getSetCookie().length, 0, "no cookie is set on a refusal");
    });
  });

  test("without a token configured the server behaves exactly as before", async () => {
    const server = new WebServer({ port: 0, liveIntervalMs: 60 });
    servers.push(server);
    const { port } = await server.listen();
    const response = await fetch(`http://127.0.0.1:${port}/api/state`);
    assert.equal(response.status, 200, "no credential needed when none was configured");
  });

  test("ephemeralToken: true creates a random token and enforces it", async () => {
    const server = new WebServer({ port: 0, liveIntervalMs: 60, ephemeralToken: true });
    servers.push(server);
    const { port } = await server.listen();
    assert.ok(server.ephemeralToken !== undefined);
    assert.match(server.ephemeralToken, /^[0-9a-f]{32}$/);
    assert.equal(server.auth.enabled, true);

    const unauth = await fetch(`http://127.0.0.1:${port}/api/state`);
    assert.equal(unauth.status, 401);

    const authed = await fetch(`http://127.0.0.1:${port}/api/state`, {
      headers: { authorization: `Bearer ${server.ephemeralToken}` },
    });
    assert.equal(authed.status, 200);
  });

  test("mutating request with cross-site Origin is rejected with 403 Forbidden", async () => {
    const server = new WebServer({ port: 0, liveIntervalMs: 60 });
    servers.push(server);
    const { port } = await server.listen();

    const response = await fetch(`http://127.0.0.1:${port}/api/dtc/clear`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://malicious-workshop.example.com",
      },
      body: "{}",
    });
    assert.equal(response.status, 403);
    const body = (await response.json()) as { error: string };
    assert.match(body.error, /forbidden/);
    assert.match(body.error, /origin/i);
  });
});

describe("validateRequestOrigin — CSRF and DNS rebinding protections", () => {
  test("ephemeral token generator returns 32 hex chars", () => {
    const t1 = generateEphemeralToken();
    const t2 = generateEphemeralToken();
    assert.match(t1, /^[0-9a-f]{32}$/);
    assert.notEqual(t1, t2);
  });

  test("GET requests pass regardless of origin header", () => {
    const req = {
      method: "GET",
      headers: { host: "localhost:8080", origin: "http://other.example.com" },
    } as unknown as IncomingMessage;
    assert.equal(validateRequestOrigin(req).ok, true);
  });

  test("POST requests with matching origin pass", () => {
    const req = {
      method: "POST",
      headers: { host: "localhost:8080", origin: "http://localhost:8080" },
    } as unknown as IncomingMessage;
    assert.equal(validateRequestOrigin(req).ok, true);
  });

  test("POST requests with mismatched origin fail", () => {
    const req = {
      method: "POST",
      headers: { host: "localhost:8080", origin: "https://evil.com" },
    } as unknown as IncomingMessage;
    const res = validateRequestOrigin(req);
    assert.equal(res.ok, false);
    assert.match(res.reason ?? "", /cross-origin/);
  });

  test("requests with untrusted Host header fail rebinding check", () => {
    const req = {
      method: "GET",
      headers: { host: "attacker-controlled-dns.com:8080" },
    } as unknown as IncomingMessage;
    const res = validateRequestOrigin(req);
    assert.equal(res.ok, false);
    assert.match(res.reason ?? "", /untrusted Host/);
  });
});
