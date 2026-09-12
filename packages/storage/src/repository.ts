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

import { appendFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { VehicleSessionData } from "@vdp/core";
import type { MeasurementSample } from "@vdp/core";
import { type Logger, StorageError, createLogger, messageOf } from "@vdp/shared";
import { MigrationRegistry } from "./migrations.js";
import { createZip } from "./zip.js";

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

/**
 * One line of the stored raw trace (`trace.ndjson`).
 *
 * This is the on-disk shape, not a protocol type: the payload is hex text
 * because NDJSON has no byte type. Replay and offline analysis convert it back
 * (AGENTS 18, 19) — the storage layer deliberately stays free of CAN types.
 */
export interface StoredTraceLine {
  t: number;
  canId: number;
  direction: "tx" | "rx";
  /** Uppercase, space separated hex bytes. */
  payload: string;
  channel?: string;
  extended?: boolean;
  fd?: boolean;
}

export interface SessionRepository {
  save(data: VehicleSessionData): Promise<void>;
  load(id: string): Promise<{ data: VehicleSessionData; appliedMigrations: string[] }>;
  list(): Promise<StoredSessionSummary[]>;
  delete(id: string): Promise<void>;
  exists(id: string): Promise<boolean>;
  appendSamples(id: string, samples: readonly MeasurementSample[]): Promise<void>;
  appendLines(id: string, stream: "trace" | "log", lines: readonly string[]): Promise<void>;
  exportPackage(id: string): Promise<Uint8Array>;
  /** Raw trace of a stored session, for replay and offline analysis (AGENTS 19). */
  readTrace(id: string): Promise<StoredTraceLine[]>;
  /** Recorded measurement samples of a stored session (AGENTS 10, 30: Sitzungsvergleich). */
  readSamples(id: string): Promise<MeasurementSample[]>;
}

export interface FileSystemRepositoryOptions {
  rootDir: string;
  logger?: Logger;
  migrations?: MigrationRegistry;
}

const SESSION_FILE = "session.json";
const STREAM_FILES = {
  measurements: "measurements.ndjson",
  trace: "trace.ndjson",
  log: "log.ndjson",
} as const;

export class FileSystemSessionRepository implements SessionRepository {
  private readonly log: Logger;
  private readonly migrations: MigrationRegistry;

  constructor(private readonly options: FileSystemRepositoryOptions) {
    this.log = (options.logger ?? createLogger("storage", { level: "INFO" })).child("storage");
    this.migrations = options.migrations ?? new MigrationRegistry();
  }

  private dir(id: string): string {
    assertSafeId(id);
    return join(this.options.rootDir, id);
  }

  async save(data: VehicleSessionData): Promise<void> {
    const dir = this.dir(data.id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, SESSION_FILE), JSON.stringify(data, null, 2), "utf8");
    this.log.info("session saved", { id: data.id, ecus: data.ecus.length });
  }

  async load(id: string): Promise<{ data: VehicleSessionData; appliedMigrations: string[] }> {
    const path = join(this.dir(id), SESSION_FILE);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
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
      this.log.info("session migrated", { id, applied });
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
        const parsed = JSON.parse(await readFile(path, "utf8")) as VehicleSessionData;
        summaries.push(summarize(parsed, info.size));
      } catch (error) {
        this.log.warn("skipping unreadable session", { entry, error: messageOf(error) });
      }
    }
    return summaries.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  }

  async delete(id: string): Promise<void> {
    await rm(this.dir(id), { recursive: true, force: true });
    this.log.info("session deleted", { id });
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
    await this.append(
      id,
      STREAM_FILES.measurements,
      samples.map((sample) => JSON.stringify(sample)),
    );
  }

  async appendLines(id: string, stream: "trace" | "log", lines: readonly string[]): Promise<void> {
    if (lines.length === 0) return;
    await this.append(id, STREAM_FILES[stream], lines);
  }

  private async append(id: string, file: string, lines: readonly string[]): Promise<void> {
    const dir = this.dir(id);
    await mkdir(dir, { recursive: true });
    await appendFile(join(dir, file), `${lines.join("\n")}\n`, "utf8");
  }

  /**
   * Read the stored raw trace.
   *
   * A trace is append-only and may end mid-line after a crash, so unreadable
   * lines are skipped with a warning instead of failing the whole replay: the
   * frames before the crash are still worth analysing.
   */
  async readTrace(id: string): Promise<StoredTraceLine[]> {
    const path = join(this.dir(id), STREAM_FILES.trace);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      return [];
    }
    return parseTraceLines(raw, (message, line) =>
      this.log.warn("skipping unreadable trace line", { id, line, error: message }),
    );
  }

  /**
   * Read the recorded measurement samples.
   *
   * Like the trace, the file is append-only: a crash can leave a partial last
   * line, so unreadable lines are counted and skipped — the samples before the
   * crash are still valid data, and dropping the whole recording because of the
   * last byte would throw away a running measurement.
   */
  async readSamples(id: string): Promise<MeasurementSample[]> {
    const path = join(this.dir(id), STREAM_FILES.measurements);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      return [];
    }
    return parseSampleLines(raw, (message, line) =>
      this.log.warn("skipping unreadable sample line", { id, line, error: message }),
    );
  }

  /** ZIP session package with metadata and every stream (AGENTS 17). */
  async exportPackage(id: string): Promise<Uint8Array> {
    const dir = this.dir(id);
    const entries = [
      { name: "session.json", data: encode(await readFile(join(dir, SESSION_FILE), "utf8")) },
    ];
    for (const [key, file] of Object.entries(STREAM_FILES)) {
      try {
        entries.push({ name: file, data: encode(await readFile(join(dir, file), "utf8")) });
      } catch {
        entries.push({ name: file, data: encode("") });
      }
      void key;
    }
    const archive = createZip(entries, `vdp session ${id}`);
    this.log.info("session package exported", {
      id,
      bytes: archive.length,
      entries: entries.length,
    });
    return archive;
  }
}

