/**
 * Offline trace analyzer (AGENTS 15, 21).
 *
 * Works purely on recorded data — no vehicle needed — which makes it usable for
 * protocol debugging and for replay/regression testing (AGENTS 31.5).
 *
 * Raw stays raw: nothing here reinterprets a frame as something it is not, and
 * decoded values are always reported next to the bytes they came from.
 */

import {
  type DefinitionPackage,
  type EcuDefinition,
  type SignalDefinition,
  type SignalIndex,
  indexPackage,
} from "@vdp/definitions";
import { NEGATIVE_RESPONSE_SID, POSITIVE_RESPONSE_OFFSET, serviceName } from "@vdp/protocols-uds";
import { toHex } from "@vdp/shared";
import type { CanFrame } from "@vdp/transport-can";

export interface TraceEntry {
  t: number;
  frame: CanFrame;
}

/** A parsed line whose timestamp may be absent (candump output carries none). */
export interface RawTraceLine {
  /** null means "the source did not record a timestamp" — not "t = 0". */
  t: number | null;
  frame: CanFrame;
}

export interface DecodedUdsResponse {
  serviceId: number;
  positive: boolean;
  did?: number;
  /** Response payload without the service identifier (and without the DID echo). */
  data?: Uint8Array;
  nrc?: number;
}

export interface IsoTpMessageSummary {
  /** Request identifier of the ISO-TP pair this message belongs to. */
  txId: number;
  /** Response identifier of the ISO-TP pair. */
  rxId: number;
  /** Identifier this message actually arrived on. */
  sourceId: number;
  /** Requests must never be decoded as if they were responses. */
  direction: "request" | "response";
  payload: string;
  bytes: Uint8Array;
  firstFrameT: number;
  lastFrameT: number;
  frames: number;
  decoded?: string;
  did?: number;
}

export interface CanIdSummary {
  canId: number;
  extended: boolean;
  frames: number;
  dlcDistribution: Record<string, number>;
  periodMs: number | null;
  firstT: number;
  lastT: number;
  known: boolean;
  name?: string;
}

export interface TraceFinding {
  kind:
    | "unknown-id"
    | "malformed"
    | "incomplete-transport-message"
    | "negative-response"
    | "high-rate"
    | "info";
  severity: "info" | "minor" | "major";
  message: string;
  canId?: number;
  t?: number;
}

export interface TraceAnalysis {
  frames: number;
  durationMs: number;
  ids: CanIdSummary[];
  messages: IsoTpMessageSummary[];
  findings: TraceFinding[];
  decodedSignals: Array<{ t: number; signal: string; value: number; unit?: string }>;
}

export interface AnalyzerOptions {
  definitions?: DefinitionPackage;
  /** Identifier pairs to rebuild as ISO-TP sessions; derived from definitions when omitted. */
  pairs?: Array<{ txId: number; rxId: number }>;
  /** Frames per second above which an identifier is reported as high-rate. */
  highRateFramesPerSecond?: number;
}

/** Parse one recorded frame line: platform NDJSON, candump output or CSV. */
export function parseTraceLine(line: string, channel = "trace"): RawTraceLine | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as {
        t?: number;
        canId?: number;
        extended?: boolean;
        dlc?: number;
        data?: number[] | string;
      };
      if (parsed.canId === undefined || parsed.data === undefined) return null;
      const payload =
        typeof parsed.data === "string" ? hexToBytes(parsed.data) : new Uint8Array(parsed.data);
      return {
        t: parsed.t ?? null,
        frame: {
          timestamp: parsed.t ?? 0,
          id: parsed.canId,
          extended: parsed.extended ?? false,
          fd: false,
          dlc: parsed.dlc ?? payload.length,
          payload,
          channel,
        },
      };
    } catch {
      return null;
    }
  }

  // candump: "  vcan0  7E0   [3]  02 3E 80" (3 hex digits = 11-bit, 8 = 29-bit)
  const candump = /^\s*\S+\s+([0-9A-Fa-f]{3,8})\s+\[(\d)\]\s+((?:[0-9A-Fa-f]{2}\s*)*)$/i.exec(
    trimmed,
  );
  if (candump) {
    const idText = candump[1] ?? "0";
    const payload = hexToBytes((candump[3] ?? "").replace(/\s+/g, ""));
    return {
      t: null,
      frame: {
        timestamp: 0,
        id: Number.parseInt(idText, 16),
        extended: idText.length > 3,
        fd: false,
        dlc: Number.parseInt(candump[2] ?? "0", 10),
        payload,
        channel,
      },
    };
  }

  // CSV: "t,canId,extended,dlc,data"
  const csv = /^([0-9.]+),([0-9]+),(true|false),(\d+),([0-9A-Fa-f ]*)$/.exec(trimmed);
  if (csv) {
    const payload = hexToBytes((csv[5] ?? "").replace(/\s+/g, ""));
    return {
      t: Number.parseFloat(csv[1] ?? "0"),
      frame: {
        timestamp: Number.parseFloat(csv[1] ?? "0"),
        id: Number.parseInt(csv[2] ?? "0", 10),
        extended: csv[3] === "true",
        fd: false,
        dlc: Number.parseInt(csv[4] ?? "0", 10),
        payload,
        channel,
      },
    };
  }
  return null;
}

