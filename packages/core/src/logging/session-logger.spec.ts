/**
 * SessionLogger tests (AGENTS 17, 18, 33).
 *
 * The raw trace is the witness for replay and regression: entries must be
 * lossless (payload bytes preserved, both directions recorded), bounded in
 * memory, and exportable without reinterpretation.
 */

import assert from "node:assert/strict";
import { toHex } from "@vdp/shared";
import { createFrame } from "@vdp/transport-can";
import fc from "fast-check";
import { describe, test } from "vitest";
import type { MeasurementSample } from "../measurements/recorder.js";
import { SessionLogger } from "./session-logger.js";

function frameAt(id: number, payload: number[], timestamp: number, direction: "tx" | "rx" = "rx") {
  return createFrame(id, new Uint8Array(payload), { timestamp, direction });
}

describe("trace recording", () => {
  test("entries keep both directions, hex payload and the injectable clock", () => {
    let now = 10_000;
    const session = new SessionLogger({ clock: () => now });
    session.recordFrame(frameAt(0x7e0, [0x22, 0xf1, 0x90], now, "tx"));
    now = 10_050;
    const entry = session.recordFrame(frameAt(0x7e8, [0x62, 0xf1, 0x90, 0x57], now, "rx"));
    assert.equal(entry.direction, "rx");
    assert.equal(entry.payloadHex, "62F19057");
    assert.equal(entry.canIdHex, "0x7E8");
    assert.equal(entry.t, 50);
    assert.equal(session.traceLength, 2);
    // A frame whose timestamp is 0/absent falls back to the injectable clock.
    const undated = createFrame(0x123, new Uint8Array([1]), { timestamp: 0 });
    session.recordFrame(undated);
    assert.equal(session.snapshot().trace[2]?.t, 50, "clock fallback: 10050 - 10000");
  });

  test("the trace cap drops the OLDEST entries, never silently grows unbounded", () => {
    let now = 0;
    const session = new SessionLogger({ clock: () => now, maxTraceEntries: 10 });
    for (let i = 0; i <= 25; i++) {
      now = i;
      session.recordFrame(frameAt(0x100 + i, [i & 0xff], now));
    }
    assert.equal(session.traceLength, 10);
    const first = session.snapshot().trace[0] as { canId: number; t: number };
    assert.equal(first.canId, 0x110, "the first 16 entries were evicted");
  });

  test("pairs() matches each tx request with the next rx response", () => {
    let now = 0;
    const session = new SessionLogger({ clock: () => now });
    session.recordFrame(frameAt(0x7e0, [0x10, 0x03], (now += 10), "tx"));
    session.recordFrame(frameAt(0x7e8, [0x50, 0x03], (now += 10), "rx"));
    session.recordFrame(frameAt(0x7e8, [0x02, 0x01], (now += 10), "rx"));
    session.recordFrame(frameAt(0x7e0, [0x3e, 0x00], (now += 10), "tx"));
    const pairs = session.pairs();
    assert.equal(pairs.length, 2);
    assert.equal(pairs[0]?.response?.payloadHex, "5003");
    assert.equal(pairs[1]?.response, null, "a request without response is reported as null");
  });

  test("diagnostic log entries carry scope, message and fields", () => {
    let now = 500;
    const session = new SessionLogger({ clock: () => now });
    const entry = session.log("uds", "session control", { type: "extended" });
    assert.equal(entry.scope, "uds");
    assert.equal(entry.fields?.type, "extended");
    assert.equal(entry.t, 0);
    now = 800;
    assert.equal(session.log("dtc", "scanned").t, 300);
    assert.equal(session.entries.length, 2);
  });

  test("traceFor filters one identifier", () => {
    const session = new SessionLogger({ clock: () => 0 });
    session.recordFrame(frameAt(0x7e0, [1], 0, "tx"));
    session.recordFrame(frameAt(0x7e8, [2], 1, "rx"));
    session.recordFrame(frameAt(0x7e0, [3], 2, "tx"));
    assert.equal(session.traceFor(0x7e0).length, 2);
  });
});

