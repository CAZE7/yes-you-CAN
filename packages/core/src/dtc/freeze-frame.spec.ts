/**
 * Freeze frame decoding (AGENTS 20): the definition package owns the layout,
 * undocumented bytes stay raw evidence — never guessed into values.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import type { FreezeFrameField, SignalDefinition } from '@vdp/definitions';
import { SignalDecoder } from '../measurements/decoder.js';
import { decodeFreezeFrame, signalMapOf } from './freeze-frame.js';

const coolant: SignalDefinition = {
  id: 'engine.coolant_temperature',
  name: 'Coolant temperature',
  ecu: 'engine',
  did: 0x0c00,
  byteOffset: 0,
  length: 2,
  encoding: 'uint16',
  scale: 0.1,
  unit: '°C',
};

const rpm: SignalDefinition = {
  id: 'engine.rpm',
  name: 'Engine RPM',
  ecu: 'engine',
  did: 0x0c00,
  byteOffset: 2,
  length: 2,
  encoding: 'uint16',
  scale: 0.25,
  unit: '1/min',
};

const SIGNALS = new Map([
  [coolant.id, coolant],
  [rpm.id, rpm],
]);

const layout: FreezeFrameField[] = [
  { did: 0x0c00, name: 'Motorwerte', signals: [coolant.id, rpm.id] },
  { did: 0xf40c, length: 1 },
];

const PAYLOAD = new Uint8Array([0x0b, 0xb8, 0x07, 0xd0, 0x2a]);
//  field 0x0c00: 0x0bb8 = 3000 * 0.1 = 300.0 °C? (fixture, not physics) | 0x07d0 = 2000 * 0.25 = 500 1/min
//  field 0xf40c: 0x2a, 1 byte, no signals

describe('undocumented records', () => {
  test('without any layout the record is kept raw, never interpreted', () => {
    const frame = decodeFreezeFrame(PAYLOAD, { code: 'P0420', recordNumber: 0x01 });
    assert.equal(frame.documented, false);
    assert.deepEqual(frame.fields, []);
    assert.equal(frame.unassignedHex, '0B B8 07 D0 2A');
    assert.ok(frame.notes[0]?.includes('no definition for P0420'));
  });

  test('an empty record and a definition without layout produce distinct notes', () => {
    const empty = decodeFreezeFrame(new Uint8Array(), { code: 'P0420', recordNumber: 1 });
    assert.ok(empty.notes[0]?.includes('empty snapshot record'));

    const noLayout = decodeFreezeFrame(PAYLOAD, { code: 'P0420', recordNumber: 1, definition: { code: 'P0420', description: 'x' } });
    assert.ok(noLayout.notes[0]?.includes('documents no freeze frame layout'));
  });
});

describe('documented records', () => {
  test('fields are split in declaration order and signals decoded with scale', () => {
    const frame = decodeFreezeFrame(PAYLOAD, { code: 'P0301', recordNumber: 0x02, fields: layout, signals: SIGNALS });
    assert.equal(frame.documented, true);
    assert.equal(frame.unassignedHex, '');
    assert.deepEqual(frame.notes, ['field 0xF40C has no signal definitions — its bytes are reported without interpretation']);
    const [motor, load] = frame.fields;
    assert.equal(motor?.name, 'Motorwerte');
    assert.equal(motor?.rawHex, '0B B8 07 D0');
    assert.equal(motor?.values[0]?.value, 300);
    assert.equal(motor?.values[1]?.value, 500);
    assert.equal(load?.name, 'DID 0xF40C', 'a field without a label falls back to the hex DID');
    assert.deepEqual(load?.values, []);
  });

  test('field length can be derived from the signals instead of a declared length', () => {
    const fields: FreezeFrameField[] = [{ did: 0x0c00, signals: [coolant.id] }];
    const frame = decodeFreezeFrame(new Uint8Array([0x00, 0x64, 0xff, 0xff]), { code: 'P0420', recordNumber: 1, fields, signals: SIGNALS });
    assert.equal(frame.fields[0]?.rawHex, '00 64', 'two bytes, derived from byteOffset+length');
    assert.equal(frame.unassignedHex, 'FF FF', 'the rest stays raw');
    assert.equal(frame.documented, false);
  });

  test('leftover bytes are reported, not silently dropped', () => {
    const fields: FreezeFrameField[] = [{ did: 0xf40c, length: 1 }];
    const frame = decodeFreezeFrame(PAYLOAD, { code: 'P0420', recordNumber: 1, fields, signals: SIGNALS });
    assert.equal(frame.documented, false);
    assert.equal(frame.unassignedHex, 'B8 07 D0 2A');
    assert.ok(frame.notes.some((note) => note.includes('4 byte(s) are not covered')));
  });

  test('a record shorter than the layout stops cleanly at the missing field', () => {
    const frame = decodeFreezeFrame(new Uint8Array([0x0b, 0xb8]), { code: 'P0420', recordNumber: 1, fields: layout, signals: SIGNALS });
    assert.equal(frame.fields.length, 0, 'the first field already needs 4 bytes');
    assert.ok(frame.notes[0]?.includes('record is shorter than the declared layout'));
    assert.ok(frame.notes[0]?.includes('needs 4'));
    assert.equal(frame.documented, false);

    const twoFields = decodeFreezeFrame(new Uint8Array([0x0b, 0xb8, 0x07, 0xd0]), { code: 'P0420', recordNumber: 1, fields: layout, signals: SIGNALS });
    assert.equal(twoFields.fields.length, 1, 'the second field (1 byte) is missing');
    assert.ok(twoFields.notes[0]?.includes('needs 1'));
  });
});

describe('broken layouts', () => {
  test('a field with neither length nor signals aborts the split with a note', () => {
    const fields: FreezeFrameField[] = [{ did: 0x1234 }];
    const frame = decodeFreezeFrame(PAYLOAD, { code: 'P0420', recordNumber: 1, fields, signals: SIGNALS });
    assert.deepEqual(frame.fields, []);
    assert.ok(frame.notes.some((note) => note.includes('declares neither a length nor signals')));
    assert.ok(frame.notes.some((note) => note.includes('could not be split with the documented layout')));
    assert.equal(frame.unassignedHex, '0B B8 07 D0 2A');
  });

  test('unknown signal ids are ignored; a fully unknown field reports its bytes uninterpreted', () => {
    const fields: FreezeFrameField[] = [{ did: 0x0c00, signals: ['ghost.signal', coolant.id] }];
    const frame = decodeFreezeFrame(new Uint8Array([0x00, 0x64]), { code: 'P0420', recordNumber: 1, fields, signals: SIGNALS });
    assert.equal(frame.fields.length, 1);
    assert.equal(frame.fields[0]?.values.length, 1);
    assert.equal(frame.notes.length, 0);
  });

  test('bytes too short for a signal are reported as "not covered", never zero-filled', () => {
    const wide: SignalDefinition = { ...coolant, length: 4 };
    const fields: FreezeFrameField[] = [{ did: 0x0c00, length: 2, signals: [wide.id] }];
    const frame = decodeFreezeFrame(new Uint8Array([0x00, 0x64]), { code: 'P0420', recordNumber: 1, fields, signals: new Map([[wide.id, wide]]) });
    assert.equal(frame.fields[0]?.rawHex, '00 64', 'the field itself is split correctly');
    assert.deepEqual(frame.fields[0]?.values, [], 'the 4-byte signal gets no zero-padded guess');
    assert.ok(frame.notes.some((note) => note.includes('not covered by the 2 byte(s)')));
  });

  test('a throwing decoder only loses the one signal, not the record', () => {
    const decoder = new SignalDecoder();
    decoder.decode = () => {
      throw new Error('boom');
    };
    const fields: FreezeFrameField[] = [{ did: 0x0c00, signals: [coolant.id] }];
    const frame = decodeFreezeFrame(new Uint8Array([0x00, 0x64]), { code: 'P0420', recordNumber: 1, fields, signals: SIGNALS, decoder });
    assert.deepEqual(frame.fields[0]?.values, []);
    assert.ok(frame.notes.some((note) => note.includes('could not be decoded: boom')));
  });

  test('a field without signal definitions is reported without interpretation', () => {
    const fields: FreezeFrameField[] = [{ did: 0xf40c, length: 2, signals: [] }];
    const frame = decodeFreezeFrame(new Uint8Array([0xaa, 0xbb]), { code: 'P0420', recordNumber: 1, fields, signals: SIGNALS });
    assert.equal(frame.fields[0]?.rawHex, 'AA BB');
    assert.ok(frame.notes[0]?.includes('no signal definitions'));
  });
});

describe('signalMapOf', () => {
  test('exposes the index byId map directly', () => {
    const map = signalMapOf({ byId: SIGNALS });
    assert.equal(map.get('engine.rpm')?.unit, '1/min');
  });
});
