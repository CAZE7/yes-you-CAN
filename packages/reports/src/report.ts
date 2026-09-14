/**
 * Diagnostic report builder (AGENTS 21).
 *
 * Sections follow the spec: vehicle, VIN, date, mileage, ECU overview, DTC
 * summary, measurement anomalies, sessions, notes, recommendations.
 * One builder produces a document model, which is rendered to HTML (screen) or
 * PDF (workshop handout) — content and presentation stay separate.
 */

import {
  type DtcVariantKnowledge,
  type SignalStatistics,
  type VehicleDetermination,
  type VehicleSessionData,
  describeVehicle,
  maskVin,
} from "@vdp/core";
import { PdfDocument } from "./pdf.js";

export interface ReportAnomaly {
  signal: string;
  reason: string;
  value?: number;
}

export interface ReportDtc {
  code: string;
  description?: string;
  severity: string;
  ecu: string;
  hint?: string;
}

export interface ReportInput {
  session: VehicleSessionData;
  dtcs?: readonly ReportDtc[];
  statistics?: readonly SignalStatistics[];
  anomalies?: readonly ReportAnomaly[];
  recommendations?: readonly string[];
  /** Hide the VIN in printed output (AGENTS 27: VIN handling must be deliberate). */
  maskVin?: boolean;
  workshop?: string;
  technician?: string;
}

export interface ReportSection {
  heading: string;
  rows: Array<{ label: string; value: string }>;
  table?: { columns: string[]; rows: string[][] };
}

export interface ReportDocument {
  title: string;
  subtitle: string;
  generatedAt: string;
  sections: ReportSection[];
}

export function buildReport(input: ReportInput): ReportDocument {
  const session = input.session;
  const dtcs = input.dtcs ?? [];
  const statistics = input.statistics ?? [];
  const anomalies = input.anomalies ?? [];
  // Variant knowledge is looked up in the session record rather than handed in: a
  // stored scan is the one place that says which variant a description was written
  // for, so a report built from a reopened session keeps that statement (ADR 0026).
  const knowledge = knowledgeIndex(session);
  const recommendations =
    input.recommendations ?? defaultRecommendations(dtcs, anomalies, knowledge);

  return {
    title: "Vehicle Diagnostic Report",
    subtitle: `${describeVehicle(session.vehicle)} · ${session.startedAt}`,
    generatedAt: new Date().toISOString(),
    // The section order is the AGENTS 21 report order — vehicle first, findings
    // in the middle, what to do next last, because that is the order a workshop
    // reads a handout in.
    sections: [
      vehicleSection(input),
      transportSection(session),
      ecuOverviewSection(session),
      dtcSummarySection(dtcs, knowledge),
      variantKnowledgeSection(dtcs, knowledge, session.determination),
      measurementsSection(statistics),
      anomalySection(anomalies),
      actionSection(session),
      noteSection(session),
      recommendationSection(recommendations),
    ],
  };
}

/** Vehicle, VIN (masked on request, AGENTS 27), model year, mileage and session window. */
function vehicleSection(input: ReportInput): ReportSection {
  const session = input.session;
  const analysis = session.vehicle?.vinAnalysis;
  return {
    heading: "Vehicle",
    rows: [
      { label: "Vehicle", value: describeVehicle(session.vehicle) },
      {
        label: "VIN",
        value: input.maskVin ? maskVin(session.vehicle?.vin) : (session.vehicle?.vin ?? "—"),
      },
      {
        label: "VIN check digit",
        value: analysis
          ? `${analysis.checkDigit} (expected ${analysis.expectedCheckDigitChar || "—"})`
          : "—",
      },
      {
        label: "Model year",
        value: session.vehicle?.modelYear ? String(session.vehicle.modelYear) : "—",
      },
      {
        label: "Mileage",
        value:
          session.mileageKm !== undefined ? `${session.mileageKm.toLocaleString("de-DE")} km` : "—",
      },
      { label: "Session started", value: session.startedAt },
      { label: "Session ended", value: session.endedAt ?? "still open" },
      ...determinationRows(session.determination),
      ...(input.workshop ? [{ label: "Workshop", value: input.workshop }] : []),
      ...(input.technician ? [{ label: "Technician", value: input.technician }] : []),
    ],
  };
}

