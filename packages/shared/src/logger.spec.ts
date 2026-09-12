import assert from "node:assert/strict";
import { test } from "vitest";
import {
  ConsoleSink,
  LOG_LEVEL_ORDER,
  type LogLevel,
  type LogRecord,
  MemorySink,
  createLogger,
  safeStringify,
} from "./logger.js";

const record = (level: LogLevel, message = "m", fields?: Record<string, unknown>): LogRecord => ({
  timestamp: "2026-09-12T00:00:00.000Z",
  level,
  scope: "uds",
  message,
  ...(fields ? { fields } : {}),
});

test("level filtering drops below threshold", () => {
  const sink = new MemorySink();
  const log = createLogger("uds", { level: "WARN" }, [sink]);
  log.debug("ignored");
  log.warn("kept");
  assert.equal(sink.all().length, 1);
  assert.equal(sink.all()[0]?.level, "WARN");
});

test("raw protocol logging is opt-in (AGENTS 33)", () => {
  const quiet = new MemorySink();
  createLogger("can", { level: "TRACE", rawProtocol: false }, [quiet]).raw("frame", {
    data: new Uint8Array([1]),
  });
  assert.equal(quiet.all().length, 0);

  const loud = new MemorySink();
  createLogger("can", { level: "TRACE", rawProtocol: true }, [loud]).raw("frame", {
    data: new Uint8Array([1, 2]),
  });
  assert.equal(loud.all().length, 1);
  assert.deepEqual((loud.all()[0]?.fields as Record<string, unknown>)?.data, "01 02");
});

test("scope filtering and child loggers share the record buffer", () => {
  const sink = new MemorySink();
  const root = createLogger("connection", { level: "TRACE", scopes: ["uds"] }, [sink]);
  root.info("connection message");
  root.child("uds").info("uds message");
  assert.equal(sink.all().length, 1);
  assert.equal(sink.all()[0]?.scope, "uds");
  assert.equal(root.records.length, 1);
});

test("level order is monotonic", () => {
  assert.ok(LOG_LEVEL_ORDER.TRACE < LOG_LEVEL_ORDER.DEBUG);
  assert.ok(LOG_LEVEL_ORDER.DEBUG < LOG_LEVEL_ORDER.INFO);
  assert.ok(LOG_LEVEL_ORDER.INFO < LOG_LEVEL_ORDER.WARN);
  assert.ok(LOG_LEVEL_ORDER.WARN < LOG_LEVEL_ORDER.ERROR);
});

test("console sink does not throw on circular structures", () => {
  const sink = new ConsoleSink();
  const circular: Record<string, unknown> = { a: 1 };
  circular["self"] = circular;
  const original = console.log;
  console.log = () => undefined;
  try {
    sink.write({ timestamp: "t", level: "INFO", scope: "ui", message: "m", fields: circular });
  } finally {
    console.log = original;
  }
});

test("the console sink routes every level to the matching console method", () => {
  const calls: Array<{ method: string; line: string }> = [];
  const original = { error: console.error, warn: console.warn, log: console.log };
  console.error = (line: unknown) => {
    calls.push({ method: "error", line: String(line) });
  };
  console.warn = (line: unknown) => {
    calls.push({ method: "warn", line: String(line) });
  };
  console.log = (line: unknown) => {
    calls.push({ method: "log", line: String(line) });
  };
  try {
    const sink = new ConsoleSink();
    sink.write(record("ERROR", "m", { nrc: 0x31 }));
    sink.write(record("WARN"));
    sink.write(record("INFO", "m", { bytes: new Uint8Array([0x02, 0x50, 0x01]) }));
  } finally {
    console.error = original.error;
    console.warn = original.warn;
    console.log = original.log;
  }
  assert.deepEqual(
    calls.map((entry) => entry.method),
    ["error", "warn", "log"],
    "ERROR belongs on stderr, WARN on console.warn, the rest on console.log",
  );
  assert.match(calls[0]?.line ?? "", /ERROR \[uds\] m \{"nrc":49\}/);
  assert.ok(
    (calls[1]?.line ?? "").endsWith("WARN  [uds] m"),
    "without fields no JSON is appended to the line",
  );
  assert.match(
    calls[2]?.line ?? "",
    /"bytes":"02 50 01"/,
    "bytes are logged as hex, not as numbers",
  );
});

test("the memory sink trims the oldest records once it reaches its limit", () => {
  const sink = new MemorySink(2);
  for (const message of ["first", "second", "third"]) sink.write(record("INFO", message));
  assert.deepEqual(
    sink.all().map((entry) => entry.message),
    ["second", "third"],
    "the buffer must not grow past its limit",
  );
});

test("the memory sink filters by scope and can be cleared", () => {
  const sink = new MemorySink();
  sink.write({ ...record("INFO", "frame"), scope: "can" });
  sink.write(record("WARN", "timeout"));
  assert.deepEqual(
    sink.byScope("uds").map((entry) => entry.message),
    ["timeout"],
  );
  assert.equal(sink.byScope("storage").length, 0, "an unused scope yields nothing");
  sink.clear();
  assert.equal(sink.all().length, 0, "clear must empty the buffer");
});

test("safeStringify renders bytes as hex and BigInt as digits (AGENTS 33)", () => {
  assert.equal(safeStringify({ data: new Uint8Array([0x7e, 0x05]) }), '{"data":"7e 05"}');
  // longer than 32 bytes: shown truncated, with the number of omitted bytes
  assert.match(safeStringify({ long: new Uint8Array(34).fill(0xab) }), /ab( ab){31}…\(\+2\)/);
  assert.equal(safeStringify({ id: 10n }), '{"id":"10"}', "JSON cannot carry a BigInt");
  const circular: Record<string, unknown> = { a: 1 };
  circular.self = circular;
  assert.equal(
    safeStringify(circular),
    "[unserializable]",
    "a cycle must not throw inside the log call",
  );
});

test("addSink is idempotent, so a sink registered twice does not write twice", () => {
  const sink = new MemorySink();
  const log = createLogger("uds", { level: "INFO" });
  log.addSink(sink);
  log.addSink(sink);
  log.info("once");
  assert.equal(sink.all().length, 1);
});

test("a child logger writes through the sinks registered on its parent", () => {
  const sink = new MemorySink();
  const parent = createLogger("connection", { level: "INFO" });
  parent.addSink(sink);
  parent.child("uds").info("through the child");
  assert.deepEqual(
    sink.all().map((entry) => entry.scope),
    ["uds"],
    "the child shares the sinks but keeps its own scope",
  );
});

test("the record buffer stops at its collect limit and drops the oldest", () => {
  const log = createLogger("can", { level: "TRACE" });
  for (let i = 0; i < 10_005; i += 1) log.trace(`frame ${i}`);
  assert.equal(log.records.length, 10_000, "a long session must not grow the buffer without bound");
  assert.equal(log.records[0]?.message, "frame 5", "the oldest records are dropped first");
});

test("a logger created without options defaults to INFO (AGENTS 33)", () => {
  const sink = new MemorySink();
  const log = createLogger("app", {}, [sink]);
  log.debug("dropped below the default level");
  log.info("kept");
  assert.deepEqual(
    sink.all().map((entry) => [entry.level, entry.message]),
    [["INFO", "kept"]],
    "the default level must be INFO, not TRACE and not OFF",
  );
});
