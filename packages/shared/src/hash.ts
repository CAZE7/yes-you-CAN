/**
 * SHA-256 as a portable primitive (FIPS 180-4 §6.2; also ISO/IEC 10118-3:2004).
 *
 * Why a hand-written digest sits in the foundation layer: the raw-trace manifest
 * (`@vdp/core`'s `logging/integrity.ts`) hashes a recording so that a later reader
 * can prove a decoded finding still matches the bytes it came from (AGENTS 18).
 * The core is a portable layer and stays free of `node:` builtins — that is the
 * rule `architecture/architecture.yaml` writes down as `rules.nodeBuiltins`, and a
 * `node:crypto` import in the core fails it (measured 2026-09-18:
 * `[node-builtin] @vdp/core imports node:crypto, but is a portable layer`). A
 * hashing dependency is no way out either (ADR 0002: no runtime dependencies). So
 * the one package every other package may reach carries the digest itself, and the
 * same source runs in Node, in a browser worker and in an export pipeline.
 *
 * The digest is byte-identical to `createHash("sha256")` over the same bytes —
 * `hash.spec.ts` pins that against `node:crypto`, because a stored manifest that
 * stops verifying is a lost recording, not a changed implementation.
 */

/** K[0..63]: first 32 bits of the cube roots of the first 64 primes (FIPS 180-4 §4.2.2). */
const ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** H(0): first 32 bits of the square roots of the first 8 primes (FIPS 180-4 §5.3.3). */
const INITIAL_STATE = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

const BLOCK_BYTES = 64;
/** Structural type: `TextEncoder` is a value here, not a type (no DOM lib, §28). */
interface Utf8Encoder {
  encode(input: string): Uint8Array;
}

const encoder: Utf8Encoder = new TextEncoder();

function rotr(value: number, bits: number): number {
  return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}

/**
 * FIPS 180-4 §6.2.2 — one 512-bit block into the running state. `words` is scratch
 * space the caller keeps, so hashing a long trace allocates it once, not per block.
 */
function compressBlock(
  state: Uint32Array,
  data: Uint8Array,
  offset: number,
  words: Uint32Array,
): void {
  for (let t = 0; t < 16; t += 1) {
    const base = offset + t * 4;
    words[t] =
      (((data[base] as number) << 24) |
        ((data[base + 1] as number) << 16) |
        ((data[base + 2] as number) << 8) |
        (data[base + 3] as number)) >>>
      0;
  }
  for (let t = 16; t < 64; t += 1) {
    const earlier = words[t - 15] as number;
    const oldest = words[t - 2] as number;
    const sigma0 = rotr(earlier, 7) ^ rotr(earlier, 18) ^ (earlier >>> 3);
    const sigma1 = rotr(oldest, 17) ^ rotr(oldest, 19) ^ (oldest >>> 10);
    words[t] = ((words[t - 16] as number) + sigma0 + (words[t - 7] as number) + sigma1) >>> 0;
  }

  let a = state[0] as number;
  let b = state[1] as number;
  let c = state[2] as number;
  let d = state[3] as number;
  let e = state[4] as number;
  let f = state[5] as number;
  let g = state[6] as number;
  let h = state[7] as number;

  for (let t = 0; t < 64; t += 1) {
    const bigSigma1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
    const choose = (e & f) ^ (~e & g);
    const temp1 =
      (h + bigSigma1 + choose + (ROUND_CONSTANTS[t] as number) + (words[t] as number)) >>> 0;
    const bigSigma0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
    const majority = (a & b) ^ (a & c) ^ (b & c);
    const temp2 = (bigSigma0 + majority) >>> 0;
    h = g;
    g = f;
    f = e;
    e = (d + temp1) >>> 0;
    d = c;
    c = b;
    b = a;
    a = (temp1 + temp2) >>> 0;
  }

  const added = [a, b, c, d, e, f, g, h];
  for (let i = 0; i < 8; i += 1) state[i] = ((state[i] as number) + (added[i] as number)) >>> 0;
}

/** The message plus its 0x80 pad and the 64-bit big-endian bit length (§4.1 padding). */
function paddedMessage(bytes: Uint8Array): Uint8Array {
  const bitLength = bytes.length * 8;
  // The padded message ends on a block boundary, and the length field (8 bytes)
  // never fits in the block the message itself ends in — hence +8, floored, +64.
  const paddedLength = Math.floor((bytes.length + 8) / BLOCK_BYTES) * BLOCK_BYTES + BLOCK_BYTES;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const highWords = Math.floor(bitLength / 0x100000000);
  const lowWords = bitLength % 0x100000000;
  // The length field is the last eight bytes, big-endian: four bytes of the high
  // word, then four of the low word, each most-significant byte first (§4.1).
  for (let i = 0; i < 8; i += 1) {
    const word = i < 4 ? highWords : lowWords;
    padded[paddedLength - 8 + i] = (word >>> (8 * (3 - (i % 4)))) & 0xff;
  }
  return padded;
}

/**
 * Lowercase hexadecimal SHA-256 over `input`. A string is hashed as its UTF-8
 * bytes, which is what `createHash("sha256").update(text, "utf8")` does, so a
 * digest recorded through Node and one recorded here describe the same value.
 *
 * The length field is 64 bits wide; inputs at or above 2^29 bytes (512 MiB) would
 * carry a non-zero high word, and no test builds one — the budget of a unit run is
 * far below a gigabyte. The arithmetic above keeps the high word for those inputs.
 */
export function sha256Hex(input: string | Uint8Array): string {
  const bytes = typeof input === "string" ? encoder.encode(input) : input;
  const padded = paddedMessage(bytes);
  const state = Uint32Array.from(INITIAL_STATE);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += BLOCK_BYTES) {
    compressBlock(state, padded, offset, words);
  }
  let hex = "";
  for (let i = 0; i < 8; i += 1) hex += (state[i] as number).toString(16).padStart(8, "0");
  return hex;
}
