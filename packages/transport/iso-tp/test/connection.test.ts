import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fromHex, toHex } from '@vdp/shared';
import {
  type AdapterCapabilities,
  type AdapterInfo,
  type CanBus,
  type CanFilter,
  type CanFrame,
  type FrameListener,
} from '@vdp/transport-can';
import { IsoTpConnection, parseStMin } from '../src/index.js';

/**
 * Minimal virtual CAN wire.
 *
 * `send()` broadcasts to every *other* node (like a real bus seen through an
 * adapter that filters its own echo); `inject()` feeds a frame to this node only
 * and is used to simulate frames arriving from an ECU in protocol tests.
 */
interface Wire {
  buses: VirtualBus[];
  frames: CanFrame[];
  deliver(frame: CanFrame, from: VirtualBus): void;
}

function createWire(): Wire {
  const wire: Wire = {
    buses: [],
    frames: [],
    deliver(frame, from) {
      wire.frames.push(frame);
      for (const bus of wire.buses) {
        if (bus === from) continue;
        bus.receiveFrame({ ...frame, direction: 'rx' });
      }
    },
  };
  return wire;
}

const INFO: AdapterInfo = { id: 'virtual', kind: 'virtual', name: 'Virtual CAN', channels: ['vcan0'] };

/** Yield to the microtask queue so a started request can register its pending slot. */
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

class VirtualBus implements CanBus {
  readonly info = INFO;
  capabilities: AdapterCapabilities = { can: true, canFd: false, doip: false, isoTpOffload: false, channels: 1 };
  private listeners: Array<{ listener: FrameListener; filters?: readonly CanFilter[] }> = [];
  private opened = false;

  constructor(readonly wire: Wire) {
    wire.buses.push(this);
  }

  async open(): Promise<void> {
    this.opened = true;
  }
  async close(): Promise<void> {
    this.opened = false;
  }
  isOpen(): boolean {
    return this.opened;
  }
  async send(frame: CanFrame): Promise<void> {
    this.wire.deliver(frame, this);
  }
  subscribe(listener: FrameListener, filters?: readonly CanFilter[]): () => void {
    const entry = { listener, ...(filters ? { filters } : {}) };
    this.listeners.push(entry);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== entry);
    };
  }
  receiveFrame(frame: CanFrame): void {
    for (const entry of this.listeners) {
      if (entry.filters && !entry.filters.some((f) => (frame.id & f.mask) === (f.id & f.mask))) continue;
      entry.listener(frame);
    }
  }
  /** Simulate an incoming frame on this node. */
  inject(id: number, payload: Uint8Array, extended = false): void {
    this.receiveFrame({ timestamp: Date.now(), id, extended, fd: false, dlc: payload.length, payload, channel: 'vcan0', direction: 'rx' });
  }
}

interface Pair {
  wire: Wire;
  tester: IsoTpConnection;
  ecu: IsoTpConnection;
  requests: Uint8Array[];
  respond(payload: Uint8Array | null): void;
}

function createPair(options: { fd?: boolean; extendedAddressing?: boolean; timing?: Record<string, number> } = {}): Pair {
  const wire = createWire();
  const testerBus = new VirtualBus(wire);
  const ecuBus = new VirtualBus(wire);
  if (options.fd) {
    const fdCapabilities: AdapterCapabilities = { can: true, canFd: true, doip: false, isoTpOffload: false, channels: 1 };
    testerBus.capabilities = fdCapabilities;
    ecuBus.capabilities = fdCapabilities;
  }
  const base = {
    ...(options.extendedAddressing ? { addressing: 'extended' as const, extended: true } : {}),
    timing: { nBsMs: 60, nCrMs: 60, nAsMs: 0, stMinMs: 0, stMinTxMs: 0, ...(options.timing ?? {}) },
    sleep: async () => undefined,
    now: () => Date.now(),
  };
  const tester = new IsoTpConnection(testerBus, { txId: 0x7e0, rxId: 0x7e8, targetAddress: 0xf1, sourceAddress: 0x10, ...base });
  const ecu = new IsoTpConnection(ecuBus, { txId: 0x7e8, rxId: 0x7e0, targetAddress: 0x10, sourceAddress: 0xf1, ...base });
  const requests: Uint8Array[] = [];
  let responder: (() => void) | null = null;
  ecu.onUnsolicited((payload) => {
    requests.push(payload);
    responder?.();
  });
  tester.open();
  ecu.open();
  return {
    wire,
    tester,
    ecu,
    requests,
    respond(payload) {
      responder = () => {
        if (payload) void ecu.sendOnly(payload);
      };
    },
  };
}

