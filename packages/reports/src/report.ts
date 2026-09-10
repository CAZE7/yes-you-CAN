/**
 * Diagnostic report builder (AGENTS 21).
 *
 * Sections follow the spec: vehicle, VIN, date, mileage, ECU overview, DTC
 * summary, measurement anomalies, sessions, notes, recommendations.
 * One builder produces a document model, which is rendered to HTML (screen) or
 * PDF (workshop handout) — content and presentation stay separate.
 */

import { describeVehicle, maskVin, type VehicleSessionData } from '@vdp/core';
import type { SignalStatistics } from '@vdp/core';
import { PdfDocument } from './pdf.js';

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
  const vin = input.maskVin ? maskVin(session.vehicle?.vin) : (session.vehicle?.vin ?? '—');
  const sections: ReportSection[] = [];

  sections.push({
    heading: 'Vehicle',
    rows: [
      { label: 'Vehicle', value: describeVehicle(session.vehicle) },
      { label: 'VIN', value: vin },
      { label: 'VIN check digit', value: session.vehicle?.vinAnalysis ? `${session.vehicle.vinAnalysis.checkDigit} (expected ${session.vehicle.vinAnalysis.expectedCheckDigitChar || '—'})` : '—' },
      { label: 'Model year', value: session.vehicle?.modelYear ? String(session.vehicle.modelYear) : '—' },
      { label: 'Mileage', value: session.mileageKm !== undefined ? `${session.mileageKm.toLocaleString('de-DE')} km` : '—' },
      { label: 'Session started', value: session.startedAt },
      { label: 'Session ended', value: session.endedAt ?? 'still open' },
      ...(input.workshop ? [{ label: 'Workshop', value: input.workshop }] : []),
      ...(input.technician ? [{ label: 'Technician', value: input.technician }] : []),
    ],
  });

  sections.push({
    heading: 'Adapter and transport',
    rows: [
      { label: 'Adapter', value: `${session.adapter.name} (${session.adapter.id})` },
      { label: 'Transport', value: `${session.transport.kind} on ${session.transport.channel}, MTU ${session.transport.mtu}` },
      { label: 'Definition package', value: session.definitionPackage ? `${session.definitionPackage.oem} v${session.definitionPackage.version}` : 'none' },
    ],
  });

  sections.push({
    heading: 'ECU overview',
    rows: session.ecus.map((ecu) => ({
      label: `${ecu.name} (0x${ecu.txId.toString(16)} → 0x${ecu.rxId.toString(16)})`,
      value: ecu.reachable ? `reachable, ${ecu.identification.length} identification values, P2 ${ecu.timing.p2Ms} ms` : `not reachable${ecu.lastError ? `: ${ecu.lastError}` : ''}`,
    })),
    table: {
      columns: ['ECU', 'Protocol', 'Identification', 'DTCs'],
      rows: session.ecus.map((ecu) => [
        ecu.name,
        ecu.protocol,
        ecu.identification.map((entry) => `${entry.label}: ${entry.value}`).join('; ') || '—',
        String(ecu.dtcs?.length ?? 0),
      ]),
    },
  });

  const dtcs = input.dtcs ?? [];
  const severityCount = (severity: string): number => dtcs.filter((dtc) => dtc.severity === severity).length;
  sections.push({
    heading: 'DTC summary',
    rows: [
      { label: 'Total', value: String(dtcs.length) },
      { label: 'Critical', value: String(severityCount('critical')) },
      { label: 'Major', value: String(severityCount('major')) },
      { label: 'Minor', value: String(severityCount('minor')) },
      { label: 'Info', value: String(severityCount('info')) },
    ],
    table: {
      columns: ['Code', 'Severity', 'ECU', 'Description'],
      rows: dtcs.map((dtc) => [dtc.code, dtc.severity, dtc.ecu, dtc.description ?? '—']),
    },
  });

  const statistics = input.statistics ?? [];
  sections.push({
    heading: 'Measurements',
    rows: [
      { label: 'Signals recorded', value: String(statistics.length) },
      { label: 'Samples', value: String(statistics.reduce((sum, stat) => sum + stat.samples, 0)) },
    ],
    table: {
      columns: ['Signal', 'Min', 'Max', 'Average', 'Delta', 'Unit'],
      rows: statistics.map((stat) => [
        stat.name,
        formatNumber(stat.min),
        formatNumber(stat.max),
        formatNumber(stat.average),
        formatNumber(stat.delta),
        stat.unit ?? '',
      ]),
    },
  });

  const anomalies = input.anomalies ?? [];
  sections.push({
    heading: 'Anomalies',
    rows:
      anomalies.length === 0
        ? [{ label: 'Result', value: 'no anomalies detected in the recorded window' }]
        : anomalies.map((anomaly) => ({ label: anomaly.signal, value: anomaly.reason })),
  });

  sections.push({
    heading: 'Diagnostic actions',
    rows: session.actions.length === 0
      ? [{ label: 'Result', value: 'read-only session — no write actions performed' }]
      : session.actions.map((action) => ({
          label: `${action.timestamp} · ${action.kind} · ${action.ecuId}`,
          value: `${action.description} → ${action.result}${action.detail ? ` (${action.detail})` : ''}`,
        })),
  });

  sections.push({
    heading: 'Notes',
    rows: session.notes.length === 0
      ? [{ label: 'Result', value: '—' }]
      : session.notes.map((note) => ({ label: note.timestamp, value: note.text })),
  });

  const recommendations = input.recommendations ?? defaultRecommendations(dtcs, anomalies);
  sections.push({
    heading: 'Recommendations',
    rows: recommendations.length === 0
      ? [{ label: 'Result', value: 'no recommendations' }]
      : recommendations.map((recommendation, index) => ({ label: String(index + 1), value: recommendation })),
  });

  return {
    title: 'Vehicle Diagnostic Report',
    subtitle: `${describeVehicle(session.vehicle)} · ${session.startedAt}`,
    generatedAt: new Date().toISOString(),
    sections,
  };
}

