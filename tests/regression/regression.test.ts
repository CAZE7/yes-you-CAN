/**
 * Regression catalogue (AGENTS 31.6).
 *
 * Every entry below is a bug that was actually found and fixed. Each one states
 * the symptom that gave it away, because a regression test without the symptom is
 * just an assertion nobody dares to change.
 *
 * The compiler caught none of these. They were found by running code.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DefinitionError, fromHex, toHex } from '@vdp/shared';
import { DefinitionRegistry, genericPackage } from '@vdp/definitions';
import { IsoTpConnection } from '@vdp/transport-iso-tp';
import { ReplayTransport } from '@vdp/transport-can';
import { createVirtualCanNetwork, VirtualVehicle } from '@vdp/simulators';
import { DiagnosticEngine } from '@vdp/core';
import { createLogger } from '@vdp/shared';

const logger = createLogger('regression', { level: 'ERROR' });

/** Two buses on ONE network — separate networks never see each other. */
function createChannel(channel: string) {
  const network = createVirtualCanNetwork({ channel });
  const a = network.createBus('a');
  const b = network.createBus('b');
  void a.open();
  void b.open();
  return { a, b };
}

test('REGRESSION: a first frame below 256 bytes was misread as the escape form', () => {
  // Symptom: every multi-frame response shorter than 256 bytes decoded to a
  // nonsensical length, because the escape check looked only at the PCI nibble.
  // FF_DL is 12 bits; it is zero only in the escape form (ISO 15765-2 §9.5.2).
  const { a, b } = createChannel('reg-ffdl');
  const connection = new IsoTpConnection(a, { txId: 0x7e0, rxId: 0x7e8, channel: 'reg-ffdl' }, logger);
  connection.open();

  const received: Uint8Array[] = [];
  connection.onUnsolicited((payload) => received.push(payload));

  // 0x10 0x14 → FF_DL = 0x014 = 20 bytes, NOT the escape form.
  void b.send({ timestamp: Date.now(), id: 0x7e8, extended: false, fd: false, dlc: 8, payload: fromHex('10 14 62 F1 90 31 48 47'), channel: 'reg-ffdl', direction: 'tx' });
  void b.send({ timestamp: Date.now(), id: 0x7e8, extended: false, fd: false, dlc: 8, payload: fromHex('21 43 4D 38 32 36 33 33'), channel: 'reg-ffdl', direction: 'tx' });
  void b.send({ timestamp: Date.now(), id: 0x7e8, extended: false, fd: false, dlc: 8, payload: fromHex('22 41 30 30 34 33 35 32'), channel: 'reg-ffdl', direction: 'tx' });

  return new Promise<void>((resolve) => {
    setTimeout(() => {
      assert.equal(received.length, 1, 'the 20 byte message must be delivered');
      assert.equal(received[0]?.length, 20);
      resolve();
    }, 60);
  });
});

test('REGRESSION: flow control arriving before the waiter was registered was dropped', async () => {
  // Symptom: transmitting a long payload hung until N_Bs expired, because the
  // peer answered synchronously inside send() and no waiter existed yet.
  const { a, b } = createChannel('reg-fc');
  const connection = new IsoTpConnection(a, { txId: 0x7e0, rxId: 0x7e8, channel: 'reg-fc', timing: { nBsMs: 200 } }, logger);
  connection.open();

  // Answer every first frame immediately, before any waiter could be registered.
  b.subscribe((frame) => {
    if (((frame.payload[0] ?? 0) >> 4) !== 1) return;
    void b.send({ timestamp: Date.now(), id: 0x7e8, extended: false, fd: false, dlc: 8, payload: fromHex('30 00 00 00 00 00 00 00'), channel: 'reg-fc', direction: 'tx' });
  });

  await connection.sendOnly(new Uint8Array(60).fill(0x5a));
  assert.ok(true, 'the transfer must complete despite the synchronous flow control');
});

