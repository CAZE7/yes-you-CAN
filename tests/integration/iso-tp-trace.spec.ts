/**
 * ISO-TP trace integration (AGENTS 7, 18, 31.5, 31.6; ADR 0005, ADR 0039).
 *
 * The three fixtures in `tests/fixtures/traces/` are candump `-l` recordings of
 * this repository's own reference stack — `UdsClient` and `UdsServer` behind two
 * `IsoTpConnection` nodes on a virtual wire (`scripts/record-trace-fixtures.mjs`).
 * No vehicle, no hardware: what makes them worth keeping is that they are *wire
 * bytes*, not a table of expectations written next to the code they test.
 *
 * A recording produced by the implementation under test can only prove something
 * if the expectations are independent of it, so this suite checks each fixture
 * three ways:
 *
 *   1. **Structure** — `tests/helpers/iso-tp-frames.ts` re-reads every PCI byte
 *      straight from ISO 15765-2 and reassembles the messages itself, without
 *      importing the transport package. SF_DL, FF_DL, Sequence Numbers and the
 *      Flow Control discipline are validated there.
 *   2. **Bytes** — the expected payloads below are literal hex/ASCII taken from
 *      ISO 14229-1 (service ids, DIDs, NRCs) and from the VIN/part-number
 *      examples, never read back from a decoder.
 *   3. **Live** — the same conversation is run against a live `UdsServer`, and
 *      the frames that hit the virtual bus must equal the recorded ones. This is
 *      the check that keeps a fixture honest over time: if the implementation
 *      drifts away from the recording, this test fails even though the replay
 *      tests still pass (a replay only ever compares the client to the past).
 *
 * Replay itself goes through the production `ReplayTransport`, including its
 * `pace` mode, because timing is part of a trace: NRC 0x78 followed 25 ms later
 * by the real answer is two messages, and a burst delivery loses the second one.
 */

import assert from "node:assert/strict";
import { UdsClient, UdsServer, type UdsServerLink } from "@vdp/protocols-uds";
import { createLogger, toHex } from "@vdp/shared";
import { createVirtualCanNetwork } from "@vdp/simulators";
import { ReplayTransport } from "@vdp/transport-can";
import { IsoTpConnection } from "@vdp/transport-iso-tp";
import { describe, test } from "vitest";
import {
  type CandumpTrace,
  parseCandumpLog,
  readTraceFixture,
  toRecording,
} from "../helpers/candump.js";
import { readIsoTpFrame, validateIsoTpTrace } from "../helpers/iso-tp-frames.js";

const logger = createLogger("iso-tp-trace", { level: "ERROR" });

/** The identifier pair every fixture documents in its header (ISO 15765-2 normal addressing). */
const TESTER_ID = 0x7e0;
const ECU_ID = 0x7e8;
const PAIR = { txId: TESTER_ID, rxId: ECU_ID } as const;

/** The ECU the fixtures were recorded against, with exactly the DIDs it answers. */
const ECU_NAME = "engine-gateway";
const VIN = "1HGCM82633A004352";
const SPARE_PART = "03C906016K";
const ECU_SERIAL = [0x00, 0x11, 0x22, 0x33] as const;
const TRACE_DIDS = [
  { did: 0xf190, value: () => ascii(VIN) },
  { did: 0xf187, value: () => ascii(SPARE_PART) },
  { did: 0xf18c, value: () => new Uint8Array(ECU_SERIAL) },
] as const;
/** Timing the fixtures were recorded with, and the client is configured with. */
const TRACE_TIMING = { p2Ms: 50, p2StarMs: 5000 } as const;
/** Response-pending gap of `response-pending.log` (the ECU's `pendingResponseDelayMs`). */
const PENDING_GAP_MS = 25;

const SINGLE_FRAME = "single-frame-uds.log";
const MULTI_FRAME = "multi-frame-read-data-by-identifier.log";
const RESPONSE_PENDING = "response-pending.log";

const FIXTURES = [
  { file: SINGLE_FRAME, frames: 5, durationMs: 4 },
  { file: MULTI_FRAME, frames: 9, durationMs: 8 },
  { file: RESPONSE_PENDING, frames: 3, durationMs: 26 },
] as const;

