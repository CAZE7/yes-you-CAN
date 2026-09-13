/**
 * Measurement decoding (AGENTS 14) — raw bytes to the diagnostic IR, then a
 * projection for callers that speak {@link DecodedSignal} (master backlog P0 #6).
 *
 * Raw bytes never reach the UI. Everything goes
 * raw response → IR observation (value with provenance, or a named gap) → value + unit.
 * Raw and decoded values are kept separate end to end (AGENTS 34.7).
 *
 * The IR step is what makes an *absent* signal distinguishable from a signal that
 * could not be *observed*: `decode()` still answers `null` (its contract, and what
 * `strict` throws for), while `observe()` answers a gap that carries the reason.
 */

import type { SignalDefinition } from "@vdp/definitions";
import {
  type SignalGap,
  type SignalObservation,
  type SignalReading,
  signalGap,
  signalReading,
} from "@vdp/diagnostic-ir";
import {
  DecodeError,
  type Logger,
  ascii,
  createLogger,
  readBitsBE,
  readFloat32BE,
  readIntBE,
  readUintBE,
  toHex,
} from "@vdp/shared";

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

/** What the caller knows about the read that produced these bytes (P0 #6). */
export interface ObservationContext {
  /** ECU that was asked; defaults to the definition's ECU id. */
  ecuId?: string;
  /** When the bytes arrived; defaults to now. */
  at?: string;
  /** Definition package version the value is interpreted with. */
  definitionVersion?: string;
}

export class SignalDecoder {
  private readonly log: Logger;
  private readonly strict: boolean;

  constructor(options: DecodeOptions = {}) {
    this.log = (options.logger ?? createLogger("decoder", { level: "WARN" })).child("decoder");
    this.strict = options.strict ?? false;
  }

  /**
   * Decode one signal into the diagnostic IR: a reading with its provenance, or a
   * gap that names what could not be read (P0 #6).
   *
   * This is the computation; {@link decode} is the projection for existing
   * callers. Two entry points, one code path.
   */
  observe(
    signal: SignalDefinition,
    payload: Uint8Array,
    context: ObservationContext = {},
  ): SignalObservation {
    const observation = this.decodeObservation(signal, payload);
    if (observation.kind === "signal-gap") return observation;
    return signalReading({
      signalId: observation.signalId,
      ...(observation.name !== undefined ? { name: observation.name } : {}),
      ecuId: context.ecuId ?? observation.ecuId,
      did: observation.did,
      raw: observation.raw,
      rawHex: observation.rawHex,
      rawValue: observation.rawValue,
      value: observation.value,
      ...(observation.unit !== undefined ? { unit: observation.unit } : {}),
      ...(observation.enumText !== undefined ? { enumText: observation.enumText } : {}),
      outOfRange: observation.outOfRange,
      at: context.at ?? new Date().toISOString(),
      ...(context.definitionVersion !== undefined
        ? { definitionVersion: context.definitionVersion }
        : {}),
    });
  }

  /**
   * Decode one signal out of a DID payload.
   * `payload` is the data part of the 0x62 response (DID header already removed).
   */
  decode(signal: SignalDefinition, payload: Uint8Array): DecodedSignal | null {
    const observation = this.decodeObservation(signal, payload);
    if (observation.kind === "signal-gap") return this.reject(observation);
    return toDecodedSignal(observation);
  }

  /** The decoding itself — the one place the encodings are implemented. */
  private decodeObservation(signal: SignalDefinition, payload: Uint8Array): SignalObservation {
    const start = signal.byteOffset;
    const end = start + signal.length;
    // The window has to lie inside the payload, ordered, at *both* ends.
    // `subarray` is forgiving about a negative start — it wraps around to the end
    // of the buffer — and about a negative length, which turns `end` into a count
    // from the end; either one would return bytes belonging to somebody else,
    // which is worse than no answer at all (AGENTS 34.7: raw and decoded never
    // mix, AGENTS 24: no invented data). Validated packages cannot produce such a
    // window; live and imported definitions can.
    if (start < 0 || end < start || end > payload.length) {
      return this.gap(
        signal,
        `payload for DID 0x${signal.did.toString(16)} has ${payload.length} bytes but signal needs ${signal.length} at offset ${start}`,
      );
    }
    const slice = payload.subarray(start, end);

    if (signal.bitOffset !== undefined && signal.bitLength !== undefined) {
      // A bit window is read zero-padded outside the container, so an oversized
      // declaration would silently produce a plausible-looking low value.
      const bitEnd = signal.bitOffset + signal.bitLength;
      if (signal.bitOffset < 0 || signal.bitLength < 1 || bitEnd > slice.length * 8) {
        return this.gap(
          signal,
          `bit window ${signal.bitOffset}..${bitEnd} does not fit the ${slice.length * 8} bit container of DID 0x${signal.did.toString(16)}`,
        );
      }
      const rawBits = readBitsBE(slice, signal.bitOffset, signal.bitLength);
      return this.finish(signal, slice, rawBits, rawBits);
    }

    switch (signal.encoding) {
      case "ascii": {
        const text = ascii(slice);
        return this.finishText(signal, slice, text);
      }
      case "bool": {
        const raw = (slice[0] ?? 0) !== 0;
        return this.finishBoolean(signal, slice, raw);
      }
      case "bitmask": {
        const raw = signal.length === 1 ? (slice[0] ?? 0) : readUintBE(slice, 0, signal.length);
        return this.finish(signal, slice, raw, raw, { skipScaling: true });
      }
      case "bcd": {
        let digits = "";
        for (const byte of slice) digits += byte.toString(16).padStart(2, "0");
        const raw = Number.parseInt(digits, 10);
        if (!Number.isFinite(raw)) return this.gap(signal, `invalid BCD payload ${toHex(slice)}`);
        return this.finish(signal, slice, raw, raw);
      }
      case "float32": {
        const raw = readFloat32BE(signal.endianness === "little" ? reverse(slice) : slice, 0);
        return this.finish(signal, slice, raw, raw);
      }
      case "uint8":
      case "uint16":
      case "uint24":
      case "uint32": {
        const raw = readUintBE(
          signal.endianness === "little" ? reverse(slice) : slice,
          0,
          signal.length,
        );
        return this.finish(signal, slice, raw, raw);
      }
      case "int8":
      case "int16":
      case "int32": {
        const raw = readIntBE(
          signal.endianness === "little" ? reverse(slice) : slice,
          0,
          signal.length,
        );
        return this.finish(signal, slice, raw, raw);
      }
      default:
        return this.gap(signal, `unsupported encoding "${signal.encoding}"`);
    }
  }

