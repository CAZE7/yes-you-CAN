/** Byte/hex helpers. Kept dependency-free and allocation-conscious. */

export function toHex(data: Uint8Array, separator = ' '): string {
  let out = '';
  for (let i = 0; i < data.length; i++) {
    if (i > 0) out += separator;
    out += (data[i] as number).toString(16).padStart(2, '0');
  }
  return out.toUpperCase();
}

export function fromHex(text: string): Uint8Array {
  const clean = text.replace(/0x/gi, '').replace(/[^0-9a-fA-F]/g, '');
  if (clean.length % 2 !== 0) throw new Error(`fromHex: odd number of hex digits in "${text}"`);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

export function u16be(data: Uint8Array, offset = 0): number {
  const hi = data[offset] ?? 0;
  const lo = data[offset + 1] ?? 0;
  return (hi << 8) | lo;
}

export function u32be(data: Uint8Array, offset = 0): number {
  return ((u16be(data, offset) << 16) | u16be(data, offset + 2)) >>> 0;
}

export function writeU16be(value: number): Uint8Array {
  return new Uint8Array([(value >>> 8) & 0xff, value & 0xff]);
}

export function writeU32be(value: number): Uint8Array {
  return new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

/** Big-endian unsigned read of `length` bytes (1..6). */
export function readUintBE(data: Uint8Array, offset: number, length: number): number {
  let value = 0;
  for (let i = 0; i < length; i++) value = value * 256 + (data[offset + i] ?? 0);
  return value;
}

/** Big-endian signed read of `length` bytes using two's complement. */
export function readIntBE(data: Uint8Array, offset: number, length: number): number {
  const unsigned = readUintBE(data, offset, length);
  const signBit = 2 ** (length * 8 - 1);
  return unsigned >= signBit ? unsigned - signBit * 2 : unsigned;
}

export function readFloat32BE(data: Uint8Array, offset = 0): number {
  const view = new DataView(data.buffer, data.byteOffset + offset, 4);
  return view.getFloat32(0, false);
}

/** Bit range read (MSB-first bit numbering within the byte sequence). */
export function readBitsBE(data: Uint8Array, bitOffset: number, bitLength: number): number {
  let value = 0;
  for (let i = 0; i < bitLength; i++) {
    const bitIndex = bitOffset + i;
    const byte = data[Math.floor(bitIndex / 8)] ?? 0;
    const bit = (byte >>> (7 - (bitIndex % 8))) & 1;
    value = value * 2 + bit;
  }
  return value;
}

export function ascii(data: Uint8Array): string {
  let out = '';
  for (const b of data) {
    if (b === 0) break;
    out += String.fromCharCode(b);
  }
  return out.trim();
}

export function asciiBytes(text: string, length?: number): Uint8Array {
  const raw = new Uint8Array(length ?? text.length);
  for (let i = 0; i < raw.length; i++) {
    const code = text.charCodeAt(i);
    raw[i] = Number.isFinite(code) ? code & 0xff : 0x20;
  }
  return raw;
}
