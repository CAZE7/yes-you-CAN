/**
 * Measurement decoding (AGENTS 14).
 *
 * Raw bytes never reach the UI. Everything goes
 * raw response → decoder → signal → value + unit.
 * Raw and decoded values are kept separate end to end (AGENTS 34.7).
 */

import { DecodeError, ascii, readBitsBE, readFloat32BE, readIntBE, readUintBE, toHex, type Logger, createLogger } from '@vdp/shared';
import type { SignalDefinition } from '@vdp/definitions';

export interface DecodedSignal {
  signalId: string;
  name: string;
  /** Raw bytes the value was derived from — always stored (AGENTS 14/17). */
  raw: Uint8Array;
  rawHex: string;
  /** Raw integer/float before scale and offset. */
  rawValue: number | string | boolean;
  /** Physical value after scale/offset. */
  value: number | string | boolean;
  unit?: string;
  /** Enum text when the raw value matched an enumMapping entry. */
  enumText?: string;
  /** True when the physical value is outside the declared min/max range. */
  outOfRange: boolean;
  did: number;
  ecu: string;
}

export interface DecodeOptions {
  logger?: Logger;
  /** Throw on invalid input instead of returning null (used by protocol tests). */
  strict?: boolean;
}

export class SignalDecoder {
  private readonly log: Logger;
  private readonly strict: boolean;

  constructor(options: DecodeOptions = {}) {
    this.log = (options.logger ?? createLogger('decoder', { level: 'WARN' })).child('decoder');
    this.strict = options.strict ?? false;
  }

  /**
   * Decode one signal out of a DID payload.
   * `payload` is the data part of the 0x62 response (DID header already removed).
   */
  decode(signal: SignalDefinition, payload: Uint8Array): DecodedSignal | null {
    const start = signal.byteOffset;
    const end = start + signal.length;
    if (end > payload.length) {
      return this.fail(
        signal,
        `payload for DID 0x${signal.did.toString(16)} has ${payload.length} bytes but signal needs ${end}`,
      );
    }
    const slice = payload.subarray(start, end);

    if (signal.bitOffset !== undefined && signal.bitLength !== undefined) {
      const rawBits = readBitsBE(slice, signal.bitOffset, signal.bitLength);
      return this.finish(signal, slice, rawBits, rawBits);
    }

    switch (signal.encoding) {
      case 'ascii': {
        const text = ascii(slice);
        return this.finishText(signal, slice, text);
      }
      case 'bool': {
        const raw = (slice[0] ?? 0) !== 0;
        return this.finishBoolean(signal, slice, raw);
      }
      case 'bitmask': {
        const raw = signal.length === 1 ? (slice[0] ?? 0) : readUintBE(slice, 0, signal.length);
        return this.finish(signal, slice, raw, raw, { skipScaling: true });
      }
      case 'bcd': {
        let digits = '';
        for (const byte of slice) digits += byte.toString(16).padStart(2, '0');
        const raw = parseInt(digits, 10);
        if (!Number.isFinite(raw)) return this.fail(signal, `invalid BCD payload ${toHex(slice)}`);
        return this.finish(signal, slice, raw, raw);
      }
      case 'float32': {
        const raw = readFloat32BE(signal.endianness === 'little' ? reverse(slice) : slice, 0);
        return this.finish(signal, slice, raw, raw);
      }
      case 'uint8':
      case 'uint16':
      case 'uint24':
      case 'uint32': {
        const raw = readUintBE(signal.endianness === 'little' ? reverse(slice) : slice, 0, signal.length);
        return this.finish(signal, slice, raw, raw);
      }
      case 'int8':
      case 'int16':
      case 'int32': {
        const raw = readIntBE(signal.endianness === 'little' ? reverse(slice) : slice, 0, signal.length);
        return this.finish(signal, slice, raw, raw);
      }
      default:
        return this.fail(signal, `unsupported encoding "${signal.encoding}"`);
    }
  }

  /** Decode every signal of a DID payload. */
  decodeAll(signals: readonly SignalDefinition[], payload: Uint8Array): DecodedSignal[] {
    const results: DecodedSignal[] = [];
    for (const signal of signals) {
      const decoded = this.decode(signal, payload);
      if (decoded) results.push(decoded);
    }
    return results;
  }

  private finish(
    signal: SignalDefinition,
    slice: Uint8Array,
    rawValue: number,
    physicalInput: number,
    options: { skipScaling?: boolean } = {},
  ): DecodedSignal {
    const scale = signal.scale ?? 1;
    const offset = signal.offsetValue ?? 0;
    const value = options.skipScaling ? rawValue : round(physicalInput * scale + offset, scale);
    const enumText = signal.enumMapping ? signal.enumMapping[rawValue] : undefined;
    const outOfRange =
      typeof value === 'number' &&
      ((signal.min !== undefined && value < signal.min) || (signal.max !== undefined && value > signal.max));
    if (outOfRange) {
      this.log.warn('decoded value outside declared range', {
        signal: signal.id,
        value,
        min: signal.min,
        max: signal.max,
      });
    }
    return {
      signalId: signal.id,
      name: signal.name,
      raw: slice.slice(),
      rawHex: toHex(slice),
      rawValue,
      value,
      ...(signal.unit ? { unit: signal.unit } : {}),
      ...(enumText ? { enumText } : {}),
      outOfRange,
      did: signal.did,
      ecu: signal.ecu,
    };
  }

  private finishText(signal: SignalDefinition, slice: Uint8Array, text: string): DecodedSignal {
    return {
      signalId: signal.id,
      name: signal.name,
      raw: slice.slice(),
      rawHex: toHex(slice),
      rawValue: text,
      value: text,
      outOfRange: false,
      did: signal.did,
      ecu: signal.ecu,
    };
  }

  private finishBoolean(signal: SignalDefinition, slice: Uint8Array, raw: boolean): DecodedSignal {
    const enumText = signal.enumMapping ? signal.enumMapping[raw ? 1 : 0] : undefined;
    return {
      signalId: signal.id,
      name: signal.name,
      raw: slice.slice(),
      rawHex: toHex(slice),
      rawValue: raw,
      value: raw,
      ...(enumText ? { enumText } : {}),
      outOfRange: false,
      did: signal.did,
      ecu: signal.ecu,
    };
  }

  private fail(signal: SignalDefinition, reason: string): null {
    if (this.strict) throw new DecodeError(`cannot decode ${signal.id}: ${reason}`, { signalId: signal.id });
    this.log.error('decode failed', { signal: signal.id, reason });
    return null;
  }
}

/** Round to the resolution implied by the scale so floats stay readable. */
function round(value: number, scale: number): number {
  const decimals = Math.max(0, Math.min(6, Math.ceil(-Math.log10(scale))));
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function reverse(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[data.length - 1 - i] ?? 0;
  return out;
}
