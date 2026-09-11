/**
 * Session logging and raw CAN trace (AGENTS 17, 18).
 *
 * Two streams are kept apart by design:
 *  - decoded diagnostic data (measurements, DTCs, actions), and
 *  - the raw CAN trace, so any decoding problem stays reproducible later.
 *
 * Exports: CSV and JSON here; ZIP session packages and PDF reports live in the
 * storage and reports packages (AGENTS 17/21).
 */

import type { DtcRecord } from "@vdp/protocols-uds";
import { toHex } from "@vdp/shared";
import type { CanFrame } from "@vdp/transport-can";
import type { Marker, MeasurementSample } from "../measurements/recorder.js";

export interface RawTraceEntry {
  timestamp: string;
  t: number;
  canId: number;
  canIdHex: string;
  direction: "tx" | "rx";
  dlc: number;
  payload: Uint8Array;
  payloadHex: string;
  channel: string;
  extended: boolean;
  fd: boolean;
}

export interface DiagnosticLogEntry {
  timestamp: string;
  t: number;
  scope: string;
  message: string;
  fields?: Record<string, unknown>;
}

export interface SessionLogOptions {
  /** Cap the raw trace so a long recording cannot exhaust memory. */
  maxTraceEntries?: number;
  clock?: () => number;
}

export class SessionLogger {
  private readonly trace: RawTraceEntry[] = [];
  private readonly logEntries: DiagnosticLogEntry[] = [];
  private readonly startedAt: number;
  private readonly clock: () => number;
  private readonly maxTraceEntries: number;

  constructor(options: SessionLogOptions = {}) {
    this.clock = options.clock ?? (() => Date.now());
    this.startedAt = this.clock();
    this.maxTraceEntries = options.maxTraceEntries ?? 200_000;
  }

  get traceLength(): number {
    return this.trace.length;
  }

  recordFrame(frame: CanFrame): RawTraceEntry {
    const at = frame.timestamp || this.clock();
    const entry: RawTraceEntry = {
      timestamp: new Date(at).toISOString(),
      t: at - this.startedAt,
      canId: frame.id,
      canIdHex: `0x${frame.id.toString(16).toUpperCase()}`,
      direction: frame.direction ?? "rx",
      dlc: frame.dlc,
      // The adapter may reuse its buffer, so the evidence is copied out:
      // `payloadHex` is what the exports read and `payload` is what a replay feeds
      // back into a bus, and neither may change after this entry was recorded.
      payload: frame.payload.slice(),
      payloadHex: toHex(frame.payload, ""),
      channel: frame.channel,
      extended: frame.extended,
      fd: frame.fd,
    };
    this.trace.push(entry);
    if (this.trace.length > this.maxTraceEntries)
      this.trace.splice(0, this.trace.length - this.maxTraceEntries);
    return entry;
  }

  log(scope: string, message: string, fields?: Record<string, unknown>): DiagnosticLogEntry {
    const at = this.clock();
    const entry: DiagnosticLogEntry = {
      timestamp: new Date(at).toISOString(),
      t: at - this.startedAt,
      scope,
      message,
      ...(fields ? { fields } : {}),
    };
    this.logEntries.push(entry);
    return entry;
  }

  /** Raw trace filtered to one identifier — the common case when debugging. */
  traceFor(canId: number): RawTraceEntry[] {
    return this.trace.filter((entry) => entry.canId === canId);
  }

  /** Request/response pairs per identifier, for the trace analyzer tool. */
  pairs(): Array<{ request: RawTraceEntry; response: RawTraceEntry | null }> {
    const result: Array<{ request: RawTraceEntry; response: RawTraceEntry | null }> = [];
    for (let i = 0; i < this.trace.length; i++) {
      const entry = this.trace[i] as RawTraceEntry;
      if (entry.direction !== "tx") continue;
      const response = this.trace.slice(i + 1).find((later) => later.direction === "rx") ?? null;
      result.push({ request: entry, response });
    }
    return result;
  }

  get entries(): readonly DiagnosticLogEntry[] {
    return this.logEntries;
  }

  // ------------------------------------------------------------- exports

  /**
   * CSV export of measurement samples (AGENTS 17).
   * Semicolon separated with a dot decimal separator is avoided on purpose: the
   * RFC 4180 comma form is what every tool understands.
   */
  static toCsv(samples: readonly MeasurementSample[], markers: readonly Marker[] = []): string {
    const header = "timestamp,t_ms,signal,value,raw_value,raw_hex,unit,enum_text,out_of_range";
    const lines = [header];
    for (const sample of samples) {
      lines.push(
        [
          csvValue(sample.timestamp),
          String(sample.t),
          csvValue(sample.signal),
          csvValue(formatValue(sample.value)),
          csvValue(formatValue(sample.rawValue)),
          csvValue(sample.rawHex),
          csvValue(sample.unit ?? ""),
          csvValue(sample.enumText ?? ""),
          sample.outOfRange ? "true" : "false",
        ].join(","),
      );
    }
    if (markers.length > 0) {
      lines.push("");
      lines.push("# markers");
      lines.push("timestamp,t_ms,label,kind,detail");
      for (const marker of markers) {
        lines.push(
          [
            csvValue(marker.timestamp),
            String(marker.t),
            csvValue(marker.label),
            csvValue(marker.kind),
            csvValue(marker.detail ?? ""),
          ].join(","),
        );
      }
    }
    return `${lines.join("\n")}\n`;
  }

  /** Raw CAN trace as CSV (AGENTS 18). */
  static traceToCsv(entries: readonly RawTraceEntry[]): string {
    const lines = ["timestamp,t_ms,can_id,direction,dlc,payload,channel,extended,fd"];
    for (const entry of entries) {
      lines.push(
        [
          csvValue(entry.timestamp),
          String(entry.t),
          entry.canIdHex,
          entry.direction,
          String(entry.dlc),
          csvValue(entry.payloadHex),
          csvValue(entry.channel),
          entry.extended ? "true" : "false",
          entry.fd ? "true" : "false",
        ].join(","),
      );
    }
    return `${lines.join("\n")}\n`;
  }

  /** JSON export — lossless, raw and decoded values side by side. */
  static toJson(payload: {
    meta: Record<string, unknown>;
    samples: readonly MeasurementSample[];
    markers: readonly Marker[];
    dtcs: readonly DtcRecord[];
    trace: readonly RawTraceEntry[];
    log: readonly DiagnosticLogEntry[];
  }): string {
    return JSON.stringify(
      {
        format: "vdp.session",
        formatVersion: 1,
        exportedAt: new Date().toISOString(),
        meta: payload.meta,
        measurements: payload.samples,
        markers: payload.markers,
        dtcs: payload.dtcs,
        trace: payload.trace.map((entry) => ({ ...entry, payload: entry.payloadHex })),
        log: payload.log,
      },
      null,
      2,
    );
  }

  snapshot(): { trace: RawTraceEntry[]; log: DiagnosticLogEntry[] } {
    return { trace: [...this.trace], log: [...this.logEntries] };
  }
}

/** Quote exactly what RFC 4180 requires quoted, doubling embedded quotes. */
function csvValue(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n") || value.includes("\r"))
    return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/**
 * Values are written the way JavaScript prints them: the export adds no formatting
 * layer of its own, so a CSV cell and the decoded sample always agree. A value that
 * is missing stays an empty cell rather than the word "undefined", which a
 * spreadsheet would otherwise read as data.
 */
function formatValue(value: number | string | boolean | null | undefined): string {
  return value === null || value === undefined ? "" : String(value);
}
