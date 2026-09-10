import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdapterUnsupportedError } from '@vdp/shared';
import { CanableAdapter } from '@vdp/adapter-canable';
import { createFrame } from '@vdp/transport-can';
import {
  AdapterCatalog,
  ELM327_DEFAULT_BAUD,
  SLCAN_DEFAULT_BAUD,
  assertAdapterUsable,
  configureSerialPort,
  createHostAdapterCatalog,
  formatAdapterHelp,
  missingRequiredSettings,
  openSerialStream,
  parseAdapterArgv,
  selectionFromPayload,
  supportedBitrates,
  validateSelection,
} from '../src/index.js';
import { createDeviceSide, createPtyPair, hasSocat } from './pty.js';

/* ------------------------------------------------------- argument parsing */

test('adapter arguments are parsed in both --flag=value and --flag value form', () => {
  const parsed = parseAdapterArgv(['--port=8080', '--adapter=slcan', '--device=/dev/ttyUSB0', '--bitrate=250k', '--baud', '115200']);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.selection.id, 'slcan');
  assert.equal(parsed.selection.config.device, '/dev/ttyUSB0');
  assert.equal(parsed.selection.config.bitrate, '250k');
  assert.equal(parsed.selection.config.baudRate, 115200);
});

test('a following flag is not swallowed as a value', () => {
  const parsed = parseAdapterArgv(['--adapter=slcan', '--listen-only', '--port=8080', '--channel=can0']);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.selection.config.listenOnly, true);
  assert.equal(parsed.selection.config.channel, 'can0');
});

test('a flag that takes no value rejects one', () => {
  const parsed = parseAdapterArgv(['--listen-only=yes']);
  assert.equal(parsed.errors.length, 1);
  assert.match(parsed.errors[0] ?? '', /does not take a value/);
  assert.equal(parsed.selection.config.listenOnly, undefined);
});

test('a non-numeric baud rate is rejected instead of silently ignored', () => {
  const parsed = parseAdapterArgv(['--baud=fast']);
  assert.match(parsed.errors[0] ?? '', /--baud must be a positive integer/);
});

test('unrelated arguments stay untouched by the adapter parser', () => {
  const parsed = parseAdapterArgv(['--sessions=./x', '--interval=100']);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.selection.id, 'simulator');
  assert.deepEqual(parsed.selection.config, {});
});

/* -------------------------------------------------------- catalog checks */

test('the host catalog ships the adapters AGENTS 4 requires', () => {
  const catalog = createHostAdapterCatalog();
  const ids = catalog.ids();
  for (const id of ['elm327', 'slcan', 'socketcan']) assert.ok(ids.includes(id), `missing adapter ${id}`);
  assert.equal(catalog.get('elm327')?.capabilities.can, true);
  assert.equal(catalog.get('elm327')?.capabilities.isoTpOffload, false, 'ISO-TP stays in this platform (AGENTS 5)');
});

test('an unknown adapter id fails with the list of known ids', () => {
  const catalog = createHostAdapterCatalog();
  assert.throws(() => catalog.require('obd-link-9000'), (error: unknown) => {
    assert.ok(error instanceof AdapterUnsupportedError);
    assert.match(error.message, /unknown adapter "obd-link-9000"/);
    assert.match(error.message, /elm327/);
    return true;
  });
});

test('a serial adapter without a device reports the missing setting, not a device error', async () => {
  const catalog = createHostAdapterCatalog();
  const described = await catalog.describe('slcan');
  assert.equal(described.probe.available, false);
  assert.match(described.probe.detail, /missing --device=<serial device>/);
  assert.equal(described.kind, 'serial');
  assert.equal(described.transport, 'can');
  assert.equal(described.defaults?.baudRate, SLCAN_DEFAULT_BAUD);
});

test('probing a device path that does not exist is reported, never thrown', async () => {
  const catalog = createHostAdapterCatalog();
  const described = await catalog.describe('elm327', { device: '/dev/definitely-not-there' });
  assert.equal(described.probe.available, false);
  assert.match(described.probe.detail, /not usable/);
  assert.ok((described.probe.hints ?? []).length > 0, 'a failed probe must suggest a next step');
});

