import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SESSION_SCHEMA_VERSION, type VehicleSessionData, createSession } from "@vdp/core";
import { StorageError, createLogger } from "@vdp/shared";
import type { AdapterInfo, TransportInfo } from "@vdp/transport-can";
import { test } from "vitest";
import {
  FileSystemSessionRepository,
  MemorySessionRepository,
  MigrationRegistry,
  assertSafeId,
  crc32,
  createZip,
  listZipEntries,
} from "./index.js";

const ADAPTER: AdapterInfo = {
  id: "virtual",
  kind: "virtual",
  name: "Virtual CAN",
  channels: ["vcan0"],
};
const TRANSPORT: TransportInfo = { kind: "can", channel: "vcan0", mtu: 8 };
const logger = createLogger("storage", { level: "ERROR" });

function sampleSession(id = "session_test"): VehicleSessionData {
  const data = createSession({ adapter: ADAPTER, transport: TRANSPORT, id, title: "Test session" });
  data.vehicle = { vin: "1HGCM82633A004352" };
  data.ecus.push({
    id: "ecu_1",
    name: "Engine",
    protocol: "uds",
    txId: 0x7e0,
    rxId: 0x7e8,
    extended: false,
    identification: [{ label: "VIN", value: "1HGCM82633A004352" }],
    supportedServices: [0x10, 0x22, 0x19],
    sessionType: 1,
    timing: { p2Ms: 50, p2StarMs: 5000 },
    reachable: true,
  });
  return data;
}

test("crc32 matches the well known check value", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
});

test("zip archives list their entries back in order", () => {
  const archive = createZip([
    { name: "session.json", data: new TextEncoder().encode('{"a":1}') },
    { name: "measurements.ndjson", data: new TextEncoder().encode("line\n") },
  ]);
  assert.deepEqual(listZipEntries(archive), ["session.json", "measurements.ndjson"]);
  assert.equal(archive[0], 0x50, "local file header signature starts with PK");
  assert.equal(archive[1], 0x4b);
});

test("unsafe session ids are rejected before touching the filesystem", () => {
  assert.throws(() => assertSafeId("../etc/passwd"), StorageError);
  assert.throws(() => assertSafeId("a/b"), StorageError);
  assert.doesNotThrow(() => assertSafeId("session_2026-09-10.ok"));
});

test("memory repository round trips a session and its streams", async () => {
  const repo = new MemorySessionRepository();
  const data = sampleSession();
  await repo.save(data);
  assert.equal(await repo.exists(data.id), true);
  const loaded = await repo.load(data.id);
  assert.equal(loaded.data.vehicle?.vin, "1HGCM82633A004352");
  assert.equal(loaded.appliedMigrations.length, 0);

  await repo.appendSamples(data.id, [
    {
      timestamp: "2026-09-10T12:00:00.000Z",
      t: 0,
      signal: "engine.rpm",
      value: 850,
      rawValue: 3400,
      rawHex: "0D 48",
      unit: "rpm",
      outOfRange: false,
    },
  ]);
  await repo.appendLines(data.id, "trace", ['{"canId":2016}']);
  assert.equal(repo.streamOf(data.id, "measurements").length, 1);
  assert.equal(repo.streamOf(data.id, "trace").length, 1);

  const list = await repo.list();
  assert.equal(list.length, 1);
  assert.equal(list[0]?.vin, "1HGCM82633A004352");

  await repo.delete(data.id);
  assert.equal(await repo.exists(data.id), false);
  await assert.rejects(repo.load(data.id), StorageError);
});

test("session packages contain metadata and every stream", async () => {
  const repo = new MemorySessionRepository();
  const data = sampleSession("session_pkg");
  await repo.save(data);
  await repo.appendLines(data.id, "log", ['{"scope":"uds"}']);
  const archive = await repo.exportPackage(data.id);
  const names = listZipEntries(archive);
  assert.ok(names.includes("session.json"));
  assert.ok(names.includes("measurements.ndjson"));
  assert.ok(names.includes("trace.ndjson"));
  assert.ok(names.includes("log.ndjson"));
});