/** In-memory repository for tests and for ephemeral environments. */
export interface MemoryRepositoryOptions {
  migrations?: MigrationRegistry;
  logger?: Logger;
}

export class MemorySessionRepository implements SessionRepository {
  private readonly sessions = new Map<string, VehicleSessionData>();
  private readonly streams = new Map<string, Map<string, string[]>>();
  private readonly migrations: MigrationRegistry;
  private readonly log: Logger;

  /**
   * Accepts a bare `MigrationRegistry` for backwards compatibility as well as the
   * options object, so both repositories are configured the same way.
   */
  constructor(options: MemoryRepositoryOptions | MigrationRegistry = {}) {
    const isRegistry = options instanceof MigrationRegistry;
    this.migrations = isRegistry ? options : (options.migrations ?? new MigrationRegistry());
    this.log =
      (isRegistry ? undefined : options.logger) ?? createLogger("storage", { level: "INFO" });
    this.log.child("storage");
  }

  async save(data: VehicleSessionData): Promise<void> {
    this.sessions.set(data.id, structuredClone(data));
  }

  async load(id: string): Promise<{ data: VehicleSessionData; appliedMigrations: string[] }> {
    const stored = this.sessions.get(id);
    if (!stored) throw new StorageError(`session ${id} not found`, { id });
    const { data, applied } = this.migrations.migrate(
      JSON.parse(JSON.stringify(stored)) as Record<string, unknown>,
    );
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
    await this.append(
      id,
      "measurements",
      samples.map((sample) => JSON.stringify(sample)),
    );
  }

  async appendLines(id: string, stream: "trace" | "log", lines: readonly string[]): Promise<void> {
    await this.append(id, stream, lines);
  }