test('REGRESSION: block size was advertised but never enforced on reception', async () => {
  // Symptom: with BS=2 a sender could stream unbounded consecutive frames; we
  // never asked for the next block, so a real ECU would have stalled instead.
  const { a, b } = createChannel('reg-bs');
  const connection = new IsoTpConnection(a, { txId: 0x7e0, rxId: 0x7e8, channel: 'reg-bs', timing: { blockSize: 2 } }, logger);
  connection.open();

  const pending = connection.request(fromHex('22 F1 90'), 1000);
  const sent: Uint8Array[] = [];
  b.subscribe((frame) => sent.push(frame.payload));

  await new Promise((resolve) => setTimeout(resolve, 20));
  void b.send({ timestamp: Date.now(), id: 0x7e8, extended: false, fd: false, dlc: 8, payload: fromHex('10 1B 62 F1 90 41 42 43'), channel: 'reg-bs', direction: 'tx' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  void b.send({ timestamp: Date.now(), id: 0x7e8, extended: false, fd: false, dlc: 8, payload: fromHex('21 44 45 46 47 48 49 4A'), channel: 'reg-bs', direction: 'tx' });
  void b.send({ timestamp: Date.now(), id: 0x7e8, extended: false, fd: false, dlc: 8, payload: fromHex('22 4B 4C 4D 4E 4F 50 51'), channel: 'reg-bs', direction: 'tx' });
  await new Promise((resolve) => setTimeout(resolve, 30));

  const flowControls = sent.filter((payload) => ((payload[0] ?? 0) >> 4) === 3);
  assert.equal(flowControls.length, 2, `expected a flow control per block, got ${flowControls.length}`);

  void b.send({ timestamp: Date.now(), id: 0x7e8, extended: false, fd: false, dlc: 8, payload: fromHex('23 52 53 54 55 56 57 58'), channel: 'reg-bs', direction: 'tx' });
  const response = await pending;
  assert.equal(response.length, 27);
});

test('REGRESSION: the trace analyzer decoded requests as if they were responses', () => {
  // Symptom: a tester request `22 F1 90` showed up in the report as a positive
  // READ_DATA_BY_IDENTIFIER response — a response that never happened.
  return import('@vdp/trace-analyzer').then(({ analyzeTrace, parseTrace }) => {
    const analysis = analyzeTrace(parseTrace('  vcan0  7E0   [4]  03 22 F1 90'), { definitions: genericPackage });
    const request = analysis.messages[0];
    assert.equal(request?.direction, 'request');
    assert.match(request?.decoded ?? '', /^REQUEST /, 'a request must be labelled as a request');
  });
});

test('REGRESSION: the slcan parser mis-split extended identifiers', () => {
  // Symptom: `T18DAF1003023E80` parsed with a 3-digit id and swallowed payload
  // bytes, because the regex alternation {3}|{8} backtracked into the data.
  return import('@vdp/adapter-canable').then(({ parseSlcanLine }) => {
    const extended = parseSlcanLine('T18DAF1003023E80', 'slcan0');
    assert.ok(extended, 'the extended frame must parse');
    assert.equal(extended.id, 0x18daf100);
    assert.equal(extended.extended, true);
    assert.deepEqual(Array.from(extended.payload), [0x02, 0x3e, 0x80]);

    const standard = parseSlcanLine('t7E03023E80', 'slcan0');
    assert.equal(standard?.id, 0x7e0);
    assert.equal(standard?.extended, false);
    assert.deepEqual(Array.from(standard?.payload ?? []), [0x02, 0x3e, 0x80]);
  });
});

test('REGRESSION: findEcuByAddress never matched because `extended` is optional', () => {
  // Symptom: the registry returned undefined for every 11-bit ECU, since the
  // generic package leaves `extended` unset and `undefined === false` is false.
  const registry = new DefinitionRegistry();
  const found = registry.findEcuByAddress(0x7e0);
  assert.ok(found, 'the engine ECU must be found by its request identifier');
  assert.equal(found.ecuId, 'engine');
});

test('REGRESSION: fromHex rejected input the tests claimed it accepted', () => {
  // Symptom: a test asserted fromHex('0x7DF 02 10 03') yields five bytes — nine
  // hex digits cannot produce five bytes. The parser was right, the test was not.
  assert.deepEqual(fromHex('0x7D 0xF0 02'), new Uint8Array([0x7d, 0xf0, 0x02]));
  assert.throws(() => fromHex('ABC'), /odd number of hex digits/);
});

test('REGRESSION: raw protocol logging was filtered away by the global level', () => {
  // Symptom: with level WARN the explicit rawProtocol switch did nothing, so
  // protocol traces could not be enabled without raising everything to TRACE.
  return import('@vdp/shared').then(({ createLogger: makeLogger, MemorySink }) => {
    const sink = new MemorySink();
    makeLogger('can', { level: 'WARN', rawProtocol: true }, [sink]).raw('frame', { data: new Uint8Array([1, 2]) });
    assert.equal(sink.all().length, 1, 'rawProtocol must bypass the level filter');
    assert.equal((sink.all()[0]?.fields as Record<string, unknown>)?.data, '01 02', 'byte fields are stored as hex');
  });
});

test('REGRESSION: the virtual bus labelled the sender’s own frames as rx', async () => {
  // Symptom: a recorded trace contained only rx frames, so half the conversation
  // was missing and request/response pairing was impossible.
  const network = createVirtualCanNetwork({ channel: 'reg-dir', echoToSender: true });
  const sender = network.createBus('sender');
  await sender.open();

  const seen: Array<string | undefined> = [];
  sender.subscribe((frame) => seen.push(frame.direction));
  await sender.send({ timestamp: Date.now(), id: 0x7e0, extended: false, fd: false, dlc: 3, payload: fromHex('02 3E 80'), channel: 'reg-dir', direction: 'tx' });

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(seen, ['tx'], 'the sender must see its own frame as tx');
});

test('REGRESSION: a DBC broadcast message was turned into a diagnostic ECU', () => {
  // Symptom: importing a DBC produced ECUs whose txId equalled rxId — an
  // identifier pair no vehicle answers — and the validator rejected the package.
  return import('@vdp/definition-importer').then(({ diagnosticRequestFor, importDbc }) => {
    assert.equal(diagnosticRequestFor(0x7e8, false), 0x7e0);
    assert.equal(diagnosticRequestFor(0x666, false), null, 'a broadcast id is not a diagnostic response');

    const result = importDbc('BO_ 666 BroadcastSpeed: 8 Vector__XXX\n SG_ WheelSpeed : 0|16@1+ (0.01,0) [0|655] "kmh" Vector__XXX\n', {
      oem: 'test',
      name: 'regression',
      provenance: { sourceType: 'community', source: 'regression fixture' },
    });
    assert.equal(result.pkg.ecus.length, 0, 'the broadcast must not become an ECU');
    assert.ok(result.skipped.some((entry) => entry.reason === 'message id is not a diagnostic response identifier'));
  });
});

test('REGRESSION: replay answered requests that the recording never contained', async () => {
  // Symptom: a fuzzy replay hid protocol changes instead of exposing them, which
  // is the opposite of what a regression harness is for.
  const bus = new ReplayTransport(
    { frames: [{ t: 0, canId: 0x7e0, direction: 'tx', payload: fromHex('03 22 F1 90') }, { t: 1, canId: 0x7e8, direction: 'rx', payload: fromHex('03 62 F1 90') }] },
    { logger, immediate: true, matchByIdOnly: false },
  );
  await bus.open();

  const received: Uint8Array[] = [];
  bus.subscribe((frame) => received.push(frame.payload));
  await bus.send({ timestamp: Date.now(), id: 0x7e0, extended: false, fd: false, dlc: 4, payload: fromHex('03 22 BE EF'), channel: 'replay0' });

  assert.equal(received.length, 0, 'a changed request must not be answered from a different recording entry');
  assert.equal(bus.deviations[0]?.kind, 'payload-differs');
  await bus.close();
});

test('REGRESSION: definition packages without provenance passed validation', () => {
  // Symptom: OEM data of unknown origin looked authoritative in the UI, which
  // AGENTS 24 explicitly forbids.
  const broken = { ...genericPackage, oem: '', version: 'not-semver' };
  return import('@vdp/definitions').then(({ validateDefinitionPackage }) => {
    const result = validateDefinitionPackage(broken);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => error.includes('oem is required')));
    assert.ok(result.errors.some((error) => error.includes('SemVer')));
    assert.ok(new DefinitionError('x') instanceof Error);
  });
});

