/**
 * Freeze frames / environment data (AGENTS 20).
 *
 * A freeze frame is the ECU's own record of *where the vehicle was* when a fault
 * was stored. ISO 14229-1 defines the request (`0x19 0x04`
 * `reportDTCSnapshotRecordByDTCNumber`) but deliberately leaves the record layout
 * to the manufacturer — there is no standardized field order to decode against.
 *
 * Two consequences shape this module:
 *
 * 1. The layout comes from the definition package, never from code (AGENTS 13).
 * 2. A record the package does not describe is **not** interpreted. It is returned
 *    with `documented: false` and its raw bytes intact, because raw bytes are
 *    evidence and a plausible-looking guess is not.
 */

import { toHex, type Logger } from '@vdp/shared';
import type { DtcDefinition, FreezeFrameField, SignalDefinition, SignalIndex } from '@vdp/definitions';
import type { DecodedSignal } from '../measurements/decoder.js';
import { SignalDecoder } from '../measurements/decoder.js';

export interface FreezeFrameFieldView {
  did: number;
  /** Label from the definition package, or the DID in hex. */
  name: string;
  rawHex: string;
  values: DecodedSignal[];
}

export interface FreezeFrame {
  dtcCode: string;
  recordNumber: number;
  /** True when every byte of the record is covered by a documented field. */
  documented: boolean;
  fields: FreezeFrameFieldView[];
  /** Bytes no documented field claimed, as hex (empty when fully documented). */
  unassignedHex: string;
  /** Everything the reader wants a human to know about this record. */
  notes: string[];
}

export interface DecodeFreezeFrameOptions {
  /** Fault code the record belongs to, as the ECU reports it. */
  code: string;
  recordNumber: number;
  /**
   * DTC definition of the active package. Its `freezeFrame` layout is what the
   * record is split with; without it the record stays raw.
   */
  definition?: DtcDefinition;
  /** Layout override for callers that do not hold the definition itself. */
  fields?: readonly FreezeFrameField[];
  /** Signals of the active definition package, keyed by signal id. */
  signals?: ReadonlyMap<string, SignalDefinition>;
  decoder?: SignalDecoder;
  logger?: Logger;
}

/**
 * Split and decode a freeze frame record.
 *
 * The fields are consumed in the order the definition declares, because that is
 * the only information available about the record: UDS does not transmit a DID
 * list inside a snapshot record on all ECUs, and where it does the encoding is
 * manufacturer specific.
 */
export function decodeFreezeFrame(payload: Uint8Array, options: DecodeFreezeFrameOptions): FreezeFrame {
  const declared = options.fields ?? options.definition?.freezeFrame ?? [];
  const signals = options.signals ?? new Map<string, SignalDefinition>();
  const decoder = options.decoder ?? new SignalDecoder();
  const notes: string[] = [];
  const fields: FreezeFrameFieldView[] = [];
  let offset = 0;

  if (declared.length === 0) {
    notes.push(
      payload.length === 0
        ? 'the ECU returned an empty snapshot record'
        : options.definition
          ? `the definition documents no freeze frame layout for ${options.code} — the record is kept raw (AGENTS 13)`
          : `no definition for ${options.code} — the record is kept raw instead of being interpreted (AGENTS 13, 24)`,
    );
    return {
      dtcCode: options.code,
      recordNumber: options.recordNumber,
      documented: false,
      fields,
      unassignedHex: toHex(payload),
      notes,
    };
  }

  for (const field of declared) {
    const fieldSignals = (field.signals ?? [])
      .map((id) => signals.get(id))
      .filter((signal): signal is SignalDefinition => signal !== undefined);
    const length = fieldLength(field, fieldSignals);
    if (length === undefined) {
      notes.push(
        `field 0x${field.did.toString(16).toUpperCase()} declares neither a length nor signals — the remaining ${payload.length - offset} bytes stay raw`,
      );
      break;
    }
    if (offset + length > payload.length) {
      notes.push(
        `record is shorter than the declared layout: ${payload.length - offset} bytes left, field 0x${field.did.toString(16).toUpperCase()} needs ${length}`,
      );
      break;
    }
    const valueBytes = payload.subarray(offset, offset + length);
    offset += length;

    const values: DecodedSignal[] = [];
    if (fieldSignals.length === 0) {
      notes.push(`field 0x${field.did.toString(16).toUpperCase()} has no signal definitions — its bytes are reported without interpretation`);
    }
    for (const signal of fieldSignals) {
      try {
        const decoded = decoder.decode(signal, valueBytes);
        // `null` means "the bytes do not cover this signal" — a short or
        // differently laid out record. Reported, never padded with a zero.
        if (!decoded) {
          notes.push(`signal ${signal.id} is not covered by the ${length} byte(s) of field 0x${field.did.toString(16).toUpperCase()}`);
          continue;
        }
        values.push(decoded);
      } catch (error) {
        // A single undecodable signal must not hide the rest of the record.
        notes.push(`signal ${signal.id} could not be decoded: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    fields.push({
      did: field.did,
      name: field.name ?? `DID 0x${field.did.toString(16).toUpperCase()}`,
      rawHex: toHex(valueBytes),
      values,
    });
  }

  const rest = payload.subarray(offset);
  if (rest.length > 0) {
    notes.push(`${rest.length} byte(s) are not covered by the documented layout — kept raw`);
  }
  if (declared.length > 0 && fields.length === 0 && payload.length > 0) {
    notes.push('the record could not be split with the documented layout — the bytes stay raw');
  }

  return {
    dtcCode: options.code,
    recordNumber: options.recordNumber,
    documented: fields.length === declared.length && rest.length === 0,
    fields,
    unassignedHex: toHex(rest),
    notes,
  };
}

/** Length of one field: declared explicitly, or derived from the highest signal. */
function fieldLength(field: FreezeFrameField, signals: readonly SignalDefinition[]): number | undefined {
  if (field.length !== undefined && field.length > 0) return field.length;
  if (signals.length === 0) return undefined;
  return signals.reduce((max, signal) => Math.max(max, signal.byteOffset + signal.length), 0);
}

/** Convenience wrapper for a caller that only has a signal index. */
export function signalMapOf(index: SignalIndex): ReadonlyMap<string, SignalDefinition> {
  return index.byId;
}