test('STmin decoding follows ISO 15765-2 (ms range, 100-900us range, reserved)', () => {
  assert.equal(parseStMin(0x00), 0);
  assert.equal(parseStMin(0x14), 20);
  assert.equal(parseStMin(0x7f), 127);
  assert.equal(parseStMin(0xf1), 1);
  assert.equal(parseStMin(0xf5), 1);
  assert.equal(parseStMin(0xf9), 1);
  assert.equal(parseStMin(0x80), 127, 'reserved values must be treated as maximum');
  assert.equal(parseStMin(0xf0), 127);
});

test('single frame request/response round trip', async () => {
  const pair = createPair();
  pair.respond(fromHex('50 03 00 32 01 F4'));
  const response = await pair.tester.request(fromHex('10 03'));
  assert.equal(toHex(response), '50 03 00 32 01 F4');
  assert.equal(pair.requests.length, 1);
  assert.equal(toHex(pair.requests[0] as Uint8Array), '10 03');
  assert.equal(pair.tester.stats.txSingleFrames, 1);
  assert.equal(pair.tester.stats.rxSingleFrames, 1);
});

test('multi-frame response is reassembled and flow control is sent', async () => {
  const pair = createPair();
  const payload = fromHex('62 F1 90 57 56 57 5A 5A 39 4B 5A 31 32 33 34 35 36');
  pair.respond(payload);
  const response = await pair.tester.request(fromHex('22 F1 90'));
  assert.equal(toHex(response), toHex(payload));
  assert.equal(pair.tester.stats.rxMultiFrameMessages, 1);
  assert.equal(pair.ecu.stats.txMultiFrameMessages, 1);
  assert.ok(pair.tester.stats.txFlowControlFrames >= 1, 'tester must send at least one Flow Control frame');
  assert.equal(pair.ecu.stats.rxFlowControlFrames >= 1, true);
});

test('a 17-byte First Frame is decoded via the 12-bit FF_DL field, not the escape form', async () => {
  // Regression: `10 11` means FF_DL = 0x011 (17 bytes). Treating a zero PCI nibble
  // as the 4-byte escape would corrupt every message below 256 bytes.
  const pair = createPair();
  pair.respond(new Uint8Array(17).fill(0x5a));
  const response = await pair.tester.request(fromHex('22 F1 90'));
  assert.equal(response.length, 17);
  const firstFrame = pair.wire.frames.find((f) => f.id === 0x7e8);
  assert.ok(firstFrame);
  assert.equal(firstFrame.payload[0], 0x10);
  assert.equal(firstFrame.payload[1], 0x11);
});

test('multi-frame request is segmented by the tester', async () => {
  const pair = createPair();
  const request = new Uint8Array(40).fill(0xab);
  pair.respond(fromHex('71 01 00 01'));
  const response = await pair.tester.request(request);
  assert.equal(toHex(response), '71 01 00 01');
  const sent = pair.wire.frames.filter((f) => f.id === 0x7e0);
  assert.equal((sent[0]?.payload[0] ?? 0) & 0xf0, 0x10, 'first frame expected');
  assert.equal((sent[1]?.payload[0] ?? 0) & 0xf0, 0x20, 'consecutive frame expected');
  assert.equal(toHex(pair.requests[0] as Uint8Array), toHex(request));
});

test('sequence number wraps at 16 consecutive frames', () => {
  const wire = createWire();
  const bus = new VirtualBus(wire);
  const conn = new IsoTpConnection(bus, { txId: 0x7e0, rxId: 0x7e8, sleep: async () => undefined });
  assert.equal(conn.frameCountFor(7), 1);
  assert.equal(conn.frameCountFor(8), 2);
  // 6 bytes in the First Frame + 7 bytes per Consecutive Frame
  assert.equal(conn.frameCountFor(6 + 7 * 15), 16, 'sequence counter wraps after 15 CFs');
});

test('sequence error aborts the request with an ISO-TP error', async () => {
  const wire = createWire();
  const testerBus = new VirtualBus(wire);
  const tester = new IsoTpConnection(testerBus, { txId: 0x7e0, rxId: 0x7e8, sleep: async () => undefined, timing: { nCrMs: 50 } });
  tester.open();
  const promise = tester.request(fromHex('22 F1 90'));
  // Let request() register its pending slot before frames start arriving.
  await tick();
  // ECU announces 20 bytes, then sends a Consecutive Frame with the wrong sequence.
  testerBus.inject(0x7e8, fromHex('10 14 62 F1 90 00 00'));
  testerBus.inject(0x7e8, fromHex('25 AA AA AA AA AA AA'));
  await assert.rejects(promise, /sequence error/i);
  assert.equal(tester.stats.sequenceErrors, 1);
});

