import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toHex } from '@vdp/shared';
import { genericPackage } from '@vdp/definitions';
import { analyzeTrace, decodeUdsResponse, formatTraceReport, parseTrace, parseTraceLine, rebuildIsoTpMessages, type TraceFinding } from '../src/index.js';

test('candump, CSV and NDJSON trace lines all parse to frames', () => {
  const candump = parseTraceLine('  vcan0  7E0   [3]  02 3E 80');
  assert.equal(candump?.frame.id, 0x7e0);
  assert.equal(candump?.frame.channel, 'vcan0'.replace('vcan0', 'trace'), 'channel defaults when the line carries none of its own');
  assert.deepEqual(Array.from(candump?.frame.payload ?? []), [0x02, 0x3e, 0x80]);

  const extended = parseTraceLine('  vcan0  18DAF100   [8]  02 3E 80 00 00 00 00 00');
  assert.equal(extended?.frame.extended, true);

  const csv = parseTraceLine('1000,2016,false,3,023E80');
  assert.equal(csv?.t, 1000);
  assert.equal(csv?.frame.id, 2016);
  assert.equal(csv?.frame.dlc, 3);
  assert.deepEqual(Array.from(csv?.frame.payload ?? []), [0x02, 0x3e, 0x80]);

  const ndjson = parseTraceLine('{"t":1500,"canId":2024,"data":"023E80"}');
  assert.equal(ndjson?.t, 1500);
  assert.equal(ndjson?.frame.id, 2024);

  assert.equal(parseTraceLine(''), null);
  assert.equal(parseTraceLine('garbage'), null);
});

test('missing timestamps are synthesised so period maths still works', () => {
  const entries = parseTrace('  vcan0  7E0   [3]  02 3E 80\n  vcan0  7E0   [3]  02 3E 80\n');
  assert.equal(entries.length, 2);
  assert.notEqual(entries[0]?.t, entries[1]?.t);
});

test('a full multi-frame exchange is rebuilt into one message', () => {
  const entries = parseTrace(
    [
      '  vcan0  7E0   [4]  03 22 F1 90',
      // 0x014 = 20 bytes announced: 62 F1 90 + the 17 byte VIN
      '  vcan0  7E8   [8]  10 14 62 F1 90 31 48 47',
      '  vcan0  7E0   [3]  30 00 00',
      '  vcan0  7E8   [8]  21 43 4D 38 32 36 33 33',
      '  vcan0  7E8   [8]  22 41 30 30 34 33 35 32',
    ].join('\n'),
  );
  const analysis = analyzeTrace(entries);
  const vin = analysis.messages.find((message) => message.did === 0xf190 && message.direction === 'response');
  assert.ok(vin, 'VIN read must be rebuilt from the trace');
  assert.equal(vin.frames, 3);
  assert.equal(vin.decoded, 'READ_DATA_BY_IDENTIFIER 0xF190');
  assert.equal(vin.payload, '62 F1 90 31 48 47 43 4D 38 32 36 33 33 41 30 30 34 33 35 32');
  const request = analysis.messages.find((message) => message.direction === 'request');
  assert.ok(request, 'the tester request must be rebuilt as its own message');
  assert.equal(request.sourceId, 0x7e0);
  assert.equal(request.payload, '22 F1 90');
  assert.equal(request.decoded, 'REQUEST READ_DATA_BY_IDENTIFIER 0xF190');
  assert.equal(vin.sourceId, 0x7e8);
  assert.equal(vin.direction, 'response');
});

test('signals present in the definition package are decoded from the trace', () => {
  const entries = parseTrace('  vcan0  7E8   [8]  06 62 F4 0C 0D 48 00 00');
  const analysis = analyzeTrace(entries, { definitions: genericPackage });
  const rpm = analysis.decodedSignals.find((entry) => entry.signal === 'engine.rpm');
  assert.ok(rpm, 'engine.rpm must be decoded from the raw response');
  assert.equal(rpm.value, 850);
  assert.equal(rpm.unit, 'rpm');
});

test('an incomplete multi-frame message is reported as a finding', () => {
  const entries = parseTrace('  vcan0  7E8   [8]  10 14 62 F1 90 31 48 47');
  const findings: TraceFinding[] = [];
  const messages = rebuildIsoTpMessages(entries, [{ txId: 0x7e0, rxId: 0x7e8 }], findings);
  assert.equal(messages.length, 0);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.kind, 'incomplete-transport-message');
  assert.equal(findings[0]?.severity, 'major');
});

