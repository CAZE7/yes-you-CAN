/**
 * SessionLogger tests (AGENTS 17, 18, 33).
 *
 * The raw trace is the witness for replay and regression: entries must be
 * lossless (payload bytes preserved, both directions recorded), bounded in
 * memory, and exportable without reinterpretation.
 */

import assert from 'node:assert/strict';
import fc from 'fast-check';
import { describe, test } from 'vitest';
import { createFrame } from '@vdp/transport-can';
import { toHex } from '@vdp/shared';
import { SessionLogger } from './session-logger.js';

function frameAt(id: number, payload: number[], timestamp: number, direction: 'tx' | 'rx' = 'rx') {
  return createFrame(id, new Uint8Array(payload), { timestamp, direction });
}

describe('trace recording', () => {
  test('entries keep both directions, hex payload and the injectable clock', () => {
    let now = 10_000;
    const session = new SessionLogger({ clock: () => now });
    session.recordFrame(frameAt(0x7e0, [0x22, 0xf1, 0x90], now, 'tx'));
    now = 10_050;
    const entry = session.recordFrame(frameAt(0x7e8, [0x62, 0xf1, 0x90, 0x57], now, 'rx'));
    assert.equal(entry.direction, 'rx');
    assert.equal(entry.payloadHex, '62F19057');
    assert.equal(entry.canIdHex, '0x7E8');
    assert.equal(entry.t, 50);
    assert.equal(session.traceLength, 2);
    // A frame whose timestamp is 0/absent falls back to the injectable clock.
    const undated = createFrame(0x123, new Uint8Array([1]), { timestamp: 0 });
    session.recordFrame(undated);
    assert.equal(session.snapshot().trace[2]?.t, 50, 'clock fallback: 10050 - 10000');
  });

  test('the trace cap drops the OLDEST entries, never silently grows unbounded', () => {
    let now = 0;
    const session = new SessionLogger({ clock: () => now, maxTraceEntries: 10 });
    for (let i = 0; i <= 25; i++) {
      now = i;
      session.recordFrame(frameAt(0x100 + i, [i & 0xff], now));
    }
    assert.equal(session.traceLength, 10);
    const first = session.snapshot().trace[0] as { canId: number; t: number };
    assert.equal(first.canId, 0x110, 'the first 16 entries were evicted');
  });

  test('pairs() matches each tx request with the next rx response', () => {
    let now = 0;
    const session = new SessionLogger({ clock: () => now });
    session.recordFrame(frameAt(0x7e0, [0x10, 0x03], (now += 10), 'tx'));
    session.recordFrame(frameAt(0x7e8, [0x50, 0x03], (now += 10), 'rx'));
    session.recordFrame(frameAt(0x7e8, [0x02, 0x01], (now += 10), 'rx'));
    session.recordFrame(frameAt(0x7e0, [0x3e, 0x00], (now += 10), 'tx'));
    const pairs = session.pairs();
    assert.equal(pairs.length, 2);
    assert.equal(pairs[0]?.response?.payloadHex, '5003');
    assert.equal(pairs[1]?.response, null, 'a request without response is reported as null');
  });

  test('diagnostic log entries carry scope, message and fields', () => {
    let now = 500;
    const session = new SessionLogger({ clock: () => now });
    const entry = session.log('uds', 'session control', { type: 'extended' });
    assert.equal(entry.scope, 'uds');
    assert.equal(entry.fields?.type, 'extended');
    assert.equal(entry.t, 0);
    now = 800;
    assert.equal(session.log('dtc', 'scanned').t, 300);
    assert.equal(session.entries.length, 2);
  });

  test('traceFor filters one identifier', () => {
    const session = new SessionLogger({ clock: () => 0 });
    session.recordFrame(frameAt(0x7e0, [1], 0, 'tx'));
    session.recordFrame(frameAt(0x7e8, [2], 1, 'rx'));
    session.recordFrame(frameAt(0x7e0, [3], 2, 'tx'));
    assert.equal(session.traceFor(0x7e0).length, 2);
  });
});

describe('exports (AGENTS 17/18)', () => {
  test('CSV escapes quotes, commas and newlines per RFC 4180', () => {
    const csv = SessionLogger.toCsv(
      [
        {
          timestamp: '2026-09-11T08:00:00.000Z',
          t: 0,
          signal: 'engine.note',
          value: 'knock, "loud"',
          rawValue: 'x',
          rawHex: '00',
          outOfRange: false,
        },
      ],
      [{ id: 'marker_1', t: 5, timestamp: '2026-09-11T08:00:00.005Z', label: 'line\nbreak', kind: 'user' }],
    );
    assert.ok(csv.includes('"knock, ""loud"""'));
    assert.ok(csv.includes('"line\nbreak"'));
    assert.ok(csv.endsWith('\n'));
    assert.ok(csv.includes('# markers'));
  });

  test('trace CSV keeps id, direction, dlc and payload', () => {
    const session = new SessionLogger({ clock: () => 0 });
    const entry = session.recordFrame(frameAt(0x7e8, [0x62, 0xf1], 0, 'rx'));
    const csv = SessionLogger.traceToCsv([entry]);
    assert.match(csv, /0x7E8,rx,2,62F1,can0,false,false/);
  });

  test('JSON export is the lossless format marker + payload-as-hex', () => {
    const json = SessionLogger.toJson({
      meta: { vin: '1HGCM82633A004352' },
      samples: [],
      markers: [],
      dtcs: [],
      trace: [{ ...traceStub(), payloadHex: toHex(new Uint8Array([1, 2]), '') }],
      log: [],
    });
    const parsed = JSON.parse(json) as { format: string; formatVersion: number; trace: Array<{ payload: string }> };
    assert.equal(parsed.format, 'vdp.session');
    assert.equal(parsed.formatVersion, 1);
    assert.equal(parsed.trace[0]?.payload, '0102');
  });

  test('property: every recorded frame re-exports with an identical payload hex', () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 0x7ff }),
        fc.uint8Array({ minLength: 0, maxLength: 8 }),
        fc.nat({ max: 0xffff }),
        (id, payload, timestamp) => {
          const session = new SessionLogger({ clock: () => timestamp });
          const entry = session.recordFrame(createFrame(id, payload, { timestamp, direction: 'tx' }));
          assert.equal(entry.payloadHex, toHex(payload, ''));
          assert.equal(entry.dlc, payload.length === 0 ? 0 : Math.min(payload.length, 8));
        },
      ),
    );
  });
});

function traceStub() {
  return {
    timestamp: '2026-09-11T08:00:00.000Z',
    t: 0,
    canId: 0x7e8,
    canIdHex: '0x7E8',
    direction: 'rx' as const,
    dlc: 2,
    payload: new Uint8Array([1, 2]),
    payloadHex: '0102',
    channel: 'can0',
    extended: false,
    fd: false,
  };
}
