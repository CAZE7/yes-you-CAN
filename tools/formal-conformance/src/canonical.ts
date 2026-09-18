/**
 * The canonical vocabulary of the conformance vectors (ADR 0045).
 *
 * A vector names frames, errors and results *in its own words* — never in the
 * words of an implementation. The same file therefore drives three readers:
 *
 * - the TypeScript runner, which maps canonical frames onto real CAN frames and
 *   maps the production implementation back onto canonical results;
 * - the Haskell reference (`formal/ConformanceDriver.hs`), which runs the same
 *   frames through the step functions of `IsoTpStateMachine`/`SafetyCore`;
 * - the report, which compares both results field by field.
 *
 * The wire encoding rule (classic CAN, 8-byte frames, normal addressing) — this
 * is the one table every reader must agree on, so it lives here as data and as
 * the only codec:
 *
 * - Single Frame: `0x0N` then N payload bytes (N 1..7)
 * - First Frame: `0x1H LL` then the first data bytes, H = high nibble of the
 *   total length, LL its low byte; total length 8..4095
 * - Consecutive Frame: `0x2S` then at most 7 payload bytes, S the sequence
 *   number (1..15, wrapping to 0)
 * - Flow Control: `0x3F BS ST`, F the status (0 CTS, 1 Wait, 2 Overflow), BS the
 *   block size, ST the STmin byte (0..127 ms)
 *
 * Frames shorter than their declared content are legal *input* (a malformed
 * sender is part of the domain); sent frames are encoded at exact length.
 */

/** One frame in canonical form — the shape vectors use for input and output. */
export type IsoTpFrame =
  | { pci: "single"; payload: number[] }
  | { pci: "first"; totalLength: number; payload: number[] }
  | { pci: "consecutive"; sn: number; payload: number[] }
  | { pci: "flow-control"; status: number; blockSize: number; stMin: number };

/**
 * The closed set of failure classes the modelled domain distinguishes.
 *
 * These names are the *contract* between the two implementations: the transport
 * reports what happened, and only this tool decides which class it is. The
 * mapping from a production error to a class is structured first (error
 * details), and any error the mapping does not know is a tool failure — never a
 * silent pass.
 */
export const ISO_TP_ERROR_CLASSES = [
  "empty-payload",
  "message-too-long",
  "timeout-nBs",
  "timeout-nCr",
  "timeout-response",
  "wftmax",
  "buffer-overflow",
] as const;

export type IsoTpErrorClass = (typeof ISO_TP_ERROR_CLASSES)[number];

/**
 * The comparable result of one ISO-TP vector run.
 *
 * `delivered`/`response`: the payload the application would see.
 * `counters`: what the connection recorded of the transcript (deltas of its
 * own stats, so the vector never depends on a log line).
 * Internal state is deliberately absent: a vector asserts observable
 * behaviour — delivery, emitted frames, counters — not field names.
 */
export interface IsoTpResult {
  delivered: number[] | null;
  error: IsoTpErrorClass | null;
  sentFrames: IsoTpFrame[];
  counters: { sequenceErrors: number; timeouts: number; retries: number };
}

/* ------------------------------------------------------------------ safety */

/** The failure classes of the safety rule set, shared by both models. */
export const SAFETY_ERROR_CLASSES = ["refused", "expired"] as const;
export type SafetyErrorClass = (typeof SAFETY_ERROR_CLASSES)[number];

/** Transaction states the stage machine can end in (canonical names). */
export const SAFETY_STATES = [
  "open",
  "prepared",
  "confirmed",
  "executed",
  "verified",
  "suspended",
  "aborted",
  "rolled-back",
] as const;
export type SafetyState = (typeof SAFETY_STATES)[number];

export interface SafetyPrecheckResult {
  granted: boolean;
  failed: number;
  unproven: number;
}

export interface SafetyFlowResult {
  ok: boolean;
  state: SafetyState;
  writeReached: boolean;
  verified: boolean;
  rolledBack: boolean;
  failed: number;
  unproven: number;
}

export interface SafetyStagesResult {
  state: SafetyState;
  stageOk: boolean[];
}

export type SafetyResult =
  | ({ kind: "precheck" } & SafetyPrecheckResult)
  | ({ kind: "flow" } & SafetyFlowResult)
  | ({ kind: "stages" } & SafetyStagesResult);

/** A vector result as the driver emits it: a name and one comparable object. */
export interface NamedResult {
  name: string;
  result: IsoTpResult | SafetyResult;
}

/* ------------------------------------------------------------------- codec */

export class FrameError extends Error {}

