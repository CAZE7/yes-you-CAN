/**
 * The workbench's own observability (ADR 0049).
 *
 * The finding this pins: a session in which five modules stopped answering produced
 * **no output at all** — `createLogger` writes to the sinks it is handed, and the
 * server was handed none, so every `log.warn` (including "DTC scan failed for ECU")
 * ended in an in-memory buffer nobody reads. At the same moment `POST /api/dtc/scan`
 * answered `{"dtcs":[]}` with HTTP 200. Two silent components next to each other make
 * an operator's wrong conclusion, and neither of them lied.
 *
 * So the process logger is tested like the rest of the contract: it has to reach
 * stdout, and the level switch has to work — a `VDP_LOG_LEVEL` that silently meant
 * `INFO` would be the same defect one layer down.
 */

import assert from "node:assert/strict";
import { test } from "vitest";
import { createServerLogger } from "../src/server.js";

/**
 * Run `body` with the console captured, because that is the sink under test.
 *
 * All three methods: `ConsoleSink` routes by level (`console.error` for ERROR,
 * `console.warn` for WARN, `console.log` for the rest), and a capture of one of them
 * would report a missing line where the level merely chose another stream.
 */
function captureConsole(body: () => void): string[] {
  const lines: string[] = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  const collect = (line?: unknown) => {
    lines.push(String(line));
  };
  console.log = collect;
  console.warn = collect;
  console.error = collect;
  try {
    body();
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  }
  return lines;
}

test("the process logger reaches stdout, with its fields", () => {
  const lines = captureConsole(() => {
    createServerLogger("INFO").info("DTC scan complete", { count: 0, unread: 5 });
  });
  assert.equal(lines.length, 1, "one record, one line — the sink is attached");
  assert.match(lines[0] ?? "", /INFO/, "the level is part of the line");
  assert.match(lines[0] ?? "", /DTC scan complete/);
  assert.match(
    lines[0] ?? "",
    /"unread":5/,
    "the number that mattered is in the line, not beside it",
  );
});

test("a warning is written at the default level", () => {
  const lines = captureConsole(() => {
    createServerLogger(undefined).warn("DTC scan failed for ECU", { ecu: "Body Control Module" });
  });
  assert.equal(lines.length, 1, "without VDP_LOG_LEVEL the level is INFO, so WARN passes");
  assert.match(lines[0] ?? "", /WARN/);
  assert.match(lines[0] ?? "", /Body Control Module/);
});

test("the level switch is honoured, and a word that is no level falls back", () => {
  const quiet = captureConsole(() => {
    createServerLogger("error").info("not shown — INFO is below the requested level");
    createServerLogger("error").error("shown");
  });
  assert.equal(quiet.length, 1, "VDP_LOG_LEVEL=error suppresses INFO");
  assert.match(quiet[0] ?? "", /shown/);

  const fallback = captureConsole(() => {
    createServerLogger("chatty").warn("an unknown word must not silence the workbench");
  });
  assert.equal(fallback.length, 1, "an unparsable level is INFO, never silence");
});
