import assert from "node:assert/strict";
import { test } from "vitest";
import type { GoldenTraceEntry } from "./format.js";
import {
  applyReplacements,
  bytesToHex,
  containsInMessages,
  findBytesInMessages,
  frameBytes,
  reassemble,
} from "./isobytes.js";

function frame(partial: Partial<GoldenTraceEntry> & { payload: string }): GoldenTraceEntry {
  return {
    t: 0,
    canId: 0x7e8,
    direction: "rx",
    ...partial,
  };
}

/** `VIN` split the way a real ECU sends it: first frame plus consecutive frames. */
const VIN = "1HGCM82633A004352";
/** The same VIN as the bytes a trace carries. */
const VIN_HEX = "314847434D383236333341303034333532";
const FF = "101462F190314847";
const CF1 = "21434D3832363333";
const CF2 = "2241303034333532";

test("a first frame plus consecutive frames reassemble to the message payload", () => {
  const trace = [
    frame({ payload: FF }),
    frame({ payload: CF1 }),
    frame({ payload: CF2 }),
    frame({ payload: "037E00AAAAAAAAAA", canId: 0x7e0, direction: "tx" }),
  ];
  const messages = reassemble(trace, [0, 1, 2]);
  assert.equal(messages.length, 1);
  assert.equal(bytesToHex(messages[0]?.payload ?? []), "62F190" + VIN_HEX);
  // Every payload byte knows which frame byte it came from — that is what makes
  // an edit land in the right place of the right frame.
  assert.deepEqual(
    messages[0]?.positions.map((position) => [position.frameIndex, position.byteIndex]),
    [
      [0, 2],
      [0, 3],
      [0, 4],
      [0, 5],
      [0, 6],
      [0, 7],
      [1, 1],
      [1, 2],
      [1, 3],
      [1, 4],
      [1, 5],
      [1, 6],
      [1, 7],
      [2, 1],
      [2, 2],
      [2, 3],
      [2, 4],
      [2, 5],
      [2, 6],
      [2, 7],
    ],
  );
});

test("a single frame is reassembled without a length header and pads are ignored", () => {
  const messages = reassemble([frame({ payload: "037F2231AAAAAAAA" })], [0]);
  assert.equal(bytesToHex(messages[0]?.payload ?? []), "7F2231");
});

test("extended addressing shifts the PCI byte by one", () => {
  // Extended addressing puts the target address in front of the PCI byte.
  const trace = [frame({ payload: "DA101462F19031", extended: true })];
  const messages = reassemble(trace, [0]);
  assert.equal(messages[0]?.payload[0], 0x62, "the address byte must not end up in the payload");
  assert.deepEqual(messages[0]?.positions[0], { frameIndex: 0, byteIndex: 3 });
});

test("a flow control frame ends the message it interrupts", () => {
  // A flow control frame is the tester answering a First Frame; it is not payload.
  // `reassemble` is handed the frames of one group, so an ungrouped list makes the
  // interruption visible — the incomplete message is dropped instead of being
  // silently glued together with whatever comes next.
  const trace = [
    frame({ payload: FF }),
    frame({ payload: "300000", canId: 0x7e0, direction: "tx" }),
    frame({ payload: CF1 }),
    frame({ payload: CF2 }),
  ];
  assert.equal(reassemble(trace, [0, 1, 2, 3]).length, 0);
  // Without the flow control frame in between the same frames form the message.
  assert.equal(bytesToHex(reassemble(trace, [0, 2, 3])[0]?.payload ?? []), "62F190" + VIN_HEX);
});