/** Which adapter and transport produced the data, and which definition version interpreted it. */
function transportSection(session: VehicleSessionData): ReportSection {
  return {
    heading: "Adapter and transport",
    rows: [
      { label: "Adapter", value: `${session.adapter.name} (${session.adapter.id})` },
      {
        label: "Transport",
        value: `${session.transport.kind} on ${session.transport.channel}, MTU ${session.transport.mtu}`,
      },
      {
        label: "Definition package",
        value: session.definitionPackage
          ? `${session.definitionPackage.oem} v${session.definitionPackage.version}`
          : "none",
      },
    ],
  };
}

/** ECU explorer summary: one row per ECU plus the identification table (AGENTS 12). */
function ecuOverviewSection(session: VehicleSessionData): ReportSection {
  return {
    heading: "ECU overview",
    rows: session.ecus.map((ecu) => ({
      label: `${ecu.name} (0x${ecu.txId.toString(16)} → 0x${ecu.rxId.toString(16)})`,
      value: ecu.reachable
        ? `reachable, ${ecu.identification.length} identification values, P2 ${ecu.timing.p2Ms} ms`
        : `not reachable${ecu.lastError ? `: ${ecu.lastError}` : ""}`,
    })),
    table: {
      columns: ["ECU", "Protocol", "Identification", "DTCs"],
      rows: session.ecus.map((ecu) => [
        ecu.name,
        ecu.protocol,
        ecu.identification.map((entry) => `${entry.label}: ${entry.value}`).join("; ") || "—",
        String(ecu.dtcs?.length ?? 0),
      ]),
    },
  };
}

/** Fault counts per severity plus the code list (AGENTS 20/21). */
function dtcSummarySection(
  dtcs: readonly ReportDtc[],
  knowledge: Map<string, DtcVariantKnowledge>,
): ReportSection {
  const severityCount = (severity: string): number =>
    dtcs.filter((dtc) => dtc.severity === severity).length;
  return {
    heading: "DTC summary",
    rows: [
      { label: "Total", value: String(dtcs.length) },
      { label: "Critical", value: String(severityCount("critical")) },
      { label: "Major", value: String(severityCount("major")) },
      { label: "Minor", value: String(severityCount("minor")) },
      { label: "Info", value: String(severityCount("info")) },
    ],
    table: {
      // "Knowledge" is the scope of the wording, so a reader can tell a variant
      // statement from a manufacturer-wide one without opening another section.
      columns: ["Code", "Severity", "ECU", "Description", "Knowledge"],
      rows: dtcs.map((dtc) => [
        dtc.code,
        dtc.severity,
        dtc.ecu,
        dtc.description ?? "—",
        knowledgeFor(knowledge, dtc)?.scope ?? "—",
      ]),
    },
  };
}

/**
 * Which vehicle this report speaks about, and how far the evidence reached
 * (AGENTS 11.1, ADR 0026).
 *
 * Three states are kept apart on purpose: never determined, determined as
 * unresolved (a provider answered "nothing matched", with its reason) and matched
 * (with score, contradictions and provenance). Collapsing them would let a missing
 * lookup read as a proven negative.
 */
