/**
 * Samples, markers and raw trace rows for the graph and the trace panel
 * (AGENTS 14, 16, 18).
 *
 * Split out of `backend.ts` (0.E E15). The rule that belongs in this file: the chart
 * consumes `numeric`, never the formatted string — precision and decimal separator are
 * presentation, and parsing them back would move formatting into the graph core
 * (AGENTS 14). The two formatters live here — `formatValue` because all three rows
 * format through it, `formatCanId` because an address has exactly one printed shape in
 * this app; `ecu-view.ts` imports both rather than repeating either (AGENTS 34.2).
 */

import type { MarkerInfo, MeasurementReading } from "@vdp/domain";
import { formatMeasuredValue } from "@vdp/shared";
import type { RawTraceEntry } from "@vdp/storage";

export interface SampleView {
  signal: string;
  name: string;
  /** Formatted for display — the UI shows this string verbatim. */
  value: string;
  /**
   * Numeric value for the graphs, `null` for textual/enum signals.
   * Charts must never parse a formatted string back into a number: the decimal
   * separator and the precision belong to the presentation layer (AGENTS 14).
   */
  numeric: number | null;
  /** Undecoded value next to the decoded one (AGENTS 34.7). */
  rawValue: number | string | boolean;
  rawHex: string;
  unit?: string;
  outOfRange: boolean;
  t: number;
  timestamp: string;
}

/** Marker on the shared time axis (AGENTS 16 "Event-Marker", AGENTS 20 DTC events). */
export interface MarkerView {
  id: string;
  t: number;
  timestamp: string;
  label: string;
  kind: "dtc" | "action" | "note" | "user" | "anomaly";
  detail?: string;
}

export interface TraceView {
  t: number;
  timestamp: string;
  canId: string;
  direction: "tx" | "rx";
  dlc: number;
  data: string;
  channel: string;
  extended: boolean;
}

export function toSampleView(reading: MeasurementReading): SampleView {
  return {
    signal: reading.signalId,
    name: reading.name ?? reading.signalId,
    value: formatValue(reading.value),
    numeric:
      typeof reading.value === "number" && Number.isFinite(reading.value) ? reading.value : null,
    rawValue: reading.rawValue,
    rawHex: reading.rawHex,
    ...(reading.unit ? { unit: reading.unit } : {}),
    outOfRange: reading.outOfRange,
    t: reading.t,
    timestamp: reading.timestamp,
  };
}

export function toMarkerView(marker: MarkerInfo): MarkerView {
  return {
    id: marker.markerId,
    t: marker.t,
    timestamp: marker.timestamp,
    label: marker.label,
    kind: marker.kind,
    ...(marker.detail ? { detail: marker.detail } : {}),
  };
}

export function toTraceView(entry: RawTraceEntry): TraceView {
  return {
    t: entry.t,
    timestamp: entry.timestamp,
    canId: entry.canIdHex,
    direction: entry.direction,
    dlc: entry.dlc,
    data: entry.payloadHex,
    channel: entry.channel,
    extended: entry.extended,
  };
}

/** CAN identifier as it is displayed and sent back by the UI (e.g. `0x7E8`). */
export function formatCanId(id: number): string {
  return `0x${id.toString(16).toUpperCase()}`;
}

/**
 * A reading as the graph labels it.
 *
 * The numeric branch is the shared rule (`formatMeasuredValue`) — this function only
 * adds the two kinds a signal can carry that are not numbers.
 */
export function formatValue(value: number | string | boolean): string {
  if (typeof value === "number") return formatMeasuredValue(value);
  return String(value);
}