export function parseTrace(content: string, channel = "trace"): TraceEntry[] {
  const entries: TraceEntry[] = [];
  let lastT = 0;
  for (const line of content.split("\n")) {
    const entry = parseTraceLine(line, channel);
    if (!entry) continue;
    // A source without timestamps (candump) gets a synthetic 1 ms grid so period
    // maths still works; a recorded t = 0 is a real timestamp and is kept as is.
    if (entry.t === null) {
      lastT += 1;
      entries.push({ t: lastT, frame: entry.frame });
    } else {
      lastT = entry.t;
      entries.push({ t: entry.t, frame: entry.frame });
    }
  }
  return entries;
}

/** Decode a UDS response payload: service, DID echo, data, or negative response. */
export function decodeUdsResponse(payload: Uint8Array): DecodedUdsResponse | null {
  const sid = payload[0];
  if (sid === undefined) return null;
  if (sid === NEGATIVE_RESPONSE_SID) {
    const requested = payload[1] ?? 0;
    const nrc = payload[2] ?? 0;
    return { serviceId: requested, positive: false, nrc };
  }
  const serviceId = sid - POSITIVE_RESPONSE_OFFSET;
  if (serviceId <= 0 || serviceId > 0x3f) return null;
  if (serviceId === 0x22 || serviceId === 0x2e) {
    const did = ((payload[1] ?? 0) << 8) | (payload[2] ?? 0);
    return { serviceId, positive: true, did, data: payload.subarray(3) };
  }
  return { serviceId, positive: true, data: payload.subarray(1) };
}

/** Decode a tester request payload (service, optional DID) for display. */
export function decodeUdsRequest(payload: Uint8Array): { serviceId: number; did?: number } | null {
  const sid = payload[0];
  if (sid === undefined || sid === NEGATIVE_RESPONSE_SID) return null;
  if (
    (payload[1] !== undefined && (sid === 0x22 || sid === 0x2e)) ||
    sid === 0x22 ||
    sid === 0x2e
  ) {
    const did = ((payload[1] ?? 0) << 8) | (payload[2] ?? 0);
    return { serviceId: sid, did };
  }
  return { serviceId: sid };
}

/** Analyse a trace: group identifiers, rebuild ISO-TP messages, decode what definitions allow. */
export function analyzeTrace(
  entries: readonly TraceEntry[],
  options: AnalyzerOptions = {},
): TraceAnalysis {
  const pkg = options.definitions;
  const ecusByAddress = indexEcuAddresses(pkg);
  const findings: TraceFinding[] = [];

  const ids = summarizeIdentifiers(
    entries,
    ecusByAddress,
    findings,
    options.highRateFramesPerSecond ?? 200,
  );
  const pairs = options.pairs ?? derivePairs(pkg, entries);
  const messages = rebuildIsoTpMessages(entries, pairs, findings);
  const decodedSignals = decodeMessages(
    messages,
    { ecusByAddress, ...(pkg ? { signalIndex: indexPackage(pkg) } : {}) },
    findings,
  );

  return {
    frames: entries.length,
    durationMs: traceDurationMs(entries),
    ids: ids.sort((a, b) => b.frames - a.frames),
    messages,
    findings,
    decodedSignals,
  };
}