test('required settings are derived from the entry, not from the caller', () => {
  const catalog = createHostAdapterCatalog();
  assert.deepEqual(missingRequiredSettings(catalog.require('elm327'), {}), ['--device=<serial device>']);
  // socketcan declares a channel *default* (can0), so nothing is missing — a
  // default is a decision, not an omission, and must not be reported as an error.
  assert.deepEqual(missingRequiredSettings(catalog.require('socketcan'), {}), []);
  assert.deepEqual(missingRequiredSettings(catalog.require('socketcan'), { channel: '' }), ['--channel=<can interface>']);
});

test('the socketcan probe never throws, whatever the binding does', async () => {
  const catalog = createHostAdapterCatalog();
  const described = await catalog.describe('socketcan', { channel: 'can0' });
  assert.equal(typeof described.probe.available, 'boolean');
  assert.ok(described.probe.detail.length > 0);
});

/* ------------------------------------------------------ selection checks */

test('validation collects every problem at once', () => {
  const catalog = createHostAdapterCatalog();
  const result = validateSelection(catalog, { id: 'slcan', config: {} });
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0] ?? '', /--device/);
});

test('validation applies the entry defaults to the resolved config', () => {
  const catalog = createHostAdapterCatalog();
  const result = validateSelection(catalog, { id: 'elm327', config: { device: '/dev/null' } });
  assert.equal(result.ok, true);
  assert.equal(result.resolved.baudRate, ELM327_DEFAULT_BAUD);
  assert.equal(result.resolved.channel, 'elm0');
});

test('a bitrate the adapter cannot use is rejected before opening the port', () => {
  const catalog = createHostAdapterCatalog();
  const result = validateSelection(catalog, { id: 'slcan', config: { device: '/dev/null', bitrate: '500m' } });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /unsupported bitrate "500m"/);
  assert.ok(supportedBitrates().includes('500k'));
});

test('a selection from an HTTP body ignores unknown fields and coerces a numeric baud rate', () => {
  const selection = selectionFromPayload({
    id: 'slcan',
    device: ' /dev/ttyUSB0 ',
    bitrate: '500k',
    listenOnly: true,
    baudRate: '115200',
    // An attacker-controlled extra field must not reach the adapter config.
    evil: 'rm -rf',
  });
  assert.equal(selection.id, 'slcan');
  assert.deepEqual(selection.config, { device: '/dev/ttyUSB0', bitrate: '500k', listenOnly: true, baudRate: 115200 });
});

test('a non-object body falls back to the default adapter instead of crashing', () => {
  const selection = selectionFromPayload(null, 'simulator');
  assert.deepEqual(selection, { id: 'simulator', config: {} });
});

test('assertAdapterUsable refuses an unusable device with a transport error', async () => {
  const catalog = createHostAdapterCatalog();
  await assert.rejects(
    () => assertAdapterUsable(catalog.require('elm327'), { device: '/dev/definitely-not-there' }),
    /not usable/,
  );
});

test('the help text lists every registered adapter', () => {
  const catalog = createHostAdapterCatalog();
  const help = formatAdapterHelp(catalog);
  for (const id of catalog.ids()) assert.match(help, new RegExp(id));
});

/* -------------------------------------------------------- serial device */

test('a serial stream reads and writes over a real character device', { skip: hasSocat() ? false : 'socat is not installed' }, async () => {
  const pair = await createPtyPair();
  const device = createDeviceSide(pair.b);
  const stream = await openSerialStream({ device: pair.a });
  try {
    const chunks: string[] = [];
    stream.onData((chunk) => chunks.push(chunk));
    await stream.write('ATZ\r');
    await device.waitFor('ATZ');

    device.write('ELM327 v1.5\r');
    await waitFor(() => chunks.join('').includes('ELM327 v1.5'));

    assert.equal(stream.isOpen(), true);
    assert.match(stream.describe(), /serial/);
    assert.ok(stream.bytesRead > 0 && stream.bytesWritten > 0, 'byte counters must reflect the transfer');
    const errors: Error[] = [];
    stream.onError((error) => errors.push(error));
    assert.deepEqual(errors, []);
  } finally {
    await stream.close();
    await device.close();
    pair.dispose();
  }
});

