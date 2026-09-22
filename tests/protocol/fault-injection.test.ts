/**
 * Fault injection at the transport seam (master backlog P0 #12; AGENTS 9, 29).
 *
 * The healthy side is a real `UdsServer`; only the wire lies. That distinction is the
 * whole point: a client that passes against a scripted answer proves nothing about a
 * bus that drops frames, answers late, or answers for the wrong service.
 *
 * What each case pins is the **client's answer** to the fault — the error type, what
 * it counted in `stats`, and what it did *not* do (no silent success, no retry storm,
 * no answer applied to the next transaction). A fault that ends in a positive response
 * is a bug; a fault that ends in silence is a bug too.
 */

import assert from "node:assert/strict";
import { NRC, SID, UdsClient, UdsServer, type UdsTiming } from "@vdp/protocols-uds";
import { createLogger, IsoTpError, ProtocolError, UdsNegativeResponseError } from "@vdp/shared";
import { type FaultStep, FaultyLink } from "@vdp/simulators";
import { afterAll, test } from "vitest";
import { waitFor } from "../helpers/wait.js";

const logger = createLogger("fault-injection", { level: "ERROR" });
/** A wait that never waits: every timeout case runs instantly (AGENTS 34.7). */
const instant = async () => Promise.resolve();
// P2 and P2* are one millisecond each and the sleep is injected, so no case here ever
// waits for real bus timing; S3 is irrelevant to these faults but part of the type.
const TIMING: UdsTiming = { p2Ms: 1, p2StarMs: 1, s3Ms: 1_000 };

/** One DTC, so a positive answer has a body a truncation can cut. */
const DTC = { code: "P0420", status: 0x2f, snapshot: undefined };

let server: UdsServer | undefined;

function wire(faults: readonly FaultStep[], serverOptions: { pending?: boolean } = {}) {
  const link = new FaultyLink({ faults, sleep: instant });
  server?.stop();
  server = new UdsServer(link, {
    name: "fault-ecu",
    logger,
    dtcs: [DTC] as never,
    ...(serverOptions.pending === true
      ? { pendingResponseServices: [SID.READ_DTC_INFORMATION], pendingResponseDelayMs: 0 }
      : {}),
  });
  server.start();
  const client = new UdsClient(link, {
    name: "fault-ecu",
    timing: TIMING,
    logger,
    sleep: () => Promise.resolve(),
  });
  return { link, client };
}

afterAll(() => server?.stop());

test("silence on the wire is a timeout, counted, and nothing else", async () => {
  const { link, client } = wire([{ at: 0, fault: { kind: "never-answer" } }]);
  await assert.rejects(() => client.readDtcByStatusMask(0xff), /no response within/);
  assert.equal(client.stats.timeouts, 1);
  assert.equal(client.stats.responses, 0, "a swallowed answer is not an answer");
  assert.equal(link.requests.length, 1, "the client does not retry a timeout on its own");
  assert.deepEqual(
    link.wire.filter((entry) => entry.dir === "ecu→client").map((entry) => entry.outcome),
    ["swallowed"],
  );
});

test("a request that never reaches the ECU leaves the ECU silent, not surprised", async () => {
  const { link, client } = wire([{ at: 0, fault: { kind: "no-forward" } }]);
  await assert.rejects(() => client.readDtcByStatusMask(0xff), /no response within/);
  assert.equal(server?.stats.requests, 0, "the ECU never saw the request");
  assert.equal(link.wire[0]?.outcome, "not-forwarded");
});

test("a reply for another service is refused as a protocol error, not parsed", async () => {
  const { client } = wire([{ at: 0, fault: { kind: "wrong-sid", sid: 0x62 } }]);
  await assert.rejects(
    () => client.readDtcByStatusMask(0xff),
    (error: unknown) =>
      error instanceof ProtocolError &&
      /unexpected UDS response for SID 0x19/.test(String(error.message)),
  );
  assert.equal(client.stats.responses, 1, "the frame was received — it just is not an answer");
});

test("a negative response keeps its NRC and its name", async () => {
  const { client } = wire([{ at: 0, fault: { kind: "negative", nrc: NRC.SERVICE_NOT_SUPPORTED } }]);
  const error = await client.readDtcByStatusMask(0xff).then(
    () => undefined,
    (caught: unknown) => caught,
  );
  assert.ok(error instanceof UdsNegativeResponseError);
  assert.equal(error.nrc, NRC.SERVICE_NOT_SUPPORTED);
  assert.equal(error.serviceId, SID.READ_DTC_INFORMATION);
  assert.equal(client.stats.negativeResponses, 1);
});

test("a busy ECU is asked again exactly once, then the answer counts", async () => {
  const { link, client } = wire([
    { at: 0, fault: { kind: "negative", nrc: NRC.BUSY_REPEAT_REQUEST } },
  ]);
  const records = await client.readDtcByStatusMask(0xff);
  assert.equal(records.length, 1, "the retry reached the healthy ECU");
  assert.equal(link.requests.length, 2, "one retry, not a loop");
  assert.equal(client.stats.negativeResponses, 1);
});

