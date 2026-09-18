/**
 * SHA-256 (FIPS 180-4) in dependency-free TypeScript.
 *
 * Portable layers hash through this module instead of `node:crypto`, so the
 * same input has the same digest in Node, a replay worker, and an export
 * pipeline: the importer of this module decides nothing about the runtime,
 * and the module itself decides nothing about the host (no `node:` import,
 * no `TextEncoder` global, no `Buffer`). One-shot only — the hashed traces
 * are small (hundreds of short trace lines), so no streaming state is kept.
 *
 * The schedule reads use `as number` (the bytes.ts precedent): every index is
 * provably in range, so there is no fallback arm that coverage would have to
 * reach without ever firing.
 */

const ROUND_CONSTANTS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const;

const INITIAL_STATE = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
] as const;

const HEX_DIGITS = "0123456789abcdef";

function rotateRight(value: number, bits: number): number {
  return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}

/**
 * UTF-8 encode without any platform API. A lone surrogate is not a character
 * and encodes as U+FFFD, the same replacement `Buffer.from(text, "utf8")`
 * and `TextEncoder` produce — the digest must not depend on which encoder ran.
 */
function utf8Bytes(text: string): Uint8Array {
  const bytes: number[] = [];
  for (const char of text) {
    // `for..of` yields whole characters, so the code point always exists.
    const point = char.codePointAt(0) as number;
    const code = point >= 0xd800 && point <= 0xdfff ? 0xfffd : point;
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >>> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >>> 12), 0x80 | ((code >>> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      bytes.push(
        0xf0 | (code >>> 18),
        0x80 | ((code >>> 12) & 0x3f),
        0x80 | ((code >>> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return Uint8Array.from(bytes);
}

/** SHA-256 digest of `data` (FIPS 180-4 §6.2). */
export function sha256(data: Uint8Array): Uint8Array {
  const bitLengthLow = (data.length << 3) >>> 0;
  const bitLengthHigh = Math.floor(data.length / 0x20000000);
  const withOne = data.length + 1;
  const zeroBytes = (56 - (withOne % 64) + 64) % 64;
  const padded = new Uint8Array(withOne + zeroBytes + 8);
  padded.set(data, 0);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, bitLengthHigh, false);
  view.setUint32(padded.length - 4, bitLengthLow, false);

  const state: [number, number, number, number, number, number, number, number] = [
    ...INITIAL_STATE,
  ];
  const schedule = new Array<number>(64).fill(0);
  for (let block = 0; block < padded.length; block += 64) {
    for (let i = 0; i < 16; i++) schedule[i] = view.getUint32(block + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const head = schedule[i - 15] as number;
      const tail = schedule[i - 2] as number;
      const s0 = rotateRight(head, 7) ^ rotateRight(head, 18) ^ (head >>> 3);
      const s1 = rotateRight(tail, 17) ^ rotateRight(tail, 19) ^ (tail >>> 10);
      const low = (schedule[i - 16] as number) + s0;
      schedule[i] = (low + (schedule[i - 7] as number) + s1) >>> 0;
    }
    let a = state[0];
    let b = state[1];
    let c = state[2];
    let d = state[3];
    let e = state[4];
    let f = state[5];
    let g = state[6];
    let h = state[7];
    for (let i = 0; i < 64; i++) {
      const s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const ch = (e & f) ^ (~e & g);
      const roundKey = ROUND_CONSTANTS[i] as number;
      const scheduled = schedule[i] as number;
      const t1 = (h + s1 + ch + roundKey + scheduled) >>> 0;
      const s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    state[0] = (state[0] + a) >>> 0;
    state[1] = (state[1] + b) >>> 0;
    state[2] = (state[2] + c) >>> 0;
    state[3] = (state[3] + d) >>> 0;
    state[4] = (state[4] + e) >>> 0;
    state[5] = (state[5] + f) >>> 0;
    state[6] = (state[6] + g) >>> 0;
    state[7] = (state[7] + h) >>> 0;
  }

  const digest = new Uint8Array(32);
  const out = new DataView(digest.buffer);
  out.setUint32(0, state[0], false);
  out.setUint32(4, state[1], false);
  out.setUint32(8, state[2], false);
  out.setUint32(12, state[3], false);
  out.setUint32(16, state[4], false);
  out.setUint32(20, state[5], false);
  out.setUint32(24, state[6], false);
  out.setUint32(28, state[7], false);
  return digest;
}

/** SHA-256 of `data` as lowercase hexadecimal. */
export function sha256Hex(data: Uint8Array): string {
  const digest = sha256(data);
  let out = "";
  for (const byte of digest) {
    out += HEX_DIGITS.charAt((byte >>> 4) & 0xf) + HEX_DIGITS.charAt(byte & 0xf);
  }
  return out;
}

/** SHA-256 of `text` (UTF-8) as lowercase hexadecimal. */
export function sha256HexUtf8(text: string): string {
  return sha256Hex(utf8Bytes(text));
}
