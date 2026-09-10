/**
 * Minimal ZIP writer (store method, no compression).
 *
 * A session package has to be a plain ZIP so workshops can open it with any tool
 * (AGENTS 17). Compression would require a dependency; stored entries are
 * perfectly valid ZIP and text-heavy session data still compresses on read.
 */

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function writeU16(value: number): Uint8Array {
  return new Uint8Array([value & 0xff, (value >>> 8) & 0xff]);
}

function writeU32(value: number): Uint8Array {
  return new Uint8Array([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]);
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Build a ZIP archive from in-memory entries. */
export function createZip(entries: readonly ZipEntry[], comment = 'vdp session package'): Uint8Array {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = new TextEncoder().encode(entry.name);
    const crc = crc32(entry.data);
    const local = concat([
      writeU32(0x04034b50),
      writeU16(20), // version needed
      writeU16(0), // flags
      writeU16(0), // method: stored
      writeU16(0), // mod time
      writeU16(0), // mod date
      writeU32(crc),
      writeU32(entry.data.length),
      writeU32(entry.data.length),
      writeU16(nameBytes.length),
      writeU16(0),
      nameBytes,
      entry.data,
    ]);
    localParts.push(local);

    centralParts.push(
      concat([
        writeU32(0x02014b50),
        writeU16(20), // version made by
        writeU16(20), // version needed
        writeU16(0),
        writeU16(0),
        writeU16(0),
        writeU16(0),
        writeU32(crc),
        writeU32(entry.data.length),
        writeU32(entry.data.length),
        writeU16(nameBytes.length),
        writeU16(0),
        writeU16(0),
        writeU16(0),
        writeU16(0),
        writeU32(0),
        writeU32(offset),
        nameBytes,
      ]),
    );
    offset += local.length;
  }

  const centralDirectory = concat(centralParts);
  const commentBytes = new TextEncoder().encode(comment);
  const end = concat([
    writeU32(0x06054b50),
    writeU16(0),
    writeU16(0),
    writeU16(entries.length),
    writeU16(entries.length),
    writeU32(centralDirectory.length),
    writeU32(offset),
    writeU16(commentBytes.length),
    commentBytes,
  ]);

  return concat([...localParts, centralDirectory, end]);
}

/** Read back the entry names of an archive we produced — enough for validation tests. */
export function listZipEntries(archive: Uint8Array): string[] {
  const decoder = new TextDecoder();
  const names: string[] = [];
  let offset = 0;
  while (offset + 4 <= archive.length) {
    const signature = (archive[offset] ?? 0) | ((archive[offset + 1] ?? 0) << 8) | ((archive[offset + 2] ?? 0) << 16) | ((archive[offset + 3] ?? 0) << 24);
    if (signature !== 0x04034b50) break;
    const nameLength = (archive[offset + 26] ?? 0) | ((archive[offset + 27] ?? 0) << 8);
    const extraLength = (archive[offset + 28] ?? 0) | ((archive[offset + 29] ?? 0) << 8);
    const compressedSize =
      (archive[offset + 18] ?? 0) | ((archive[offset + 19] ?? 0) << 8) | ((archive[offset + 20] ?? 0) << 16) | ((archive[offset + 21] ?? 0) << 24);
    const name = decoder.decode(archive.subarray(offset + 30, offset + 30 + nameLength));
    names.push(name);
    offset += 30 + nameLength + extraLength + compressedSize;
  }
  return names;
}
