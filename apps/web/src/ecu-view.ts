/**
 * One ECU on the bus, and the freeze frame of one of its codes (AGENTS 12, 20).
 *
 * Split out of `backend.ts` with no behaviour change (0.E E15): both are projections of
 * a runtime read model, and the CAN-id formatting lives here next to the rows that use
 * it, in one definition rather than three inline `toString(16)` calls.
 */

import type { EcuSummary, FreezeFrameInfo } from "@vdp/domain";
import { formatCanId, formatValue } from "./trace-view.js";

export interface EcuView {
  id: string;
  name: string;
  txId: string;
  rxId: string;
  extended: boolean;
  reachable: boolean;
  identification: Array<{ label: string; value: string }>;
  services: string[];
  sessionType: number;
  p2Ms: number;
  dtcCount: number;
  lastError?: string;
}

/**
 * Freeze frame of a fault code, as shown in the UI (AGENTS 20).
 *
 * Decoded values and raw bytes both travel to the front end so an operator can
 * see that a value came from a byte range, not from a guess.
 */
export interface FreezeFrameView {
  code: string;
  recordNumber: number;
  documented: boolean;
  notes: string[];
  unassignedHex: string;
  fields: Array<{
    did: string;
    name: string;
    rawHex: string;
    values: Array<{
      signal: string;
      name: string;
      value: string;
      unit?: string;
      rawHex: string;
      outOfRange: boolean;
    }>;
  }>;
}

export function toEcuView(summary: EcuSummary): EcuView {
  return {
    id: summary.ecuId,
    name: summary.name,
    txId: formatCanId(summary.txId),
    rxId: formatCanId(summary.rxId),
    extended: summary.extended,
    reachable: summary.reachable,
    identification: summary.identification.map((entry) => ({
      label: entry.label,
      value: entry.value,
    })),
    services: summary.supportedServices.map((sid) => `0x${sid.toString(16).toUpperCase()}`),
    sessionType: summary.sessionType,
    p2Ms: summary.p2Ms,
    dtcCount: summary.dtcCount,
    ...(summary.lastError ? { lastError: summary.lastError } : {}),
  };
}

export function toFreezeFrameView(info: FreezeFrameInfo): FreezeFrameView {
  return {
    code: info.code,
    recordNumber: info.recordNumber,
    documented: info.documented,
    notes: [...info.notes],
    unassignedHex: info.unassignedHex,
    fields: info.fields.map((field) => ({
      did: `0x${field.did.toString(16).toUpperCase()}`,
      name: field.name,
      rawHex: field.rawHex,
      values: field.values.map((value) => ({
        signal: value.signalId,
        name: value.name,
        value: formatValue(value.value),
        ...(value.unit ? { unit: value.unit } : {}),
        rawHex: value.rawHex,
        outOfRange: value.outOfRange,
      })),
    })),
  };
}
