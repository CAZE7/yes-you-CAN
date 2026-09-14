import assert from "node:assert/strict";
import { test } from "vitest";
import { GOLDEN_FORMAT, GOLDEN_FORMAT_VERSION, type GoldenCheck } from "./format.js";
import {
  GoldenSessionFormatError,
  goldenSessionToJson,
  parseGoldenSession,
  summariseChecks,
} from "./parse.js";

/** A minimal file that satisfies every rule; each test breaks exactly one. */
function goldenJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    format: GOLDEN_FORMAT,
    formatVersion: GOLDEN_FORMAT_VERSION,
    id: "generic-baseline",
    title: "Generic baseline",
    provenance: {
      source: "simulator",
      recordedAt: "2026-01-01T00:00:00.000Z",
      recordedBy: "vitest",
      adapter: "virtual-can",
      definitions: { package: "generic", version: "1.0.0" },
      redaction: ["vin"],
    },
    expectations: {
      ecus: [{ ecu: "engine", rxId: 0x7e8 }],
      identity: { vin: "REDACTED-VIN-0000" },
      dtcs: [{ ecu: "engine", code: "P0420", status: 0x2f }],
      signals: [{ signal: "engine.rpm", ecu: "engine", equal: 850 }],
    },
    recording: {
      format: "vdp.session",
      trace: [{ t: 0, canId: 0x7e0, direction: "tx", payload: "023e00" }],
    },
    ...overrides,
  });
}

function expectFormatError(json: string, field: string): void {
  assert.throws(
    () => parseGoldenSession(json, "fixture"),
    (error: unknown) => {
      assert.ok(error instanceof GoldenSessionFormatError, `expected format error, got ${error}`);
      assert.equal(error.field, field);
      return true;
    },
  );
}

test("a well-formed file parses and normalises the hex payloads", () => {
  const session = parseGoldenSession(goldenJson(), "fixture");
  assert.equal(session.id, "generic-baseline");
  assert.equal(session.recording.trace[0]?.payload, "023E00", "hex is upper case in the model");
  assert.equal(session.expectations.identity?.vin, "REDACTED-VIN-0000");
  assert.equal(session.expectations.signals[0]?.equal, 850);
});

test("format and version are checked before anything else", () => {
  expectFormatError(goldenJson({ format: "vdp.trace" }), "format");
  expectFormatError(goldenJson({ formatVersion: GOLDEN_FORMAT_VERSION + 1 }), "formatVersion");
  expectFormatError(goldenJson({ formatVersion: undefined }), "formatVersion");
  expectFormatError("not json at all", "fixture");
  expectFormatError("[]", "fixture");
});

test("a recording without requests cannot be replayed", () => {
  expectFormatError(
    goldenJson({
      recording: { format: "vdp.session", trace: [] },
    }),
    "recording.trace",
  );
  expectFormatError(
    goldenJson({
      recording: {
        format: "vdp.session",
        trace: [{ t: 0, canId: 0x7e8, direction: "rx", payload: "027E00" }],
      },
    }),
    "recording.trace",
  );
  expectFormatError(
    goldenJson({
      recording: {
        format: "vdp.other",
        trace: [{ t: 0, canId: 1, direction: "tx", payload: "00" }],
      },
    }),
    "recording.format",
  );
});

test("trace entries are validated field by field", () => {
  const withTrace = (entry: unknown): string =>
    goldenJson({ recording: { format: "vdp.session", trace: [entry] } });
  expectFormatError(
    withTrace({ t: 0, canId: 1, direction: "sideways", payload: "00" }),
    "recording.trace[0].direction",
  );
  expectFormatError(
    withTrace({ t: 0, direction: "tx", payload: "00" }),
    "recording.trace[0].canId",
  );
  expectFormatError(
    withTrace({ t: 0, canId: 1, direction: "tx", payload: "0G" }),
    "recording.trace[0].payload",
  );
  expectFormatError(
    withTrace({ t: 0, canId: 1, direction: "tx", payload: "0" }),
    "recording.trace[0].payload",
  );
  expectFormatError(withTrace("nope"), "recording.trace[0]");
});

