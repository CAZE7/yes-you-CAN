import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ascii, concatBytes, fromHex, readBitsBE, readFloat32BE, readIntBE, readUintBE, toHex } from '../src/bytes.js';

test('toHex formats uppercase with separator', () => {
  assert.equal(toHex(new Uint8Array([0x02, 0x10, 0x03])), '02 10 03');
  assert.equal(toHex(new Uint8Array([0x02, 0x10]), ''), '0210');
});

test('fromHex tolerates 0x prefixes and separators', () => {
  assert.deepEqual(fromHex('0x7D 0xF0 02 10 03'), new Uint8Array([0x7d, 0xf0, 0x02, 0x10, 0x03]));
  assert.deepEqual(fromHex('7D.F0'), new Uint8Array([0x7d, 0xf0]));
  assert.deepEqual(fromHex('0x07e8'), new Uint8Array([0x07, 0xe8]));
});

test('fromHex rejects odd digit counts', () => {
  assert.throws(() => fromHex('ABC'));
});

test('big-endian unsigned/signed reads', () => {
  const data = fromHex('01 00 FF 80 00 0A');
  assert.equal(readUintBE(data, 0, 2), 256);
  assert.equal(readIntBE(data, 2, 2), -128);
  assert.equal(readUintBE(data, 2, 2), 0xff80);
  assert.equal(readUintBE(data, 4, 2), 10);
});

test('readBitsBE reads MSB-first bit ranges', () => {
  // 0b10110100 = 0xB4
  const data = new Uint8Array([0xb4]);
  assert.equal(readBitsBE(data, 0, 2), 0b10);
  assert.equal(readBitsBE(data, 2, 4), 0b1101);
  assert.equal(readBitsBE(data, 7, 1), 0);
});

test('float32 big-endian decode', () => {
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, 1.5, false);
  assert.equal(readFloat32BE(new Uint8Array(view.buffer)), 1.5);
});

test('ascii stops at NUL and trims', () => {
  assert.equal(ascii(new Uint8Array([0x57, 0x56, 0x57, 0x00, 0x20])), 'WVW');
});

test('concatBytes concatenates without extra allocation semantics', () => {
  assert.deepEqual(concatBytes([new Uint8Array([1, 2]), new Uint8Array([3])]), new Uint8Array([1, 2, 3]));
  assert.deepEqual(concatBytes([]), new Uint8Array([]));
});
