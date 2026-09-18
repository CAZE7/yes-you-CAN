import assert from "node:assert/strict";
import { IsoTpError } from "@vdp/shared";
import { describe, test } from "vitest";
import { classifyIsoTpError, runIsoTpVector } from "./isotp-runner.js";
import type { IsoTpVector } from "./vectors.js";

/** Yield to the macrotask queue — the same way the protocol suite settles. */
const yield0 = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const time = {
  async sleep(ms: number): Promise<void> {
    if (ms <= 0) await yield0();
    else await new Promise((resolve) => setImmediate(resolve));
  },
};

function baseVector(overrides: Partial<IsoTpVector>): IsoTpVector {
  return {
    name: "spec",
    side: "rx",
    config: {
      nBsMs: 30,
      nCrMs: 30,
      wftMax: 8,
      maxRetries: 0,
      blockSize: 0,
      stMinMs: 0,
      budgetMs: 300,
    },
    input: [],
    payload: [],
    peer: [],
    expect: {
      delivered: null,
      error: null,
      sentFrames: [],
      counters: { sequenceErrors: 0, timeouts: 0, retries: 0 },
    },
    ...overrides,
  };
}

describe("ISO-TP runner over the production connection", () => {
  test("a single frame reaches the application exactly as declared", async () => {
    const result = await runIsoTpVector(
      baseVector({ input: [{ in: [3, 0x61, 0x62, 0x63] }] }),
      time,
    );
    assert.deepEqual(result.delivered, [0x61, 0x62, 0x63]);
    assert.deepEqual(result.sentFrames, []);
    assert.equal(result.error, null);
  });

  test("a segmented reception answers with one flow control and the joined payload", async () => {
    const data = Array.from({ length: 20 }, (_, i) => 0xa0 + i);
    const result = await runIsoTpVector(
      baseVector({
        input: [
          { in: [0x10, 20, ...data.slice(0, 6)] },
          { in: [0x21, ...data.slice(6, 13)] },
          { in: [0x22, ...data.slice(13, 20)] },
        ],
      }),
      time,
    );
    assert.deepEqual(result.delivered, data);
    assert.deepEqual(result.sentFrames, [
      { pci: "flow-control", status: 0, blockSize: 0, stMin: 0 },
    ]);
    assert.equal(result.counters.sequenceErrors, 0);
  });

  test("a wrong sequence number aborts and counts — the reception does not limp on", async () => {
    const result = await runIsoTpVector(
      baseVector({
        input: [{ in: [0x10, 20, 1, 2, 3, 4, 5, 6] }, { in: [0x25, 7, 8, 9, 10, 11, 12, 13] }],
      }),
      time,
    );
    assert.equal(result.delivered, null);
    assert.equal(result.counters.sequenceErrors, 1);
  });

  test("the N_Cr guard fires on the model clock, not on the wall clock", async () => {
    const result = await runIsoTpVector(
      baseVector({
        input: [{ in: [0x10, 20, 1, 2, 3, 4, 5, 6] }, { tickMs: 31 }, { checkCr: true }],
      }),
      time,
    );
    assert.equal(result.error, "timeout-nCr");
    assert.equal(result.counters.timeouts, 1);
  });

  test("a transmission completes when the peer grants flow control", async () => {
    const data = Array.from({ length: 20 }, (_, i) => 0xc0 + i);
    const result = await runIsoTpVector(
      baseVector({
        side: "tx",
        payload: data,
        peer: [
          { after: 0, frame: [0x30, 0, 0] },
          { after: 2, frame: [2, 0x62, 0x09] },
        ],
      }),
      time,
    );
    assert.deepEqual(result.delivered, [0x62, 0x09]);
    assert.deepEqual(
      result.sentFrames.map((f) => f.pci),
      ["first", "consecutive", "consecutive"],
    );
  });

  test("silence from the peer surfaces as the N_Bs class with the counter it moved", async () => {
    const result = await runIsoTpVector(
      baseVector({ side: "tx", payload: Array.from({ length: 20 }, () => 1), peer: [] }),
      time,
    );
    assert.equal(result.error, "timeout-nBs");
    assert.equal(result.counters.timeouts, 1);
    assert.deepEqual(
      result.sentFrames.map((f) => f.pci),
      ["first"],
    );
  });
});

describe("error classification", () => {
  test("the classifier reads structured details, not prose", () => {
    assert.equal(
      classifyIsoTpError(new IsoTpError("x", { flowControl: "overflow" })),
      "buffer-overflow",
    );
    assert.equal(classifyIsoTpError(new IsoTpError("x", { timeout: "N_Bs" })), "timeout-nBs");
    assert.equal(classifyIsoTpError(new IsoTpError("x", { timeout: "WFTmax" })), "wftmax");
    assert.equal(
      classifyIsoTpError(new IsoTpError("x", { timeout: "response" })),
      "timeout-response",
    );
    assert.equal(classifyIsoTpError(new IsoTpError("x", { payloadLength: 0 })), "empty-payload");
    assert.equal(classifyIsoTpError(new IsoTpError("x", { tooLong: true })), "message-too-long");
    assert.equal(classifyIsoTpError(new IsoTpError("x", { sequenceError: true })), null);
    assert.equal(classifyIsoTpError(new Error("foreign")), null);
  });
});
