/**
 * Reading and writing golden-session files (master backlog P0 #10).
 *
 * The parser is strict on purpose. A golden session is evidence: a file that is
 * half-understood would turn a regression suite into a generator of green ticks.
 * Every field the runner relies on is checked here, and the error message names
 * the field and what was found — never just "invalid JSON".
 */

import {
  GOLDEN_FORMAT,
  GOLDEN_FORMAT_VERSION,
  type GoldenCheck,
  type GoldenDtcExpectation,
  type GoldenEcuExpectation,
  type GoldenExpectations,
  type GoldenIdentityExpectation,
  type GoldenProvenance,
  type GoldenRecording,
  type GoldenSession,
  type GoldenSignalExpectation,
  type GoldenSource,
  type GoldenTraceEntry,
} from "./format.js";

export class GoldenSessionFormatError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(`${field}: ${message}`);
    this.name = "GoldenSessionFormatError";
    this.field = field;
  }
}

const SOURCES: readonly GoldenSource[] = ["simulator", "vehicle", "bench"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, field: string, path: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new GoldenSessionFormatError(`${path}.${field}`, "expected a non-empty string");
  }
  return value;
}

function optionalString(
  record: Record<string, unknown>,
  field: string,
  path: string,
): string | undefined {
  const value = record[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new GoldenSessionFormatError(`${path}.${field}`, "expected a string");
  }
  return value;
}

function optionalNumber(
  record: Record<string, unknown>,
  field: string,
  path: string,
): number | undefined {
  const value = record[field];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new GoldenSessionFormatError(`${path}.${field}`, "expected a finite number");
  }
  return value;
}

function requireArray(record: Record<string, unknown>, field: string, path: string): unknown[] {
  const value = record[field];
  if (!Array.isArray(value)) {
    throw new GoldenSessionFormatError(`${path}.${field}`, "expected an array");
  }
  return value;
}

function parseHex(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw new GoldenSessionFormatError(path, "expected a hex string");
  }
  if (!/^[0-9a-fA-F]*$/.test(value)) {
    throw new GoldenSessionFormatError(path, `not a hex string: "${value}"`);
  }
  if (value.length % 2 !== 0) {
    throw new GoldenSessionFormatError(path, `hex string has an odd number of digits: "${value}"`);
  }
  return value.toUpperCase();
}

function parseTraceEntry(value: unknown, index: number): GoldenTraceEntry {
  const path = `recording.trace[${index}]`;
  if (!isRecord(value)) throw new GoldenSessionFormatError(path, "expected an object");
  const canId = optionalNumber(value, "canId", path);
  if (canId === undefined) throw new GoldenSessionFormatError(`${path}.canId`, "expected a number");
  const t = optionalNumber(value, "t", path) ?? 0;
  const direction = value.direction;
  if (direction !== "tx" && direction !== "rx") {
    throw new GoldenSessionFormatError(`${path}.direction`, `expected "tx" or "rx"`);
  }
  const entry: GoldenTraceEntry = {
    ...value,
    t,
    canId,
    direction,
    payload: parseHex(value.payload, `${path}.payload`),
  };
  return entry;
}

function parseRecording(value: unknown): GoldenRecording {
  if (!isRecord(value)) {
    throw new GoldenSessionFormatError("recording", "expected the vdp.session export object");
  }
  const format = value.format;
  if (format !== "vdp.session") {
    throw new GoldenSessionFormatError(
      "recording.format",
      `expected "vdp.session", found ${JSON.stringify(format)}`,
    );
  }
  const trace = requireArray(value, "trace", "recording").map(parseTraceEntry);
  if (trace.length === 0) {
    throw new GoldenSessionFormatError(
      "recording.trace",
      "a recording without frames proves nothing",
    );
  }
  const recording: GoldenRecording = {
    ...value,
    format: "vdp.session",
    trace,
  };
  if (!recording.trace.some((entry) => entry.direction === "tx")) {
    throw new GoldenSessionFormatError(
      "recording.trace",
      "no tester frame in the recording — a replay needs the requests",
    );
  }
  return recording;
}

function parseEcu(value: unknown, index: number): GoldenEcuExpectation {
  const path = `expectations.ecus[${index}]`;
  if (!isRecord(value)) throw new GoldenSessionFormatError(path, "expected an object");
  const rxId = optionalNumber(value, "rxId", path);
  if (rxId === undefined) throw new GoldenSessionFormatError(`${path}.rxId`, "expected a number");
  const unreachable = value.unreachable;
  if (unreachable !== undefined && typeof unreachable !== "boolean") {
    throw new GoldenSessionFormatError(`${path}.unreachable`, "expected a boolean");
  }
  return {
    ecu: requireString(value, "ecu", path),
    rxId,
    ...(unreachable === true ? { unreachable: true } : {}),
  };
}