/** Both identifiers of every defined ECU, so a frame is recognised in either direction. */
export function indexEcuAddresses(pkg: DefinitionPackage | undefined): Map<number, EcuDefinition> {
  const ecusByAddress = new Map<number, EcuDefinition>();
  for (const ecu of pkg?.ecus ?? []) {
    ecusByAddress.set(ecu.address.rxId, ecu);
    ecusByAddress.set(ecu.address.txId, ecu);
  }
  return ecusByAddress;
}

/**
 * Per identifier summary: frame count, DLC distribution, period and the
 * `unknown-id` findings for identifiers no definition package explains.
 *
 * Split out of `analyzeTrace` because the bus-load question needs the finished
 * summaries, not the raw frames — and a periodic identifier is exactly what an
 * operator asks about first (AGENTS 15).
 */
export function summarizeIdentifiers(
  entries: readonly TraceEntry[],
  ecusByAddress: ReadonlyMap<number, EcuDefinition>,
  findings: TraceFinding[],
  highRateFramesPerSecond = 200,
): CanIdSummary[] {
  const grouped = new Map<number, CanIdSummary>();

  for (const entry of entries) {
    const knownEcu = ecusByAddress.get(entry.frame.id);
    const existing = grouped.get(entry.frame.id);
    if (existing) {
      existing.frames++;
      existing.lastT = entry.t;
      const key = String(entry.frame.payload.length);
      existing.dlcDistribution[key] = (existing.dlcDistribution[key] ?? 0) + 1;
      continue;
    }
    grouped.set(entry.frame.id, {
      canId: entry.frame.id,
      extended: entry.frame.extended,
      frames: 1,
      dlcDistribution: { [String(entry.frame.payload.length)]: 1 },
      periodMs: null,
      firstT: entry.t,
      lastT: entry.t,
      known: knownEcu !== undefined,
      ...(knownEcu ? { name: knownEcu.name } : {}),
    });
    if (knownEcu === undefined) {
      findings.push({
        kind: "unknown-id",
        severity: "minor",
        message: `Identifier 0x${entry.frame.id.toString(16)} is not part of the loaded definition package`,
        canId: entry.frame.id,
        ...(entry.t ? { t: entry.t } : {}),
      });
    }
  }

  const summaries = Array.from(grouped.values(), (summary) => ({
    ...summary,
    periodMs:
      summary.frames > 1
        ? Number(((summary.lastT - summary.firstT) / (summary.frames - 1)).toFixed(1))
        : null,
  }));
  flagHighRate(summaries, findings, highRateFramesPerSecond);
  return summaries;
}

/** Bus load question: an identifier that floods the bus is a finding of its own. */
function flagHighRate(
  ids: readonly CanIdSummary[],
  findings: TraceFinding[],
  highRateFramesPerSecond: number,
): void {
  for (const summary of ids) {
    const seconds = (summary.lastT - summary.firstT) / 1000;
    if (seconds > 0 && summary.frames / seconds > highRateFramesPerSecond) {
      findings.push({
        kind: "high-rate",
        severity: "info",
        message: `0x${summary.canId.toString(16)} sends ${Math.round(summary.frames / seconds)} frames/s — check whether this bus load is expected`,
        canId: summary.canId,
      });
    }
  }
}

/** Elapsed time between the first and the last recorded frame. */
export function traceDurationMs(entries: readonly TraceEntry[]): number {
  if (entries.length < 2) return 0;
  return (entries.at(-1)?.t ?? 0) - (entries[0]?.t ?? 0);
}

/** What a message can be decoded against: the ECU it came from and its signals. */
export interface MessageDecodeContext {
  ecusByAddress: ReadonlyMap<number, EcuDefinition>;
  signalIndex?: SignalIndex;
}

/**
 * Annotate every rebuilt ISO-TP message with its UDS meaning and collect the
 * decoded signal values.
 *
 * Requests and responses never share a decode path: reading a request payload as
 * a response would report a positive answer that never happened (AGENTS 18 —
 * raw stays raw). Anything that cannot be decoded becomes a finding instead of a
 * guess, so the report distinguishes "not understood" from "understood and fine".
 */