test("filesystem repository persists sessions and appends NDJSON streams", async () => {
  const root = await mkdtemp(join(tmpdir(), "vdp-storage-"));
  try {
    const repo = new FileSystemSessionRepository({ rootDir: root, logger });
    const data = sampleSession("session_fs");
    await repo.save(data);
    assert.equal(await repo.exists(data.id), true);

    await repo.appendSamples(data.id, [
      {
        timestamp: "2026-09-10T12:00:00.000Z",
        t: 0,
        signal: "engine.rpm",
        value: 850,
        rawValue: 3400,
        rawHex: "0D 48",
        unit: "rpm",
        outOfRange: false,
      },
      {
        timestamp: "2026-09-10T12:00:00.100Z",
        t: 100,
        signal: "engine.rpm",
        value: 860,
        rawValue: 3440,
        rawHex: "0D 70",
        unit: "rpm",
        outOfRange: false,
      },
    ]);
    await repo.appendLines(data.id, "trace", ['{"canId":2016}']);

    const loaded = await repo.load(data.id);
    assert.equal(loaded.data.id, "session_fs");
    const list = await repo.list();
    assert.equal(list.length, 1);
    assert.ok((list[0]?.sizeBytes ?? 0) > 0);

    const archive = await repo.exportPackage(data.id);
    assert.ok(archive.length > 100);
    assert.ok(listZipEntries(archive).includes("measurements.ndjson"));

    await repo.delete(data.id);
    assert.equal(await repo.exists(data.id), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("listing an empty or missing directory yields no sessions", async () => {
  const repo = new FileSystemSessionRepository({
    rootDir: "/tmp/definitely-missing-vdp-dir",
    logger,
  });
  assert.deepEqual(await repo.list(), []);
});

test("migration registry applies migrations in order and records them", () => {
  const registry = new MigrationRegistry([
    {
      fromVersion: 0,
      toVersion: 1,
      description: "initial shape",
      up: (data) => ({ ...data, ecus: data["ecus"] ?? [] }),
    },
  ]);
  const { data, applied } = registry.migrate({ id: "old", schemaVersion: 0, startedAt: "x" });
  assert.equal(data.schemaVersion, 1);
  assert.equal(applied.length, 1);
  assert.match(applied[0] ?? "", /initial shape/);
});

test("a missing migration step is reported instead of silently skipped", () => {
  const registry = new MigrationRegistry([]);
  assert.throws(
    () => registry.migrate({ id: "x", schemaVersion: 0 }),
    /no migration registered from schema version 0/,
  );
});

test("sessions written by a newer build are rejected", () => {
  const registry = new MigrationRegistry([]);
  assert.throws(
    () => registry.migrate({ id: "x", schemaVersion: SESSION_SCHEMA_VERSION + 1 }),
    /newer version/,
  );
});

test("a migration that skips a version is rejected at registration", () => {
  assert.throws(
    () =>
      new MigrationRegistry([
        { fromVersion: 0, toVersion: 2, description: "skips one", up: (data) => data },
      ]),
    /must advance exactly one version/,
  );
});

test("a stored session from an older schema version is upgraded on load", async () => {
  const registry = new MigrationRegistry([
    {
      fromVersion: 0,
      toVersion: 1,
      description: "add tags array",
      up: (data) => ({ ...data, tags: data["tags"] ?? [] }),
    },
  ]);
  const repo = new MemorySessionRepository(registry);
  // Store a legacy-shaped session directly (schemaVersion 0).
  const legacy = { ...sampleSession("legacy"), schemaVersion: 0 };
  await repo.save(legacy);
  const loaded = await repo.load("legacy");
  assert.equal(loaded.data.schemaVersion, SESSION_SCHEMA_VERSION);
  assert.deepEqual(loaded.data.tags, []);
  assert.equal(loaded.appliedMigrations.length, 1);
});

/* ---------------------------------------- repository edge cases (AGENTS 0.E E4) */

test("loading a missing or corrupted session fails with a clear StorageError", async () => {
  const root = await mkdtemp(join(tmpdir(), "vdp-storage-load-"));
  try {
    const repo = new FileSystemSessionRepository({ rootDir: root, logger });
    await assert.rejects(repo.load("does_not_exist"), /not found/);

    const { mkdir, writeFile, readFile } = await import("node:fs/promises");
    await mkdir(join(root, "broken"), { recursive: true });
    await writeFile(join(root, "broken", "session.json"), "{not json", "utf8");
    await assert.rejects(repo.load("broken"), /corrupted/);

    // A corrupted session must never destroy or rewrite unrelated data.
    assert.equal(await readFile(join(root, "broken", "session.json"), "utf8"), "{not json");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an upgraded session is persisted, so the migration runs only once", async () => {
  const root = await mkdtemp(join(tmpdir(), "vdp-storage-migrate-"));
  try {
    const registry = new MigrationRegistry([
      {
        fromVersion: 0,
        toVersion: 1,
        description: "add tags array",
        up: (data) => ({ ...data, tags: data["tags"] ?? [] }),
      },
    ]);
    const repo = new FileSystemSessionRepository({ rootDir: root, logger, migrations: registry });
    const legacy = { ...sampleSession("session_migrated"), schemaVersion: 0 };
    const { mkdir, writeFile, readFile } = await import("node:fs/promises");
    await mkdir(join(root, "session_migrated"), { recursive: true });
    await writeFile(join(root, "session_migrated", "session.json"), JSON.stringify(legacy), "utf8");

    const first = await repo.load("session_migrated");
    assert.equal(first.appliedMigrations.length, 1);
    assert.equal(first.data.schemaVersion, SESSION_SCHEMA_VERSION);

    // The upgraded shape is written back: a second load applies nothing.
    const stored = JSON.parse(
      await readFile(join(root, "session_migrated", "session.json"), "utf8"),
    );
    assert.equal(stored.schemaVersion, SESSION_SCHEMA_VERSION);
    const second = await repo.load("session_migrated");
    assert.equal(second.appliedMigrations.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("listing skips unreadable entries instead of failing the whole list", async () => {
  const root = await mkdtemp(join(tmpdir(), "vdp-storage-list-"));
  try {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const repo = new FileSystemSessionRepository({ rootDir: root, logger });
    const good = sampleSession("session_good");
    await repo.save(good);

    // A corrupted session.json must not break the listing of the rest.
    await mkdir(join(root, "session_broken"), { recursive: true });
    await writeFile(join(root, "session_broken", "session.json"), "{not json", "utf8");
    // An entry whose session.json is a directory is skipped, not crashed on.
    await mkdir(join(root, "session_odd", "session.json"), { recursive: true });

    const list = await repo.list();
    assert.deepEqual(
      list.map((entry) => entry.id),
      ["session_good"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("trace and sample streams survive a crash-truncated last line", async () => {
  const root = await mkdtemp(join(tmpdir(), "vdp-storage-crash-"));
  try {
    const { appendFile } = await import("node:fs/promises");
    const repo = new FileSystemSessionRepository({ rootDir: root, logger });
    const data = sampleSession("session_crash");
    await repo.save(data);

    // Current line, legacy field names, hex-id fallback, and junk that must be
    // skipped: payload missing, unparseable canId, and a truncated JSON tail.
    await repo.appendLines(data.id, "trace", [
      '{"t":1,"canId":2016,"direction":"tx","payload":"02 10 01","channel":"vcan0","extended":true,"fd":false}',
      '{"t":2,"canIdHex":"7E8","payloadHex":"01 02"}',
      '{"t":3,"canId":"zz","payload":"FF"}',
      '{"t":4,"canId":123}',
      '{"t":5,"canId":456,"payload":"AB"',
    ]);
    const trace = await repo.readTrace(data.id);
    assert.deepEqual(
      trace.map((line) => line.t),
      [1, 2],
      "junk lines are skipped, not fatal",
    );
    assert.equal(trace[1]?.canId, 0x7e8, "canIdHex is decoded");
    assert.equal(trace[1]?.payload, "01 02", "payloadHex is accepted");
    assert.equal(trace[0]?.direction, "tx");
    assert.equal(trace[1]?.direction, "rx", "missing direction defaults to rx");

    await repo.appendSamples(data.id, [
      {
        timestamp: "2026-09-10T12:00:00.000Z",
        t: 0,
        signal: "engine.rpm",
        value: 850,
        rawValue: 3400,
        rawHex: "0D 48",
        unit: "rpm",
        outOfRange: false,
      },
    ]);
    // Simulate appended junk after the last flush: no signal, no finite t,
    // no value, a minimal valid line, and a truncated tail.
    await appendFile(
      join(root, data.id, "measurements.ndjson"),
      '{"t":5,"value":1}\n{"signal":"a","t":"x","value":1}\n{"signal":"a","t":6}\n' +
        '{"signal":"a","t":7,"value":2}\n{"signal":"b","t":8,"value":3',
      "utf8",
    );
    const samples = await repo.readSamples(data.id);
    assert.deepEqual(
      samples.map((sample) => sample.t),
      [0, 7],
      "invalid lines are dropped",
    );
    assert.equal(samples[1]?.timestamp, new Date(0).toISOString(), "timestamp gets a default");
    assert.equal(samples[1]?.rawHex, "", "rawHex gets a default");
    assert.equal(samples[1]?.outOfRange, false);

    // No streams at all means empty results, not errors.
    await repo.save(sampleSession("session_empty"));
    assert.deepEqual(await repo.readTrace("session_empty"), []);
    assert.deepEqual(await repo.readSamples("session_empty"), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("memory repository honours the options object and reads its streams back", async () => {
  const registry = new MigrationRegistry();
  const repo = new MemorySessionRepository({ migrations: registry, logger });
  const data = sampleSession("session_mem");
  data.endedAt = "2026-09-10T13:00:00.000Z";
  await repo.save(data);
  await repo.appendLines(data.id, "trace", [
    '{"t":1,"canId":2016,"direction":"rx","payload":"AB"}',
  ]);
  await repo.appendSamples(data.id, [
    {
      timestamp: "2026-09-10T12:00:00.000Z",
      t: 0,
      signal: "engine.rpm",
      value: 850,
      rawValue: 3400,
      rawHex: "0D 48",
      unit: "rpm",
      outOfRange: false,
    },
  ]);

  assert.equal((await repo.readTrace(data.id)).length, 1);
  assert.equal((await repo.readSamples(data.id)).length, 1);

  const [summary] = await repo.list();
  assert.equal(summary?.endedAt, data.endedAt, "endedAt is part of the summary");
  assert.equal(summary?.title, "Test session");

  // A session without title/VIN omits the optional summary fields entirely.
  const bare = sampleSession("session_bare");
  bare.title = undefined;
  bare.vehicle = undefined;
  await repo.save(bare);
  const bareSummary = (await repo.list()).find((entry) => entry.id === "session_bare");
  assert.ok(bareSummary);
  assert.equal("title" in (bareSummary as object), false);
  assert.equal("vin" in (bareSummary as object), false);

  // Unknown sessions export nothing.
  await assert.rejects(repo.exportPackage("nope"), StorageError);
});

test("zip listing stops gracefully on empty or truncated archives", () => {
  assert.deepEqual(listZipEntries(new Uint8Array()), []);
  const archive = createZip([{ name: "a.txt", data: new TextEncoder().encode("x") }]);
  assert.deepEqual(listZipEntries(archive.subarray(0, 3)), [], "a truncated header is no crash");
});