function ascii(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function text(data: Uint8Array): string {
  return new TextDecoder().decode(data);
}

/** One frame as the wire shows it: `7E0#02 3E 80`. */
function wireOf(canId: number, payload: Uint8Array): string {
  return `${canId.toString(16).toUpperCase().padStart(3, "0")}#${toHex(payload)}`;
}

/** The frames a fixture recorded, as the wire shows them. */
function recorded(trace: CandumpTrace): string[] {
  return trace.frames.map((frame) => wireOf(frame.canId, frame.payload));
}

/** The UDS payloads a fixture carries, with the ISO-TP PCI byte removed. */
function messagesOf(trace: CandumpTrace): number[][] {
  return validateIsoTpTrace(trace.frames).messages.map((message) => [...message.payload]);
}

// --------------------------------------------------------------------- reader

describe("candump reader", () => {
  test("reads the candump -l form and rebases its clock to the first frame", () => {
    const trace = parseCandumpLog(
      [
        "# recorded with candump -l vcan0",
        "",
        "(1790035200.500000) vcan0 7E0#0322F190",
        "(1790035200.501500) vcan0 7E8#101462F190314847",
        "",
      ].join("\n"),
      PAIR,
    );

    assert.equal(trace.channel, "vcan0");
    assert.deepEqual(trace.comments, ["recorded with candump -l vcan0"]);
    assert.deepEqual(trace.rejected, []);
    assert.deepEqual(trace.ignored, []);
    assert.deepEqual(
      trace.frames.map((frame) => [frame.t, frame.direction, wireOf(frame.canId, frame.payload)]),
      [
        [0, "tx", "7E0#03 22 F1 90"],
        [1.5, "rx", "7E8#10 14 62 F1 90 31 48 47"],
      ],
    );
    assert.equal(trace.durationMs, 1.5);
    assert.deepEqual(toRecording(trace).frames, trace.frames);
  });

  test("reads a CAN FD frame: ## is followed by the flags byte, then the data", () => {
    const trace = parseCandumpLog("(1.000000) vcan0 7E8##0162F19031484743", PAIR);
    const frame = trace.frames[0];
    assert.ok(frame, "the FD line must be read as a frame");
    assert.equal(frame.fd, true);
    assert.equal(wireOf(frame.canId, frame.payload), "7E8#62 F1 90 31 48 47 43");
  });

  test("reads a 29-bit identifier as extended", () => {
    const trace = parseCandumpLog("(1.000000) vcan0 18DAF110#0322F190", { txId: 0x18daf110 });
    const frame = trace.frames[0];
    assert.ok(frame, "the extended line must be read as a frame");
    assert.equal(frame.canId, 0x18daf110);
    assert.equal(frame.extended, true);
    assert.equal(frame.direction, "tx");
  });

  test("reads the timestamped console form", () => {
    const trace = parseCandumpLog("(0.001000)  vcan0  7E8   [8]  10 14 62 F1 90 31 48 47", PAIR);
    assert.equal(trace.frames.length, 1);
    assert.equal(
      wireOf(0x7e8, trace.frames[0]?.payload ?? new Uint8Array()),
      "7E8#10 14 62 F1 90 31 48 47",
    );
    assert.equal(trace.frames[0]?.t, 0, "the first frame of a trace is its zero point");
  });

  test("reads the console form without a clock on a synthetic 1 ms grid", () => {
    // `candump` without -t writes no timestamp at all; the offline analyzer already
    // reads that line, and this reader keeps its 1 ms grid so a paced replay of an
    // undated log still delivers one message at a time (AGENTS 34.2: reuse).
    const trace = parseCandumpLog(
      ["  vcan0  7E8   [4]  03 7F 22 78", "  vcan0  7E8   [7]  62 F1 8C 00 11 22 33"].join("\n"),
      PAIR,
    );
    assert.deepEqual(
      trace.frames.map((frame) => frame.t),
      [0, 1],
    );
    assert.equal(trace.channel, "vcan0", "the interface name survives the delegation");
    assert.deepEqual(trace.rejected, []);
  });

  test("rejects a frame whose data is shorter than its DLC instead of inventing bytes", () => {
    const trace = parseCandumpLog("(0.001000) vcan0 7E8 [8] 10 14 62", PAIR);
    assert.deepEqual(trace.frames, []);
    assert.equal(trace.rejected.length, 1);
    assert.match(trace.rejected[0]?.reason ?? "", /DLC 8 but 3 data byte/);
  });

  test("rejects a line it does not understand and keeps reading the rest", () => {
    const trace = parseCandumpLog(
      ["CAN bus logging started", "(1.000000) vcan0 7E0#023E80", "(1.001000) vcan0 7E0#0322F"].join(
        "\n",
      ),
      PAIR,
    );
    assert.equal(trace.frames.length, 1, "the readable frame survives");
    assert.equal(trace.rejected.length, 2);
    assert.match(trace.rejected[0]?.reason ?? "", /not a known candump line/);
    assert.match(trace.rejected[1]?.reason ?? "", /odd number of hex digits/);
  });

  test("ignores frames that are on the bus but not part of this conversation", () => {
    const trace = parseCandumpLog(
      [
        "(1.000000) vcan0 7E0#023E80",
        "(1.001000) vcan0 620#0102030405",
        "(1.002000) can0 7E0#021003",
      ].join("\n"),
      { ...PAIR, channel: "vcan0" },
    );
    assert.equal(trace.frames.length, 1);
    assert.equal(trace.ignored.length, 2);
    assert.match(trace.ignored[0]?.reason ?? "", /not part of the 0x7e0\/0x7e8 pair/);
    assert.match(trace.ignored[1]?.reason ?? "", /interface can0/);
  });

  test("accounts for every line of a fixture, including its documentation", () => {
    const trace = readTraceFixture(SINGLE_FRAME, PAIR);
    const kinds = trace.lines.map((line) => line.kind);
    assert.equal(
      kinds.filter((kind) => kind === "comment").length,
      trace.comments.length,
      "every comment line is kept as fixture documentation",
    );
    assert.equal(kinds.filter((kind) => kind === "frame").length, trace.frames.length);
    assert.deepEqual(
      kinds.filter((kind) => kind !== "comment" && kind !== "frame" && kind !== "blank"),
      [],
      "a fixture has no rejected and no ignored line",
    );
    assert.ok(
      trace.comments.some((line) => line.includes("record-trace-fixtures.mjs")),
      "a fixture must say where it came from",
    );
    assert.ok(
      trace.comments.some((line) => line.includes("candump -l")),
      "a fixture must say which format it is in",
    );
  });
});

// ------------------------------------------------------------------ structure

describe("the recorded fixtures are valid ISO 15765-2", () => {
  for (const fixture of FIXTURES) {
    test(`${fixture.file} reads completely and violates no ISO-TP rule`, () => {
      const trace = readTraceFixture(fixture.file, PAIR);
      assert.deepEqual(
        trace.rejected.map((line) => line.reason),
        [],
        "a fixture is a witness — an unreadable line invalidates it",
      );
      assert.equal(trace.frames.length, fixture.frames);
      assert.equal(trace.durationMs, fixture.durationMs);
      assert.equal(trace.channel, "vcan0");

      const check = validateIsoTpTrace(trace.frames);
      assert.deepEqual(check.problems, []);
      assert.ok(check.messages.length > 0);
    });
  }

  test("single frames: SF_DL equals the data length of every frame", () => {
    const trace = readTraceFixture(SINGLE_FRAME, PAIR);
    const check = validateIsoTpTrace(trace.frames);
    assert.deepEqual(check.flowControls, [], "nothing here needs flow control");
    assert.deepEqual(
      check.messages.map((message) => toHex(message.payload)),
      ["3E 80", "10 03", "50 03 00 32 01 F4", "22 F1 86", "62 F1 86 03"],
    );
    assert.ok(check.messages.every((message) => !message.segmented));
    // Hand-decoded from the standard, not from the fixture header: 0x3E 0x80 is
    // TesterPresent with suppressPosRspMsgIndicationBit, 0x10 0x03 opens the
    // extended session, and 0x50 0x03 0x00 0x32 0x01 0xF4 reports P2 = 50 ms and
    // P2* = 500 × 10 ms = 5000 ms (ISO 14229-1 §9.2.4, ISO 14229-2 §7.4).
    assert.deepEqual(messagesOf(trace)[1], [0x10, 0x03]);
    assert.deepEqual(messagesOf(trace)[2], [0x50, 0x03, 0x00, 0x32, 0x01, 0xf4]);
  });

  test("multi frames: FF_DL equals the reassembled length, SN counts 1, 2, …", () => {
    const trace = readTraceFixture(MULTI_FRAME, PAIR);
    const check = validateIsoTpTrace(trace.frames);
    const segmented = check.messages.filter((message) => message.segmented);
    assert.equal(segmented.length, 2, "VIN and spare part number are both longer than 7 bytes");

    const vin = segmented[0];
    assert.ok(vin, "first segmented message");
    assert.equal(vin.announcedLength, 20, "FF_DL 0x014 = 3 response bytes + 17 VIN characters");
    assert.equal(vin.payload.length, 20);
    assert.deepEqual(vin.frameIndices, [1, 3, 4], "First Frame plus two Consecutive Frames");
    assert.equal(text(vin.payload.subarray(3)), VIN);

    const part = segmented[1];
    assert.ok(part, "second segmented message");
    assert.equal(part.announcedLength, 13, "FF_DL 0x0D = 3 response bytes + 10 characters");
    assert.equal(text(part.payload.subarray(3)), SPARE_PART);

    // The tester answered both First Frames with ContinueToSend, BS = 0 (send the
    // rest), STmin = 0 — and each Flow Control answers the First Frame before it.
    assert.equal(check.flowControls.length, 2);
    for (const flow of check.flowControls) {
      assert.equal(flow.info.status, "continueToSend");
      assert.equal(flow.info.blockSize, 0);
      assert.equal(flow.info.separationTimeMs, 0);
      assert.ok(flow.answersFrameIndex !== null, "a Flow Control must answer a First Frame");
    }
    assert.deepEqual(
      check.flowControls.map((flow) => flow.answersFrameIndex),
      [1, 6],
    );
    // Sequence Numbers are part of the frame bytes: 0x21, 0x22, then 0x21 again
    // for the second message (SN restarts at 1 per message, ISO 15765-2 §9.6.4).
    assert.deepEqual(
      trace.frames
        .filter((frame) => frame.canId === ECU_ID && (frame.payload[0] ?? 0) >> 4 === 2)
        .map((frame) => frame.payload[0]),
      [0x21, 0x22, 0x21],
    );
  });

  test("response pending: NRC 0x78 and the real answer are two single frames, 25 ms apart", () => {
    const trace = readTraceFixture(RESPONSE_PENDING, PAIR);
    const check = validateIsoTpTrace(trace.frames);
    assert.deepEqual(
      check.messages.map((message) => [...message.payload]),
      [
        [0x22, 0xf1, 0x8c],
        [0x7f, 0x22, 0x78],
        [0x62, 0xf1, 0x8c, ...ECU_SERIAL],
      ],
    );
    const pendingAt = trace.frames[1]?.t ?? Number.NaN;
    const answerAt = trace.frames[2]?.t ?? Number.NaN;
    assert.equal(answerAt - pendingAt, PENDING_GAP_MS, "the P2* window is part of the recording");
    assert.equal(
      trace.frames.filter((frame) => frame.canId === TESTER_ID).length,
      1,
      "the tester asked once — a pending response is not a reason to repeat the request",
    );
  });

  test("the validator fails on the traces it is supposed to fail on", () => {
    // A validator that accepts everything proves nothing, so each rule gets a
    // broken input: a wrong Sequence Number, a short FF_DL, a missing Flow
    // Control, and an SF_DL that does not match its own frame.
    const good = readTraceFixture(MULTI_FRAME, PAIR).frames;

    const wrongSn = good.map((frame, index) =>
      index === 3
        ? { ...frame, payload: new Uint8Array([0x22, ...frame.payload.subarray(1)]) }
        : frame,
    );
    assert.match(validateIsoTpTrace(wrongSn).problems.join("\n"), /Sequence Number 2, expected 1/);

    const shortDl = good.map((frame, index) =>
      index === 1
        ? { ...frame, payload: new Uint8Array([0x10, 0x13, ...frame.payload.subarray(2)]) }
        : frame,
    );
    assert.match(
      validateIsoTpTrace(shortDl).problems.join("\n"),
      /FF_DL 19 but the Consecutive Frames carried 20 bytes/,
    );

    const noFlowControl = good.filter((_frame, index) => index !== 2);
    assert.match(validateIsoTpTrace(noFlowControl).problems.join("\n"), /before the Flow Control/);

    const strayFlowControl = [
      { canId: TESTER_ID, direction: "tx" as const, payload: new Uint8Array([0x30, 0x00, 0x00]) },
    ];
    assert.match(
      validateIsoTpTrace(strayFlowControl).problems.join("\n"),
      /Flow Control without a preceding First Frame/,
    );

    const wrongSfDl = [
      {
        canId: ECU_ID,
        direction: "rx" as const,
        payload: new Uint8Array([0x05, 0x62, 0xf1, 0x86, 0x03]),
      },
    ];
    assert.match(validateIsoTpTrace(wrongSfDl).problems.join("\n"), /SF_DL 5 but 4 data bytes/);

    const truncated = good.slice(0, 4);
    assert.match(validateIsoTpTrace(truncated).problems.join("\n"), /never completed/);
  });

  test("STmin decoding follows ISO 15765-2 Table 24, including the reserved ranges", () => {
    const fc = (stmin: number) => readIsoTpFrame(new Uint8Array([0x30, 0x00, stmin]));
    assert.deepEqual(fc(0x0a), {
      kind: "flow-control",
      status: "continueToSend",
      blockSize: 0,
      separationTimeMs: 10,
      separationTimeRaw: 0x0a,
      separationTimeReserved: false,
    });
    assert.deepEqual(fc(0xf5), {
      kind: "flow-control",
      status: "continueToSend",
      blockSize: 0,
      separationTimeMs: 0.5,
      separationTimeRaw: 0xf5,
      separationTimeReserved: false,
    });
    const reserved = fc(0x80);
    assert.equal(reserved.kind, "flow-control");
    if (reserved.kind === "flow-control") assert.equal(reserved.separationTimeReserved, true);
    // Wait and overflow are statuses a receiver may send; a trace that contains
    // them is not broken, but the validator reports an overflow (buffer too small).
    assert.equal(readIsoTpFrame(new Uint8Array([0x31, 0x00, 0x00])).kind, "flow-control");
    assert.match(
      validateIsoTpTrace([
        {
          canId: ECU_ID,
          direction: "rx",
          payload: new Uint8Array([0x10, 0x0e, 0x62, 0xf1, 0x87, 0x30, 0x33, 0x43]),
        },
        { canId: TESTER_ID, direction: "tx", payload: new Uint8Array([0x32, 0x00, 0x00]) },
      ]).problems.join("\n"),
      /buffer overflow/,
    );
  });

  test("reserved PCI types and classic-CAN escape lengths are invalid frames", () => {
    assert.match(readIsoTpFrame(new Uint8Array([0x40, 0x01])).kind, /invalid/);
    assert.equal(readIsoTpFrame(new Uint8Array([0x00, 0x08]), { fd: false }).kind, "invalid");
    const fdEscape = readIsoTpFrame(
      new Uint8Array([0x00, 0x09, 0x62, 0xf1, 0x90, 0x31, 0x48, 0x47, 0x43, 0x4d]),
      {
        fd: true,
        frameLength: 64,
      },
    );
    assert.equal(fdEscape.kind, "single");
    if (fdEscape.kind === "single") assert.equal(fdEscape.announcedLength, 9);
    // A First Frame that would have fit into a Single Frame is a sender bug.
    assert.equal(
      readIsoTpFrame(new Uint8Array([0x10, 0x05, 0x62, 0xf1, 0x86, 0x03])).kind,
      "invalid",
    );
  });
});

// --------------------------------------------------------------------- replay

interface ReplayHarness {
  trace: CandumpTrace;
  transport: ReplayTransport;
  connection: IsoTpConnection;
  client: UdsClient;
  close(): Promise<void>;
}

/**
 * Put a `UdsClient` on a recorded trace: ISO-TP over `ReplayTransport`, which
 * answers every request from the recording instead of from an ECU.
 */
async function replayFixture(
  fileName: string,
  options: { pace?: boolean } = {},
): Promise<ReplayHarness> {
  const trace = readTraceFixture(fileName, PAIR);
  const transport = new ReplayTransport(toRecording(trace), {
    logger,
    ...(options.pace === undefined ? {} : { pace: options.pace }),
  });
  await transport.open();
  const connection = new IsoTpConnection(transport, { txId: TESTER_ID, rxId: ECU_ID }, logger);
  connection.open();
  const client = new UdsClient(connection, { name: ECU_NAME, logger, timing: { ...TRACE_TIMING } });
  return {
    trace,
    transport,
    connection,
    client,
    close: async () => {
      connection.close();
      await transport.close();
    },
  };
}

describe("replay: UdsClient against the recorded traces", () => {
  test("single frames replay byte for byte, with the session timing the ECU reported", async () => {
    const harness = await replayFixture(SINGLE_FRAME);
    try {
      // TesterPresent with suppressPosRspMsgIndicationBit: sent, never answered.
      await harness.client.testerPresent(true);
      const session = await harness.client.diagnosticSessionControl(0x03);
      assert.deepEqual(session, { sessionType: 0x03, p2Ms: 50, p2StarMs: 5000 });
      assert.equal(harness.client.activeSessionName, "extendedDiagnosticSession");

      const active = await harness.client.readDid(0xf186);
      assert.deepEqual(
        [...(active ?? [])],
        [0x03],
        "the ECU confirms the extended session is active",
      );

      assert.deepEqual(harness.transport.deviations, []);
      assert.deepEqual(harness.transport.stats, {
        sends: 3,
        matched: 3,
        unmatched: 0,
        delivered: 2,
      });
      assert.deepEqual(
        harness.transport.unusedExchanges().length,
        0,
        "every recorded request was asked",
      );
      assert.deepEqual(harness.client.stats, {
        requests: 3,
        responses: 2,
        negativeResponses: 0,
        pendingResponses: 0,
        timeouts: 0,
      });
      assert.equal(harness.connection.stats.txSingleFrames, 3);
      assert.equal(harness.connection.stats.rxSingleFrames, 2);
      assert.equal(harness.connection.stats.rxMultiFrameMessages, 0);
      assert.equal(harness.connection.stats.timeouts, 0);
    } finally {
      await harness.close();
    }
  });

  test("a segmented VIN arrives as one message out of three frames", async () => {
    const harness = await replayFixture(MULTI_FRAME);
    try {
      assert.equal(await harness.client.readVin(), VIN);
      const part = await harness.client.readDid(0xf187);
      assert.equal(text(part ?? new Uint8Array()), SPARE_PART);

      assert.equal(harness.connection.stats.rxMultiFrameMessages, 2);
      assert.equal(
        harness.connection.stats.txFlowControlFrames,
        2,
        "one Flow Control per First Frame",
      );
      assert.equal(harness.connection.stats.rxFlowControlFrames, 0);
      assert.equal(harness.connection.stats.sequenceErrors, 0);
      // Two requests plus two Flow Control frames hit the transport; the Flow
      // Control frames belong to the answer and must not open an exchange.
      assert.deepEqual(harness.transport.stats, {
        sends: 4,
        matched: 2,
        unmatched: 0,
        delivered: 5,
      });
      assert.deepEqual(harness.transport.deviations, []);
      assert.deepEqual(harness.transport.unusedExchanges().length, 0);
    } finally {
      await harness.close();
    }
  });

  test("a paced replay keeps NRC 0x78 and the final answer two messages apart", async () => {
    const harness = await replayFixture(RESPONSE_PENDING, { pace: true });
    try {
      const started = Date.now();
      const serial = await harness.client.readDid(0xf18c);
      const elapsed = Date.now() - started;

      assert.deepEqual([...(serial ?? [])], [...ECU_SERIAL]);
      assert.deepEqual(harness.client.stats, {
        requests: 1,
        responses: 2,
        negativeResponses: 0,
        pendingResponses: 1,
        timeouts: 0,
      });
      assert.deepEqual(harness.transport.deviations, []);
      assert.equal(harness.transport.stats.matched, 1);
      assert.ok(
        elapsed >= PENDING_GAP_MS,
        `the recorded ${PENDING_GAP_MS} ms P2* window must survive the replay (took ${elapsed} ms)`,
      );
      assert.ok(elapsed < 2000, `a replay must not stall (took ${elapsed} ms)`);
    } finally {
      await harness.close();
    }
  });

  test("a request the recording does not contain is reported as a deviation", async () => {
    // Strictness is the point of a replay: 0xF186 is not in the multi-frame trace,
    // so asking for it must be *visible*. The transport falls back to matching the
    // identifier and says so — it answers from the recorded VIN exchange, whose DID
    // echo the client then rightly refuses to read as an answer for 0xF186.
    const harness = await replayFixture(MULTI_FRAME);
    try {
      const active = await harness.client.readDid(0xf186);
      assert.equal(active, null, "a VIN response is not an answer for another DID");
      assert.equal(harness.transport.deviations.length, 1);
      const deviation = harness.transport.deviations[0];
      assert.equal(deviation?.kind, "payload-differs");
      assert.equal(deviation?.sentPayload, "03 22 F1 86");
      assert.equal(deviation?.recordedPayload, "03 22 F1 90");
      assert.equal(
        harness.transport.unusedExchanges().length,
        1,
        "the spare part number request stayed on the shelf",
      );
    } finally {
      await harness.close();
    }
  });
});

// ----------------------------------------------------------------------- live

interface LivePair {
  client: UdsClient;
  server: UdsServer;
  /** Every frame that crossed the virtual bus, as the wire shows it. */
  wire(): string[];
  close(): Promise<void>;
}

/**
 * The same conversation the fixtures recorded, run live: two `IsoTpConnection`
 * nodes on a virtual CAN network, a `UdsServer` behind one, a `UdsClient` in
 * front of the other. The server link is the four-line seam the simulator uses
 * (`onUnsolicited` in, `sendOnly` out) — ISO-TP knows nothing about UDS.
 */
async function createLivePair(options: { pendingResponse?: boolean } = {}): Promise<LivePair> {
  const network = createVirtualCanNetwork();
  const testerBus = network.createBus("tester");
  const ecuParamBus = network.createBus(ECU_NAME);
  await testerBus.open();
  await ecuParamBus.open();

  const testerIso = new IsoTpConnection(testerBus, { txId: TESTER_ID, rxId: ECU_ID }, logger);
  const ecuParamIso = new IsoTpConnection(ecuParamBus, { txId: ECU_ID, rxId: TESTER_ID }, logger);
  testerIso.open();
  ecuParamIso.open();

  const link: UdsServerLink = {
    onMessage: (listener) => ecuParamIso.onUnsolicited(listener),
    send: (payload) => ecuParamIso.sendOnly(payload),
  };
  const server = new UdsServer(link, {
    name: ECU_NAME,
    logger,
    timing: { ...TRACE_TIMING, s3Ms: 5000 },
    dids: [...TRACE_DIDS],
    ...(options.pendingResponse
      ? { pendingResponseServices: [0x22], pendingResponseDelayMs: PENDING_GAP_MS }
      : {}),
  });
  server.start();
  // The ECU of `single-frame-uds.log` reports the session it is in, so the live
  // counterpart registers the same DID the recorder did (ISO 14229-1 Annex D).
  server.registerDid({ did: 0xf186, value: () => Uint8Array.of(server.sessions.sessionType) });

  const client = new UdsClient(testerIso, { name: ECU_NAME, logger, timing: { ...TRACE_TIMING } });
  return {
    client,
    server,
    wire: () => network.snapshot().map((frame) => wireOf(frame.id, frame.payload)),
    close: async () => {
      server.stop();
      testerIso.close();
      ecuParamIso.close();
      await testerBus.close();
      await ecuParamBus.close();
    },
  };
}

describe("live: the fixtures are what the stack puts on the wire today", () => {
  test("single-frame conversation", async () => {
    const pair = await createLivePair();
    try {
      await pair.client.testerPresent(true);
      await pair.client.diagnosticSessionControl(0x03);
      await pair.client.readDid(0xf186);
      assert.deepEqual(pair.wire(), recorded(readTraceFixture(SINGLE_FRAME, PAIR)));
    } finally {
      await pair.close();
    }
  });

  test("segmented conversation, including the tester's Flow Control bytes", async () => {
    const pair = await createLivePair();
    try {
      assert.equal(await pair.client.readVin(), VIN);
      assert.equal(text((await pair.client.readDid(0xf187)) ?? new Uint8Array()), SPARE_PART);
      assert.deepEqual(pair.wire(), recorded(readTraceFixture(MULTI_FRAME, PAIR)));
    } finally {
      await pair.close();
    }
  });

  test("response-pending conversation", async () => {
    const pair = await createLivePair({ pendingResponse: true });
    try {
      assert.deepEqual([...((await pair.client.readDid(0xf18c)) ?? [])], [...ECU_SERIAL]);
      assert.equal(pair.client.stats.pendingResponses, 1);
      assert.deepEqual(pair.wire(), recorded(readTraceFixture(RESPONSE_PENDING, PAIR)));
    } finally {
      await pair.close();
    }
  });
});