describe("exports (AGENTS 17/18)", () => {
  test("CSV escapes quotes, commas and newlines per RFC 4180", () => {
    const csv = SessionLogger.toCsv(
      [
        {
          timestamp: "2026-09-11T08:00:00.000Z",
          t: 0,
          signal: "engine.note",
          value: 'knock, "loud"',
          rawValue: "x",
          rawHex: "00",
          outOfRange: false,
        },
      ],
      [
        {
          id: "marker_1",
          t: 5,
          timestamp: "2026-09-11T08:00:00.005Z",
          label: "line\nbreak",
          kind: "user",
        },
      ],
    );
    assert.ok(csv.includes('"knock, ""loud"""'));
    assert.ok(csv.includes('"line\nbreak"'));
    assert.ok(csv.endsWith("\n"));
    assert.ok(csv.includes("# markers"));
  });

  test("trace CSV keeps id, direction, dlc and payload", () => {
    const session = new SessionLogger({ clock: () => 0 });
    const entry = session.recordFrame(frameAt(0x7e8, [0x62, 0xf1], 0, "rx"));
    const csv = SessionLogger.traceToCsv([entry]);
    assert.match(csv, /0x7E8,rx,2,62F1,can0,false,false/);
  });

  test("JSON export is the lossless format marker + payload-as-hex", () => {
    const json = SessionLogger.toJson({
      meta: { vin: "1HGCM82633A004352" },
      samples: [],
      markers: [],
      dtcs: [],
      trace: [{ ...traceStub(), payloadHex: toHex(new Uint8Array([1, 2]), "") }],
      log: [],
    });
    const parsed = JSON.parse(json) as {
      format: string;
      formatVersion: number;
      trace: Array<{ payload: string }>;
    };
    assert.equal(parsed.format, "vdp.session");
    assert.equal(parsed.formatVersion, 1);
    assert.equal(parsed.trace[0]?.payload, "0102");
  });

  test("property: every recorded frame re-exports with an identical payload hex", () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 0x7ff }),
        fc.uint8Array({ minLength: 0, maxLength: 8 }),
        fc.nat({ max: 0xffff }),
        (id, payload, timestamp) => {
          const session = new SessionLogger({ clock: () => timestamp });
          const entry = session.recordFrame(
            createFrame(id, payload, { timestamp, direction: "tx" }),
          );
          assert.equal(entry.payloadHex, toHex(payload, ""));
          assert.equal(entry.dlc, payload.length === 0 ? 0 : Math.min(payload.length, 8));
        },
      ),
    );
  });
});

/**
 * A minimal RFC 4180 reader, so "we can write it" and "someone can read it back"
 * are tested against each other instead of against a hand-copied string.
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += char;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** A sample as the recorder would hand it over; every test varies one field. */
function sample(overrides: Partial<MeasurementSample> = {}): MeasurementSample {
  return {
    timestamp: "2026-09-11T08:00:01.000Z",
    t: 1000,
    signal: "engine.rpm",
    value: 847,
    rawValue: 105,
    rawHex: "0069",
    outOfRange: false,
    ...overrides,
  };
}

