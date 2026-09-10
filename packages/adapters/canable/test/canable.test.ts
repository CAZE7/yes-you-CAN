import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fromHex, toHex } from '@vdp/shared';
import { createFrame } from '@vdp/transport-can';
import { MemoryByteStream } from '@vdp/adapter-elm327';
import { BITRATES, CanableAdapter, formatSlcanFrame, isSlcanError, parseSlcanLine } from '../src/index.js';

test('standard and extended frames are formatted in slcan syntax', () => {
  assert.equal(formatSlcanFrame(createFrame(0x7e0, fromHex('02 3E 80'))), 't7E03023E80\r');
  // '02 3E 80' is three bytes, so the DLC field is 3.
  assert.equal(formatSlcanFrame(createFrame(0x18daf100, fromHex('02 3E 80'), { extended: true })), 'T18DAF1003023E80\r');
});

test('frame lines are parsed, including the optional timestamp suffix', () => {
  const frame = parseSlcanLine('t7E837F2231', 'slcan0', 5000);
  assert.ok(frame);
  assert.equal(frame.id, 0x7e8);
  assert.equal(toHex(frame.payload), '7F 22 31');
  assert.equal(frame.extended, false);

  // Extended id + DLC 2 + payload 5003 + 3-digit timestamp suffix.
  const extended = parseSlcanLine('T18DA00F1250030FF', 'slcan0', 9000);
  assert.ok(extended);
  assert.equal(extended.extended, true);
  assert.equal(extended.dlc, 2);
  assert.equal(toHex(extended.payload), '50 03');
});

test('lines that are not frames are rejected', () => {
  assert.equal(parseSlcanLine('V1234', 'slcan0'), null);
  assert.equal(parseSlcanLine('OK', 'slcan0'), null);
  assert.equal(parseSlcanLine('t7E837F22', 'slcan0'), null, 'payload shorter than the DLC must not be accepted');
  assert.equal(parseSlcanLine('r7E80', 'slcan0'), null, 'remote frames carry no payload');
});

test('BEL answers are counted as errors', () => {
  assert.equal(isSlcanError('\u0007'), true);
  assert.equal(isSlcanError('\r'), false);
});

test('open() configures bitrate, timestamps and opens the channel', async () => {
  const stream = new MemoryByteStream();
  stream.open();
  const adapter = new CanableAdapter({ stream, bitrate: '500k', commandTimeoutMs: 100 });
  await adapter.open();
  assert.equal(adapter.isOpen(), true);
  assert.deepEqual(stream.written, [`${BITRATES['500k']}\r`, 'Z1\r', 'O\r']);
});

test('sent frames reach the stream and received frames reach subscribers', async () => {
  const stream = new MemoryByteStream();
  stream.open();
  const adapter = new CanableAdapter({ stream, commandTimeoutMs: 100 });
  await adapter.open();
  const received: string[] = [];
  adapter.subscribe((frame) => received.push(toHex(frame.payload)));
  await adapter.send(createFrame(0x7e0, fromHex('02 3E 80')));
  assert.ok(stream.written.includes('t7E03023E80\r'), `expected the slcan frame, got ${stream.written.join(' | ')}`);

  stream.emit('t7E837F2231\r');
  assert.deepEqual(received, ['7F 22 31']);
  assert.equal(adapter.counters.rx, 1);
});

test('BEL responses increment the error counter', async () => {
  const stream = new MemoryByteStream();
  stream.open();
  const adapter = new CanableAdapter({ stream, commandTimeoutMs: 100 });
  await adapter.open();
  stream.emit('\u0007');
  assert.equal(adapter.counters.errors, 1);
});

test('CAN-FD frames are rejected', async () => {
  const stream = new MemoryByteStream();
  stream.open();
  const adapter = new CanableAdapter({ stream, commandTimeoutMs: 100 });
  await adapter.open();
  await assert.rejects(adapter.send(createFrame(0x7e0, new Uint8Array(12).fill(1), { fd: true })), /CAN-FD/);
});

test('close() sends the close command and stops delivery', async () => {
  const stream = new MemoryByteStream();
  stream.open();
  const adapter = new CanableAdapter({ stream, commandTimeoutMs: 100 });
  await adapter.open();
  await adapter.close();
  assert.equal(adapter.isOpen(), false);
  assert.ok(stream.written.at(-1) === 'C\r');
});
