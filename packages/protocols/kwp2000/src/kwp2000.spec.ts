import assert from "node:assert/strict";
import type { UdsLink } from "@vdp/protocols-uds";
import { UdsNegativeResponseError, fromHex, toHex } from "@vdp/shared";
import { test } from "vitest";
import { KWP_LOCAL_ID, KWP_SID, Kwp2000Client, kwpServiceName } from "./index.js";

/** Scripted link: answers with canned payloads or negative responses. */
function createLink(script: (payload: Uint8Array) => Uint8Array): {
  link: UdsLink;
  requests: Uint8Array[];
} {
  const requests: Uint8Array[] = [];
  const link: UdsLink = {
    async request(payload) {
      requests.push(payload);
      return script(payload);
    },
    async sendOnly(payload) {
      requests.push(payload);
    },
    async receive() {
      return null;
    },
  };
  return { link, requests };
}

test("service names are resolvable for logging", () => {
  assert.equal(
    kwpServiceName(KWP_SID.READ_DATA_BY_LOCAL_IDENTIFIER),
    "READ_DATA_BY_LOCAL_IDENTIFIER",
  );
  assert.equal(kwpServiceName(0x99), "KWP_SERVICE_0x99");
});

test("identification values are read by local identifier", async () => {
  const { link, requests } = createLink(() =>
    fromHex("61 90 31 48 47 43 4D 38 32 36 33 33 41 30 30 34 33 35 32"),
  );
  const client = new Kwp2000Client(link, { name: "kwp-ecu" });
  const vin = await client.readVin();
  assert.equal(vin, "1HGCM82633A004352");
  assert.equal(requests[0]?.[0], KWP_SID.READ_DATA_BY_LOCAL_IDENTIFIER);
  assert.equal(requests[0]?.[1], KWP_LOCAL_ID.VEHICLE_IDENTIFICATION_NUMBER);
});

test("an unavailable local identifier returns null instead of throwing", async () => {
  const { link } = createLink(() => fromHex("7F 21 31"));
  const client = new Kwp2000Client(link);
  assert.equal(await client.readLocalIdentifier(KWP_LOCAL_ID.IMMOBILIZER_CODE), null);
});

test("unexpected negative responses surface as typed errors", async () => {
  const { link } = createLink(() => fromHex("7F 21 33"));
  const client = new Kwp2000Client(link);
  await assert.rejects(client.readEcuIdentificationCode(), (error: unknown) => {
    assert.ok(error instanceof UdsNegativeResponseError);
    assert.equal(error.nrc, 0x33);
    assert.equal(error.nrcName, "securityAccessDenied");
    return true;
  });
  assert.equal(client.stats.negativeResponses, 1);
});

test("mismatched positive response service ids are rejected", async () => {
  const { link } = createLink(() => fromHex("62 90 01"));
  const client = new Kwp2000Client(link);
  await assert.rejects(client.readVin(), /unexpected KWP2000 response/);
});

test("fault codes are decoded with their KWP2000 status bits", async () => {
  const { link } = createLink(() => fromHex("58 01 12 34 0D 56 78 01"));
  const client = new Kwp2000Client(link);
  const faults = await client.readFaultCodes();
  assert.equal(faults.length, 2);
  assert.equal(faults[0]?.raw, "1234");
  assert.equal(faults[0]?.status, 0x0d);
  assert.equal(faults[0]?.confirmed, true);
  assert.equal(faults[0]?.pending, true);
  assert.equal(faults[0]?.testFailed, true);
  assert.equal(faults[1]?.raw, "5678");
  assert.equal(faults[1]?.testFailed, true);
  assert.equal(faults[1]?.confirmed, false);
});

test("session start and fault clearing use the KWP2000 services", async () => {
  const { link, requests } = createLink(
    (payload) => new Uint8Array([(payload[0] ?? 0) + 0x40, payload[1] ?? 0]),
  );
  const client = new Kwp2000Client(link);
  assert.equal(await client.startDiagnosticSession(0x89), 0x89);
  await client.clearFaultCodes();
  assert.equal(requests[0]?.[0], KWP_SID.START_DIAGNOSTIC_SESSION);
  assert.equal(requests[1]?.[0], KWP_SID.CLEAR_DIAGNOSTIC_INFORMATION);
});

test("tester present keeps the session alive and can be stopped", async () => {
  const { link, requests } = createLink((payload) => new Uint8Array([(payload[0] ?? 0) + 0x40]));
  const client = new Kwp2000Client(link);
  const { vi } = await import("vitest");
  vi.useFakeTimers();
  try {
    client.startTesterPresent(5);
    await vi.advanceTimersByTimeAsync(20);
    client.stopTesterPresent();
    assert.ok(requests.length >= 2, "keep-alive ticks fired");
    const after = requests.length;
    await vi.advanceTimersByTimeAsync(50);
    assert.equal(requests.length, after, "no ticks after stop");
  } finally {
    vi.useRealTimers();
  }
  void toHex;
});
