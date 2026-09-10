/**
 * Session repository (AGENTS 10, 17).
 *
 * Layout on disk — one directory per session:
 *   sessions/<id>/session.json      metadata, ECUs, DTC snapshots, actions, notes
 *   sessions/<id>/measurements.ndjson   append-only decoded samples
 *   sessions/<id>/trace.ndjson          append-only raw CAN trace
 *   sessions/<id>/log.ndjson            structured diagnostic log
 *
 * NDJSON is used for the streams so a crash cannot invalidate a whole recording
 * and so replay can read incrementally (AGENTS 19).
 */

import { mkdir, readdir, readFile, rm, stat, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { StorageError, type Logger, createLogger } from '@vdp/shared';
import type { VehicleSessionData } from '@vdp/core';
import { MigrationRegistry } from './migrations.js';
import { createZip } from './zip.js';
import type { MeasurementSample } from '@vdp/core';

export interface StoredSessionSummary {
  id: string;
  startedAt: string;
  endedAt?: string;
  title?: string;
  vin?: string;
  ecus: number;
  dtcCount: number;
  sizeBytes: number;
  schemaVersion: number;
}

export interface SessionRepository {
  save(data: VehicleSessionData): Promise<void>;
  load(id: string): Promise<{ data: VehicleSessionData; appliedMigrations: string[] }>;
  list(): Promise<StoredSessionSummary[]>;
  delete(id: string): Promise<void>;
  exists(id: string): Promise<boolean>;
  appendSamples(id: string, samples: readonly MeasurementSample[]): Promise<void>;
  appendLines(id: string, stream: 'trace' | 'log', lines: readonly string[]): Promise<void>;
  exportPackage(id: string): Promise<Uint8Array>;
}

export interface FileSystemRepositoryOptions {
  rootDir: string;
  logger?: Logger;
  migrations?: MigrationRegistry;
}

const SESSION_FILE = 'session.json';
const STREAM_FILES = { measurements: 'measurements.ndjson', trace: 'trace.ndjson', log: 'log.ndjson' } as const;

export class FileSystemSessionRepository implements SessionRepository {
  private readonly log: Logger;
  private readonly migrations: MigrationRegistry;

  constructor(private readonly options: FileSystemRepositoryOptions) {
    this.log = (options.logger ?? createLogger('storage', { level: 'INFO' })).child('storage');
    this.migrations = options.migrations ?? new MigrationRegistry();
  }

  private dir(id: string): string {
    assertSafeId(id);
    return join(this.options.rootDir, id);
  }

  async save(data: VehicleSessionData): Promise<void> {
    const dir = this.dir(data.id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, SESSION_FILE), JSON.stringify(data, null, 2), 'utf8');
    this.log.info('session saved', { id: data.id, ecus: data.ecus.length });
  }

  async load(id: string): Promise<{ data: VehicleSessionData; appliedMigrations: string[] }> {
    const path = join(this.dir(id), SESSION_FILE);
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (error) {
      throw new StorageError(`session ${id} not found: ${messageOf(error)}`, { id });
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch (error) {
      throw new StorageError(`session ${id} is corrupted: ${messageOf(error)}`, { id });
    }
    const { data, applied } = this.migrations.migrate(parsed);
    if (applied.length > 0) {
      this.log.info('session migrated', { id, applied });
      await this.save(data);
    }
    return { data, appliedMigrations: applied };
  }

  async list(): Promise<StoredSessionSummary[]> {
    let entries: string[];
    try {
      entries = await readdir(this.options.rootDir);
    } catch {
      return [];
    }
    const summaries: StoredSessionSummary[] = [];
    for (const entry of entries) {
      const path = join(this.options.rootDir, entry, SESSION_FILE);
      try {
        const info = await stat(path);
        if (!info.isFile()) continue;
        const parsed = JSON.parse(await readFile(path, 'utf8')) as VehicleSessionData;
        summaries.push(summarize(parsed, info.size));
      } catch (error) {
        this.log.warn('skipping unreadable session', { entry, error: messageOf(error) });
      }
    }
    return summaries.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  }

  async delete(id: string): Promise<void> {
    await rm(this.dir(id), { recursive: true, force: true });
    this.log.info('session deleted', { id });
  }

  async exists(id: string): Promise<boolean> {
    try {
      await stat(join(this.dir(id), SESSION_FILE));
      return true;
    } catch {
      return false;
    }
  }

  async appendSamples(id: string, samples: readonly MeasurementSample[]): Promise<void> {
    if (samples.length === 0) return;
    await this.append(id, STREAM_FILES.measurements, samples.map((sample) => JSON.stringify(sample)));
  }

  async appendLines(id: string, stream: 'trace' | 'log', lines: readonly string[]): Promise<void> {
    if (lines.length === 0) return;
    await this.append(id, STREAM_FILES[stream], lines);
  }

  private async append(id: string, file: string, lines: readonly string[]): Promise<void> {
    const dir = this.dir(id);
    await mkdir(dir, { recursive: true });
    await appendFile(join(dir, file), `${lines.join('\n')}\n`, 'utf8');
  }

  /** ZIP session package with metadata and every stream (AGENTS 17). */
  async exportPackage(id: string): Promise<Uint8Array> {
    const dir = this.dir(id);
    const entries = [{ name: 'session.json', data: encode(await readFile(join(dir, SESSION_FILE), 'utf8')) }];
    for (const [key, file] of Object.entries(STREAM_FILES)) {
      try {
        entries.push({ name: file, data: encode(await readFile(join(dir, file), 'utf8')) });
      } catch {
        entries.push({ name: file, data: encode('') });
      }
      void key;
    }
    const archive = createZip(entries, `vdp session ${id}`);
    this.log.info('session package exported', { id, bytes: archive.length, entries: entries.length });
    return archive;
  }
}

/** In-memory repository for tests and for ephemeral environments. */
export class MemorySessionRepository implements SessionRepository {
  private readonly sessions = new Map<string, VehicleSessionData>();
  private readonly streams = new Map<string, Map<string, string[]>>();
  private readonly migrations: MigrationRegistry;

  constructor(migrations?: MigrationRegistry) {
    this.migrations = migrations ?? new MigrationRegistry();
  }

  async save(data: VehicleSessionData): Promise<void> {
    this.sessions.set(data.id, structuredClone(data));
  }

  async load(id: string): Promise<{ data: VehicleSessionData; appliedMigrations: string[] }> {
    const stored = this.sessions.get(id);
    if (!stored) throw new StorageError(`session ${id} not found`, { id });
    const { data, applied } = this.migrations.migrate(JSON.parse(JSON.stringify(stored)) as Record<string, unknown>);
    return { data, appliedMigrations: applied };
  }

  async list(): Promise<StoredSessionSummary[]> {
    return Array.from(this.sessions.values())
      .map((data) => summarize(data, JSON.stringify(data).length))
      .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  }

  async delete(id: string): Promise<void> {
    this.sessions.delete(id);
    this.streams.delete(id);
  }

  async exists(id: string): Promise<boolean> {
    return this.sessions.has(id);
  }

  async appendSamples(id: string, samples: readonly MeasurementSample[]): Promise<void> {
    await this.append(id, 'measurements', samples.map((sample) => JSON.stringify(sample)));
  }

  async appendLines(id: string, stream: 'trace' | 'log', lines: readonly string[]): Promise<void> {
    await this.append(id, stream, lines);
  }

  private async append(id: string, stream: string, lines: readonly string[]): Promise<void> {
    const map = this.streams.get(id) ?? new Map<string, string[]>();
    const existing = map.get(stream) ?? [];
    existing.push(...lines);
    map.set(stream, existing);
    this.streams.set(id, map);
  }

  async exportPackage(id: string): Promise<Uint8Array> {
    const data = this.sessions.get(id);
    if (!data) throw new StorageError(`session ${id} not found`, { id });
    const entries = [{ name: 'session.json', data: encode(JSON.stringify(data, null, 2)) }];
    const streams = this.streams.get(id);
    for (const file of Object.values(STREAM_FILES)) {
      const key = (Object.keys(STREAM_FILES) as Array<keyof typeof STREAM_FILES>).find((k) => STREAM_FILES[k] === file);
      entries.push({ name: file, data: encode((streams?.get(key ?? 'measurements') ?? []).join('\n')) });
    }
    return createZip(entries, `vdp session ${id}`);
  }

  /** Test helper. */
  streamOf(id: string, stream: 'measurements' | 'trace' | 'log'): string[] {
    return this.streams.get(id)?.get(stream) ?? [];
  }
}

/**
 * Single source of truth for list entries, so the filesystem and the in-memory
 * repository cannot drift apart in what they report.
 */
export function summarize(data: VehicleSessionData, sizeBytes: number): StoredSessionSummary {
  return {
    id: data.id,
    startedAt: data.startedAt,
    ...(data.endedAt ? { endedAt: data.endedAt } : {}),
    ...(data.title ? { title: data.title } : {}),
    ...(data.vehicle?.vin ? { vin: data.vehicle.vin } : {}),
    ecus: data.ecus?.length ?? 0,
    dtcCount: data.dtcSnapshots?.at(-1)?.records.length ?? 0,
    sizeBytes,
    schemaVersion: data.schemaVersion,
  };
}

/** Reject path traversal in session ids before it reaches the filesystem. */
export function assertSafeId(id: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(id)) {
    throw new StorageError(`unsafe session id "${id}"`, { id });
  }
}

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
