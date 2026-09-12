import assert from "node:assert/strict";
import { type VehicleSessionData, createSession } from "@vdp/core";
import type { AdapterInfo, TransportInfo } from "@vdp/transport-can";
import { test } from "vitest";
import { PdfDocument, buildReport, renderHtml, renderPdf, sanitize } from "./index.js";

const ADAPTER: AdapterInfo = {
  id: "virtual",
  kind: "virtual",
  name: "Virtual CAN",
  channels: ["vcan0"],
};
const TRANSPORT: TransportInfo = { kind: "can", channel: "vcan0", mtu: 8 };

function sampleSession(): VehicleSessionData {
  const data = createSession({
    adapter: ADAPTER,
    transport: TRANSPORT,
    id: "session_report",
    title: "Report test",
  });
  data.vehicle = {
    vin: "1HGCM82633A004352",
    brand: "Honda",
    model: "Accord",
    modelYear: 2003,
    vinAnalysis: {
      vin: "1HGCM82633A004352",
      wellFormed: true,
      checkDigit: "valid",
      checkDigitChar: "3",
      expectedCheckDigitChar: "3",
      wmi: "1HG",
      modelYearChar: "3",
      plantChar: "A",
      serial: "004352",
      notes: [],
    },
  };
  data.mileageKm = 187_450;
  data.ecus.push({
    id: "ecu_engine",
    name: "Engine Control Unit",
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
  data.actions.push({
    id: "a1",
    timestamp: "2026-09-10T12:00:00.000Z",
    kind: "read",
    ecuId: "ecu_engine",
    description: "Read DTCs",
    result: "success",
  });
  data.notes.push({
    id: "n1",
    timestamp: "2026-09-10T12:05:00.000Z",
    text: "Customer reports rough idle under load.",
  });
  return data;
}

test("the PDF starts with a valid header and ends with %%EOF", () => {
  const pdf = new PdfDocument();
  pdf.text("Hello", 40, 800);
  const bytes = pdf.toBytes();
  assert.equal(new TextDecoder().decode(bytes.subarray(0, 8)), "%PDF-1.4");
  const tail = new TextDecoder().decode(bytes.subarray(-8));
  assert.match(tail, /%%EOF/);
});

test("non-Latin-1 characters are mapped so byte offsets stay valid", () => {
  assert.equal(sanitize("100%"), "100%");
  assert.equal(sanitize("→"), "->");
  assert.equal(sanitize("日本"), "??");
  assert.equal(sanitize("°C"), "°C");
});

/** One char per byte, so string indices in these tests are byte offsets. */
const asLatin1 = (bytes: Uint8Array) => Array.from(bytes, (b) => String.fromCharCode(b)).join("");

const contains = (bytes: Uint8Array, sequence: number[]) => {
  for (let i = 0; i <= bytes.length - sequence.length; i += 1) {
    if (sequence.every((value, n) => bytes[i + n] === value)) return true;
  }
  return false;
};

test("report text is written as Latin-1, not UTF-8 (regression: mojibake)", () => {
  const doc = new PdfDocument();
  doc.text("Kühlmittel 90 °C", 40, 800);
  const bytes = doc.toBytes();
  // The fonts declare /WinAnsiEncoding, so one byte is one glyph. UTF-8 puts two
  // bytes there and a reader shows "KÃ¼hlmittel 90 Â°C" — measured 2026-09-12.
  assert.ok(contains(bytes, [0xfc]), "ü must be the single Latin-1 byte 0xFC");
  assert.ok(contains(bytes, [0xb0]), "° must be the single Latin-1 byte 0xB0");
  assert.ok(!contains(bytes, [0xc3, 0xbc]), "no UTF-8 sequence for ü");
  assert.ok(!contains(bytes, [0xc2, 0xb0]), "no UTF-8 sequence for °");
  // The binary header comment is four raw bytes above 127 by convention.
  assert.deepEqual([...bytes.subarray(9, 15)], [0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]);
});

test("stream lengths and xref offsets describe the bytes that are really there", () => {
  const doc = new PdfDocument();
  doc.text("Kühlmittel 90 °C · ≥ ≤ • €", 40, 800);
  doc.addPage();
  doc.text("zweite Seite", 40, 800);
  const text = asLatin1(doc.toBytes());

  const streams = [...text.matchAll(/\/Length (\d+) >>\nstream\n([\s\S]*?)\nendstream/g)];
  assert.ok(streams.length >= 2, "expected one content stream per page");
  for (const match of streams) {
    const declared = match[1];
    const body = match[2];
    assert.ok(declared !== undefined && body !== undefined, "both capture groups must match");
    assert.equal(
      Number(declared),
      body.length,
      "/Length must equal the bytes between stream and endstream",
    );
  }
  const startxref = Number(text.match(/startxref\n(\d+)/)?.[1] ?? "");
  assert.equal(
    text.slice(startxref, startxref + 4),
    "xref",
    "startxref must point at the xref table",
  );
  // Every in-use entry must point at the object it claims to describe.
  const entries = [...text.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
  assert.ok(entries.length >= 4, "expected an xref entry per object");
  entries.forEach((offset, index) => {
    assert.ok(
      text.startsWith(`${index + 1} 0 obj`, offset),
      `xref entry ${index + 1} must point at object ${index + 1}, found ` +
        `${JSON.stringify(text.slice(offset, offset + 12))}`,
    );
  });
});

test("sanitize maps the characters a diagnostic report really uses into Latin-1", () => {
  assert.equal(sanitize("→"), "->");
  assert.equal(sanitize("•"), "-");
  assert.equal(sanitize("≥"), ">=");
  assert.equal(sanitize("≤"), "<=");
  assert.equal(sanitize("€"), "EUR");
  assert.equal(sanitize("日本"), "??");
  // Nothing above Latin-1 may survive: that is the whole point of sanitize.
  for (const text of ["→", "•", "≥", "≤", "€", "日本", "90 °C", "Kühlmittel", "→ ≥ • € 日本"]) {
    for (const char of sanitize(text)) {
      assert.ok(
        (char.codePointAt(0) ?? 0) <= 0xff,
        `${JSON.stringify(text)} left a non-Latin-1 character`,
      );
    }
  }
});

test("multi-page documents list every page in the page tree", () => {
  const pdf = new PdfDocument();
  pdf.text("page 1", 40, 800);
  pdf.addPage();
  pdf.text("page 2", 40, 800);
  const bytes = new TextDecoder().decode(pdf.toBytes());
  assert.match(bytes, /\/Count 2/);
  assert.equal((bytes.match(/\/Type \/Page[^s]/g) ?? []).length, 2);
  assert.match(bytes, /Helvetica-Bold/, "bold font must be embedded as a resource");
});

test("report covers every section required by AGENTS 21", () => {
  const document = buildReport({
    session: sampleSession(),
    dtcs: [
      {
        code: "P0420",
        severity: "major",
        ecu: "Engine",
        description: "Catalyst efficiency below threshold",
        hint: "Check lambda sensors first.",
      },
    ],
  });
  const headings = document.sections.map((section) => section.heading);
  for (const required of [
    "Vehicle",
    "ECU overview",
    "DTC summary",
    "Measurements",
    "Anomalies",
    "Diagnostic actions",
    "Notes",
    "Recommendations",
  ]) {
    assert.ok(headings.includes(required), `missing section: ${required}`);
  }
  const vehicle = document.sections.find((section) => section.heading === "Vehicle");
  assert.ok(vehicle?.rows.some((row) => row.label === "VIN" && row.value === "1HGCM82633A004352"));
  assert.ok(vehicle?.rows.some((row) => row.label === "Mileage" && row.value.includes("187.450")));
});

test("the VIN can be masked for printed output (AGENTS 27)", () => {
  const document = buildReport({ session: sampleSession(), maskVin: true });
  const vehicle = document.sections.find((section) => section.heading === "Vehicle");
  const vinRow = vehicle?.rows.find((row) => row.label === "VIN");
  assert.ok(vinRow);
  assert.equal(vinRow.value, "1HG**********4352");
});

test("recommendations fall back to DTC hints when none are supplied", () => {
  const document = buildReport({
    session: sampleSession(),
    dtcs: [{ code: "P0300", severity: "critical", ecu: "Engine", hint: "Inspect ignition coils." }],
  });
  const recommendations = document.sections.find(
    (section) => section.heading === "Recommendations",
  );
  assert.ok(recommendations?.rows.some((row) => row.value.includes("Inspect ignition coils.")));
});

test("HTML rendering escapes untrusted text", () => {
  const session = sampleSession();
  session.notes.push({
    id: "n2",
    timestamp: "2026-09-10T12:06:00.000Z",
    text: '<script>alert("xss")</script>',
  });
  const html = renderHtml(buildReport({ session }));
  assert.ok(!html.includes("<script>alert"));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.match(html, /<!doctype html>/);
  assert.match(html, /<h2>DTC summary<\/h2>/);
});

test("PDF rendering produces a non-trivial document with tables", () => {
  const document = buildReport({
    session: sampleSession(),
    dtcs: [
      {
        code: "P0420",
        severity: "major",
        ecu: "Engine",
        description: "Catalyst efficiency below threshold",
      },
    ],
    statistics: [
      {
        signal: "engine.rpm",
        name: "Engine speed",
        unit: "rpm",
        samples: 30,
        min: 780,
        max: 4200,
        average: 2100,
        delta: 3420,
        first: 800,
        last: 900,
        outOfRangeCount: 0,
      },
    ],
    anomalies: [{ signal: "engine.rpm", reason: "delta 3420 is far above the median" }],
  });
  const bytes = renderPdf(document);
  assert.ok(bytes.length > 2000, `PDF looks too small: ${bytes.length}`);
  const text = new TextDecoder("latin1").decode(bytes);
  assert.match(text, /Vehicle Diagnostic Report/);
  assert.match(text, /DTC summary/);
  assert.match(text, /Engine speed/);
  assert.match(text, /trailer/);
  assert.match(text, /startxref/);
});

test("long reports paginate instead of overflowing the page", () => {
  const session = sampleSession();
  for (let i = 0; i < 80; i++) {
    session.notes.push({
      id: `n${i}`,
      timestamp: "2026-09-10T12:06:00.000Z",
      text: `Observation ${i}: the vehicle behaves differently when cold, especially at low RPM and high load.`,
    });
  }
  const bytes = renderPdf(buildReport({ session }));
  const text = new TextDecoder("latin1").decode(bytes);
  const count = Number(/\/Count (\d+)/.exec(text)?.[1] ?? "0");
  assert.ok(count >= 2, `expected pagination, got ${count} page(s)`);
});