test('negative responses and unknown identifiers are flagged', () => {
  // 0x03 = ISO-TP single frame carrying the three byte negative response 7F 22 31
  const entries = parseTrace(['  vcan0  7E8   [4]  03 7F 22 31', '  vcan0  123   [8]  00 00 00 00 00 00 00 00'].join('\n'));
  const analysis = analyzeTrace(entries, { definitions: genericPackage });
  assert.ok(analysis.findings.some((finding) => finding.kind === 'negative-response'));
  assert.ok(analysis.findings.some((finding) => finding.kind === 'unknown-id' && finding.canId === 0x123));
});

test('identifiers from the definition package are marked as known', () => {
  const entries = parseTrace('  vcan0  7E8   [8]  02 50 01 00 32 01 F4 AA AA');
  const analysis = analyzeTrace(entries, { definitions: genericPackage });
  const ecuId = analysis.ids.find((id) => id.canId === 0x7e8);
  assert.equal(ecuId?.known, true);
  assert.equal(ecuId?.name, 'Engine Control Unit');
});

test('period and duration statistics are computed per identifier', () => {
  const lines: string[] = [];
  for (let t = 0; t < 10; t++) lines.push(`${t * 10},2016,false,8,023E80000000000000`);
  const analysis = analyzeTrace(parseTrace(lines.join('\n')));
  assert.equal(analysis.frames, 10);
  assert.equal(analysis.durationMs, 90);
  assert.equal(analysis.ids[0]?.periodMs, 10);
});

test('high bus rate is reported as an informational finding', () => {
  const lines: string[] = [];
  for (let t = 0; t < 100; t++) lines.push(`${t},2016,false,8,023E80000000000000`);
  const analysis = analyzeTrace(parseTrace(lines.join('\n')), { highRateFramesPerSecond: 500 });
  assert.ok(analysis.findings.some((finding) => finding.kind === 'high-rate'));
});

test('the markdown report contains every section', () => {
  const entries = parseTrace('  vcan0  7E8   [4]  03 7F 22 31');
  const report = formatTraceReport(analyzeTrace(entries, { definitions: genericPackage }));
  assert.match(report, /# Trace analysis/);
  assert.match(report, /## Identifiers/);
  assert.match(report, /## Decoded messages/);
  assert.match(report, /## Findings/);
  assert.match(report, /0x7E8/);
});

test('hex payloads are rendered uppercase and space separated', () => {
  const entries = parseTrace('  vcan0  7E8   [3]  02 50 01');
  const analysis = analyzeTrace(entries);
  assert.equal(analysis.messages[0]?.payload, toHex(new Uint8Array([0x50, 0x01])));
});

test('UDS responses are decoded into service, DID and payload', () => {
  const positive = decodeUdsResponse(new Uint8Array([0x62, 0xf4, 0x0c, 0x0d, 0x48]));
  assert.equal(positive?.serviceId, 0x22);
  assert.equal(positive?.positive, true);
  assert.equal(positive?.did, 0xf40c);
  assert.deepEqual(Array.from(positive?.data ?? []), [0x0d, 0x48]);

  const negative = decodeUdsResponse(new Uint8Array([0x7f, 0x22, 0x31]));
  assert.equal(negative?.positive, false);
  assert.equal(negative?.serviceId, 0x22);
  assert.equal(negative?.nrc, 0x31);

  assert.equal(decodeUdsResponse(new Uint8Array([])), null, 'empty payload must not decode');
});

test('a frame with a reserved PCI type is not mistaken for a message', () => {
  // 0x7F has PCI type 7, which ISO 15765-2 does not define; a bare "7F 22 31"
  // without a single frame length prefix is therefore ignored, not decoded.
  const entries = parseTrace('  vcan0  7E8   [3]  7F 22 31');
  const analysis = analyzeTrace(entries);
  assert.equal(analysis.messages.length, 0);
});

test('a request is never reported as a positive response', () => {
  const entries = parseTrace('  vcan0  7E0   [4]  03 22 F1 90');
  const analysis = analyzeTrace(entries, { definitions: genericPackage });
  const request = analysis.messages[0];
  assert.equal(request?.direction, 'request');
  assert.match(request?.decoded ?? '', /^REQUEST /);
  assert.ok(!analysis.findings.some((finding) => finding.kind === 'negative-response'));
});