/** Encode one canonical frame to its payload bytes (exact length, no padding). */
export function encodeFrame(frame: IsoTpFrame): number[] {
  switch (frame.pci) {
    case "single":
      if (frame.payload.length < 1 || frame.payload.length > 7) {
        throw new FrameError(`single frame carries 1..7 bytes, got ${frame.payload.length}`);
      }
      return [frame.payload.length, ...frame.payload];
    case "first": {
      const { totalLength } = frame;
      if (totalLength < 8 || totalLength > 4095) {
        throw new FrameError(`first frame totalLength must be 8..4095, got ${totalLength}`);
      }
      if (frame.payload.length > 6) {
        throw new FrameError("first frame carries at most 6 bytes on classic CAN");
      }
      return [0x10 | ((totalLength >>> 8) & 0x0f), totalLength & 0xff, ...frame.payload];
    }
    case "consecutive":
      if (frame.sn < 0 || frame.sn > 15) {
        throw new FrameError(`sequence number must be 0..15, got ${frame.sn}`);
      }
      if (frame.payload.length < 1 || frame.payload.length > 7) {
        throw new FrameError(`consecutive frame carries 1..7 bytes, got ${frame.payload.length}`);
      }
      return [0x20 | (frame.sn & 0x0f), ...frame.payload];
    case "flow-control":
      if (frame.status < 0 || frame.status > 2) {
        throw new FrameError(`flow control status must be 0..2, got ${frame.status}`);
      }
      return [0x30 | (frame.status & 0x0f), frame.blockSize, frame.stMin];
  }
}

/**
 * Decode one wire frame. `null` means “not a known PCI” — the same class of
 * event both models treat as an unknown frame.
 */
export function decodeFrame(bytes: readonly number[]): IsoTpFrame | null {
  const pci = bytes[0];
  if (pci === undefined) return null;
  const type = pci & 0xf0;
  if (type === 0x00) {
    const declared = pci & 0x0f;
    // The escape form belongs to CAN FD and is out of the modelled domain; a
    // reserved length 0 decodes to no frame the way both models refuse it.
    if (declared === 0) return null;
    return { pci: "single", payload: bytes.slice(1, 1 + declared) };
  }
  if (type === 0x10) {
    const ffDl = ((pci & 0x0f) << 8) | (bytes[1] ?? 0);
    // Escape form or impossible 12-bit lengths are “unknown” in the modelled
    // domain — mirrors the transport's refusal rather than inventing a class.
    if (ffDl === 0 || ffDl < 8) return null;
    return { pci: "first", totalLength: ffDl, payload: bytes.slice(2) };
  }
  if (type === 0x20) {
    return { pci: "consecutive", sn: pci & 0x0f, payload: bytes.slice(1) };
  }
  if (type === 0x30) {
    return {
      pci: "flow-control",
      status: pci & 0x0f,
      blockSize: bytes[1] ?? 0,
      stMin: bytes[2] ?? 0,
    };
  }
  return null;
}

/**
 * Decode the frames a run put on the wire. Anything an implementation sends
 * that the codec cannot name is a tool failure — the mapping refuses to hide a
 * deviation behind a placeholder.
 */
export function decodeCapturedFrames(frames: readonly (readonly number[])[]): IsoTpFrame[] {
  return frames.map((bytes) => {
    const frame = decodeFrame(bytes);
    if (frame === null) {
      throw new FrameError(`sent frame with an unknown PCI: [${bytes.join(", ")}]`);
    }
    return frame;
  });
}

/**
 * Canonical JSON: sorted keys, no insignificant whitespace.
 *
 * Both sides build their result objects differently; equality is defined on
 * this rendering, so a key order that differs never reads as a deviation.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** Field-wise difference paths of two canonical results (`[]` means equal). */
export function diffPaths(expected: unknown, actual: unknown): string[] {
  const diffs: string[] = [];
  walk("", expected, actual, diffs);
  return diffs;
}

function walk(path: string, a: unknown, b: unknown, out: string[]): void {
  if (Object.is(a, b)) return;
  if (Array.isArray(a) && Array.isArray(b)) {
    const shared = Math.max(a.length, b.length);
    for (let i = 0; i < shared; i++) walk(`${path}[${i}]`, a[i], b[i], out);
    return;
  }
  if (
    typeof a === "object" &&
    a !== null &&
    typeof b === "object" &&
    b !== null &&
    !Array.isArray(a) &&
    !Array.isArray(b)
  ) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of [...keys].sort()) {
      walk(
        path === "" ? key : `${path}.${key}`,
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
        out,
      );
    }
    return;
  }
  out.push(path === "" ? "<root>" : path);
}