  /** Decode every signal of a DID payload as projections — gaps yield no entry. */
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
  ): SignalReading {
    const scale = signal.scale ?? 1;
    const offset = signal.offsetValue ?? 0;
    const value = options.skipScaling ? rawValue : round(physicalInput * scale + offset, scale);
    const enumText = signal.enumMapping ? signal.enumMapping[rawValue] : undefined;
    const outOfRange =
      typeof value === "number" &&
      ((signal.min !== undefined && value < signal.min) ||
        (signal.max !== undefined && value > signal.max));
    if (outOfRange) {
      this.log.warn("decoded value outside declared range", {
        signal: signal.id,
        value,
        min: signal.min,
        max: signal.max,
      });
    }
    return this.reading(signal, slice, rawValue, value, {
      outOfRange,
      ...(enumText ? { enumText } : {}),
    });
  }

  private finishText(signal: SignalDefinition, slice: Uint8Array, text: string): SignalReading {
    return this.reading(signal, slice, text, text, { outOfRange: false });
  }

  /** One place that builds an IR reading — every encoding path ends here. */
  private reading(
    signal: SignalDefinition,
    slice: Uint8Array,
    rawValue: SignalReading["rawValue"],
    value: SignalReading["value"],
    options: { outOfRange: boolean; enumText?: string },
  ): SignalReading {
    return signalReading({
      signalId: signal.id,
      name: signal.name,
      ecuId: signal.ecu,
      did: signal.did,
      raw: slice.slice(),
      rawHex: toHex(slice),
      rawValue,
      value,
      ...(signal.unit !== undefined ? { unit: signal.unit } : {}),
      ...(options.enumText !== undefined ? { enumText: options.enumText } : {}),
      outOfRange: options.outOfRange,
    });
  }

  private finishBoolean(signal: SignalDefinition, slice: Uint8Array, raw: boolean): SignalReading {
    const enumText = signal.enumMapping ? signal.enumMapping[raw ? 1 : 0] : undefined;
    return this.reading(signal, slice, raw, raw, {
      outOfRange: false,
      ...(enumText ? { enumText } : {}),
    });
  }

  /** A decode that could not happen: a named gap, logged as the error it is. */
  private gap(signal: SignalDefinition, reason: string): SignalGap {
    this.log.error("decode failed", { signal: signal.id, reason });
    return signalGap({
      signalId: signal.id,
      name: signal.name,
      ecuId: signal.ecu,
      did: signal.did,
      reason,
    });
  }

  /** Projection policy of `decode()`: throw in strict mode, otherwise no value. */
  private reject(gap: SignalGap): null {
    if (this.strict) {
      throw new DecodeError(`cannot decode ${gap.signalId}: ${gap.reason}`, {
        signalId: gap.signalId,
      });
    }
    return null;
  }
}

/**
 * Project an IR reading onto the signal type this package has always returned.
 *
 * `DecodedSignal` predates the IR and is still the shape the snapshot path, the
 * replay tooling and the export formats speak. The projection is lossless for
 * those fields: the IR carries *more* (provenance, timestamp), not different
 * values.
 */
export function toDecodedSignal(reading: SignalReading): DecodedSignal {
  return {
    signalId: reading.signalId,
    name: reading.name ?? reading.signalId,
    raw: reading.raw,
    rawHex: reading.rawHex,
    rawValue: reading.rawValue,
    value: reading.value,
    ...(reading.unit !== undefined ? { unit: reading.unit } : {}),
    ...(reading.enumText !== undefined ? { enumText: reading.enumText } : {}),
    outOfRange: reading.outOfRange,
    did: reading.did,
    ecu: reading.ecuId,
  };
}

/** Round to the resolution implied by the scale so floats stay readable. */
function round(value: number, scale: number): number {
  // The magnitude of the scale says how many decimals are meaningful, its sign
  // does not: an inverted sensor (scale -0.1) still wants one decimal, and a
  // negative scale inside log10 would answer NaN and smear every value.
  const decimals = Math.max(0, Math.min(6, Math.ceil(-Math.log10(Math.abs(scale)))));
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function reverse(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[data.length - 1 - i] ?? 0;
  return out;
}
