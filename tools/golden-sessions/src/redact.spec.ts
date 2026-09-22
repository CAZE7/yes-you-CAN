import assert from "node:assert/strict";
import { test } from "vitest";
import { type GoldenSession, type GoldenTraceEntry, VIN_PLACEHOLDER } from "./format.js";
import {
  assertGoldenRedacted,
  assertNoVinLikeTokens,
  assertVinGone,
  containsInMessages,
  findVinLikeTokens,
  redactedVinBytes,
  redactGoldenSession,
  redactRecording,
  redactText,
  vinHexForms,
} from "./index.js";

const VIN = "1HGCM82633A004352";
/** The VIN as ISO-TP frames: first frame plus two consecutive frames. */
const VIN_FRAMES: GoldenTraceEntry[] = [
  { t: 0, canId: 0x7e8, direction: "rx", payload: "101462F190314847" },
  { t: 0, canId: 0x7e8, direction: "rx", payload: "21434D3832363333" },
  { t: 0, canId: 0x7e8, direction: "rx", payload: "2241303034333532" },
];

test("redactText replaces every spelling of the VIN, case-insensitively", () => {
  const text = `vin=${VIN} lower=${VIN.toLowerCase()} spaced=${VIN.slice(0, 8)} • ${VIN.slice(8)}`;
  const redacted = redactText(text, VIN);
  assert.equal(redacted.includes(VIN), false);
  assert.equal(redacted.includes(VIN.toLowerCase()), false);
  assert.equal(redacted.includes(VIN_PLACEHOLDER), true);
  assert.equal(redactText(text, ""), text, "no VIN means nothing to replace");
});

test("redactText keeps text that merely looks similar", () => {
  const text = "VIN-like but not the one: 1HGCM82633A004399";
  assert.equal(redactText(text, VIN), text);
});

test("vinHexForms covers the compact, spaced and colon-separated spellings", () => {
  const forms = vinHexForms(VIN);
  assert.equal(forms.length, 3);
  assert.equal(forms[0], "314847434D383236333341303034333532");
  assert.equal(forms[1], "31 48 47 43 4D 38 32 36 33 33 41 30 30 34 33 35 32");
  assert.equal(forms[2], "31:48:47:43:4D:38:32:36:33:33:41:30:30:34:33:35:32");
});

test("redactedVinBytes is the placeholder as bytes, never longer than a VIN", () => {
  const bytes = redactedVinBytes();
  assert.equal(bytes.length, VIN_PLACEHOLDER.length);
  assert.equal(String.fromCharCode(...bytes), VIN_PLACEHOLDER);
  assert.equal(bytes.length, 17);
});

test("redactRecording replaces the VIN in text and inside reassembled ISO-TP messages", () => {
  const recording = {
    format: "vdp.session",
    meta: { vin: VIN, note: `recorded ${VIN}` },
    trace: [{ t: 0, canId: 0x7e0, direction: "tx" as const, payload: "0322F190" }, ...VIN_FRAMES],
    log: [{ message: `read ${VIN} from the engine` }],
  };
  const redacted = redactRecording(recording, VIN);

  assert.equal(JSON.stringify(redacted).includes(VIN), false);
  // The frame text alone would not show it: the VIN is split across frames, so a
  // text-only redaction leaves it readable in the reassembled message.
  assert.equal(containsInMessages(redacted.trace, [...Buffer.from(VIN, "latin1")]), false);
  assert.equal(
    containsInMessages(redacted.trace, [...Buffer.from(VIN_PLACEHOLDER, "latin1")]),
    true,
  );
  assert.equal(redacted.trace[1]?.payload, "101462F190524544");
  assert.equal(redactRecording(recording, "").trace, recording.trace);
});