test('response timeout surfaces as ISO-TP timeout error', async () => {
  const pair = createPair({ timing: { nBsMs: 20, nCrMs: 20 } });
  await assert.rejects(pair.tester.request(fromHex('22 F1 90'), 25), /timeout/i);
  assert.equal(pair.tester.stats.timeouts, 1);
});

test('N_Bs timeout triggers a retry when maxRetries is configured', async () => {
  const wire = createWire();
  const testerBus = new VirtualBus(wire);
  const tester = new IsoTpConnection(testerBus, {
    txId: 0x7e0,
    rxId: 0x7e8,
    sleep: async () => undefined,
    timing: { nBsMs: 15, nCrMs: 15, maxRetries: 2 },
  });
  tester.open();
  // Multi-frame path with nobody answering Flow Control → N_Bs timeout.
  await assert.rejects(tester.request(new Uint8Array(30).fill(0x11)), /N_Bs timeout/);
  assert.equal(tester.stats.retries, 2, 'both configured retries must be attempted');
});

test('padding fills frames to the MTU with the pad byte', async () => {
  const wire = createWire();
  const bus = new VirtualBus(wire);
  const conn = new IsoTpConnection(bus, { txId: 0x7e0, rxId: 0x7e8, padding: true, padByte: 0x55, sleep: async () => undefined });
  conn.open();
  await conn.sendOnly(fromHex('3E 80'));
  const frame = wire.frames[0];
  assert.ok(frame);
  assert.equal(frame.payload.length, 8);
  assert.equal(toHex(frame.payload), '02 3E 80 55 55 55 55 55');
});

test('extended addressing prefixes the address byte and filters foreign senders', async () => {
  const pair = createPair({ extendedAddressing: true });
  pair.respond(fromHex('7F 22 31'));
  const response = await pair.tester.request(fromHex('22 F1 90'));
  assert.equal(toHex(response), '7F 22 31');
  const sent = pair.wire.frames.filter((f) => f.id === 0x7e0)[0];
  assert.ok(sent);
  assert.equal(sent.payload[0], 0xf1, 'target address must be the first byte');
  assert.equal(sent.payload[1], 0x03, 'PCI follows the address byte (3 data bytes)');
});

test('frames from a foreign source address are ignored under extended addressing', () => {
  const wire = createWire();
  const testerBus = new VirtualBus(wire);
  const tester = new IsoTpConnection(testerBus, {
    txId: 0x7e0,
    rxId: 0x7e8,
    extended: true,
    addressing: 'extended',
    targetAddress: 0xf1,
    sourceAddress: 0x10,
    sleep: async () => undefined,
  });
  tester.open();
  let unsolicited = 0;
  tester.onUnsolicited(() => {
    unsolicited++;
  });
  testerBus.inject(0x7e8, fromHex('99 02 50 03'), true);
  assert.equal(unsolicited, 0, 'frames from an unexpected source address must be dropped');
  testerBus.inject(0x7e8, fromHex('10 02 50 03'), true);
  assert.equal(unsolicited, 1, 'the expected source address is accepted');
});

/**
 * Tester plus a scripted "ECU" on the same wire. The ECU side observes the
 * tester's transmissions and injects Flow Control frames back.
 */
function createScriptedPair(options: { wftMax?: number; nBsMs?: number } = {}) {
  const wire = createWire();
  const testerBus = new VirtualBus(wire);
  const ecuBus = new VirtualBus(wire);
  const tester = new IsoTpConnection(testerBus, {
    txId: 0x7e0,
    rxId: 0x7e8,
    sleep: async () => undefined,
    timing: { nBsMs: options.nBsMs ?? 200, wftMax: options.wftMax ?? 8 },
  });
  tester.open();
  const sendToTester = (payload: Uint8Array): void => testerBus.inject(0x7e8, payload);
  const seen: CanFrame[] = [];
  ecuBus.subscribe((frame) => {
    seen.push(frame);
  });
  return { wire, tester, testerBus, ecuBus, seen, sendToTester };
}