  async readTrace(id: string): Promise<StoredTraceLine[]> {
    const lines = this.streams.get(id)?.get("trace") ?? [];
    return parseTraceLines(lines.join("\n"));
  }

  async readSamples(id: string): Promise<MeasurementSample[]> {
    const lines = this.streams.get(id)?.get("measurements") ?? [];
    return parseSampleLines(lines.join("\n"));
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
    const entries = [{ name: "session.json", data: encode(JSON.stringify(data, null, 2)) }];
    const streams = this.streams.get(id);
    for (const file of Object.values(STREAM_FILES)) {
      const key = (Object.keys(STREAM_FILES) as Array<keyof typeof STREAM_FILES>).find(
        (k) => STREAM_FILES[k] === file,
      );
      entries.push({
        name: file,
        data: encode((streams?.get(key ?? "measurements") ?? []).join("\n")),
      });
    }
    return createZip(entries, `vdp session ${id}`);
  }

  /** Test helper. */
  streamOf(id: string, stream: "measurements" | "trace" | "log"): string[] {
    return this.streams.get(id)?.get(stream) ?? [];
  }
}

/**
 * Parse stored trace lines into `StoredTraceLine`, skipping anything unreadable.
 *
 * Shared by the filesystem and the in-memory repository so their behaviour
 * cannot diverge. A trace is append-only and may end mid-line after a crash, so
 * an unreadable line is reported and skipped instead of failing the whole
 * replay: the frames before the crash are still worth analysing.
 */
export function parseTraceLines(
  raw: string,
  onError?: (message: string, line: string) => void,
): StoredTraceLine[] {
  const parsed: StoredTraceLine[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const record = JSON.parse(trimmed) as Record<string, unknown>;
      const payload =
        typeof record["payload"] === "string"
          ? record["payload"]
          : typeof record["payloadHex"] === "string"
            ? record["payloadHex"]
            : "";
      const canId =
        typeof record["canId"] === "number"
          ? record["canId"]
          : Number.parseInt(String(record["canIdHex"] ?? ""), 16);
      if (!Number.isFinite(canId) || payload.length === 0) continue;
      parsed.push({
        t: typeof record["t"] === "number" ? record["t"] : 0,
        canId,
        direction: record["direction"] === "tx" ? "tx" : "rx",
        payload,
        ...(typeof record["channel"] === "string" ? { channel: record["channel"] } : {}),
        ...(typeof record["extended"] === "boolean" ? { extended: record["extended"] } : {}),
        ...(typeof record["fd"] === "boolean" ? { fd: record["fd"] } : {}),
      });
    } catch (error) {
      onError?.(messageOf(error), trimmed);
    }
  }
  return parsed;
}

/**
 * Parse stored sample lines, skipping anything unreadable.
 *
 * A sample without a signal id or without a finite `t` cannot be placed on the
 * shared time axis, so it is dropped rather than rendered at position zero.
 */
export function parseSampleLines(
  raw: string,
  onError?: (message: string, line: string) => void,
): MeasurementSample[] {
  const parsed: MeasurementSample[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const record = JSON.parse(trimmed) as Partial<MeasurementSample>;
      if (typeof record.signal !== "string" || record.signal.length === 0) continue;
      if (typeof record.t !== "number" || !Number.isFinite(record.t)) continue;
      if (record.value === undefined) continue;
      parsed.push({
        timestamp:
          typeof record.timestamp === "string" ? record.timestamp : new Date(0).toISOString(),
        t: record.t,
        signal: record.signal,
        value: record.value,
        rawValue: record.rawValue ?? record.value,
        rawHex: typeof record.rawHex === "string" ? record.rawHex : "",
        ...(typeof record.unit === "string" ? { unit: record.unit } : {}),
        ...(typeof record.enumText === "string" ? { enumText: record.enumText } : {}),
        outOfRange: record.outOfRange === true,
      });
    } catch (error) {
      onError?.(messageOf(error), trimmed);
    }
  }
  return parsed;
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