export function decodeMessages(
  messages: IsoTpMessageSummary[],
  context: MessageDecodeContext,
  findings: TraceFinding[],
): TraceAnalysis["decodedSignals"] {
  const decodedSignals: TraceAnalysis["decodedSignals"] = [];

  for (const message of messages) {
    if (message.direction === "request") {
      const request = decodeUdsRequest(message.bytes);
      message.decoded = request
        ? `REQUEST ${serviceName(request.serviceId)}${request.did !== undefined ? ` 0x${request.did.toString(16).toUpperCase().padStart(4, "0")}` : ""}`
        : undefined;
      if (request?.did !== undefined) message.did = request.did;
      continue;
    }
    const response = decodeUdsResponse(message.bytes);
    if (!response) {
      findings.push({
        kind: "malformed",
        severity: "minor",
        message: `Payload on 0x${message.sourceId.toString(16)} is not a valid UDS response: ${message.payload}`,
        canId: message.sourceId,
        t: message.firstFrameT,
      });
      continue;
    }
    message.decoded = response.positive
      ? `${serviceName(response.serviceId)}${response.did !== undefined ? ` 0x${response.did.toString(16).toUpperCase().padStart(4, "0")}` : ""}`
      : `NEGATIVE ${serviceName(response.serviceId)} (NRC 0x${(response.nrc ?? 0).toString(16).padStart(2, "0")})`;
    if (response.did !== undefined) message.did = response.did;

    if (
      response.positive &&
      response.serviceId === 0x22 &&
      response.did !== undefined &&
      context.signalIndex &&
      response.data
    ) {
      const ecu = context.ecusByAddress.get(message.sourceId);
      const candidates = ecu
        ? (context.signalIndex.byDid.get(ecu.id)?.get(response.did) ?? [])
        : [];
      for (const signal of candidates) {
        const decoded = decodeSignalAt(signal, response.data);
        if (decoded) {
          decodedSignals.push({
            t: message.firstFrameT,
            signal: signal.id,
            value: decoded.value,
            ...(decoded.unit ? { unit: decoded.unit } : {}),
          });
        }
      }
    }
    if (!response.positive) {
      findings.push({
        kind: "negative-response",
        severity: "minor",
        message: `Negative response in trace on 0x${message.sourceId.toString(16)}: ${message.payload}`,
        canId: message.sourceId,
        t: message.firstFrameT,
      });
    }
  }
  return decodedSignals;
}

/** Rebuild ISO-TP messages from a trace: single frames plus first/consecutive frame runs. */
export function rebuildIsoTpMessages(
  entries: readonly TraceEntry[],
  pairs: ReadonlyArray<{ txId: number; rxId: number }>,
  findings: TraceFinding[],
): IsoTpMessageSummary[] {
  const messages: IsoTpMessageSummary[] = [];
  // Both directions of a pair are rebuilt: a trace usually contains requests and
  // responses, and half a conversation is not analyzable.
  const idToPair = new Map<
    number,
    { txId: number; rxId: number; direction: "request" | "response" }
  >();
  for (const pair of pairs) {
    idToPair.set(pair.rxId, { txId: pair.txId, rxId: pair.rxId, direction: "response" });
    idToPair.set(pair.txId, { txId: pair.txId, rxId: pair.rxId, direction: "request" });
  }

  const active = new Map<
    number,
    { parts: Uint8Array[]; expected: number; firstT: number; lastT: number; frames: number }
  >();

  for (const entry of entries) {
    const pair = idToPair.get(entry.frame.id);
    if (!pair) continue;
    const data = entry.frame.payload;
    if (data.length === 0) continue;
    const pci = (data[0] ?? 0) >> 4;

    if (pci === 0) {
      const length = data[0] ?? 0;
      if (length === 0 || length > data.length - 1) continue;
      const payload = data.subarray(1, 1 + length);
      messages.push({
        txId: pair.txId,
        rxId: pair.rxId,
        sourceId: entry.frame.id,
        direction: pair.direction,
        payload: toHex(payload),
        bytes: payload.slice(),
        firstFrameT: entry.t,
        lastFrameT: entry.t,
        frames: 1,
      });
    } else if (pci === 1) {
      const expected = (((data[0] ?? 0) & 0x0f) << 8) | (data[1] ?? 0);
      active.set(entry.frame.id, {
        parts: [data.subarray(2)],
        expected,
        firstT: entry.t,
        lastT: entry.t,
        frames: 1,
      });
    } else if (pci === 2) {
      const state = active.get(entry.frame.id);
      if (!state) continue;
      state.parts.push(data.subarray(1));
      state.lastT = entry.t;
      state.frames++;
      const total = state.parts.reduce((sum, part) => sum + part.length, 0);
      if (total >= state.expected) {
        const merged = concat(state.parts).subarray(0, state.expected);
        messages.push({
          txId: pair.txId,
          rxId: pair.rxId,
          sourceId: entry.frame.id,
          direction: pair.direction,
          payload: toHex(merged),
          bytes: merged.slice(),
          firstFrameT: state.firstT,
          lastFrameT: state.lastT,
          frames: state.frames,
        });
        active.delete(entry.frame.id);
      }
    }
  }

  for (const [canId, state] of active) {
    findings.push({
      kind: "incomplete-transport-message",
      severity: "major",
      message: `Multi-frame message on 0x${canId.toString(16)} never completed (${state.frames} frames seen, ${state.expected} bytes announced)`,
      canId,
      t: state.firstT,
    });
  }
  return messages;
}