test('REGRESSION: the workbench lost the ECU name in its state snapshot', async () => {
  // Symptom: live samples arrived as "Engine speed" over SSE but the snapshot
  // showed the bare signal id, because the recorder stores no name.
  const vehicle = new VirtualVehicle({ definitions: genericPackage, logger, networkOptions: { echoToSender: true } });
  await vehicle.start();
  const engine = new DiagnosticEngine({ bus: vehicle.testerBus, definitions: [genericPackage], logger });
  await engine.connect();
  await engine.startLiveData({ signalIds: ['engine.rpm'], intervalMs: 40, maxRounds: 2 });
  await new Promise((resolve) => setTimeout(resolve, 250));

  assert.equal(engine.findSignal('engine.rpm')?.name, 'Engine speed', 'the definition must supply the display name');
  const { samples } = engine.recorder.export();
  assert.ok(samples.length > 0, 'the recording must contain samples');
  await engine.disconnect();
  await vehicle.stop();
  assert.equal(toHex(fromHex('0D 48')), '0D 48');
});

test('REGRESSION: echoed transmissions were discovered as phantom ECUs', async () => {
  // Symptom: with an adapter that echoes sent frames (candump, or any bus opened
  // with echoToSender) discovery reported 13 "ECUs" instead of 3 — one for every
  // request identifier we transmitted, including the functional id 0x7DF.
  const vehicle = new VirtualVehicle({
    definitions: genericPackage,
    logger,
    networkOptions: { echoToSender: true },
  });
  await vehicle.start();
  const engine = new DiagnosticEngine({ bus: vehicle.testerBus, definitions: [genericPackage], logger });
  try {
    const result = await engine.connect();
    const ids = result.ecus.map((ecu) => ecu.rxId).sort((a, b) => a - b);

    assert.deepEqual(ids, [0x77b, 0x7e8, 0x7e9], `discovered ids were ${ids.map((id) => id.toString(16)).join(', ')}`);
    assert.ok(!ids.includes(0x7df), 'the functional request id is not an ECU');
    for (const id of ids) {
      assert.ok(id < 0x7e0 || id > 0x7e7, `0x${id.toString(16)} is a tester request id, not a response`);
    }
  } finally {
    await engine.disconnect();
    await vehicle.stop();
  }
});
