import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StorageError, createLogger } from '@vdp/shared';
import { SESSION_SCHEMA_VERSION, createSession, type VehicleSessionData } from '@vdp/core';
import type { AdapterInfo, TransportInfo } from '@vdp/transport-can';
import { FileSystemSessionRepository, MemorySessionRepository, MigrationRegistry, assertSafeId, crc32, createZip, listZipEntries } from '../src/index.js';

const ADAPTER: AdapterInfo = { id: 'virtual', kind: 'virtual', name: 'Virtual CAN', channels: ['vcan0'] };
const TRANSPORT: TransportInfo = { kind: 'can', channel: 'vcan0', mtu: 8 };
const logger = createLogger('storage', { level: 'ERROR' });

function sampleSession(id = 'session_test'): VehicleSessionData {
  const data = createSession({ adapter: ADAPTER, transport: TRANSPORT, id, title: 'Test session' });
  data.vehicle = { vin: '1HGCM82633A004352' };
  data.ecus.push({
    id: 'ecu_1',
    name: 'Engine',
    protocol: 'uds',
    txId: 0x7e0,
    rxId: 0x7e8,
    extended: false,
    identification: [{ label: 'VIN', value: '1HGCM82633A004352' }],
    supportedServices: [0x10, 0x22, 0x19],
    sessionType: 1,
    timing: { p2Ms: 50, p2StarMs: 5000 },
    reachable: true,
  });
  return data;
}

test('crc32 matches the well known check value', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('zip archives list their entries back in order', () => {
  const archive = createZip([
    { name: 'session.json', data: new TextEncoder().encode('{"a":1}') },
    { name: 'measurements.ndjson', data: new TextEncoder().encode('line\n') },
  ]);
  assert.deepEqual(listZipEntries(archive), ['session.json', 'measurements.ndjson']);
  assert.equal(archive[0], 0x50, 'local file header signature starts with PK');
  assert.equal(archive[1], 0x4b);
});

test('unsafe session ids are rejected before touching the filesystem', () => {
  assert.throws(() => assertSafeId('../etc/passwd'), StorageError);
  assert.throws(() => assertSafeId('a/b'), StorageError);
  assert.doesNotThrow(() => assertSafeId('session_2026-09-10.ok'));
});

test('memory repository round trips a session and its streams', async () => {
  const repo = new MemorySessionRepository();
  const data = sampleSession();
  await repo.save(data);
  assert.equal(await repo.exists(data.id), true);
  const loaded = await repo.load(data.id);
  assert.equal(loaded.data.vehicle?.vin, '1HGCM82633A004352');
  assert.equal(loaded.appliedMigrations.length, 0);

  await repo.appendSamples(data.id, [
    { timestamp: '2026-09-10T12:00:00.000Z', t: 0, signal: 'engine.rpm', value: 850, rawValue: 3400, rawHex: '0D 48', unit: 'rpm', outOfRange: false },
  ]);
  await repo.appendLines(data.id, 'trace', ['{"canId":2016}']);
  assert.equal(repo.streamOf(data.id, 'measurements').length, 1);
  assert.equal(repo.streamOf(data.id, 'trace').length, 1);

  const list = await repo.list();
  assert.equal(list.length, 1);
  assert.equal(list[0]?.vin, '1HGCM82633A004352');

  await repo.delete(data.id);
  assert.equal(await repo.exists(data.id), false);
  await assert.rejects(repo.load(data.id), StorageError);
});

test('session packages contain metadata and every stream', async () => {
  const repo = new MemorySessionRepository();
  const data = sampleSession('session_pkg');
  await repo.save(data);
  await repo.appendLines(data.id, 'log', ['{"scope":"uds"}']);
  const archive = await repo.exportPackage(data.id);
  const names = listZipEntries(archive);
  assert.ok(names.includes('session.json'));
  assert.ok(names.includes('measurements.ndjson'));
  assert.ok(names.includes('trace.ndjson'));
  assert.ok(names.includes('log.ndjson'));
});

test('filesystem repository persists sessions and appends NDJSON streams', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vdp-storage-'));
  try {
    const repo = new FileSystemSessionRepository({ rootDir: root, logger });
    const data = sampleSession('session_fs');
    await repo.save(data);
    assert.equal(await repo.exists(data.id), true);

    await repo.appendSamples(data.id, [
      { timestamp: '2026-09-10T12:00:00.000Z', t: 0, signal: 'engine.rpm', value: 850, rawValue: 3400, rawHex: '0D 48', unit: 'rpm', outOfRange: false },
      { timestamp: '2026-09-10T12:00:00.100Z', t: 100, signal: 'engine.rpm', value: 860, rawValue: 3440, rawHex: '0D 70', unit: 'rpm', outOfRange: false },
    ]);
    await repo.appendLines(data.id, 'trace', ['{"canId":2016}']);

    const loaded = await repo.load(data.id);
    assert.equal(loaded.data.id, 'session_fs');
    const list = await repo.list();
    assert.equal(list.length, 1);
    assert.ok((list[0]?.sizeBytes ?? 0) > 0);

    const archive = await repo.exportPackage(data.id);
    assert.ok(archive.length > 100);
    assert.ok(listZipEntries(archive).includes('measurements.ndjson'));

    await repo.delete(data.id);
    assert.equal(await repo.exists(data.id), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('listing an empty or missing directory yields no sessions', async () => {
  const repo = new FileSystemSessionRepository({ rootDir: '/tmp/definitely-missing-vdp-dir', logger });
  assert.deepEqual(await repo.list(), []);
});

test('migration registry applies migrations in order and records them', () => {
  const registry = new MigrationRegistry([
    {
      fromVersion: 0,
      toVersion: 1,
      description: 'initial shape',
      up: (data) => ({ ...data, ecus: data['ecus'] ?? [] }),
    },
  ]);
  const { data, applied } = registry.migrate({ id: 'old', schemaVersion: 0, startedAt: 'x' });
  assert.equal(data.schemaVersion, 1);
  assert.equal(applied.length, 1);
  assert.match(applied[0] ?? '', /initial shape/);
});

test('a missing migration step is reported instead of silently skipped', () => {
  const registry = new MigrationRegistry([]);
  assert.throws(() => registry.migrate({ id: 'x', schemaVersion: 0 }), /no migration registered from schema version 0/);
});

test('sessions written by a newer build are rejected', () => {
  const registry = new MigrationRegistry([]);
  assert.throws(() => registry.migrate({ id: 'x', schemaVersion: SESSION_SCHEMA_VERSION + 1 }), /newer version/);
});

test('a migration that skips a version is rejected at registration', () => {
  assert.throws(
    () => new MigrationRegistry([{ fromVersion: 0, toVersion: 2, description: 'skips one', up: (data) => data }]),
    /must advance exactly one version/,
  );
});

test('a stored session from an older schema version is upgraded on load', async () => {
  const registry = new MigrationRegistry([
    {
      fromVersion: 0,
      toVersion: 1,
      description: 'add tags array',
      up: (data) => ({ ...data, tags: data['tags'] ?? [] }),
    },
  ]);
  const repo = new MemorySessionRepository(registry);
  // Store a legacy-shaped session directly (schemaVersion 0).
  const legacy = { ...sampleSession('legacy'), schemaVersion: 0 };
  await repo.save(legacy);
  const loaded = await repo.load('legacy');
  assert.equal(loaded.data.schemaVersion, SESSION_SCHEMA_VERSION);
  assert.deepEqual(loaded.data.tags, []);
  assert.equal(loaded.appliedMigrations.length, 1);
});