/** Pairs come from definitions when available, otherwise from the diagnostic id pattern. */
export function derivePairs(
  pkg: DefinitionPackage | undefined,
  entries: readonly TraceEntry[],
): Array<{ txId: number; rxId: number }> {
  if (pkg) {
    return pkg.ecus.map((ecu) => ({ txId: ecu.address.txId, rxId: ecu.address.rxId }));
  }
  const seen = new Set(entries.map((entry) => entry.frame.id));
  const pairs: Array<{ txId: number; rxId: number }> = [];
  // ISO 15765-4 diagnostic response identifiers are 0x7E8–0x7EF and answer the
  // request identifier eight below. A captured response implies the pair even
  // when the request itself was not recorded.
  for (const canId of seen) {
    if (canId >= 0x7e8 && canId <= 0x7ef) pairs.push({ txId: canId - 8, rxId: canId });
  }
  return pairs;
}

function decodeSignalAt(
  signal: SignalDefinition,
  data: Uint8Array,
): { value: number; unit?: string } | null {
  let raw = 0;
  for (let i = 0; i < signal.length; i++) {
    const byte = data[signal.byteOffset + i];
    if (byte === undefined) return null;
    raw = (raw << 8) | byte;
  }
  return {
    value: raw * (signal.scale ?? 1) + (signal.offsetValue ?? 0),
    ...(signal.unit ? { unit: signal.unit } : {}),
  };
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/[^0-9a-f]/gi, "");
  const out = new Uint8Array(Math.floor(clean.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Human readable Markdown report for the UI and for logs. */
export function formatTraceReport(analysis: TraceAnalysis): string {
  const lines: string[] = ["# Trace analysis", ""];
  lines.push(
    `- Frames: ${analysis.frames}`,
    `- Duration: ${analysis.durationMs} ms`,
    `- Identifiers: ${analysis.ids.length}`,
    `- ISO-TP messages: ${analysis.messages.length}`,
    "",
    "## Identifiers",
    "",
    "| CAN ID | Frames | Period | DLCs | Known |",
    "|---|---|---|---|---|",
  );
  for (const id of analysis.ids.slice(0, 40)) {
    const dlcs = Object.entries(id.dlcDistribution)
      .map(([dlc, count]) => `${dlc}:${count}`)
      .join(" ");
    lines.push(
      `| 0x${id.canId.toString(16).toUpperCase()}${id.name ? ` (${id.name})` : ""} | ${id.frames} | ${id.periodMs ?? "—"} ms | ${dlcs} | ${id.known ? "yes" : "no"} |`,
    );
  }
  lines.push("", "## Decoded messages", "");
  for (const message of analysis.messages.slice(0, 40)) {
    lines.push(
      `- t=${message.firstFrameT} 0x${message.sourceId.toString(16)} ${message.direction} ${message.decoded ?? "raw"}: ${message.payload}`,
    );
  }
  lines.push("", "## Findings", "");
  for (const finding of analysis.findings.slice(0, 60)) {
    lines.push(`- **${finding.severity}** [${finding.kind}] ${finding.message}`);
  }
  return `${lines.join("\n")}\n`;
}