describe("decoded sample CSV (SessionLogger.toCsv)", () => {
  test("an empty export is the header alone, still newline terminated", () => {
    const csv = SessionLogger.toCsv([]);
    assert.equal(
      csv,
      "timestamp,t_ms,signal,value,raw_value,raw_hex,unit,enum_text,out_of_range\n",
    );
    assert.deepEqual(parseCsv(csv), [
      [
        "timestamp",
        "t_ms",
        "signal",
        "value",
        "raw_value",
        "raw_hex",
        "unit",
        "enum_text",
        "out_of_range",
      ],
    ]);
  });

  test("every row has nine fields, in the header order, and nothing else", () => {
    const csv = SessionLogger.toCsv([
      sample({ signal: "engine.rpm" }),
      sample({ signal: "engine.limp_mode", value: true, rawValue: 1, rawHex: "01" }),
    ]);
    const rows = parseCsv(csv);
    assert.equal(rows.length, 3, "header plus one row per sample");
    for (const row of rows)
      assert.equal(row.length, 9, "a fixed column count is what lets a spreadsheet load the file");
    assert.deepEqual(rows[1], [
      "2026-09-11T08:00:01.000Z",
      "1000",
      "engine.rpm",
      "847",
      "105",
      "0069",
      "",
      "",
      "false",
    ]);
    assert.deepEqual(rows[2], [
      "2026-09-11T08:00:01.000Z",
      "1000",
      "engine.limp_mode",
      "true",
      "1",
      "01",
      "",
      "",
      "false",
    ]);
  });

  test("unit and enum_text appear only when the sample has them", () => {
    const csv = SessionLogger.toCsv([
      sample({ value: 90.5, rawValue: 1305, rawHex: "0519", unit: "°C" }),
      sample({ signal: "engine.mil", value: 2, rawValue: 2, rawHex: "02", enumText: "on" }),
    ]);
    const rows = parseCsv(csv);
    assert.deepEqual(rows[1]?.slice(6), ["°C", "", "false"]);
    assert.deepEqual(rows[2]?.slice(6), ["", "on", "false"]);
    assert.ok(
      !csv.includes("undefined") && !csv.includes("null"),
      "an absent field is an empty cell, never a JS type name",
    );
  });

  test("values are written the way they were decoded, without a formatting layer in between", () => {
    const csv = SessionLogger.toCsv([
      sample({ signal: "a.int", value: 42, rawValue: 42 }),
      sample({ signal: "b.float", value: 0.1, rawValue: 1 }),
      sample({ signal: "c.bool", value: false, rawValue: 0, rawHex: "00" }),
      sample({ signal: "d.text", value: "ABCD", rawValue: "ABCD", rawHex: "41424344" }),
      sample({ signal: "e.nan", value: Number.NaN, rawValue: Number.NaN }),
      sample({ signal: "f.infinity", value: Number.POSITIVE_INFINITY, rawValue: Number.MAX_VALUE }),
      sample({ signal: "g.big", value: 1e21, rawValue: 0 }),
      sample({ signal: "h.negative", value: -40.5, rawValue: -5 }),
    ]);
    assert.deepEqual(
      parseCsv(csv)
        .slice(1)
        .map((row) => row[3]),
      ["42", "0.1", "false", "ABCD", "NaN", "Infinity", "1e+21", "-40.5"],
    );
    assert.deepEqual(
      parseCsv(csv)
        .slice(1)
        .map((row) => row[4]),
      ["42", "1", "0", "ABCD", "NaN", "1.7976931348623157e+308", "0", "-5"],
    );
  });

  test("out_of_range is a lower-case boolean", () => {
    const csv = SessionLogger.toCsv([
      sample({ value: 1, outOfRange: true }),
      sample({ signal: "x", value: 2, outOfRange: false }),
    ]);
    assert.deepEqual(
      parseCsv(csv)
        .slice(1)
        .map((row) => row[8]),
      ["true", "false"],
    );
  });

  test("commas, quotes and newlines survive the round trip", () => {
    const awkward = 'knock, "loud"\r\nsecond line';
    const csv = SessionLogger.toCsv([
      sample({ signal: "engine.note", value: awkward, rawValue: awkward, rawHex: '"' }),
    ]);
    assert.ok(
      csv.includes('"knock, ""loud""\r\nsecond line"'),
      "the field is quoted and its quotes doubled",
    );
    const row = parseCsv(csv)[1];
    assert.equal(row?.[2], "engine.note");
    assert.equal(row?.[3], awkward, "the reader gets exactly the string that went in");
    assert.equal(row?.[4], awkward);
    assert.equal(row?.[5], '"', "a lone quote is doubled, not dropped");
    assert.equal(
      parseCsv(csv).length,
      2,
      "an embedded newline does not invent a row for a reader that respects quoting",
    );
  });

  test("the marker block follows the data, only when there are markers", () => {
    assert.ok(!SessionLogger.toCsv([sample()]).includes("#"), "no markers, no comment block");
    const csv = SessionLogger.toCsv(
      [sample()],
      [
        {
          id: "marker_1",
          t: 0,
          timestamp: "2026-09-11T08:00:00.000Z",
          label: "ignition on",
          kind: "user",
        },
        {
          id: "marker_2",
          t: 5,
          timestamp: "2026-09-11T08:00:05.000Z",
          label: "key on, cold",
          detail: "engine cold",
          kind: "action",
        },
      ],
    );
    const [header, data, blank, markerTitle, markerHeader, first, second] = csv
      .trimEnd()
      .split("\n");
    assert.equal(
      header,
      "timestamp,t_ms,signal,value,raw_value,raw_hex,unit,enum_text,out_of_range",
    );
    assert.equal(
      blank,
      "",
      "a blank line separates the two blocks so a strict reader can cut here",
    );
    assert.equal(markerTitle, "# markers");
    assert.equal(markerHeader, "timestamp,t_ms,label,kind,detail");
    assert.equal(data, "2026-09-11T08:00:01.000Z,1000,engine.rpm,847,105,0069,,,false");
    assert.equal(first, "2026-09-11T08:00:00.000Z,0,ignition on,user,");
    assert.equal(second, '2026-09-11T08:00:05.000Z,5,"key on, cold",action,engine cold');
  });

  test("property: one row per sample, and every cell reads back unchanged", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            signal: fc.string({ minLength: 1 }),
            value: fc.oneof(fc.integer(), fc.double({ noNaN: true }), fc.boolean(), fc.string()),
            rawValue: fc.oneof(fc.integer(), fc.string()),
            rawHex: fc.array(fc.nat({ max: 255 }), { maxLength: 6 }).map((bytes) =>
              bytes
                .map((byte) => byte.toString(16).padStart(2, "0"))
                .join("")
                .toUpperCase(),
            ),
            unit: fc.option(fc.oneof(fc.constant("rpm"), fc.constant("°C"), fc.constant('x, y"z'))),
            enumText: fc.option(fc.string()),
            outOfRange: fc.boolean(),
          }),
          { maxLength: 6 },
        ),
        (rows) => {
          const csv = SessionLogger.toCsv(
            rows.map((row, index) =>
              sample({
                signal: row.signal,
                t: index,
                timestamp: `2026-09-11T08:00:0${index}.000Z`,
                value: row.value,
                rawValue: row.rawValue,
                rawHex: row.rawHex,
                ...(row.unit === null ? {} : { unit: row.unit }),
                ...(row.enumText === null ? {} : { enumText: row.enumText }),
                outOfRange: row.outOfRange,
              }),
            ),
          );
          const parsed = parseCsv(csv);
          assert.equal(parsed.length, rows.length + 1, "header plus one row per sample");
          for (const [index, row] of parsed.slice(1).entries()) {
            const source = rows[index] as (typeof rows)[number];
            assert.equal(row?.length, 9);
            assert.equal(row?.[0], `2026-09-11T08:00:0${index}.000Z`);
            assert.equal(row?.[1], String(index));
            assert.equal(
              row?.[2],
              source.signal,
              "the id column can hold any string, including commas and quotes",
            );
            assert.equal(row?.[3], String(source.value));
            assert.equal(row?.[4], String(source.rawValue));
            assert.equal(row?.[5], source.rawHex);
            assert.equal(row?.[6], source.unit ?? "");
            assert.equal(row?.[7], source.enumText ?? "");
            assert.equal(row?.[8], String(source.outOfRange));
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("raw trace and JSON exports", () => {
  test("traceToCsv of no frames is the header alone", () => {
    assert.equal(
      SessionLogger.traceToCsv([]),
      "timestamp,t_ms,can_id,direction,dlc,payload,channel,extended,fd\n",
    );
  });

  test("one row per frame, with the id in hex and the payload compact", () => {
    const session = new SessionLogger({ clock: () => 0 });
    const entry = session.recordFrame(frameAt(0x7e8, [0xde, 0xad], 0, "tx"));
    const rows = parseCsv(SessionLogger.traceToCsv([entry, ...session.traceFor(0x7e8)]));
    assert.equal(rows.length, 3);
    assert.deepEqual(
      rows[1],
      rows[2],
      "the entry handed to the caller is the entry that was stored",
    );
    assert.deepEqual(rows[1], [
      "1970-01-01T00:00:00.000Z",
      "0",
      "0x7E8",
      "tx",
      "2",
      "DEAD",
      "can0",
      "false",
      "false",
    ]);
  });

  test("extended and FD are reported as booleans, and nothing about FD frames is invented", () => {
    const session = new SessionLogger({ clock: () => 0 });
    const fdFrame = { ...frameAt(0x123, [1, 2, 3, 0x40], 0), fd: true, dlc: 8 };
    const row = parseCsv(SessionLogger.traceToCsv([session.recordFrame(fdFrame)]))[1];
    assert.deepEqual(row?.slice(7), ["false", "true"]);
    assert.equal(row?.[4], "8", "the dlc of an FD frame is its own, not the byte count");
    assert.equal(row?.[5], "01020340");
  });

  test("toJson is the lossless form: hex payload plus the full sample objects", () => {
    const session = new SessionLogger({ clock: () => 0 });
    const entry = session.recordFrame(frameAt(0x7e8, [0x62, 0xf1], 0));
    const json = SessionLogger.toJson({
      meta: { vin: "1HGCM82633A004352" },
      samples: [sample({ signal: "engine.rpm" })],
      markers: [],
      dtcs: [],
      trace: [entry],
      log: [...session.entries],
    });
    const parsed = JSON.parse(json) as {
      format: string;
      formatVersion: number;
      exportedAt: string;
      meta: Record<string, unknown>;
      measurements: MeasurementSample[];
      trace: Array<{ payload: string; payloadHex: string }>;
      log: unknown[];
      dtcs: unknown[];
      markers: unknown[];
    };
    assert.deepEqual(parsed.format, "vdp.session");
    assert.equal(parsed.formatVersion, 1);
    assert.equal(parsed.meta.vin, "1HGCM82633A004352");
    assert.equal(parsed.measurements[0]?.signal, "engine.rpm");
    assert.equal(
      parsed.trace[0]?.payload,
      "62F1",
      "bytes leave as hex, so JSON stays a text format",
    );
    assert.equal(parsed.trace[0]?.payloadHex, "62F1");
    assert.deepEqual(Object.keys(parsed).sort(), [
      "dtcs",
      "exportedAt",
      "format",
      "formatVersion",
      "log",
      "markers",
      "measurements",
      "meta",
      "trace",
    ]);
    assert.equal(
      new Date(parsed.exportedAt).toISOString(),
      parsed.exportedAt,
      "exportedAt is the wall clock of the export, not of the session",
    );
    assert.match(json, /\n {2}"/, "two-space indentation: a session file is also read by humans");
  });

  test("an empty session still exports every key, so a reader never has to guess", () => {
    const parsed = JSON.parse(
      SessionLogger.toJson({ meta: {}, samples: [], markers: [], dtcs: [], trace: [], log: [] }),
    ) as Record<string, unknown>;
    assert.deepEqual(parsed.measurements, []);
    assert.deepEqual(parsed.meta, {});
  });
});

describe("what a session object guarantees around the exports", () => {
  test("snapshot returns copies of both streams", () => {
    const session = new SessionLogger({ clock: () => 0 });
    session.recordFrame(frameAt(0x7e0, [1], 0, "tx"));
    session.log("uds", "hello");
    const snapshot = session.snapshot();
    snapshot.trace.length = 0;
    snapshot.log.length = 0;
    assert.equal(session.traceLength, 1, "draining the export leaves the session alone");
    assert.equal(session.entries.length, 1);
  });

  test("t is relative to the session clock start, and a backwards clock stays negative", () => {
    let now = 1_000;
    const session = new SessionLogger({ clock: () => now });
    assert.equal(
      (session.recordFrame(frameAt(0x7e0, [1], now, "tx")) as { t: number }).t,
      0,
      "the first frame is the zero point",
    );
    now = 1_500;
    assert.equal(session.log("app", "marker").t, 500, "log entries share the zero point");
    now = 900;
    // The value comes from the adapter; clamping it would hide a clock problem and
    // pretend the trace was monotonic, so the sign is kept for whoever reads it.
    assert.equal((session.recordFrame(frameAt(0x7e8, [2], now, "rx")) as { t: number }).t, -100);
  });

  test("the recorded payload is a copy: reusing a buffer cannot rewrite history", () => {
    const buffer = new Uint8Array([0x22, 0xf1, 0x90]);
    const frame = createFrame(0x7e0, buffer, { timestamp: 0, direction: "tx" });
    const session = new SessionLogger({ clock: () => 0 });
    const entry = session.recordFrame(frame);
    buffer[1] = 0x00;
    assert.equal(entry.payloadHex, "22F190", "the hex string keeps the bytes that were on the bus");
    assert.equal(toHex(entry.payload, ""), "22F190", "and so do the recorded bytes themselves");
    assert.notEqual(entry.payload, buffer);
  });

  test("a log entry without fields has no fields key at all", () => {
    const session = new SessionLogger({ clock: () => 0 });
    assert.deepEqual(Object.keys(session.log("dtc", "scanned 3 codes")), [
      "timestamp",
      "t",
      "scope",
      "message",
    ]);
    assert.deepEqual(Object.keys(session.log("dtc", "detail", { count: 3 })), [
      "timestamp",
      "t",
      "scope",
      "message",
      "fields",
    ]);
  });

  test("the trace cap can be set to zero: statistics, no evidence", () => {
    const session = new SessionLogger({ clock: () => 0, maxTraceEntries: 0 });
    session.recordFrame(frameAt(0x7e0, [1], 0, "tx"));
    assert.equal(session.traceLength, 0);
    assert.deepEqual(session.snapshot().trace, []);
    assert.equal(session.entries.length, 0, "the cap is about the raw trace only");
  });

  test("traceFor an identifier that never appeared is empty, including id 0", () => {
    const session = new SessionLogger({ clock: () => 0 });
    session.recordFrame(frameAt(0x7e0, [1], 0, "tx"));
    assert.deepEqual(session.traceFor(0x7e8), []);
    assert.deepEqual(session.traceFor(0), []);
  });

  test("a frame without a timestamp falls back to the session clock", () => {
    let now = 7;
    const session = new SessionLogger({ clock: () => 7 });
    now = 99;
    void now;
    const entry = session.recordFrame(createFrame(0x123, new Uint8Array([1]), { timestamp: 0 }));
    assert.equal(
      entry.timestamp,
      new Date(7).toISOString(),
      '0 means "no timestamp", so the clock answers',
    );
    assert.equal(entry.t, 0, "and the time base of the session is the same clock reading");
  });
});

function traceStub() {
  return {
    timestamp: "2026-09-11T08:00:00.000Z",
    t: 0,
    canId: 0x7e8,
    canIdHex: "0x7E8",
    direction: "rx" as const,
    dlc: 2,
    payload: new Uint8Array([1, 2]),
    payloadHex: "0102",
    channel: "can0",
    extended: false,
    fd: false,
  };
}
