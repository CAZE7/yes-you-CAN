/**
 * How a measured value becomes text.
 *
 * One rule, one place: integers as they are, everything else with two decimals.
 * Two decimals is the resolution the diagnostic wording already uses — the safety
 * manager writes "battery voltage 11.00 V is below the required 11.50 V", the
 * evidence engine writes the same way — and it is also what a double needs to stop
 * showing its binary seams: a model that computed `10.770000000000001` measured
 * 10.77 V, and an operator who reads the longer number is reading the float format
 * instead of the car.
 *
 * It was written out by hand four times before it existed once — `evidence/collect.ts`
 * (min/max/avg in an evidence line), `session/compare.ts` (the drift sentence),
 * `apps/web/src/trace-view.ts` (the graph label), `reports/report.ts` (the statistics
 * table). The scenario verdict, where the noise above was measured, was about to be
 * the fifth; that is the point at which writing it out again stopped being cheaper
 * than naming it.
 *
 * Not everything that calls `toFixed` is this rule, and two places keep their own code
 * on purpose: `logging/session-logger.ts` writes values exactly as JavaScript prints
 * them, so a CSV cell and the decoded sample always agree, and `reports/pdf.ts` formats
 * PDF drawing coordinates. A shared helper that quietly changes an export's bytes would
 * be a worse defect than the duplication it removed.
 *
 * One copy survives for a structural reason: `reports/report.ts` formats the same way
 * for its statistics table, and `@vdp/reports` may not import `@vdp/shared`
 * (`architecture.yaml`, `mayImport: [core, diagnostic-ir]`). Widening that edge for a
 * number formatter would trade a rule nobody asked to change for one saved line, so the
 * duplication stays and is recorded in ADR 0049 instead.
 */

/**
 * A measured number as an operator reads it.
 *
 * Deliberately *not* locale-aware and deliberately not `toPrecision`: the text ends
 * up in CSV exports, PDF reports and protocol-adjacent sentences, where a thousands
 * separator would be a parsing problem for whoever reads the file next.
 */
export function formatMeasuredValue(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}
