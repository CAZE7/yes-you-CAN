/**
 * Rate limiting (ISO 21434 CY-04, ADR 0054).
 *
 * Before this existed: `grep -c "rate.?limit" server.ts` → **0**. A single client
 * could hammer the API or open unlimited SSE streams. The limiter is intentionally
 * simple: in-memory sliding window per IP, no external store, no timers — a bench
 * tool needs a guard that says "slow down" before the event loop is saturated.
 */

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { settle } from "../../../tests/helpers/wait.js";
import { RateLimiter } from "../src/rate-limit.js";
import { WebServer } from "../src/server.js";

describe("RateLimiter — the decision", () => {
  test("allows requests up to the limit in one window", () => {
    const limiter = new RateLimiter({ maxRequests: 3, windowMs: 60_000 });
    assert.equal(limiter.checkApi("1.2.3.4", 0).allowed, true);
    assert.equal(limiter.checkApi("1.2.3.4", 10).allowed, true);
    assert.equal(limiter.checkApi("1.2.3.4", 20).allowed, true);
    const blocked = limiter.checkApi("1.2.3.4", 30);
    assert.equal(blocked.allowed, false);
    assert.ok((blocked.retryAfterMs ?? 0) > 0);
  });

  test("resets after the window", () => {
    const limiter = new RateLimiter({ maxRequests: 2, windowMs: 1000 });
    assert.equal(limiter.checkApi("1.2.3.4", 0).allowed, true);
    assert.equal(limiter.checkApi("1.2.3.4", 10).allowed, true);
    assert.equal(limiter.checkApi("1.2.3.4", 20).allowed, false);
    assert.equal(limiter.checkApi("1.2.3.4", 1001).allowed, true, "new window");
  });

  test("tracks IPs separately", () => {
    const limiter = new RateLimiter({ maxRequests: 1, windowMs: 60_000 });
    assert.equal(limiter.checkApi("1.1.1.1", 0).allowed, true);
    assert.equal(limiter.checkApi("2.2.2.2", 0).allowed, true);
    assert.equal(limiter.checkApi("1.1.1.1", 10).allowed, false);
    assert.equal(limiter.checkApi("2.2.2.2", 10).allowed, false);
  });

  test("clientIp reads remoteAddress, unknown when missing", () => {
    assert.equal(RateLimiter.clientIp({ socket: { remoteAddress: "10.0.0.1" } }), "10.0.0.1");
    assert.equal(RateLimiter.clientIp({}), "unknown");
    assert.equal(RateLimiter.clientIp({ socket: {} }), "unknown");
  });

  test("SSE streams are limited per IP", () => {
    const limiter = new RateLimiter({ maxStreams: 2 });
    assert.equal(limiter.tryOpenStream("1.2.3.4").allowed, true);
    assert.equal(limiter.tryOpenStream("1.2.3.4").allowed, true);
    assert.equal(limiter.tryOpenStream("1.2.3.4").allowed, false);
    limiter.closeStream("1.2.3.4");
    assert.equal(limiter.tryOpenStream("1.2.3.4").allowed, true);
  });

  test("closing a stream that was never opened is safe", () => {
    const limiter = new RateLimiter({ maxStreams: 1 });
    limiter.closeStream("nope");
    assert.equal(limiter.tryOpenStream("nope").allowed, true);
  });

  test("clear resets everything", () => {
    const limiter = new RateLimiter({ maxRequests: 1 });
    assert.equal(limiter.checkApi("1.2.3.4", 0).allowed, true);
    assert.equal(limiter.size, 1);
    limiter.clear();
    assert.equal(limiter.size, 0);
    assert.equal(limiter.checkApi("1.2.3.4", 0).allowed, true);
  });
});

describe("over a real socket — 429 when hammering", () => {
  test("API returns 429 after limit in window", async () => {
    const server = new WebServer({
      port: 0,
      liveIntervalMs: 60,
      rateLimit: { maxRequests: 3, windowMs: 60_000, maxStreams: 10 },
    });
    const { port } = await server.listen();
    try {
      const base = `http://127.0.0.1:${port}`;
      for (let i = 0; i < 3; i++) {
        const res = await fetch(`${base}/api/state`);
        assert.equal(res.status, 200, `request ${i} should be allowed`);
      }
      const blocked = await fetch(`${base}/api/state`);
      assert.equal(blocked.status, 429);
      const body = (await blocked.json()) as { error: string };
      assert.match(body.error, /too many requests/);
      assert.ok(blocked.headers.get("retry-after"));
    } finally {
      await server.close();
    }
  });

  test("SSE stream limit returns 429", async () => {
    const server = new WebServer({
      port: 0,
      liveIntervalMs: 60,
      rateLimit: { maxRequests: 100, windowMs: 60_000, maxStreams: 2 },
    });
    const { port } = await server.listen();
    try {
      const base = `http://127.0.0.1:${port}`;
      // Open 2 streams (test limit)
      const controllers: AbortController[] = [];
      for (let i = 0; i < 2; i++) {
        const controller = new AbortController();
        controllers.push(controller);
        void fetch(`${base}/api/stream`, { signal: controller.signal }).catch(() => {});
        await settle(20, "the server registers the SSE stream in its Set");
      }
      // 3rd should be blocked by stream limit
      const blocked = await fetch(`${base}/api/stream`);
      assert.equal(blocked.status, 429);
      const body = (await blocked.json()) as { error: string };
      assert.match(body.error, /too many streams/);
      for (const c of controllers) c.abort();
      await settle(20, "the server removes closed SSE streams from its Set");
    } finally {
      await server.close();
    }
  });

  test("without hammering, API stays 200", async () => {
    const server = new WebServer({ port: 0, liveIntervalMs: 60 });
    const { port } = await server.listen();
    try {
      const base = `http://127.0.0.1:${port}`;
      const res = await fetch(`${base}/api/state`);
      assert.equal(res.status, 200);
    } finally {
      await server.close();
    }
  });
});
