import assert from "node:assert/strict";
import {
  DefinitionError,
  fromHex,
  toHex,
  UdsNegativeResponseError,
  UdsTimeoutError,
} from "@vdp/shared";
import { test } from "vitest";
import { settle, waitFor } from "../../../../tests/helpers/wait.js";
import {
  DID,
  parseMultiDidResponse,
  parseSingleDidResponse,
  SecurityAccessRefusedError,
  standardSessions,
  UdsClient,
  type UdsLink,
  UdsServer,
  type UdsServerLink,
  type UdsServerOptions,
  xorSeedKeyAlgorithm,
} from "./index.js";

/**
 * In-memory binding between client and server. Stands in for ISO-TP/DoIP so the
 * UDS layer can be tested without any transport (AGENTS 5: transport independence).
 */
class Loopback implements UdsLink {
  readonly serverLink: UdsServerLink;
  private queue: Uint8Array[] = [];
  private waiters: Array<(payload: Uint8Array) => void> = [];

  constructor(private readonly server: { handle(payload: Uint8Array): Promise<void> }) {
    this.serverLink = {
      onMessage: () => () => undefined,
      send: async (payload: Uint8Array) => {
        const waiter = this.waiters.shift();
        if (waiter) waiter(payload);
        else this.queue.push(payload);
      },
    };
  }