test("signal expectations may carry a value or a range, never both", () => {
  const withSignal = (signal: unknown): string =>
    goldenJson({ expectations: { ecus: [], dtcs: [], signals: [signal] } });
  expectFormatError(
    withSignal({ signal: "engine.rpm", equal: 1, min: 0 }),
    "expectations.signals[0]",
  );
  expectFormatError(
    withSignal({ signal: "engine.rpm", min: 5, max: 1 }),
    "expectations.signals[0]",
  );
  expectFormatError(withSignal({ signal: "", min: 1 }), "expectations.signals[0].signal");
  expectFormatError(
    withSignal({ signal: "engine.rpm", equal: null }),
    "expectations.signals[0].equal",
  );
  // min/max without a value and minSamples are fine — a non-constant signal is
  // witnessed by its samples.
  const session = parseGoldenSession(
    withSignal({ signal: "engine.rpm", min: 1, max: 2, minSamples: 3 }),
  );
  assert.equal(session.expectations.signals[0]?.minSamples, 3);
});

test("fault-memory expectations require an integer status byte or an explicit null", () => {
  const withDtc = (dtc: unknown): string =>
    goldenJson({ expectations: { ecus: [], dtcs: [dtc], signals: [] } });
  expectFormatError(
    withDtc({ ecu: "engine", code: "P0420", status: 2.5 }),
    "expectations.dtcs[0].status",
  );
  expectFormatError(withDtc({ ecu: "engine", code: "P0420" }), "expectations.dtcs[0].status");
  const session = parseGoldenSession(withDtc({ ecu: "engine", code: "P0420", status: null }));
  assert.equal(session.expectations.dtcs[0]?.status, null);
});

test("provenance names a known source and a definition package", () => {
  const provenance = (patch: Record<string, unknown>): string =>
    goldenJson({
      provenance: {
        source: "simulator",
        recordedAt: "2026-01-01T00:00:00.000Z",
        recordedBy: "vitest",
        adapter: "virtual-can",
        definitions: { package: "generic", version: "1.0.0" },
        redaction: ["vin"],
        ...patch,
      },
    });
  expectFormatError(provenance({ source: "guesswork" }), "provenance.source");
  expectFormatError(
    provenance({ definitions: { package: "generic" } }),
    "provenance.definitions.version",
  );
  expectFormatError(provenance({ definitions: undefined }), "provenance.definitions");
  expectFormatError(provenance({ redaction: [7] }), "provenance.redaction[0]");
  // `vehicle` and `bench` are the sources a real recording will claim.
  assert.equal(parseGoldenSession(provenance({ source: "vehicle" })).provenance.source, "vehicle");
});

test("vinDerived is a list of field names when present", () => {
  const withIdentity = (identity: unknown): string =>
    goldenJson({ expectations: { ecus: [], dtcs: [], signals: [], identity } });
  expectFormatError(withIdentity({ vin: "x", vinDerived: "model" }), "identity.vinDerived");
  expectFormatError(withIdentity({ vin: "x", vinDerived: [1] }), "identity.vinDerived[0]");
  expectFormatError(withIdentity({ vin: "" }), "identity.vin");
  const session = parseGoldenSession(withIdentity({ vin: "x", vinDerived: ["modelYear"] }));
  assert.deepEqual(session.expectations.identity?.vinDerived, ["modelYear"]);
});

test("goldenSessionToJson writes a stable key order and round-trips", () => {
  const session = parseGoldenSession(goldenJson());
  const json = goldenSessionToJson(session);
  assert.equal(json.endsWith("\n"), true);
  assert.deepEqual(Object.keys(JSON.parse(json) as object), [
    "format",
    "formatVersion",
    "id",
    "title",
    "provenance",
    "expectations",
    "recording",
  ]);
  assert.deepEqual(parseGoldenSession(json), session);
});

test("summariseChecks counts ok, skipped and failed separately", () => {
  const check = (ok: boolean, skipped?: boolean): GoldenCheck => ({
    name: "c",
    ok,
    expected: "e",
    actual: "a",
    ...(skipped === true ? { skipped: true } : {}),
  });
  assert.equal(summariseChecks([check(true), check(true)]), "2 ok");
  assert.equal(summariseChecks([check(true), check(true, true)]), "1 ok, 1 skipped");
  assert.equal(
    summariseChecks([check(true), check(true, true), check(false)]),
    "1 ok, 1 skipped, 1 failed",
  );
});
