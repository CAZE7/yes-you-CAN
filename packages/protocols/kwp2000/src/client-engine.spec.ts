/**
 * Kwp2000Client edge cases beyond the service happy paths.
 *
 * Complements kwp2000.spec.ts: degenerate responses, ASCII sanitisation,
 * keep-alive error paths (fake timers only — no real waiting).
 */

import assert from "node:assert/strict";
import type { UdsLink } from "@vdp/protocols-uds";
import { UdsNegativeResponseError, createLogger, fromHex } from "@vdp/shared";
import { describe, test, vi } from "vitest";
import { KWP_LOCAL_ID, KWP_SID, Kwp2000Client } from "./index.js";

const logger = createLogger("kwp-test", { level: "ERROR" });

interface ScriptedLink extends UdsLink {
  requests: Uint8Array[];
}

function createLink(
  script: (payload: Uint8Array) => Uint8Array,
  failAfter = Number.POSITIVE_INFINITY,
): ScriptedLink {
  const requests: Uint8Array[] = [];
  return {
    requests,
    async request(payload) {
      requests.push(payload);
      if (requests.length > failAfter) throw new Error("link down");
      return script(payload);
    },
    async sendOnly() {
      requests.push(new Uint8Array(0));
    },
    async receive() {
      return null;
    },
  };
}

describe("request engine", () => {
  test("an empty response is a protocol error, never a silent accept", async () => {
    const link = createLink(() => new Uint8Array(0));
    const client = new Kwp2000Client(link, { logger });
    await assert.rejects(client.testerPresent(), /unexpected KWP2000 response/);
  });

  test("a custom timeout overrides the P3 default", async () => {
    const link = createLink(() => fromHex("7F 3E 78"));
    const client = new Kwp2000Client(link, { logger });
    await assert.rejects(
      client.request(KWP_SID.TESTER_PRESENT, [0x00], 1234),
      UdsNegativeResponseError,
    );
  });

  test("stats separate requests, responses and negative responses", async () => {
    const link = createLink(
      (payload) => new Uint8Array([(payload[0] ?? 0) + 0x40, payload[1] ?? 0]),
    );
    const client = new Kwp2000Client(link, { logger });
    await client.testerPresent();
    await client.stopDiagnosticSession();
    assert.deepEqual(client.stats, { requests: 2, responses: 2, negativeResponses: 0 });
  });

  test("the client name falls back to the generic label", () => {
    assert.equal(
      new Kwp2000Client(
        createLink(() => new Uint8Array(0)),
        { logger },
      ).name,
      "kwp2000-ecu",
    );
  });
});

describe("identification reads", () => {
  test("ASCII values are sanitised: control bytes and non-ASCII are dropped, NUL terminates", async () => {
    const link = createLink(() => fromHex("61 86 20 57 21 56 41 47 00 58 58"));
    const client = new Kwp2000Client(link, { logger });
    const code = await client.readEcuIdentificationCode();
    assert.equal(code, "W!VAG", "0x20 kept, 0x21 kept, 0x00 terminates before the XX padding");
  });

  test("whitespace-only values collapse to null", async () => {
    const link = createLink(() => fromHex("61 90 20 20"));
    const client = new Kwp2000Client(link, { logger });
    assert.equal(await client.readVin(), null);
  });

  test("readVin maps an unavailable identifier to null", async () => {
    const link = createLink(() => fromHex("7F 21 31"));
    const client = new Kwp2000Client(link, { logger });
    assert.equal(await client.readVin(), null);
  });

  test('subFunctionNotSupported is treated as "not available" (older ECUs)', async () => {
    const link = createLink(() => fromHex("7F 21 12"));
    const client = new Kwp2000Client(link, { logger });
    assert.equal(await client.readLocalIdentifier(KWP_LOCAL_ID.DIAGNOSTIC_LEVEL), null);
    assert.equal(client.stats.negativeResponses, 1);
  });

  test("success returns the payload without the identifier echo", async () => {
    const link = createLink(() => fromHex("61 87 05"));
    const client = new Kwp2000Client(link, { logger });
    assert.deepEqual(
      Array.from((await client.readLocalIdentifier(KWP_LOCAL_ID.DIAGNOSTIC_LEVEL)) ?? []),
      [0x05],
    );
  });

  test("session start echoes the accepted session type; short responses fall back", async () => {
    const echo = createLink(() => fromHex("50 89"));
    assert.equal(
      await new Kwp2000Client(echo, { logger }).startDiagnosticSession(),
      0x89,
      "default session type 0x89",
    );
    const short = createLink(() => fromHex("50"));
    assert.equal(
      await new Kwp2000Client(short, { logger }).startDiagnosticSession(0x85),
      0x85,
      "missing echo falls back",
    );
  });
});

describe("keep-alive error handling", () => {
  test("a dying link is logged per tick but never crashes the timer", async () => {
    vi.useFakeTimers();
    try {
      const link = createLink(() => new Uint8Array(0), 0);
      const client = new Kwp2000Client(link, { logger });
      client.startTesterPresent(10);
      await vi.advanceTimersByTimeAsync(35);
      client.stopTesterPresent();
      assert.ok(link.requests.length >= 2, "ticks happened despite the link failing");
      const after = link.requests.length;
      await vi.advanceTimersByTimeAsync(100);
      assert.equal(link.requests.length, after, "stopped means stopped");
    } finally {
      vi.useRealTimers();
    }
  });
});