function parseIdentity(value: unknown): GoldenIdentityExpectation {
  if (!isRecord(value)) {
    throw new GoldenSessionFormatError("expectations.identity", "expected an object");
  }
  const expectation: GoldenIdentityExpectation = { vin: requireString(value, "vin", "identity") };
  const manufacturer = optionalString(value, "manufacturer", "identity");
  const model = optionalString(value, "model", "identity");
  const modelYear = optionalNumber(value, "modelYear", "identity");
  if (manufacturer !== undefined) expectation.manufacturer = manufacturer;
  if (model !== undefined) expectation.model = model;
  if (modelYear !== undefined) expectation.modelYear = modelYear;
  if (value.vinDerived !== undefined) {
    if (!Array.isArray(value.vinDerived)) {
      throw new GoldenSessionFormatError("identity.vinDerived", "expected an array of field names");
    }
    for (const [index, entry] of value.vinDerived.entries()) {
      if (typeof entry !== "string" || entry.length === 0) {
        throw new GoldenSessionFormatError(
          `identity.vinDerived[${index}]`,
          "expected a field name",
        );
      }
    }
    if (value.vinDerived.length > 0) expectation.vinDerived = value.vinDerived as string[];
  }
  return expectation;
}

function parseDtc(value: unknown, index: number): GoldenDtcExpectation {
  const path = `expectations.dtcs[${index}]`;
  if (!isRecord(value)) throw new GoldenSessionFormatError(path, "expected an object");
  const status = value.status;
  if (status !== null && (typeof status !== "number" || !Number.isInteger(status))) {
    throw new GoldenSessionFormatError(`${path}.status`, "expected an integer status byte or null");
  }
  return {
    ecu: requireString(value, "ecu", path),
    code: requireString(value, "code", path),
    status: status === null ? null : (status as number),
  };
}

function parseSignal(value: unknown, index: number): GoldenSignalExpectation {
  const path = `expectations.signals[${index}]`;
  if (!isRecord(value)) throw new GoldenSessionFormatError(path, "expected an object");
  const equal = value.equal;
  if (
    equal !== undefined &&
    typeof equal !== "number" &&
    typeof equal !== "string" &&
    typeof equal !== "boolean"
  ) {
    throw new GoldenSessionFormatError(`${path}.equal`, "expected a number, string or boolean");
  }
  const min = optionalNumber(value, "min", path);
  const max = optionalNumber(value, "max", path);
  if (equal !== undefined && (min !== undefined || max !== undefined)) {
    throw new GoldenSessionFormatError(
      path,
      "declares `equal` and `min`/`max` — an expectation is one or the other",
    );
  }
  if (min !== undefined && max !== undefined && min > max) {
    throw new GoldenSessionFormatError(path, `min (${min}) is greater than max (${max})`);
  }
  const minSamples = optionalNumber(value, "minSamples", path);
  const ecu = optionalString(value, "ecu", path);
  return {
    signal: requireString(value, "signal", path),
    ...(ecu !== undefined ? { ecu } : {}),
    ...(equal !== undefined ? { equal } : {}),
    ...(min !== undefined ? { min } : {}),
    ...(max !== undefined ? { max } : {}),
    ...(minSamples !== undefined ? { minSamples } : {}),
  };
}

function parseExpectations(value: unknown): GoldenExpectations {
  if (!isRecord(value)) {
    throw new GoldenSessionFormatError("expectations", "expected an object");
  }
  return {
    ecus: requireArray(value, "ecus", "expectations").map(parseEcu),
    ...(value.identity !== undefined ? { identity: parseIdentity(value.identity) } : {}),
    dtcs: requireArray(value, "dtcs", "expectations").map(parseDtc),
    signals: requireArray(value, "signals", "expectations").map(parseSignal),
  };
}

function parseProvenance(value: unknown): GoldenProvenance {
  if (!isRecord(value)) {
    throw new GoldenSessionFormatError("provenance", "expected an object");
  }
  const source = value.source;
  if (typeof source !== "string" || !SOURCES.includes(source as GoldenSource)) {
    throw new GoldenSessionFormatError(
      "provenance.source",
      `expected one of ${SOURCES.join(", ")}, found ${JSON.stringify(source)}`,
    );
  }
  const definitions = value.definitions;
  if (!isRecord(definitions)) {
    throw new GoldenSessionFormatError("provenance.definitions", "expected an object");
  }
  const redaction = requireArray(value, "redaction", "provenance");
  for (const [index, entry] of redaction.entries()) {
    if (typeof entry !== "string") {
      throw new GoldenSessionFormatError(
        `provenance.redaction[${index}]`,
        'expected a field name such as "vin"',
      );
    }
  }
  const note = optionalString(value, "note", "provenance");
  return {
    source: source as GoldenSource,
    recordedAt: requireString(value, "recordedAt", "provenance"),
    recordedBy: requireString(value, "recordedBy", "provenance"),
    adapter: requireString(value, "adapter", "provenance"),
    definitions: {
      package: requireString(definitions, "package", "provenance.definitions"),
      version: requireString(definitions, "version", "provenance.definitions"),
    },
    redaction: redaction as string[],
    ...(note !== undefined ? { note } : {}),
  };
}

