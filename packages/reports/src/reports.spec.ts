import assert from "node:assert/strict";
import {
  createSession,
  type DtcVariantKnowledge,
  type VehicleDetermination,
  type VehicleSessionData,
} from "@vdp/core";
import type { AdapterInfo, TransportInfo } from "@vdp/transport-can";
import { test } from "vitest";
import { buildReport, PdfDocument, renderHtml, renderPdf, sanitize } from "./index.js";

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

/**
 * Variant knowledge in the report (AGENTS 20.1, 21, 23, ADR 0026).
 *
 * The report used to print `code (ecu): inspect before further use` while the
 * package next to it documented the cause, its order and the window it is measurable
 * in — because the call site dropped the hint and no reader looked at the scan record
 * at all. These tests pin both halves, and pin the difference between "nothing
 * documented" and "not looked up".
 */

const BITS = {
  testFailed: true,
  testFailedThisOperationCycle: true,
  pendingDtc: false,
  confirmedDtc: true,
  testNotCompletedSinceLastClear: false,
  testFailedSinceLastClear: true,
  testNotCompletedThisOperationCycle: false,
  warningIndicatorRequested: false,
};

function sessionWithKnowledge(
  knowledge: DtcVariantKnowledge | undefined,
  code = "P0420",
  ecu = "Engine Control Unit",
): VehicleSessionData {
  const session = sampleSession();
  session.dtcSnapshots.push({
    id: "dtc_1",
    takenAt: "2026-09-10T12:00:00.000Z",
    label: "scan",
    records: [
      {
        code,
        raw: "042000",
        failureType: "00",
        status: 0x24,
        statusBits: BITS,
        severity: "major",
        description: "Catalyst efficiency below threshold",
        ecuName: ecu,
        ecuId: "ecu_engine",
        ...(knowledge === undefined ? {} : { knowledge }),
      },
    ],
  });
  return session;
}

type KnowledgePattern = DtcVariantKnowledge["patterns"][number];
type KnowledgeCheck = KnowledgePattern["checks"][number];

const LOAD_CHECK: KnowledgeCheck = {
  signal: "engine.load",
  signalName: "Engine load",
  expect: "steady",
  measurable: false,
};

const CAT_PATTERN: KnowledgePattern = {
  id: "aged-catalyst",
  name: "Ageing substrate loses storage capacity",
  explanation: "conversion drops at constant load while the trim stays inside limits",
  likelihood: "common",
  repair: "replace the catalytic converter",
  scope: "vehicle-engine",
  checks: [
    {
      signal: "cat.temp",
      signalName: "Catalyst temperature",
      expect: "above 600 while driving",
      min: 600,
      windowMs: 5000,
      measurable: true,
    },
    LOAD_CHECK,
  ],
};

const CAT_KNOWLEDGE: DtcVariantKnowledge = {
  scope: "vehicle-engine",
  vehicleId: "virtual-vehicle",
  conditions: "after three warm drives",
  patterns: [CAT_PATTERN],
  provenanceType: "own",
  provenanceSource: "simulator package",
  notes: ["no fuel-trim signal is defined in this package"],
};

