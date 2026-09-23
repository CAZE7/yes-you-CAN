/**
 * AI Diagnosis Analysis Panel (ADR 0038 / P0 #42).
 *
 * Renders LLM/heuristic diagnosis results, findings, and provenance metadata.
 */

import { el, must } from "/dom.js";

/** @typedef {import("../src/views.js").AnalysisView} AnalysisView */

/** @param {AnalysisView} result */
export function renderAnalysis(result) {
  must("#analysis-source").textContent =
    `${result.provider} · Quelle: ${result.source} · Konfidenz ${Math.round(result.confidence * 100)} %`;
  const host = must("#analysis-out");
  host.replaceChildren(el("p", { text: result.summary }));
  const provenance = result.provenance;
  if (provenance) {
    const versions = [
      `Prompt ${provenance.promptVersion}`,
      `Plattform ${provenance.runtimeVersion}`,
      provenance.definitionVersion ? `Definition ${provenance.definitionVersion}` : "",
      `${provenance.evidence.length} ${provenance.evidence.length === 1 ? "Beleg" : "Belege"}`,
    ]
      .filter((part) => part !== "")
      .join(" · ");
    host.append(el("p", { class: "muted small", text: versions }));
  }
  for (const finding of result.findings) {
    const cited = finding.basedOn ?? [];
    host.append(
      el("div", { class: `finding sev-${finding.severity}` }, [
        el("h4", { text: `${finding.severity.toUpperCase()} · ${finding.title}` }),
        el("p", { text: finding.detail }),
        el("p", {
          class: "muted small",
          text: cited.length > 0 ? `gestützt auf: ${cited.join(", ")}` : "ohne einzelnen Beleg",
        }),
      ]),
    );
  }
  host.append(el("h3", { text: "Empfehlungen" }));
  const list = el("ul", { class: "plain" });
  for (const recommendation of result.recommendations)
    list.append(el("li", { text: recommendation }));
  host.append(list);
  if (result.warnings?.length) {
    host.append(el("p", { class: "muted small", text: result.warnings.join(" · ") }));
  }
}