function defaultRecommendations(dtcs: readonly ReportDtc[], anomalies: readonly ReportAnomaly[]): string[] {
  const recommendations: string[] = [];
  for (const dtc of dtcs.filter((d) => d.severity === 'critical').slice(0, 5)) {
    recommendations.push(`${dtc.code} (${dtc.ecu}): ${dtc.hint ?? 'inspect before further use'}`);
  }
  for (const anomaly of anomalies.slice(0, 5)) {
    recommendations.push(`${anomaly.signal}: ${anomaly.reason}`);
  }
  if (recommendations.length === 0) recommendations.push('No critical findings. Repeat the measurement under load if a fault is intermittent.');
  return recommendations;
}

function formatNumber(value: number | null): string {
  if (value === null) return '—';
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

/** Render to a self-contained HTML document. */
export function renderHtml(document: ReportDocument): string {
  const escape = (text: string): string =>
    text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const sections = document.sections
    .map((section) => {
      const rows = section.rows
        .map((row) => `<tr><th>${escape(row.label)}</th><td>${escape(row.value)}</td></tr>`)
        .join('\n');
      const table = section.table
        ? `<table class="grid"><thead><tr>${section.table.columns.map((column) => `<th>${escape(column)}</th>`).join('')}</tr></thead><tbody>${section.table.rows
            .map((row) => `<tr>${row.map((cell) => `<td>${escape(cell)}</td>`).join('')}</tr>`)
            .join('')}</tbody></table>`
        : '';
      return `<section><h2>${escape(section.heading)}</h2><table class="kv"><tbody>${rows}</tbody></table>${table}</section>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escape(document.title)}</title>
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
<h1>${escape(document.title)}</h1>
<p class="subtitle">${escape(document.subtitle)}</p>
${sections}
<footer>Generated ${escape(document.generatedAt)} · yes-you-CAN diagnostics platform</footer>
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
        pdf.text(truncate(column, 20), margin + index * columnWidth, y, { fontSize: 9, bold: true });
      });
      y -= 12;
      for (const row of section.table.rows) {
        ensureSpace(14);
        row.forEach((cell, index) => {
          pdf.text(truncate(cell, Math.floor(columnWidth / 5)), margin + index * columnWidth, y, { fontSize: 8.5 });
        });
        y -= 11;
      }
    }
    y -= 14;
  }

  pdf.text('yes-you-CAN diagnostics platform', margin, margin, { fontSize: 8, color: [0.5, 0.5, 0.5] });
  return pdf.toBytes();
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…`.replace('…', '-') : text;
}

function wrap(text: string, width: number): string[] {
  if (text.length <= width) return [text];
  const words = text.split(' ');
  const lines: string[] = [];
  let current = '';
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
