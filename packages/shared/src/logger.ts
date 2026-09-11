/**
 * Structured logging (AGENTS 33 Observability).
 *
 * Every subsystem logs through this interface with a stable `scope`
 * (connection | can | isotp | uds | ecu | decoder | ui | ai | storage | safety)
 * so raw protocol traces can be filtered out in production (rule 33:
 * "Raw protocol logging optional").
 */

export type LogLevel = "TRACE" | "DEBUG" | "INFO" | "WARN" | "ERROR";

export const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  TRACE: 10,
  DEBUG: 20,
  INFO: 30,
  WARN: 40,
  ERROR: 50,
};

export type LogScope =
  | "connection"
  | "can"
  | "isotp"
  | "uds"
  | "ecu"
  | "decoder"
  | "ui"
  | "ai"
  | "storage"
  | "safety"
  | "report"
  | "session"
  | "definition"
  | (string & {});

export interface LogRecord {
  timestamp: string;
  level: LogLevel;
  scope: LogScope;
  message: string;
  fields?: Record<string, unknown>;
}

export interface LogSink {
  write(record: LogRecord): void;
}

export interface LoggerOptions {
  level?: LogLevel;
  scopes?: LogScope[];
  /** When false, records with `raw: true` in fields are dropped (AGENTS 33). */
  rawProtocol?: boolean;
}

export interface Logger {
  readonly scope: LogScope;
  readonly records: readonly LogRecord[];
  child(scope: LogScope): Logger;
  trace(message: string, fields?: Record<string, unknown>): void;
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  /** Log a raw protocol frame; only emitted when rawProtocol logging is enabled. */
  raw(message: string, fields?: Record<string, unknown>): void;
  addSink(sink: LogSink): void;
}

export class ConsoleSink implements LogSink {
  write(record: LogRecord): void {
    const line = `${record.timestamp} ${record.level.padEnd(5)} [${record.scope}] ${record.message}${
      record.fields && Object.keys(record.fields).length > 0
        ? ` ${safeStringify(record.fields)}`
        : ""
    }`;
    if (record.level === "ERROR") console.error(line);
    else if (record.level === "WARN") console.warn(line);
    else console.log(line);
  }
}

export class MemorySink implements LogSink {
  private readonly buffer: LogRecord[] = [];
  private readonly limit: number;

  constructor(limit = 5000) {
    this.limit = limit;
  }

  write(record: LogRecord): void {
    this.buffer.push(record);
    if (this.buffer.length > this.limit) this.buffer.splice(0, this.buffer.length - this.limit);
  }

  all(): readonly LogRecord[] {
    return this.buffer;
  }

  byScope(scope: LogScope): LogRecord[] {
    return this.buffer.filter((r) => r.scope === scope);
  }

  clear(): void {
    this.buffer.length = 0;
  }
}

/**
 * Byte arrays are stored as hex so every sink — memory, console, a session file —
 * holds readable protocol data instead of an opaque object (AGENTS 33).
 */
export function readableFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = value instanceof Uint8Array ? toHexShort(value) : value;
  }
  return out;
}

export function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, v) => {
      if (v instanceof Uint8Array) return toHexShort(v);
      if (typeof v === "bigint") return v.toString();
      return v;
    });
  } catch {
    return "[unserializable]";
  }
}

function toHexShort(data: Uint8Array): string {
  const bytes = Array.from(data.slice(0, 32))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ");
  return data.length > 32 ? `${bytes}…(+${data.length - 32})` : bytes;
}

class DefaultLogger implements Logger {
  readonly scope: LogScope;
  private readonly options: Required<LoggerOptions>;
  private readonly sinks: LogSink[];
  private readonly collected: LogRecord[];
  private readonly collectLimit: number;

  constructor(
    scope: LogScope,
    options: LoggerOptions,
    sinks: LogSink[],
    collected: LogRecord[] = [],
    collectLimit = 10000,
  ) {
    this.scope = scope;
    this.options = {
      level: options.level ?? "INFO",
      scopes: options.scopes ?? [],
      rawProtocol: options.rawProtocol ?? false,
    };
    this.sinks = sinks;
    this.collected = collected;
    this.collectLimit = collectLimit;
  }

  get records(): readonly LogRecord[] {
    return this.collected;
  }

  child(scope: LogScope): Logger {
    return new DefaultLogger(scope, this.options, this.sinks, this.collected, this.collectLimit);
  }

  addSink(sink: LogSink): void {
    if (!this.sinks.includes(sink)) this.sinks.push(sink);
  }

  trace(message: string, fields?: Record<string, unknown>): void {
    this.emit("TRACE", message, fields);
  }
  debug(message: string, fields?: Record<string, unknown>): void {
    this.emit("DEBUG", message, fields);
  }
  info(message: string, fields?: Record<string, unknown>): void {
    this.emit("INFO", message, fields);
  }
  warn(message: string, fields?: Record<string, unknown>): void {
    this.emit("WARN", message, fields);
  }
  error(message: string, fields?: Record<string, unknown>): void {
    this.emit("ERROR", message, fields);
  }
  /**
   * Raw protocol frames are gated by their own switch (AGENTS 33: "Raw protocol
   * logging optional"), not by the global level — enabling it must work without
   * raising the whole application to TRACE.
   */
  raw(message: string, fields?: Record<string, unknown>): void {
    if (!this.options.rawProtocol) return;
    this.emit("TRACE", message, { raw: true, ...fields }, true);
  }

  private emit(
    level: LogLevel,
    message: string,
    fields?: Record<string, unknown>,
    force = false,
  ): void {
    if (!force && LOG_LEVEL_ORDER[level] < LOG_LEVEL_ORDER[this.options.level]) return;
    if (this.options.scopes.length > 0 && !this.options.scopes.includes(this.scope)) return;
    const record: LogRecord = {
      timestamp: new Date().toISOString(),
      level,
      scope: this.scope,
      message,
      ...(fields ? { fields: readableFields(fields) } : {}),
    };
    this.collected.push(record);
    if (this.collected.length > this.collectLimit)
      this.collected.splice(0, this.collected.length - this.collectLimit);
    for (const sink of this.sinks) sink.write(record);
  }
}

export function createLogger(
  scope: LogScope = "app",
  options: LoggerOptions = {},
  sinks: LogSink[] = [],
): Logger {
  return new DefaultLogger(scope, options, sinks);
}

export const nullLogger: Logger = createLogger("null", { level: "ERROR" });