test("redactGoldenSession redacts expectations and provenance as well", () => {
  const session = goldenSession({ vin: VIN });
  const redacted = redactGoldenSession(session, VIN);
  assert.equal(redacted.expectations.identity?.vin, VIN_PLACEHOLDER);
  assert.equal(
    JSON.stringify(redacted).includes(VIN),
    false,
    "no field of the file may keep the VIN",
  );
  assert.equal(redacted.provenance.redaction.includes("vin"), true);
  // The input is not modified: a caller may hold the raw recording in memory.
  assert.equal(session.expectations.identity?.vin, VIN);
});

test("assertGoldenRedacted accepts a redacted file and rejects a leak", () => {
  const redacted = redactGoldenSession(goldenSession({ vin: VIN }), VIN);
  assert.doesNotThrow(() => assertGoldenRedacted(redacted, VIN, "fixture"));
  assert.doesNotThrow(() => assertGoldenRedacted(goldenSession({ vin: VIN }), "", "no vin"));

  const leaky = goldenSession({ vin: VIN });
  assert.throws(
    () => assertGoldenRedacted(leaky, VIN, "fixture"),
    /fixture/,
    "a file that still contains the VIN must be refused",
  );

  const leakyFrame = redactGoldenSession(goldenSession({ vin: VIN }), VIN);
  // Put the frames back the way a text-only redaction leaves them: every string is
  // replaced, the VIN is still readable from the reassembled message.
  leakyFrame.recording.trace[1] = {
    t: 0,
    canId: 0x7e8,
    direction: "rx",
    payload: "101462F190314847",
  };
  leakyFrame.recording.trace[2] = {
    t: 0,
    canId: 0x7e8,
    direction: "rx",
    payload: "21434D3832363333",
  };
  leakyFrame.recording.trace[3] = {
    t: 0,
    canId: 0x7e8,
    direction: "rx",
    payload: "2241303034333532",
  };
  assert.throws(
    () => assertGoldenRedacted(leakyFrame, VIN, "fixture"),
    /ISO-TP message/,
    "a VIN hidden in the frames must be caught even when the text is clean",
  );
});

test("assertVinGone reports every occurrence it found", () => {
  assert.doesNotThrow(() => assertVinGone("clean", VIN, "text"));
  assert.throws(() => assertVinGone(`a ${VIN} b`, VIN, "text"), /text/);
});

test("findVinLikeTokens finds VIN-shaped tokens and ignores the placeholder", () => {
  const tokens = findVinLikeTokens(`one ${VIN} two WBA12345678901234 and ${VIN_PLACEHOLDER}`);
  assert.deepEqual(tokens, [VIN, "WBA12345678901234"]);
  assert.doesNotThrow(() => assertNoVinLikeTokens(`only ${VIN_PLACEHOLDER}`, "fixture"));
  assert.throws(() => assertNoVinLikeTokens(`a real one: ${VIN}`, "fixture"), /fixture/);
});

/** The smallest thing that is still a golden session, with a real VIN inside. */
function goldenSession(options: { vin: string }): GoldenSession {
  return {
    format: "vdp.golden",
    formatVersion: 1,
    id: "test-recipe",
    title: "Test recipe",
    provenance: {
      source: "simulator",
      recordedAt: "2026-01-01T00:00:00.000Z",
      recordedBy: "vitest",
      adapter: "virtual-can",
      definitions: { package: "generic", version: "1.0.0" },
      redaction: options.vin ? ["vin"] : [],
      note: `recorded ${options.vin}`,
    },
    expectations: {
      ecus: [{ ecu: "engine", rxId: 0x7e8 }],
      identity: { vin: options.vin, modelYear: 2003 },
      dtcs: [{ ecu: "engine", code: "P0420", status: 0x2f }],
      signals: [{ signal: "engine.rpm", ecu: "engine", min: 800, max: 900 }],
    },
    recording: {
      format: "vdp.session",
      meta: { vin: options.vin },
      trace: [
        { t: 0, canId: 0x7e0, direction: "tx", payload: "0322F190" },
        ...VIN_FRAMES.map((entry) => ({ ...entry })),
      ],
    },
  };
}