function determinationRows(
  determination: VehicleDetermination | undefined,
): Array<{ label: string; value: string }> {
  if (determination === undefined) {
    return [{ label: "Vehicle determination", value: "not resolved in this session" }];
  }
  const match = determination.match;
  if (match === undefined) {
    return [
      {
        label: "Vehicle determination",
        value: `unresolved: ${determination.reason ?? "no candidate had positive evidence"}`,
      },
      { label: "Resolved at", value: determination.resolvedAt },
    ];
  }
  const percent = Math.round(match.score * 100);
  const powertrain = [
    match.engineIds.length > 0 ? `engine ${match.engineIds.join("/")}` : undefined,
    match.gearboxIds.length > 0 ? `gearbox ${match.gearboxIds.join("/")}` : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join(", ");
  const coverage = `${match.ecus.matched} of ${match.ecus.expected} declared ECUs answered`;
  return [
    {
      label: "Vehicle determination",
      value: `${match.brand} ${match.model} — ${match.vehicleId} (package ${match.oem} v${match.packageVersion})`,
    },
    {
      label: "Evidence",
      value:
        `${percent} % of the evaluated criteria confirmed` +
        (match.conflicts.length > 0
          ? ` · ${match.conflicts.length} contradiction(s) kept visible: ${match.conflicts
              .map((entry) => entry.kind)
              .join(", ")}`
          : " · no contradictions"),
    },
    {
      label: "Criteria",
      value: match.evidence.map((entry) => `${entry.kind} (${entry.weight})`).join(", "),
    },
    {
      label: "Data trust",
      value: `${Math.round(match.trust * 100)} %${match.provenanceType ? ` · provenance ${match.provenanceType}` : ""}`,
    },
    { label: "Powertrain", value: powertrain.length > 0 ? powertrain : "not narrowed" },
    {
      label: "ECU coverage",
      value:
        match.ecus.missing.length > 0
          ? `${coverage}; missing: ${match.ecus.missing.join(", ")}`
          : coverage,
    },
    {
      label: "Other candidates",
      value:
        determination.alternatives.length > 0
          ? determination.alternatives
              .map((alt) => `${alt.vehicleId} (${Math.round(alt.score * 100)} %)`)
              .join(", ")
          : "none — no second candidate had positive evidence",
    },
    { label: "Resolved at", value: determination.resolvedAt },
  ];
}

/** Where a description came from, said in the report's own words (AGENTS 24). */
function scopeSentence(knowledge: DtcVariantKnowledge): string {
  switch (knowledge.scope) {
    case "vehicle-engine":
      return "documented for this vehicle's engine";
    case "vehicle-gearbox":
      return "documented for this vehicle's gearbox";
    case "vehicle":
      return "documented for this vehicle";
    default:
      return "manufacturer-wide wording only — nothing variant-specific is documented";
  }
}

/**
 * One check as a sentence: what to look at, what it must show, and for how long.
 *
 * `min`/`max` alone are written as bounds (`≥ 90`, `≤ 5`), both together as a range
 * (`45…55`). Deliberately no infinity sign: a report is also printed as a PDF, and
 * every character outside Latin-1 that has no fold in `pdf.ts` becomes a question
 * mark on paper (ADR 0021, AGENTS 24).
 */
function windowOf(check: DtcVariantKnowledge["patterns"][number]["checks"][number]): string {
  const bounds =
    check.min !== undefined && check.max !== undefined
      ? `${check.min}…${check.max}`
      : check.min !== undefined
        ? `≥ ${check.min}`
        : check.max !== undefined
          ? `≤ ${check.max}`
          : undefined;
  return [
    check.signalName || check.signal,
    check.expect,
    bounds,
    check.windowMs !== undefined ? `${check.windowMs / 1000} s` : undefined,
  ]
    .filter((part): part is string => part !== undefined && part !== "")
    .join(" · ");
}

/** One fault-memory read, indexed by code and by the ECU that reported it. */
function knowledgeIndex(session: VehicleSessionData): Map<string, DtcVariantKnowledge> {
  const index = new Map<string, DtcVariantKnowledge>();
  for (const record of session.dtcSnapshots.at(-1)?.records ?? []) {
    if (record.knowledge === undefined) continue;
    const code = record.code.trim().toUpperCase();
    index.set(`${code}|${record.ecuName ?? ""}`, record.knowledge);
    if (!index.has(`${code}|`)) index.set(`${code}|`, record.knowledge);
  }
  return index;
}

function knowledgeFor(
  index: Map<string, DtcVariantKnowledge>,
  dtc: ReportDtc,
): DtcVariantKnowledge | undefined {
  const code = dtc.code.trim().toUpperCase();
  return index.get(`${code}|${dtc.ecu}`) ?? index.get(`${code}|`);
}

/**
 * What the resolved variant documents about each code (§20.1, §23).
 *
 * One row per code that has a statement, in the order a technician works: what the
 * scope of the wording is, when the code sets, which cause is documented first, what
 * to measure to decide it, and what is still open. A repair sentence stays labelled as
 * a hint (§24), and a check without a numeric window says that a person has to judge.
 */
function variantKnowledgeSection(
  dtcs: readonly ReportDtc[],
  index: Map<string, DtcVariantKnowledge>,
  determination: VehicleDetermination | undefined,
): ReportSection {
  const rows: Array<{ label: string; value: string }> = [];
  let documented = 0;
  for (const dtc of dtcs) {
    const knowledge = knowledgeFor(index, dtc);
    if (knowledge === undefined) continue;
    documented += 1;
    const parts: string[] = [scopeSentence(knowledge)];
    if (knowledge.conditions !== undefined) parts.push(`sets when: ${knowledge.conditions}`);
    const pattern = knowledge.patterns[0];
    if (pattern !== undefined) {
      parts.push(
        `documented cause (${pattern.likelihood ?? "no likelihood stated"}): ${pattern.name}`,
      );
      if (pattern.explanation !== undefined) parts.push(pattern.explanation);
      const measurable = pattern.checks.find((check) => check.measurable);
      const manual = pattern.checks.find((check) => !check.measurable);
      if (measurable !== undefined) parts.push(`measure first: ${windowOf(measurable)}`);
      else if (manual !== undefined)
        parts.push(`no numeric window — judge by hand: ${manual.signalName || manual.signal}`);
      else parts.push("no measurement this package can evaluate for it");
      if (pattern.repair !== undefined) parts.push(`repair hint (unverified): ${pattern.repair}`);
    }
    if (knowledge.provenanceType !== undefined) {
      parts.push(`source: ${knowledge.provenanceSource ?? knowledge.provenanceType}`);
    }
    if (knowledge.notes.length > 0) parts.push(`open: ${knowledge.notes.join("; ")}`);
    rows.push({ label: `${dtc.code} · ${dtc.ecu}`, value: parts.join(" · ") });
  }
  if (rows.length === 0) {
    const reason =
      dtcs.length === 0
        ? "this report lists no fault codes"
        : determination?.match === undefined
          ? "no vehicle was determined, so only manufacturer-wide wording is available"
          : "the resolved vehicle documents nothing about these codes";
    rows.push({ label: "Variant knowledge", value: `none — ${reason}` });
    return { heading: "Variant knowledge", rows };
  }
  rows.unshift({
    label: "Documented for",
    value: `${documented} of ${dtcs.length} listed code(s); codes without a row here have no statement in this package`,
  });
  return { heading: "Variant knowledge", rows };
}

/** Min/max/average/delta per recorded signal (AGENTS 16 statistics). */
function measurementsSection(statistics: readonly SignalStatistics[]): ReportSection {
  return {
    heading: "Measurements",
    rows: [
      { label: "Signals recorded", value: String(statistics.length) },
      { label: "Samples", value: String(statistics.reduce((sum, stat) => sum + stat.samples, 0)) },
    ],
    table: {
      columns: ["Signal", "Min", "Max", "Average", "Delta", "Unit"],
      rows: statistics.map((stat) => [
        stat.name,
        formatNumber(stat.min),
        formatNumber(stat.max),
        formatNumber(stat.average),
        formatNumber(stat.delta),
        stat.unit ?? "",
      ]),
    },
  };
}

/** "Nothing found" is a result of its own — an empty section must not read as an omission. */
function anomalySection(anomalies: readonly ReportAnomaly[]): ReportSection {
  return {
    heading: "Anomalies",
    rows:
      anomalies.length === 0
        ? [{ label: "Result", value: "no anomalies detected in the recorded window" }]
        : anomalies.map((anomaly) => ({ label: anomaly.signal, value: anomaly.reason })),
  };
}

/** Audit log of everything this session wrote (AGENTS 25). */
function actionSection(session: VehicleSessionData): ReportSection {
  return {
    heading: "Diagnostic actions",
    rows:
      session.actions.length === 0
        ? [{ label: "Result", value: "read-only session — no write actions performed" }]
        : session.actions.map((action) => ({
            label: `${action.timestamp} · ${action.kind} · ${action.ecuId}`,
            value: `${action.description} → ${action.result}${action.detail ? ` (${action.detail})` : ""}`,
          })),
  };
}

function noteSection(session: VehicleSessionData): ReportSection {
  return {
    heading: "Notes",
    rows:
      session.notes.length === 0
        ? [{ label: "Result", value: "—" }]
        : session.notes.map((note) => ({ label: note.timestamp, value: note.text })),
  };
}

function recommendationSection(recommendations: readonly string[]): ReportSection {
  return {
    heading: "Recommendations",
    rows:
      recommendations.length === 0
        ? [{ label: "Result", value: "no recommendations" }]
        : recommendations.map((recommendation, index) => ({
            label: String(index + 1),
            value: recommendation,
          })),
  };
}

function defaultRecommendations(
  dtcs: readonly ReportDtc[],
  anomalies: readonly ReportAnomaly[],
  knowledge: Map<string, DtcVariantKnowledge>,
): string[] {
  const recommendations: string[] = [];
  for (const dtc of dtcs.filter((d) => d.severity === "critical").slice(0, 5)) {
    // The documented first step wins over the generic one, but only where the
    // package actually states it: an invented order would be a diagnosis.
    const step = firstStep(knowledgeFor(knowledge, dtc));
    const advice = [dtc.hint, step].filter((part): part is string => part !== undefined);
    recommendations.push(
      `${dtc.code} (${dtc.ecu}): ${advice.length > 0 ? advice.join(" — ") : "inspect before further use"}`,
    );
  }
  for (const anomaly of anomalies.slice(0, 5)) {
    recommendations.push(`${anomaly.signal}: ${anomaly.reason}`);
  }
  if (recommendations.length === 0)
    recommendations.push(
      "No critical findings. Repeat the measurement under load if a fault is intermittent.",
    );
  return recommendations;
}

/**
 * The measuring step a package documents for one code, if it documents any.
 *
 * `undefined` is the honest answer for a code nobody described for this variant —
 * the caller then keeps the generic wording instead of inventing a sequence.
 */
function firstStep(knowledge: DtcVariantKnowledge | undefined): string | undefined {
  const pattern = knowledge?.patterns[0];
  if (pattern === undefined) return undefined;
  const measurable = pattern.checks.find((check) => check.measurable);
  if (measurable !== undefined) return `measure first: ${windowOf(measurable)}`;
  // A pattern without an evaluable check still says what a person should do; that is
  // a step, but not a measurement, and the text has to keep the difference.
  return `before measuring: ${pattern.name}`;
}

function formatNumber(value: number | null): string {
  if (value === null) return "—";
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

/** Render to a self-contained HTML document. */
export function renderHtml(document: ReportDocument): string {
  const escapeHtml = (text: string): string =>
    text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  const sections = document.sections
    .map((section) => {
      const rows = section.rows
        .map((row) => `<tr><th>${escapeHtml(row.label)}</th><td>${escapeHtml(row.value)}</td></tr>`)
        .join("\n");
      const table = section.table
        ? `<table class="grid"><thead><tr>${section.table.columns.map((column) => `<th>${escapeHtml(column)}</th>`).join("")}</tr></thead><tbody>${section.table.rows
            .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`)
            .join("")}</tbody></table>`
        : "";
      return `<section><h2>${escapeHtml(section.heading)}</h2><table class="kv"><tbody>${rows}</tbody></table>${table}</section>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(document.title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.5 system-ui, sans-serif; margin: 2rem auto; max-width: 960px; padding: 0 1rem; }
  h1 { margin-bottom: 0.25rem; }
  h2 { margin-top: 2rem; border-bottom: 1px solid #8884; padding-bottom: 0.25rem; }
  .subtitle { opacity: 0.75; }
  table { border-collapse: collapse; width: 100%; margin-top: 0.5rem; }
  th, td { text-align: left; padding: 0.35rem 0.5rem; border-bottom: 1px solid #8883; vertical-align: top; }
  table.kv th { width: 32%; font-weight: 600; }
  table.grid th { background: #8881; }
  footer { margin-top: 2rem; opacity: 0.6; font-size: 12px; }
</style>
</head>
<body>
<h1>${escapeHtml(document.title)}</h1>
<p class="subtitle">${escapeHtml(document.subtitle)}</p>
${sections}
<footer>Generated ${escapeHtml(document.generatedAt)} · yes-you-CAN diagnostics platform</footer>
</body>
</html>
`;
}

/** Render to PDF using the built-in writer. */
export function renderPdf(document: ReportDocument): Uint8Array {
  const pdf = new PdfDocument();
  const margin = 42;
  const pageWidth = pdf.width;
  const contentWidth = pageWidth - margin * 2;
  let y = pdf.height - margin;

  const ensureSpace = (needed: number): void => {
    if (y - needed < margin) {
      pdf.addPage();
      y = pdf.height - margin;
    }
  };

  pdf.text(document.title, margin, y - 14, { fontSize: 20, bold: true });
  y -= 34;
  pdf.text(document.subtitle, margin, y, { fontSize: 11 });
  y -= 18;
  pdf.text(`Generated ${document.generatedAt}`, margin, y, { fontSize: 9, color: [0.4, 0.4, 0.4] });
  y -= 26;

  for (const section of document.sections) {
    ensureSpace(60);
    pdf.text(section.heading, margin, y, { fontSize: 14, bold: true });
    y -= 6;
    pdf.rect(margin, y, contentWidth, 1, [0.5, 0.5, 0.5]);
    y -= 14;

    for (const row of section.rows) {
      const lines = Math.max(1, Math.ceil((row.value.length * 5.4) / (contentWidth * 0.62)));
      ensureSpace(lines * 13 + 4);
      pdf.text(truncate(row.label, 44), margin, y, { fontSize: 9, bold: true });
      const wrapped = wrap(row.value, 88);
      wrapped.forEach((part, index) => {
        pdf.text(part, margin + 150, y - index * 12, { fontSize: 9 });
      });
      y -= Math.max(wrapped.length, 1) * 12 + 2;
    }

    if (section.table && section.table.rows.length > 0) {
      ensureSpace(30);
      y -= 6;
      const columnWidth = contentWidth / section.table.columns.length;
      section.table.columns.forEach((column, index) => {
        pdf.text(truncate(column, 20), margin + index * columnWidth, y, {
          fontSize: 9,
          bold: true,
        });
      });
      y -= 12;
      for (const row of section.table.rows) {
        ensureSpace(14);
        row.forEach((cell, index) => {
          pdf.text(truncate(cell, Math.floor(columnWidth / 5)), margin + index * columnWidth, y, {
            fontSize: 8.5,
          });
        });
        y -= 11;
      }
    }
    y -= 14;
  }

  pdf.text("yes-you-CAN diagnostics platform", margin, margin, {
    fontSize: 8,
    color: [0.5, 0.5, 0.5],
  });
  return pdf.toBytes();
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…`.replace("…", "-") : text;
}

function wrap(text: string, width: number): string[] {
  if (text.length <= width) return [text];
  const words = text.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (current.length + word.length + 1 > width) {
      if (current) lines.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(current);
  return lines;
}