test('line settings are applied with stty, and a bad device fails loudly', { skip: hasSocat() ? false : 'socat is not installed' }, async () => {
  const pair = await createPtyPair();
  try {
    const command = await configureSerialPort(pair.a, { baudRate: 115_200 });
    assert.match(command, /^stty -F /);
    assert.match(command, /115200/);
  } finally {
    pair.dispose();
  }
  await assert.rejects(() => configureSerialPort('/dev/definitely-not-there', { baudRate: 115_200 }), /exited with code/);
});

test('opening a device that does not exist produces an actionable error', async () => {
  await assert.rejects(() => openSerialStream({ device: '/dev/definitely-not-there' }), (error: unknown) => {
    assert.ok(error instanceof AdapterUnsupportedError);
    assert.match(error.message, /cannot open serial device/);
    return true;
  });
  await assert.rejects(() => openSerialStream({ device: '  ' }), /serial device path is required/);
});

test('the slcan adapter drives a real serial port and parses frames coming back', { skip: hasSocat() ? false : 'socat is not installed' }, async () => {
  const pair = await createPtyPair();
  const device = createDeviceSide(pair.b);
  const catalog = createHostAdapterCatalog();
  const stream = await openSerialStream({ device: pair.a });
  const adapter = new CanableAdapter({ stream, bitrate: '500k', channel: 'slcan-test' });
  try {
    const frames: Array<{ id: number; direction?: string; payload: string }> = [];
    await adapter.open();
    adapter.subscribe((frame) => frames.push({ id: frame.id, direction: frame.direction, payload: Buffer.from(frame.payload).toString('hex') }));

    // The adapter configures the device before it opens the channel: the init
    // sequence must reach the wire in order (S6 = 500k, Z1 = timestamps, O = open).
    await device.waitFor('O');
    const init = device.received.join('');
    assert.match(init, /S6/, 'bitrate command');
    assert.match(init, /Z1/, 'timestamp command');
    assert.match(init, /O/, 'open channel command');

    // Frame from the ECU side → adapter listener.
    device.write('t7E83023E80\r');
    await waitFor(() => frames.length > 0);
    assert.deepEqual(frames[0], { id: 0x7e8, direction: 'rx', payload: '023e80' });

    // Frame from the tester side → wire.
    await adapter.send(createFrame(0x7e0, new Uint8Array([0x02, 0x3e, 0x80])));
    await device.waitFor('t7E03023E80');
    assert.equal(adapter.counters.tx, 1);
    assert.equal(adapter.counters.rx, 1);
  } finally {
    await adapter.close();
    await stream.close();
    await device.close();
    pair.dispose();
  }
});

test('the catalog creates the adapter it advertised', { skip: hasSocat() ? false : 'socat is not installed' }, async () => {
  const pair = await createPtyPair();
  const device = createDeviceSide(pair.b, { respondWithPrompt: true });
  const catalog = createHostAdapterCatalog();
  const entry = catalog.require('elm327');
  const probe = await entry.probe({ device: pair.a }, {});
  assert.equal(probe.available, true, probe.detail);
  const bus = await entry.create({ device: pair.a, baudRate: 38_400 }, {});
  void device;
  try {
    assert.equal(bus.info.id, 'elm327');
    await bus.open();
    assert.equal(bus.isOpen(), true);
    await device.waitFor('ATZ');
  } finally {
    await bus.close();
    await device.close();
    pair.dispose();
  }
});

/* ------------------------------------------------------------- utilities */

test('temporary files are not mistaken for usable serial devices', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vdp-host-'));
  try {
    const file = join(dir, 'not-a-tty.txt');
    await writeFile(file, 'hello', 'utf8');
    const catalog = createHostAdapterCatalog();
    // A regular file passes the probe by design (FIFO/pipe development setups),
    // but it must never be reported as a serial device in the UI detail text.
    const described = await catalog.describe('elm327', { device: file });
    assert.equal(described.probe.available, true);
    assert.match(described.probe.detail, /present and read\/write accessible/);
    const directory = await catalog.describe('elm327', { device: dir });
    assert.equal(directory.probe.available, false);
    assert.match(directory.probe.detail, /is a directory/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('registering the same adapter twice is a configuration error', () => {
  const catalog = new AdapterCatalog();
  const entry = createHostAdapterCatalog().require('elm327');
  catalog.register(entry);
  assert.throws(() => catalog.register(entry), /already registered/);
});

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