  private next(timeoutMs?: number): Promise<Uint8Array | null> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise<Uint8Array | null>((resolve) => {
      const waiter = (payload: Uint8Array): void => {
        if (timer) clearTimeout(timer);
        resolve(payload);
      };
      const timer =
        timeoutMs === undefined
          ? null
          : setTimeout(() => {
              this.waiters = this.waiters.filter((w) => w !== waiter);
              resolve(null);
            }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  async request(payload: Uint8Array): Promise<Uint8Array> {
    const first = this.next();
    // Deliberately not awaited: a real transport hands back the first response as
    // soon as it arrives while the ECU keeps working. Awaiting completion would
    // queue the final response before the client ever sees NRC 0x78, which makes
    // the P2* timeout path untestable.
    void this.server.handle(payload).catch((error: unknown) => {
      throw error;
    });
    const message = await first;
    if (!message) throw new Error("server produced no response");
    return message;
  }

  async sendOnly(payload: Uint8Array): Promise<void> {
    await this.server.handle(payload);
  }

  async receive(timeoutMs?: number): Promise<Uint8Array | null> {
    return this.next(timeoutMs);
  }
}

function createPair(options: Partial<UdsServerOptions> = {}): {
  client: UdsClient;
  server: UdsServer;
  link: Loopback;
} {
  const holder: { server?: UdsServer } = {};
  const link = new Loopback({
    handle: (payload) => {
      if (!holder.server) throw new Error("server not started");
      return holder.server.handle(payload);
    },
  });
  const server = new UdsServer(link.serverLink, { name: "sim-ecu", ...options });
  holder.server = server;
  server.start();
  const client = new UdsClient(link, { name: "sim-ecu", timing: { p2Ms: 200, p2StarMs: 1000 } });
  return { client, server, link };
}

const VIN = "1HGCM82633A004352";

const BASE_DIDS = [
  { did: DID.VEHICLE_IDENTIFIER_NUMBER, value: () => new TextEncoder().encode(VIN) },
  { did: DID.ECU_SERIAL_NUMBER, value: () => fromHex("00 11 22 33 44") },
  { did: 0xf197, value: () => new TextEncoder().encode("2.0 TSI") },
  { did: 0x1234, value: () => fromHex("09 46") },
];

test("DiagnosticSessionControl adopts the ECU reported P2/P2* timing (AGENTS 9)", async () => {
  const { client } = createPair({ dids: BASE_DIDS, timing: { p2Ms: 40, p2StarMs: 3000 } });
  const result = await client.diagnosticSessionControl(0x03);
  assert.equal(result.sessionType, 0x03);
  assert.equal(result.p2Ms, 40);
  assert.equal(result.p2StarMs, 3000);
  assert.equal(client.timing.p2Ms, 40, "client must not keep hardcoded global timing");
  assert.equal(client.activeSessionName, "extendedDiagnosticSession");
});

test("unsupported session is rejected with NRC 0x12", async () => {
  // Standard sessions: programming (0x02) is not among them.
  const { client } = createPair({ dids: BASE_DIDS, sessionDefinitions: standardSessions() });
  await assert.rejects(client.diagnosticSessionControl(0x02), (error: unknown) => {
    assert.ok(error instanceof UdsNegativeResponseError);
    assert.equal(error.nrc, 0x12);
    assert.equal(error.nrcName, "subFunctionNotSupported");
    return true;
  });
});

test("VIN can be read through the standardized DID 0xF190", async () => {
  const { client } = createPair({ dids: BASE_DIDS });
  assert.equal(await client.readVin(), VIN);
});

test("ReadDTCInformation returns decoded DTC records with severity", async () => {
  const { client } = createPair({
    dids: BASE_DIDS,
    dtcs: [
      { code: "P0420", status: 0x2f, snapshot: fromHex("09 46 00 32 01 f4") },
      { code: "P0300", status: 0x24 },
      { code: "U0155", status: 0x50 },
    ],
  });
  const dtcs = await client.readDtcByStatusMask(0xff);
  assert.equal(dtcs.length, 3);
  const catalyst = dtcs.find((d) => d.code === "P0420");
  assert.ok(catalyst);
  assert.equal(catalyst.severity, "critical");
  assert.equal(catalyst.statusBits.testFailed, true);
  assert.equal(dtcs.find((d) => d.code === "U0155")?.severity, "info");

  const supported = await client.readSupportedDtc();
  assert.deepEqual(
    supported.map((d) => d.code),
    ["P0420", "P0300", "U0155"],
  );
});

test("freeze frame snapshot can be read per DTC", async () => {
  const { client } = createPair({
    dids: BASE_DIDS,
    dtcs: [{ code: "P0420", status: 0x2f, snapshot: fromHex("09 46 00 32 01 f4") }],
  });
  const snapshot = await client.readDtcSnapshotRecord("P0420");
  assert.ok(snapshot);
  assert.equal(toHex(snapshot.data), "09 46 00 32 01 F4");
});

test("ClearDiagnosticInformation removes stored codes and resets the status of present faults", async () => {
  // ISO 14229-1 §11.3: clearing resets the DTC status information. A code whose
  // fault is stored but not currently failing leaves the fault memory; a code
  // whose fault is still present comes back with testFailed/testFailedThisOperationCycle
  // set again — which is exactly how a real ECU behaves and why a clear has to be
  // verified by re-reading instead of trusting the positive response.
  const { client } = createPair({
    dids: BASE_DIDS,
    dtcs: [
      { code: "P0420", status: 0x2f },
      { code: "P0171", status: 0x08 },
    ],
  });
  // Clearing is a write: the ECU only offers 0x14 outside the default session
  // (AGENTS 29 — no write happens in the default session).
  await client.diagnosticSessionControl(0x03);
  await client.clearDiagnosticInformation();
  const dtcs = await client.readDtcByStatusMask(0xff);
  assert.deepEqual(
    dtcs.map((dtc) => `${dtc.code}:${dtc.status.toString(16)}`),
    ["P0420:3"],
  );
  const catalyst = dtcs[0];
  assert.ok(catalyst);
  assert.equal(catalyst.statusBits.testFailed, true, "a present fault sets testFailed again");
  assert.equal(catalyst.statusBits.confirmedDtc, false, "the confirmed bit was reset by the clear");
});

test("a clear request without the group of DTC is rejected instead of clearing", async () => {
  const { client } = createPair({ dids: BASE_DIDS, dtcs: [{ code: "P0420", status: 0x08 }] });
  await client.diagnosticSessionControl(0x03);
  await assert.rejects(
    () => client.raw(fromHex("14 00")),
    (error: unknown) => {
      assert.match(String((error as { message?: string }).message), /incorrectMessageLength/);
      return true;
    },
  );
  // An unknown group is out of range. 0xFFFFFF (all) and 0x000000 are defined
  // generically; anything else is manufacturer specific and must not be guessed
  // into a successful clear (AGENTS 20).
  await assert.rejects(
    () => client.raw(fromHex("14 12 34 56")),
    (error: unknown) => {
      assert.match(String((error as { message?: string }).message), /requestOutOfRange/);
      return true;
    },
  );
  assert.equal(
    (await client.readDtcByStatusMask(0xff)).length,
    1,
    "a rejected clear changes nothing",
  );
});

test("NRC 0x78 (ResponsePending) is followed until the final response within P2*", async () => {
  const { client } = createPair({
    dids: BASE_DIDS,
    pendingResponseServices: [0x22],
    pendingResponseDelayMs: 25,
  });
  const vin = await client.readVin();
  assert.equal(vin, VIN);
  assert.equal(client.stats.pendingResponses, 1);
});

test("a missing final response after NRC 0x78 surfaces as a timeout", async () => {
  const { client, server } = createPair({
    dids: BASE_DIDS,
    pendingResponseServices: [0x22],
    pendingResponseDelayMs: 400,
  });
  client.updateTiming({ p2StarMs: 30 });
  server.resetSession();
  await assert.rejects(client.readDid(0x1234), /P2\*/);
  assert.equal(client.stats.timeouts, 1);
});

test("unknown DID produces requestOutOfRange (0x31) with a typed error", async () => {
  const { client } = createPair({ dids: BASE_DIDS });
  await assert.rejects(client.readDid(0xdead), (error: unknown) => {
    assert.ok(error instanceof UdsNegativeResponseError);
    assert.equal(error.nrc, 0x31);
    assert.equal(error.serviceId, 0x22);
    return true;
  });
  assert.equal(client.stats.negativeResponses, 1);
});

test("multi-DID read uses definition lengths in one request, otherwise one request per DID", async () => {
  const { client: withLengths } = createPair({ dids: BASE_DIDS });
  const lengths = new Map<number, number>([
    [DID.ECU_SERIAL_NUMBER, 5],
    [0x1234, 2],
  ]);
  const batched = await withLengths.readDataByIdentifier([DID.ECU_SERIAL_NUMBER, 0x1234], lengths);
  assert.equal(toHex(batched.get(DID.ECU_SERIAL_NUMBER) as Uint8Array), "00 11 22 33 44");
  assert.equal(toHex(batched.get(0x1234) as Uint8Array), "09 46");
  assert.equal(withLengths.stats.requests, 1);

  const { client: withoutLengths } = createPair({ dids: BASE_DIDS });
  const sequential = await withoutLengths.readDataByIdentifier([DID.ECU_SERIAL_NUMBER, 0x1234]);
  assert.equal(sequential.size, 2);
  assert.equal(
    withoutLengths.stats.requests,
    2,
    "without definitions each DID needs its own request",
  );
});

test("multi-DID parsing refuses to guess unknown lengths", () => {
  const response = fromHex("62 12 34 09 46 F1 8C 00 11");
  assert.throws(
    () => parseMultiDidResponse(response, new Map([[0x1234, 2]])),
    (error: unknown) => error instanceof DefinitionError,
  );
  const parsed = parseMultiDidResponse(
    response,
    new Map([
      [0x1234, 2],
      [0xf18c, 2],
    ]),
  );
  assert.equal(parsed.size, 2);
});

test("parseSingleDidResponse validates the echoed DID", () => {
  assert.equal(
    toHex(parseSingleDidResponse(fromHex("62 12 34 09 46"), 0x1234) as Uint8Array),
    "09 46",
  );
  assert.equal(parseSingleDidResponse(fromHex("62 12 34 09 46"), 0x5678), null);
  assert.equal(parseSingleDidResponse(fromHex("62 12"), 0x1234), null);
});

test("security access is refused by default and works with an explicitly registered algorithm", async () => {
  const { client } = createPair({
    dids: BASE_DIDS,
    securityAccess: {
      seed: () => fromHex("11 22 33 44"),
      verifyKey: (_level, key) => toHex(key) === "EE DD CC BB",
    },
  });
  // Security access is a write-side service: in the default session the ECU does
  // not offer it (0x7F), and the client must not work around that.
  await assert.rejects(client.unlockSecurityAccess(0x01), (error: unknown) => {
    assert.ok(error instanceof UdsNegativeResponseError);
    assert.equal(error.nrc, 0x7f, "serviceNotSupportedInActiveSession");
    return true;
  });

  await client.diagnosticSessionControl(0x03);
  // Even where the ECU offers it: without a registered algorithm the client
  // refuses locally instead of guessing a key (AGENTS 29/34.12).
  await assert.rejects(client.unlockSecurityAccess(0x01), SecurityAccessRefusedError);

  client.setSeedKeyAlgorithm(xorSeedKeyAlgorithm(0xff));
  const result = await client.unlockSecurityAccess(0x01);
  assert.equal(result.algorithm, "xor-test");
  assert.match(result.provenance, /simulator only/);
});

test("routine control returns the routine result payload", async () => {
  const { client } = createPair({
    dids: BASE_DIDS,
    routines: [{ id: 0x0202, run: () => fromHex("01 ff") }],
  });
  await client.diagnosticSessionControl(0x03);
  assert.equal(toHex(await client.startRoutine(0x0202)), "01 FF");
  await assert.rejects(client.startRoutine(0x9999), UdsNegativeResponseError);
});

test("WriteDataByIdentifier is rejected in the default session", async () => {
  const { client } = createPair({
    dids: [{ did: 0x2000, value: () => fromHex("00"), writable: true }],
  });
  await assert.rejects(client.writeDataByIdentifier(0x2000, fromHex("01")), (error: unknown) => {
    assert.ok(error instanceof UdsNegativeResponseError);
    assert.equal(error.nrc, 0x7f, "serviceNotSupportedInActiveSession");
    return true;
  });
  await client.diagnosticSessionControl(0x03);
  await client.writeDataByIdentifier(0x2000, fromHex("01"));
  const readBack = await client.readDid(0x2000);
  assert.equal(toHex(readBack as Uint8Array), "01");
});

test("TesterPresent scheduler keeps the session alive and can be stopped", async () => {
  const { client } = createPair({ dids: BASE_DIDS });
  const before = client.stats.requests;
  client.startTesterPresent(5);
  await waitFor(
    () => client.stats.requests,
    (count) => count > before,
    {
      message: "a scheduled TesterPresent",
    },
  );
  client.stopTesterPresent();
  const during = client.stats.requests;
  assert.ok(during > before, "at least one TesterPresent must have been sent");
  await settle(20, "quiet period: after stop no further TesterPresent may be scheduled");
  assert.equal(client.stats.requests, during, "no further requests after stop");
});

test("suppressed positive responses send without waiting", async () => {
  const { client } = createPair({ dids: BASE_DIDS });
  await client.testerPresent(true);
  assert.equal(client.stats.responses, 0);
  await client.testerPresent(false);
  assert.equal(client.stats.responses, 1);
});

test("unknown services are answered with serviceNotSupported", async () => {
  const { client } = createPair({ dids: BASE_DIDS });
  await assert.rejects(client.raw(fromHex("85 01")), (error: unknown) => {
    assert.ok(error instanceof UdsNegativeResponseError);
    assert.equal(error.nrc, 0x11);
    return true;
  });
});

/* ----------------------------------------------------------------------- *
 *  NRC 0x78 stress (AGENTS 31, ISO 14229-1 §9.3.2.2)
 *
 *  The client's pending-response loop is small, but it is the place where a
 *  tester decides whether the ECU is alive or not, and the place where a
 *  regression slips through if the loop forgets to count. The tests below
 *  drive the loop through a scripted link so they are deterministic and
 *  independent of real timers.
 * ----------------------------------------------------------------------- */

/** A scripted `UdsLink`: replies are queued up front, in arrival order. */
class ScriptedLink implements UdsLink {
  private readonly replies: Uint8Array[] = [];
  /** Every byte the client put on the wire, in order — used to count requests. */
  readonly sentRequests: Uint8Array[] = [];
  /** Every `receive()` call that returned a queued reply, in order. */
  readonly receives: Uint8Array[] = [];
  enqueue(...payloads: readonly Uint8Array[]): void {
    for (const payload of payloads) this.replies.push(Uint8Array.from(payload));
  }
  async request(payload: Uint8Array): Promise<Uint8Array> {
    this.sentRequests.push(payload);
    const next = this.replies.shift();
    if (!next) throw new Error(`scripted link: no reply queued for ${toHex(payload)}`);
    return next;
  }
  async sendOnly(): Promise<void> {
    // The pending loop never calls `sendOnly`; if it ever does, that is a bug
    // worth a loud failure rather than a silent no-op.
    throw new Error(
      "scripted link: sendOnly was called — the pending loop must not re-send the request",
    );
  }
  async receive(): Promise<Uint8Array | null> {
    const next = this.replies.shift();
    if (!next) return null;
    this.receives.push(next);
    return next;
  }
}

function scripted(pending: number, ok: Uint8Array): ScriptedLink {
  const link = new ScriptedLink();
  const busy = new Uint8Array([0x7f, 0x22, 0x78]);
  for (let i = 0; i < pending; i += 1) link.enqueue(busy);
  link.enqueue(ok);
  return link;
}

test("NRC 0x78: ten consecutive pending replies are followed, the final answer is delivered", async () => {
  // ISO 14229-1 §9.3.2.2: the client keeps asking within P2* until the final
  // response or `maxPendingResponses` iterations, whichever comes first. The
  // default cap is 10; a tester that holds a request in pending exactly that
  // long gets a successful final answer.
  const link = scripted(10, new Uint8Array([0x62, 0xf1, 0x90, ...new TextEncoder().encode(VIN)]));
  const client = new UdsClient(link, { name: "stress-ecu", timing: { p2Ms: 50, p2StarMs: 1000 } });
  const vin = await client.readVin();
  assert.equal(vin, VIN);
  assert.deepEqual(client.stats, {
    requests: 1,
    responses: 11,
    negativeResponses: 0,
    pendingResponses: 10,
    timeouts: 0,
  });
  // One request on the wire, ten pending receives, one final receive — the loop
  // must not have re-sent the request at any point.
  assert.equal(link.sentRequests.length, 1);
  assert.equal(link.receives.length, 10);
});

test("NRC 0x78: the eleventh pending reply surfaces as UdsTimeoutError and counts as a timeout", async () => {
  // The eleventh pending reply is the one the client refuses to extend: the
  // loop processes it, increments the counter to 10 (= `maxPendingResponses`),
  // and throws before asking for the twelfth. So the script queues 11 pendings
  // — the eleventh is the one that trips the limit.
  const link = new ScriptedLink();
  for (let i = 0; i < 11; i += 1) link.enqueue(new Uint8Array([0x7f, 0x22, 0x78]));
  const client = new UdsClient(link, { name: "stress-ecu", timing: { p2Ms: 50, p2StarMs: 1000 } });
  await assert.rejects(client.readDid(0xf190), (error: unknown) => {
    assert.ok(error instanceof UdsTimeoutError, `expected UdsTimeoutError, got ${error}`);
    return /beyond 10 iterations/.test((error as Error).message);
  });
  assert.deepEqual(client.stats, {
    requests: 1,
    responses: 11,
    negativeResponses: 0,
    pendingResponses: 10,
    timeouts: 1,
  });
});

test("NRC 0x78: a single pending reply followed by a negative response ends the loop cleanly", async () => {
  // The pending loop must not be exited by a non-pending negative response:
  // one NRC 0x78 then NRC 0x31 (requestOutOfRange) is two messages, the second
  // one is the final answer — wrong, but final. The client surfaces it as a
  // `UdsNegativeResponseError`, not a timeout.
  const link = new ScriptedLink();
  link.enqueue(new Uint8Array([0x7f, 0x22, 0x78]));
  link.enqueue(new Uint8Array([0x7f, 0x22, 0x31]));
  const client = new UdsClient(link, { name: "stress-ecu", timing: { p2Ms: 50, p2StarMs: 1000 } });
  await assert.rejects(client.readDid(0xf190), (error: unknown) => {
    assert.ok(error instanceof UdsNegativeResponseError);
    assert.equal((error as UdsNegativeResponseError).nrc, 0x31);
    return true;
  });
  assert.deepEqual(client.stats, {
    requests: 1,
    responses: 2,
    negativeResponses: 1,
    pendingResponses: 1,
    timeouts: 0,
  });
});

test("NRC 0x78: counters are honest across five diagnoses with ten pendings each", async () => {
  // A stress that exercises both the inner loop (every iteration counts a
  // pending and a response) and the outer one (every diagnosis counts a
  // request and a final answer). A counter that forgets to add on either side
  // shows up immediately.
  const link = new ScriptedLink();
  const busy = new Uint8Array([0x7f, 0x22, 0x78]);
  const ok = new Uint8Array([0x62, 0xf1, 0x90, 0x41, 0x42, 0x43]);
  for (let i = 0; i < 5; i += 1) {
    for (let j = 0; j < 10; j += 1) link.enqueue(busy);
    link.enqueue(ok);
  }
  const client = new UdsClient(link, { name: "stress-ecu", timing: { p2Ms: 50, p2StarMs: 1000 } });
  for (let i = 0; i < 5; i += 1) {
    const data = await client.readDid(0xf190);
    assert.deepEqual([...(data ?? [])], [0x41, 0x42, 0x43]);
  }
  assert.deepEqual(client.stats, {
    requests: 5,
    responses: 55,
    negativeResponses: 0,
    pendingResponses: 50,
    timeouts: 0,
  });
  assert.equal(link.sentRequests.length, 5);
  assert.equal(link.receives.length, 50);
});
