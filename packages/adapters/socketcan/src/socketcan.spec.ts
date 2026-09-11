import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AdapterUnsupportedError, fromHex, toHex } from '@vdp/shared';
import { createFrame } from '@vdp/transport-can';
import { FakeSocketCanBinding, SocketCanAdapter, tryLoadSocketCanBinding } from './index.js';

test('open() opens the interface and applies the bitrate', async () => {
  const binding = new FakeSocketCanBinding();
  const adapter = new SocketCanAdapter({ binding, iface: 'vcan0', bitrate: 500_000 });
  await adapter.open();
  assert.equal(adapter.isOpen(), true);
  assert.deepEqual(binding.opened, ['vcan0']);
  assert.equal(binding.bitrate, 500_000);
});

test('sent frames are handed to the kernel binding', async () => {
  const binding = new FakeSocketCanBinding();
  const adapter = new SocketCanAdapter({ binding, iface: 'vcan0' });
  await adapter.open();
  await adapter.send(createFrame(0x7e0, fromHex('02 3E 80')));
  assert.equal(binding.sent.length, 1);
  assert.equal(binding.sent[0]?.id, 0x7e0);
  assert.equal(toHex(binding.sent[0]?.data ?? new Uint8Array()), '02 3E 80');
  assert.equal(adapter.counters.tx, 1);
});

test('received frames reach subscribers and honour filters', async () => {
  const binding = new FakeSocketCanBinding();
  const adapter = new SocketCanAdapter({ binding, iface: 'vcan0' });
  await adapter.open();
  const received: number[] = [];
  adapter.subscribe((frame) => received.push(frame.id), [{ id: 0x7e8, mask: 0x7ff }]);
  binding.emit({ id: 0x7e8, extended: false, data: fromHex('02 50 03') });
  binding.emit({ id: 0x7e9, extended: false, data: fromHex('02 50 03') });
  assert.deepEqual(received, [0x7e8]);
  assert.equal(adapter.counters.rx, 2);
});

test('sending before open fails with a transport error', async () => {
  const binding = new FakeSocketCanBinding();
  const adapter = new SocketCanAdapter({ binding });
  await assert.rejects(adapter.send(createFrame(0x7e0, fromHex('02 3E 80'))), /not open/);
});

test('CAN-FD frames are rejected unless the interface advertises CAN-FD', async () => {
  const binding = new FakeSocketCanBinding();
  const classic = new SocketCanAdapter({ binding });
  await classic.open();
  await assert.rejects(classic.send(createFrame(0x7e0, new Uint8Array(12).fill(1), { fd: true })), /CAN-FD/);

  const fd = new SocketCanAdapter({ binding, iface: 'can1', canFd: true });
  await fd.open();
  await fd.send(createFrame(0x7e0, new Uint8Array(12).fill(1), { fd: true }));
  assert.equal(binding.sent.length, 1);
});

test('close() releases the channel', async () => {
  const binding = new FakeSocketCanBinding();
  const adapter = new SocketCanAdapter({ binding });
  await adapter.open();
  await adapter.close();
  assert.equal(adapter.isOpen(), false);
  assert.equal(binding.closed, true);
});

test('a missing native binding becomes a typed, actionable error', async () => {
  await assert.rejects(tryLoadSocketCanBinding('definitely-not-installed'), (error: unknown) => {
    assert.ok(error instanceof AdapterUnsupportedError);
    assert.match(error.message, /SocketCAN adapter unavailable/);
    return true;
  });
});

test('interface listing is delegated to the binding', async () => {
  const binding = new FakeSocketCanBinding();
  assert.deepEqual(await binding.listInterfaces?.(), ['can0', 'vcan0']);
});