/** Parse and validate a golden session. Throws {@link GoldenSessionFormatError}. */
export function parseGoldenSession(json: string, where = "golden session"): GoldenSession {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new GoldenSessionFormatError(where, `not valid JSON: ${(error as Error).message}`);
  }
  if (!isRecord(parsed)) throw new GoldenSessionFormatError(where, "expected a JSON object");
  const format = parsed.format;
  if (format !== GOLDEN_FORMAT) {
    throw new GoldenSessionFormatError(
      "format",
      `not a ${GOLDEN_FORMAT} export (format: ${JSON.stringify(format)})`,
    );
  }
  const formatVersion = parsed.formatVersion;
  if (formatVersion !== GOLDEN_FORMAT_VERSION) {
    throw new GoldenSessionFormatError(
      "formatVersion",
      `unsupported version ${JSON.stringify(formatVersion)} — this build reads ${GOLDEN_FORMAT_VERSION}`,
    );
  }
  return {
    format: GOLDEN_FORMAT,
    formatVersion: GOLDEN_FORMAT_VERSION,
    id: requireString(parsed, "id", where),
    title: requireString(parsed, "title", where),
    recording: parseRecording(parsed.recording),
    expectations: parseExpectations(parsed.expectations),
    provenance: parseProvenance(parsed.provenance),
  };
}

/** Indent and line width of the checked-in fixtures; both come from `biome.json`. */
const JSON_INDENT = 2;
const JSON_LINE_WIDTH = 100;

function isPrimitive(value: unknown): boolean {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

/**
 * Pretty-print JSON the way the repository's formatter does.
 *
 * The fixtures are generated *and* committed, and `biome check .` runs over the
 * whole tree (ADR 0026 §3: no exemption path for production files). A writer whose
 * output the formatter would immediately rewrite leaves two bad options — an ignore
 * rule for the fixtures, or a formatting step nobody runs — so it prints the shape
 * the gate expects: objects always expanded, arrays of primitives inline while they
 * fit the line width, everything else expanded.
 */
function formatJson(value: unknown, depth: number, prefixWidth: number): string {
  const indent = " ".repeat(depth * JSON_INDENT);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    if (value.every(isPrimitive)) {
      const inline = `[${value.map((entry) => JSON.stringify(entry)).join(", ")}]`;
      if (prefixWidth + inline.length <= JSON_LINE_WIDTH) return inline;
    }
    const entries = value.map(
      (entry) =>
        `${" ".repeat((depth + 1) * JSON_INDENT)}${formatJson(entry, depth + 1, (depth + 1) * JSON_INDENT)}`,
    );
    return `[\n${entries.join(",\n")}\n${indent}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).filter((key) => record[key] !== undefined);
    if (keys.length === 0) return "{}";
    const entries = keys.map((key) => {
      const name = JSON.stringify(key);
      const childPrefix = (depth + 1) * JSON_INDENT + name.length + 2;
      return `${" ".repeat((depth + 1) * JSON_INDENT)}${name}: ${formatJson(record[key], depth + 1, childPrefix)}`;
    });
    return `{\n${entries.join(",\n")}\n${indent}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Serialise a golden session with a stable key order, so re-recording a fixture
 * produces a reviewable diff instead of a reshuffled file.
 */
export function goldenSessionToJson(session: GoldenSession): string {
  const ordered = {
    format: session.format,
    formatVersion: session.formatVersion,
    id: session.id,
    title: session.title,
    provenance: session.provenance,
    expectations: session.expectations,
    recording: session.recording,
  };
  return `${formatJson(ordered, 0, 0)}\n`;
}

/** Compact one-line summary of a run, for logs and CLI output. */
export function summariseChecks(checks: readonly GoldenCheck[]): string {
  const failed = checks.filter((check) => !check.ok && !check.skipped);
  const skipped = checks.filter((check) => check.skipped).length;
  const parts = [`${checks.length - failed.length - skipped} ok`];
  if (skipped > 0) parts.push(`${skipped} skipped`);
  if (failed.length > 0) parts.push(`${failed.length} failed`);
  return parts.join(", ");
}
