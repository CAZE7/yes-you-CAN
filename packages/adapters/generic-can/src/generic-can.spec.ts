import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AdapterUnsupportedError, fromHex, toHex } from '@vdp/shared';
import { createFrame, type AdapterCapabilities, type AdapterInfo, type CanBus, type CanFilter, type CanFrame, type FrameListener } from '@vdp/transport-can';
import { GenericCanAdapter, createAdapterRegistry, createGenericCanFactory } from './index.js';

class RecordingBus implements CanBus {
  readonly info: AdapterInfo = { id: 'inner', kind: 'test', name: 'Inner bus', channels: ['can9'] };
  capabilities: AdapterCapabilities = { can: true, canFd: true, doip: false, isoTpOffload: false, channels: 1 };
  sent: CanFrame[] = [];
  listeners: Array<{ listener: FrameListener; filters?: readonly CanFilter[] }> = [];
  opened = false;

  async open(): Promise<void> { this.opened = true; }
  async close(): Promise<void> { this.opened = false; }
  isOpen(): boolean { return this.opened; }
  async send(frame: CanFrame): Promise<void> { this.sent.push(frame); }
  subscribe(listener: FrameListener, filters?: readonly CanFilter[]): () => void {
    const entry = { listener, ...(filters ? { filters } : {}) };
    this.listeners.push(entry);
    return () => { this.listeners = this.listeners.filter((l) => l !== entry); };
  }
  emit(frame: CanFrame): void {
    for (const entry of this.listeners) entry.listener(frame);
  }
}

test('metadata of the wrapped bus is preserved but re-identified', async () => {
  const inner = new RecordingBus();
  const adapter = new GenericCanAdapter({ id: 'virtual', displayName: 'Virtual CAN', bus: inner });
  await adapter.open();
  assert.equal(adapter.info.id, 'virtual');
  assert.equal(adapter.info.name, 'Virtual CAN');
  assert.deepEqual(adapter.info.channels, ['can9']);
  assert.equal(adapter.isOpen(), true);
});

test('capability overrides are applied', () => {
  const inner = new RecordingBus();
  const adapter = new GenericCanAdapter({ id: 'x', displayName: 'X', bus: inner, capabilities: { canFd: false, channels: 2 } });
  assert.equal(adapter.capabilities.canFd, false);
  assert.equal(adapter.capabilities.channels, 2);
});

test('CAN-FD frames are rejected when capabilities say so', async () => {
  const inner = new RecordingBus();
  const adapter = new GenericCanAdapter({ id: 'x', displayName: 'X', bus: inner, capabilities: { canFd: false } });
  await adapter.open();
  await assert.rejects(adapter.send(createFrame(0x7e0, new Uint8Array(12).fill(1), { fd: true })), AdapterUnsupportedError);
});

test('frames pass through in both directions with counters', async () => {
  const inner = new RecordingBus();
  const adapter = new GenericCanAdapter({ id: 'x', displayName: 'X', bus: inner });
  await adapter.open();
  const received: string[] = [];
  adapter.subscribe((frame) => received.push(toHex(frame.payload)));
  await adapter.send(createFrame(0x7e0, fromHex('02 3E 80')));
  inner.emit(createFrame(0x7e8, fromHex('02 7E 00')));
  assert.equal(inner.sent.length, 1);
  assert.deepEqual(received, ['02 7E 00']);
  assert.deepEqual(adapter.counters, { tx: 1, rx: 1 });
});

test('unsubscribe stops delivery', async () => {
  const inner = new RecordingBus();
  const adapter = new GenericCanAdapter({ id: 'x', displayName: 'X', bus: inner });
  await adapter.open();
  let count = 0;
  const unsubscribe = adapter.subscribe(() => { count++; });
  inner.emit(createFrame(0x7e8, fromHex('02 7E 00')));
  unsubscribe();
  inner.emit(createFrame(0x7e8, fromHex('02 7E 00')));
  assert.equal(count, 1);
});

test('registry creates adapters by id and lists them', () => {
  const factory = createGenericCanFactory({ id: 'virtual', displayName: 'Virtual CAN', create: () => new RecordingBus() });
  const registry = createAdapterRegistry([factory]);
  assert.deepEqual(registry.list(), [{ id: 'virtual', displayName: 'Virtual CAN' }]);
  const bus = registry.create('virtual');
  assert.ok(bus instanceof GenericCanAdapter);
  assert.throws(() => registry.create('missing'), /Unknown CAN adapter/);
});