test("a message never spans two identifiers, directions or addressing modes", () => {
  const split = [
    frame({ payload: "1014" + VIN_HEX.slice(0, 12) }),
    frame({ payload: "21" + VIN_HEX.slice(12, 26), canId: 0x7e9 }),
    frame({ payload: "22" + VIN_HEX.slice(26) }),
  ];
  const search = [...Buffer.from(VIN, "latin1")];
  // The consecutive frame belongs to another ECU, so the 0x7e8 message stays short
  // and the VIN cannot be found in it — the grouping is what makes a message.
  assert.equal(findBytesInMessages(split, search).length, 0);
  assert.equal(findBytesInMessages(split, search, (entry) => entry.canId === 0x7e8).length, 0);
});

test("findBytesInMessages locates a sequence that is split across ISO-TP frames", () => {
  const trace = [frame({ payload: FF }), frame({ payload: CF1 }), frame({ payload: CF2 })];
  const hits = findBytesInMessages(trace, [...Buffer.from(VIN, "latin1")]);
  assert.equal(hits.length, VIN.length);
  assert.equal(hits[0]?.frameIndex, 0, "the first VIN byte lives in the first frame");
  assert.equal(hits[0]?.sequenceIndex, 0);
  assert.equal(hits.at(-1)?.frameIndex, 2, "the last VIN byte lives in the last frame");
  assert.equal(hits.at(-1)?.sequenceIndex, VIN.length - 1);
  assert.equal(containsInMessages(trace, [...Buffer.from(VIN, "latin1")]), true);
  assert.equal(containsInMessages(trace, [...Buffer.from("NOT-IN-THIS-TRACE", "latin1")]), false);
});

test("findBytesInMessages accepts a filter and reports nothing for a partial sequence", () => {
  const trace = [
    frame({ payload: FF }),
    frame({ payload: CF1 }),
    frame({ payload: CF2, canId: 0x7e9 }),
  ];
  const search = [...Buffer.from(VIN, "latin1")];
  assert.equal(findBytesInMessages(trace, search, (entry) => entry.canId === 0x7e9).length, 0);
  assert.equal(findBytesInMessages(trace, search.slice(1)).length, 0);
});

test("applyReplacements writes bytes back into the frames they came from", () => {
  const trace = [frame({ payload: FF }), frame({ payload: CF1 }), frame({ payload: CF2 })];
  const search = [...Buffer.from(VIN, "latin1")];
  const replacement = [...Buffer.from("REDACTED-VIN-0000", "latin1")];
  const hits = findBytesInMessages(trace, search);
  const redacted = applyReplacements(trace, hits, replacement);

  assert.equal(redacted.length, 3);
  assert.equal(bytesToHex(redacted[0] ? frameBytes(redacted[0]) : []), "101462F190524544");
  assert.equal(containsInMessages(redacted, search), false);
  assert.equal(
    containsInMessages(redacted, replacement),
    true,
    "the placeholder must be readable from the reassembled message",
  );
  // The frames of the input are copied, never mutated in place: a caller that
  // still holds the original trace must not see a half-redacted recording.
  assert.equal(bytesToHex(frameBytes(trace[1] ?? frame({ payload: "" }))), CF1);
  assert.equal(redacted[1]?.payload, "2141435445442D56");
});

test("replacement touches only the hit bytes and keeps frame length and metadata", () => {
  const trace = [frame({ payload: "037F2231AAAAAAAA", fd: true, channel: "can0" })];
  const redacted = applyReplacements(trace, findBytesInMessages(trace, [0x7f, 0x22]), [0x7f, 0x22]);
  assert.equal(redacted[0]?.payload, "037F2231AAAAAAAA");
  assert.equal(redacted[0]?.fd, true);
  assert.equal(redacted[0]?.channel, "can0");
  assert.equal(redacted[0]?.canId, 0x7e8);
});

test("frameBytes and bytesToHex are inverses, including empty payloads", () => {
  assert.deepEqual(frameBytes(frame({ payload: "00FF10" })), [0x00, 0xff, 0x10]);
  assert.equal(bytesToHex([0x00, 0xff, 0x10]), "00FF10");
  assert.deepEqual(frameBytes(frame({ payload: "" })), []);
  assert.equal(bytesToHex([]), "");
});