test("the variant knowledge section quotes what the scan record carried", () => {
  const document = buildReport({
    session: sessionWithKnowledge(CAT_KNOWLEDGE),
    dtcs: [{ code: "P0420", severity: "major", ecu: "Engine Control Unit" }],
  });
  const section = document.sections.find((entry) => entry.heading === "Variant knowledge");
  assert.ok(section, "the section is part of the report order");
  const row = section.rows.find((entry) => entry.label === "P0420 · Engine Control Unit");
  assert.ok(row, JSON.stringify(section.rows));
  assert.match(row.value, /documented for this vehicle's engine/);
  assert.match(row.value, /sets when: after three warm drives/);
  assert.match(row.value, /documented cause \(common\): Ageing substrate loses storage capacity/);
  assert.match(row.value, /conversion drops at constant load/);
  assert.match(
    row.value,
    /measure first: Catalyst temperature · above 600 while driving · ≥ 600 · 5 s/,
  );
  assert.match(row.value, /repair hint \(unverified\): replace the catalytic converter/);
  assert.match(row.value, /source: simulator package/);
  assert.match(row.value, /open: no fuel-trim signal is defined in this package/);
  assert.equal(
    section.rows.find((entry) => entry.label === "Documented for")?.value,
    "1 of 1 listed code(s); codes without a row here have no statement in this package",
  );
});

test("a pattern without an evaluable check says so instead of pretending a measurement", () => {
  const manual: DtcVariantKnowledge = {
    scope: "vehicle-gearbox",
    patterns: [{ ...CAT_PATTERN, checks: [LOAD_CHECK] }],
    notes: [],
  };
  const document = buildReport({
    session: sessionWithKnowledge(manual),
    dtcs: [{ code: "P0420", severity: "major", ecu: "Engine Control Unit" }],
  });
  const section = document.sections.find((entry) => entry.heading === "Variant knowledge");
  assert.match(section?.rows[1]?.value ?? "", /no numeric window — judge by hand: Engine load/);

  const blind: DtcVariantKnowledge = {
    scope: "vehicle",
    patterns: [{ ...CAT_PATTERN, checks: [] }],
    notes: [],
  };
  const blindSection = buildReport({
    session: sessionWithKnowledge(blind),
    dtcs: [{ code: "P0420", severity: "major", ecu: "Engine Control Unit" }],
  }).sections.find((entry) => entry.heading === "Variant knowledge");
  assert.match(
    blindSection?.rows[1]?.value ?? "",
    /no measurement this package can evaluate for it/,
  );
});

test("manufacturer-wide wording is labelled as such, not as variant knowledge", () => {
  const packageWide: DtcVariantKnowledge = {
    scope: "package",
    patterns: [],
    notes: ["nothing variant-specific documented"],
  };
  const document = buildReport({
    session: sessionWithKnowledge(packageWide, "U0121"),
    dtcs: [{ code: "U0121", severity: "critical", ecu: "Engine Control Unit" }],
  });
  const section = document.sections.find((entry) => entry.heading === "Variant knowledge");
  const row = section?.rows.find((entry) => entry.label.startsWith("U0121"));
  assert.ok(row);
  assert.match(row.value, /manufacturer-wide wording only/);
  assert.match(row.value, /open: nothing variant-specific documented/);
  assert.equal(
    document.sections.find((entry) => entry.heading === "DTC summary")?.table?.rows[0]?.[4],
    "package",
    "the summary table names the scope of the wording it shows",
  );
});

test("the empty states stay distinguishable", () => {
  const rowsOf = (document: ReturnType<typeof buildReport>) =>
    document.sections.find((entry) => entry.heading === "Variant knowledge")?.rows ?? [];

  assert.match(
    rowsOf(buildReport({ session: sampleSession() }))[0]?.value ?? "",
    /this report lists no fault codes/,
  );
  assert.match(
    rowsOf(
      buildReport({
        session: sampleSession(),
        dtcs: [{ code: "P0420", severity: "major", ecu: "Engine" }],
      }),
    )[0]?.value ?? "",
    /no vehicle was determined, so only manufacturer-wide wording is available/,
  );

  const resolved = sessionWithKnowledge(undefined);
  resolved.determination = {
    resolvedAt: "2026-09-10T11:00:00.000Z",
    match: {
      oem: "simulator",
      packageVersion: "1.0.0",
      vehicleId: "virtual-vehicle",
      brand: "Virtual",
      model: "Simulator vehicle",
      score: 1,
      trust: 1,
      engineIds: [],
      gearboxIds: [],
      ecus: { expected: 3, matched: 3, missing: [] },
      evidence: [],
      conflicts: [],
    },
    notes: [],
    unexplained: [],
    alternatives: [],
  };
  assert.match(
    rowsOf(
      buildReport({
        session: resolved,
        dtcs: [{ code: "P0420", severity: "major", ecu: "Engine" }],
      }),
    )[0]?.value ?? "",
    /the resolved vehicle documents nothing about these codes/,
  );
});

test("the vehicle section says what was determined, and how far the evidence reached", () => {
  const determination: VehicleDetermination = {
    resolvedAt: "2026-09-10T11:00:00.000Z",
    match: {
      oem: "simulator",
      packageVersion: "1.0.0",
      vehicleId: "virtual-vehicle",
      brand: "Virtual",
      model: "Simulator vehicle",
      platform: "SIM-1",
      score: 0.8,
      trust: 0.6,
      provenanceType: "reverse-engineered",
      engineIds: ["sim-petrol"],
      gearboxIds: [],
      ecus: { expected: 3, matched: 2, missing: ["gearbox"] },
      evidence: [
        {
          kind: "part-number",
          observed: "A",
          expected: "A",
          weight: 4,
          reason: "part number matches",
        },
      ],
      conflicts: [
        {
          kind: "vin-wmi",
          observed: "WVW",
          expected: "1HG",
          weight: 3,
          reason: "another manufacturer",
        },
      ],
    },
    notes: [],
    unexplained: ["0x77b answered no definition"],
    alternatives: [{ vehicleId: "other", oem: "simulator", score: 0.3 }],
  };
  const session = sampleSession();
  session.determination = determination;
  const rows = buildReport({ session }).sections.find((e) => e.heading === "Vehicle")?.rows ?? [];
  const value = (label: string) => rows.find((row) => row.label === label)?.value ?? "";
  assert.match(value("Vehicle determination"), /Virtual Simulator vehicle — virtual-vehicle/);
  assert.match(value("Evidence"), /80 % of the evaluated criteria confirmed/);
  assert.match(value("Evidence"), /1 contradiction\(s\) kept visible: vin-wmi/);
  assert.match(value("Criteria"), /part-number \(4\)/);
  assert.match(value("Data trust"), /60 % · provenance reverse-engineered/);
  assert.match(value("Powertrain"), /engine sim-petrol/);
  assert.match(value("ECU coverage"), /2 of 3 declared ECUs answered; missing: gearbox/);
  assert.match(value("Other candidates"), /other \(30 %\)/);
  assert.equal(value("Resolved at"), "2026-09-10T11:00:00.000Z");

  const unresolved = sampleSession();
  unresolved.determination = {
    resolvedAt: "2026-09-10T11:00:00.000Z",
    reason: "no package declares vehicle definitions",
    notes: [],
    unexplained: [],
    alternatives: [],
  };
  assert.match(
    buildReport({ session: unresolved }).sections.find((e) => e.heading === "Vehicle")?.rows[7]
      ?.value ?? "",
    /unresolved: no package declares vehicle definitions/,
  );
  assert.match(
    buildReport({ session: sampleSession() }).sections.find((e) => e.heading === "Vehicle")?.rows[7]
      ?.value ?? "",
    /not resolved in this session/,
    "never asked and asked-without-result are different statements",
  );
});

test("recommendations quote the documented step, and keep the generic line where nothing is documented", () => {
  const values = (session: VehicleSessionData, hint?: string) =>
    buildReport({
      session,
      dtcs: [
        {
          code: "P0420",
          severity: "critical",
          ecu: "Engine Control Unit",
          ...(hint === undefined ? {} : { hint }),
        },
      ],
    })
      .sections.find((entry) => entry.heading === "Recommendations")
      ?.rows.map((row) => row.value) ?? [];

  const both = values(sessionWithKnowledge(CAT_KNOWLEDGE), "Rule out leaks first.");
  assert.match(both[0] ?? "", /Rule out leaks first\./);
  assert.match(both[0] ?? "", /measure first: Catalyst temperature/);

  const onlyPattern = values(
    sessionWithKnowledge({
      ...CAT_KNOWLEDGE,
      patterns: [{ ...CAT_PATTERN, checks: [] }],
    }),
  );
  assert.match(onlyPattern[0] ?? "", /before measuring: Ageing substrate loses storage capacity/);
  assert.ok(
    !(onlyPattern[0] ?? "").includes("inspect before further use"),
    "a documented cause is not the generic line",
  );

  const nothing = values(sessionWithKnowledge(undefined));
  assert.match(nothing[0] ?? "", /inspect before further use/);
});

test("the PDF fold covers the characters quoted text actually contains (ADR 0021)", () => {
  // Measured before these cases existed: a report line "45…55 km/h — Kühlung" was
  // written as "45?55 km/h ? Kühlung", and every absent value printed "?" instead of
  // the em dash the HTML shows.
  assert.equal(sanitize("…"), "...");
  assert.equal(sanitize("—"), "-");
  assert.equal(sanitize("–"), "-");
  assert.equal(sanitize("−"), "-");
  assert.equal(sanitize("45…55 km/h · ≥ 60 °C — Kühlung"), "45...55 km/h · >= 60 °C - Kühlung");

  const bytes = renderPdf(
    buildReport({
      session: sessionWithKnowledge(CAT_KNOWLEDGE),
      dtcs: [{ code: "P0420", severity: "critical", ecu: "Engine Control Unit" }],
    }),
  );
  const text = asLatin1(bytes);
  assert.ok(text.includes("measure first: Catalyst temperature"), "the row reaches the PDF");
  assert.ok(!text.includes("?"), "no question mark survives in a report of this data");
});

/**
 * The section a reader only notices when it is wrong: what this session cannot
 * prove (P0 #6, ADR 0037). A report without it reads as "0 anomalies, 0 open
 * findings" for a car whose ABS never answered.
 */
test("observations and gaps name what the session cannot prove", () => {
  const data = sampleSession();
  data.dtcSnapshots.push({
    id: "dtc_1",
    takenAt: "2026-09-10T12:04:00.000Z",
    records: [
      {
        code: "U0121",
        raw: "051200",
        failureType: "00",
        status: 0x09,
        statusBits: {
          testFailed: false,
          testFailedThisOperationCycle: false,
          pendingDtc: false,
          confirmedDtc: true,
          testNotCompletedSinceLastClear: false,
          testFailedSinceLastClear: false,
          testNotCompletedThisOperationCycle: false,
          warningIndicatorRequested: false,
        },
        severity: "info",
        ecuId: "ecu_engine",
        ecuName: "Engine Control Unit",
        evidence: "not proven (engine): no description, hint, severity or related signal",
      },
    ],
  });
  data.ecus.push({
    id: "ecu_abs",
    name: "ABS Module",
    protocol: "uds",
    txId: 0x7c0,
    rxId: 0x7c8,
    extended: false,
    identification: [],
    supportedServices: [],
    sessionType: 1,
    timing: { p2Ms: 50, p2StarMs: 5000 },
    reachable: false,
    lastError: "session request timed out",
  });
  const section = buildReport({ session: data }).sections.find(
    (entry) => entry.heading === "Observations & gaps",
  );
  assert.ok(section, "the section is part of every report");
  const reachability = section.rows.find((row) => row.label === "ECU reachability");
  assert.equal(reachability?.value, "1 of 2 answered — ABS Module: session request timed out");
  assert.match(
    section.rows.find((row) => row.label === "Reproducibility")?.value ?? "",
    /session session_report · .* definition not recorded/,
  );
  const questions = section.table?.rows ?? [];
  assert.deepEqual(
    questions.map((row) => row[0]),
    ["ECU unreachable", "code undocumented", "no scan to compare with", "no signal recorded"],
    "every open question is one row, in the order the session holds them",
  );
  assert.equal(
    questions[1]?.[2],
    "not proven (engine): no description, hint, severity or related signal",
  );
});

test("a session that measured everything says so without pretending to be certain", () => {
  const data = sampleSession();
  data.measurements.push({ signalId: "engine.rpm", name: "Engine speed", samples: 120 });
  data.dtcSnapshots.push(
    {
      id: "dtc_1",
      takenAt: "2026-09-10T12:04:00.000Z",
      records: [
        {
          code: "P0420",
          raw: "042000",
          failureType: "00",
          status: 0x28,
          statusBits: {
            testFailed: false,
            testFailedThisOperationCycle: false,
            pendingDtc: false,
            confirmedDtc: true,
            testNotCompletedSinceLastClear: false,
            testFailedSinceLastClear: true,
            testNotCompletedThisOperationCycle: false,
            warningIndicatorRequested: false,
          },
          severity: "major",
          ecuId: "ecu_engine",
          ecuName: "Engine Control Unit",
          description: "Catalyst efficiency below threshold",
        },
      ],
    },
    {
      id: "dtc_2",
      takenAt: "2026-09-10T12:06:00.000Z",
      records: [...(data.dtcSnapshots[0]?.records ?? [])],
    },
  );
  const section = buildReport({ session: data }).sections.find(
    (entry) => entry.heading === "Observations & gaps",
  );
  assert.equal(
    section?.rows.find((row) => row.label === "Open questions")?.value,
    "none — every ECU answered, every stored code is documented, signals were recorded",
  );
  assert.equal(
    section?.table,
    undefined,
    "no gaps means no table, not a table with one reassuring row",
  );
});
