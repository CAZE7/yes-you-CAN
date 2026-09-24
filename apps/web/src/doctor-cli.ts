/**
 * `--doctor` — the adapter pre-flight check on the command line (AGENTS 29).
 *
 * Extracted from server.ts: the CLI text of the doctor is its own surface
 * (hardware-day checklist output), and keeping it out of the HTTP server is
 * what lets the server stay below its size budget while the doctor talks
 * (E15: presentation leaves backend.ts; same seam, one level up).
 *
 * Exit codes mirror the harvest CLI (tools/harvest): 0 ready · 2 usage · 3
 * adapter needs attention.
 */

import {
  type AdapterCatalog,
  type AdapterDoctorReport,
  type AdapterSelection,
  formatAdapterHelp,
  parseAdapterArgv,
  runAdapterDoctor,
} from "@vdp/adapter-host";
import { type Logger, messageOf } from "@vdp/shared";

export const DOCTOR_EXIT = {
  ready: 0,
  usage: 2,
  attention: 3,
} as const;

const ICONS: Record<string, string> = { ok: "✓", warn: "⚠", fail: "✗", skip: "–" };

const VERDICTS: Record<AdapterDoctorReport["verdict"], string> = {
  ready: "bereit — verbinden",
  "needs-attention": "Aufmerksamkeit nötig (siehe ✗/⚠-Schritte)",
  blocked: "blockiert — Einstellungen prüfen",
};

/** The whole doctor result as CLI text — pure, so the wording has its own test. */
export function formatDoctorReport(report: AdapterDoctorReport): string {
  const lines: string[] = [`Adapter-Doctor: ${report.adapterId}`];
  for (const s of report.steps) {
    lines.push(`  ${ICONS[s.status] ?? "?"} ${s.label}: ${s.detail}`);
    for (const hint of s.hints ?? []) lines.push(`      → ${hint}`);
  }
  lines.push("");
  lines.push(VERDICTS[report.verdict] ?? report.verdict);
  return `${lines.join("\n")}\n`;
}

export interface DoctorCliDeps {
  catalog: AdapterCatalog;
  logger?: Logger;
  /** Where the report text goes (tests capture it). */
  write?: (text: string) => void;
  /** Doctor implementation override (tests inject a scripted report). */
  runDoctor?: typeof runAdapterDoctor;
}

/**
 * Run the doctor for the adapter flags in `argv`.
 * Returns the exit code instead of calling process.exit — one level up owns
 * that; a function that can be driven without a process is a function that
 * can be tested (0.E E17 names this class of proof).
 */
export async function runDoctorCli(argv: readonly string[], deps: DoctorCliDeps): Promise<number> {
  const write = deps.write ?? ((text: string) => process.stdout.write(text));
  const catalog = deps.catalog;
  let selection: AdapterSelection;
  try {
    const parsed = parseAdapterArgv(argv);
    if (parsed.errors.length > 0) {
      process.stderr.write(`${parsed.errors.join("; ")}\n\n${formatAdapterHelp(catalog)}\n`);
      return DOCTOR_EXIT.usage;
    }
    selection = parsed.selection;
  } catch (error) {
    process.stderr.write(`${messageOf(error)}\n\n${formatAdapterHelp(catalog)}\n`);
    return DOCTOR_EXIT.usage;
  }
  const doctor = deps.runDoctor ?? runAdapterDoctor;
  const report = await doctor(selection, {
    catalog,
    context: { ...(deps.logger ? { logger: deps.logger } : {}) },
  });
  write(formatDoctorReport(report));
  if (report.verdict === "blocked") return DOCTOR_EXIT.usage;
  if (report.verdict === "needs-attention") return DOCTOR_EXIT.attention;
  return DOCTOR_EXIT.ready;
}
