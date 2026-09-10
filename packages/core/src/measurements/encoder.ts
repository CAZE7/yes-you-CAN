/**
 * Signal encoding — the inverse of the decoder (AGENTS 14).
 *
 * Needed by the ECU simulator (AGENTS 32) to build realistic DID payloads and
 * later by the coding framework (AGENTS 25) to prepare write values. Encoding
 * always uses the same definition as decoding, so a value that round-trips is
 * proof the definition is consistent.
 */

import { EncodeError } from '@vdp/shared';
import type { SignalDefinition } from '@vdp/definitions';

export interface EncodeOptions {
  /** Total payload length to embed the signal in; defaults to byteOffset + length. */
  payloadLength?: number;
}

export function encodeSignal(signal: SignalDefinition, value: number | string | boolean, options: EncodeOptions = {}): Uint8Array {
  const totalLength = options.payloadLength ?? signal.byteOffset + signal.length;
  const payload = new Uint8Array(totalLength);
  const slice = encodeValue(signal, value);
  payload.set(slice, signal.byteOffset);
  return payload;
}

export function encodeValue(signal: SignalDefinition, value: number | string | boolean): Uint8Array {
  const little = signal.endianness === 'little';

  switch (signal.encoding) {
    case 'ascii': {
      if (typeof value !== 'string') throw new EncodeError(`signal ${signal.id} expects a string`, { signalId: signal.id });
      const out = new Uint8Array(signal.length);
      for (let i = 0; i < signal.length; i++) {
        const code = value.charCodeAt(i);
        out[i] = Number.isFinite(code) && code > 0 ? code & 0xff : 0x20;
      }
      return out;
    }
    case 'bool':
      return new Uint8Array([value ? 1 : 0]);
    case 'bitmask': {
      const raw = typeof value === 'boolean' ? (value ? 1 : 0) : toNumber(signal, value);
      return writeUint(raw, signal.length, little);
    }
    case 'bcd': {
      const raw = toNumber(signal, value);
      const digits = String(Math.trunc(Math.abs(raw))).padStart(signal.length * 2, '0');
      const out = new Uint8Array(signal.length);
      for (let i = 0; i < signal.length; i++) out[i] = parseInt(digits.slice(i * 2, i * 2 + 2), 16);
      return out;
    }
    case 'float32': {
      const raw = toNumber(signal, value);
      const view = new DataView(new ArrayBuffer(4));
      view.setFloat32(0, raw, little);
      return new Uint8Array(view.buffer);
    }
    case 'uint8':
    case 'uint16':
    case 'uint24':
    case 'uint32':
    case 'int8':
    case 'int16':
    case 'int32': {
      const scale = signal.scale ?? 1;
      const offset = signal.offsetValue ?? 0;
      const raw = Math.round((toNumber(signal, value) - offset) / scale);
      if (raw < 0 && signal.encoding.startsWith('uint')) {
        throw new EncodeError(`signal ${signal.id} is unsigned but the value ${value} encodes to ${raw}`, { signalId: signal.id });
      }
      return writeUint(raw, signal.length, little);
    }
    default:
      throw new EncodeError(`unsupported encoding "${signal.encoding}"`, { signalId: signal.id });
  }
}

function toNumber(signal: SignalDefinition, value: number | string | boolean): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) throw new EncodeError(`signal ${signal.id} expects a numeric value, got "${value}"`, { signalId: signal.id });
  return parsed;
}

function writeUint(value: number, length: number, little: boolean): Uint8Array {
  const out = new Uint8Array(length);
  let remaining = value >>> 0;
  for (let i = 0; i < length; i++) {
    out[i] = remaining & 0xff;
    remaining = Math.floor(remaining / 256);
  }
  return little ? out : out.reverse();
}