test('Flow Control "Wait" frames are tolerated up to WFTmax', async () => {
  const pair = createScriptedPair({ wftMax: 2 });
  pair.ecuBus.subscribe((frame) => {
    if (((frame.payload[0] ?? 0) & 0xf0) !== 0x10) return;
    // Two Wait frames, then Continue-To-Send (BS = 0 → send all).
    pair.sendToTester(fromHex('31 00 00'));
    pair.sendToTester(fromHex('31 00 00'));
    pair.sendToTester(fromHex('30 00 00'));
  });
  await pair.tester.sendOnly(new Uint8Array(30).fill(0x22));
  const cfFrames = pair.wire.frames.filter((f) => f.id === 0x7e0 && ((f.payload[0] ?? 0) & 0xf0) === 0x20);
  assert.equal(cfFrames.length, 4, '30 bytes - 6 byte FF chunk = 24 bytes over 4 Consecutive Frames');
  assert.equal(pair.tester.stats.rxFlowControlFrames, 3);
});

test('WFTmax exceeding aborts the transmission', async () => {
  const pair = createScriptedPair({ wftMax: 1 });
  pair.ecuBus.subscribe((frame) => {
    if (((frame.payload[0] ?? 0) & 0xf0) !== 0x10) return;
    pair.sendToTester(fromHex('31 00 00'));
    pair.sendToTester(fromHex('31 00 00'));
  });
  await assert.rejects(pair.tester.sendOnly(new Uint8Array(30).fill(0x22)), /WFTmax/);
});

test('block size from Flow Control paces consecutive frames', async () => {
  const pair = createScriptedPair();
  let cfCount = 0;
  pair.ecuBus.subscribe((frame) => {
    const pci = frame.payload[0] ?? 0;
    if ((pci & 0xf0) === 0x10) {
      pair.sendToTester(fromHex('30 02 00'));
      return;
    }
    if ((pci & 0xf0) === 0x20) {
      cfCount++;
      if (cfCount % 2 === 0) pair.sendToTester(fromHex('30 02 00'));
    }
  });
  await pair.tester.sendOnly(new Uint8Array(30).fill(0x33));
  assert.equal(cfCount, 4);
  assert.ok(pair.tester.stats.rxFlowControlFrames >= 2, 'additional Flow Control required after each block');
});

test('CAN-FD single frame escape carries payloads longer than 7 bytes', async () => {
  const wire = createWire();
  const bus = new VirtualBus(wire);
  bus.capabilities = { can: true, canFd: true, doip: false, isoTpOffload: false, channels: 1 };
  const conn = new IsoTpConnection(bus, { txId: 0x7e0, rxId: 0x7e8, fd: true, sleep: async () => undefined });
  conn.open();
  await conn.sendOnly(new Uint8Array(10).fill(0x77));
  const frame = wire.frames[0];
  assert.ok(frame);
  assert.equal(frame.payload[0], 0x00, 'escape PCI');
  assert.equal(frame.payload[1], 10, 'explicit length byte');
  assert.equal(frame.fd, true);
});

test('CAN-FD escape is rejected when the payload exceeds the MTU', async () => {
  const wire = createWire();
  const bus = new VirtualBus(wire);
  bus.capabilities = { can: true, canFd: true, doip: false, isoTpOffload: false, channels: 1 };
  const conn = new IsoTpConnection(bus, { txId: 0x7e0, rxId: 0x7e8, fd: true, sleep: async () => undefined });
  conn.open();
  await assert.rejects(conn.sendOnly(new Uint8Array(63).fill(0x77)), /does not fit a Single Frame/);
});

test('receive() delivers messages that arrive without a pending request', async () => {
  const wire = createWire();
  const bus = new VirtualBus(wire);
  const conn = new IsoTpConnection(bus, { txId: 0x7e0, rxId: 0x7e8, sleep: async () => undefined });
  conn.open();
  const promise = conn.receive(100);
  bus.inject(0x7e8, fromHex('02 7E 00'));
  const message = await promise;
  assert.ok(message);
  assert.equal(toHex(message), '7E 00');
});

test('receive() returns null on timeout', async () => {
  const wire = createWire();
  const bus = new VirtualBus(wire);
  const conn = new IsoTpConnection(bus, { txId: 0x7e0, rxId: 0x7e8, sleep: async () => undefined });
  conn.open();
  assert.equal(await conn.receive(15), null);
});

test('requests are serialised per connection (AGENTS 15)', async () => {
  const pair = createPair();
  pair.respond(fromHex('7E 00'));
  const results = await Promise.all([pair.tester.request(fromHex('3E 00')), pair.tester.request(fromHex('3E 00')), pair.tester.request(fromHex('3E 00'))]);
  assert.equal(results.length, 3);
  assert.equal(pair.requests.length, 3);
  const txFrames = pair.wire.frames.filter((f) => f.id === 0x7e0);
  assert.equal(txFrames.length, 3);
});