test("a truncated answer is a broken answer, never an empty fault memory", async () => {
  const { client } = wire([{ at: 0, fault: { kind: "truncated", keep: 1 } }]);
  await assert.rejects(
    () => client.readDtcByStatusMask(0xff),
    (error: unknown) =>
      error instanceof ProtocolError && /malformed DTC list: 1 byte/.test(String(error.message)),
  );
});

test("a partial record is refused as well — half a DTC is not a code", async () => {
  const { client } = wire([{ at: 0, fault: { kind: "truncated", keep: 5 } }]);
  await assert.rejects(() => client.readDtcByStatusMask(0xff), /malformed DTC list: 5 byte\(s\)/);
});

test("garbage behind a correct response SID is reported, not decoded", async () => {
  const { client } = wire([
    { at: 0, fault: { kind: "garbage", body: [0x02, 0xff, 0xaa, 0xbb, 0xcc] } },
  ]);
  // 0x49 + 0x02 + mask + three bytes is not a 4-byte record — the parse guard is what
  // stands between a noisy bus and a "verified" fault code.
  await assert.rejects(() => client.readDtcByStatusMask(0xff), /malformed DTC list/);
});

test("an ECU that pends and then goes quiet times out on P2*", async () => {
  const { link, client } = wire([{ at: 0, fault: { kind: "swallow-final" } }], { pending: true });
  await assert.rejects(() => client.readDtcByStatusMask(0xff), /no final response after NRC 0x78/);
  assert.equal(client.stats.pendingResponses, 1, "the pending itself was honoured");
  assert.equal(client.stats.timeouts, 1);
  // The ECU's delayed final frame is a macrotask: wait for it to show up on the wire
  // log instead of sleeping a fixed amount (AGENTS 34.7 — and the hygiene guard
  // refuses a fixed wait here for exactly that reason).
  await waitFor(() => link.wire.some((entry) => entry.fault === "swallow-final"));
  assert.ok(
    link.wire.some((entry) => entry.fault === "swallow-final" && entry.outcome === "swallowed"),
    "the final answer is on the log as swallowed — it existed and never arrived",
  );
});

test("an ECU that pends forever stops at the client's pending limit, not at random", async () => {
  const { client } = wire([{ at: 0, fault: { kind: "pending-forever" } }]);
  await assert.rejects(
    () => client.readDtcByStatusMask(0xff),
    /ResponsePending beyond 10 iterations/,
  );
  assert.equal(client.stats.pendingResponses, 10);
  assert.equal(
    client.stats.timeouts,
    0,
    "the pending budget is a protocol abort, not a transport timeout — the same distinction client-engine.spec.ts pins",
  );
});

test("a frame that arrives unasked is not taken for the answer, and the answer is not lost", async () => {
  const { link, client } = wire([
    { at: 0, fault: { kind: "stray-before-answer", payload: [0x62, 0xf1, 0x87] } },
  ]);
  await assert.rejects(
    () => client.readDtcByStatusMask(0xff),
    /unexpected UDS response for SID 0x19/,
  );
  assert.equal(
    link.unanswered.length,
    1,
    "the real 0x19 answer is still on the wire — the client must not have consumed it",
  );
});

test("an answer that comes after the timeout does not answer the next request", async () => {
  const { link, client } = wire([{ at: 0, fault: { kind: "answer-late" } }]);
  await assert.rejects(() => client.readDtcByStatusMask(0xff), /no response within/);
  const records = await client.readDtcByStatusMask(0xff);
  assert.equal(records.length, 1, "the second request got its own answer, not the stale one");
  assert.equal(link.unanswered.length, 1, "the late frame stayed parked for nobody");
});

test("a suppressed request that vanishes is invisible to the client — and must stay so", async () => {
  // 0x10 with suppressPositiveResponse never awaits an answer, so a wire that drops the
  // request cannot be noticed by the caller. Pinning this is the honest counterpart to
  // the fault list: the client is right to report success, and the *wire log* is where
  // the loss is visible (AGENTS 25: what the transport did is auditable, not guessed).
  const { link, client } = wire([{ at: 0, fault: { kind: "no-forward" } }]);
  await client.diagnosticSessionControl(0x03, { suppressPositiveResponse: true });
  assert.equal(server?.stats.requests, 0, "the ECU never saw it");
  assert.equal(link.wire[0]?.outcome, "not-forwarded");
});

test("a link that is gone surfaces as the transport's own failure", async () => {
  const link = new FaultyLink({
    faults: [{ at: 0, fault: { kind: "no-forward" } }],
    sleep: instant,
  });
  const client = new UdsClient(link, { name: "gone", timing: TIMING, logger });
  const caught = await client.readDtcByStatusMask(0xff).then(
    () => undefined,
    (error: unknown) => error,
  );
  // The transport's own error type, unchanged: a client that re-wrapped a link failure
  // as a protocol error would hide which half of the stack is broken.
  assert.ok(caught instanceof IsoTpError, `expected the link's error, got ${String(caught)}`);
  assert.match(String((caught as Error).message), /no response within/);
  assert.equal(client.stats.timeouts, 1);
});
