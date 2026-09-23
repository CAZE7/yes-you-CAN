/**
 * Extended Signal Analysis Panel (Task 5).
 *
 * Computes and renders FFT frequency spectrum, statistical moments, and physical anomalies.
 */

import * as api from "/api.js";
import { $, el, messageOf, must, select } from "/dom.js";

/** @typedef {import("../src/views.js").SampleView} SampleView */

/**
 * Populate signal selection dropdown for analysis.
 *
 * @param {readonly string[]} signals
 */
export function renderAnalysisSignalOptions(signals) {
  const selectNode = /** @type {HTMLSelectElement | null} */ ($("#analysis-signal-select"));
  if (!selectNode) return;
  const previous = selectNode.value;
  selectNode.replaceChildren(
    ...signals.map((signal) => el("option", { value: signal, text: signal })),
  );
  if (previous && signals.includes(previous)) selectNode.value = previous;
}

/**
 * Mount signal analysis event listener.
 *
 * @param {(error: unknown) => void} onError
 */
export function mountSignalAnalysisPanel(onError) {
  const btn = $("#btn-signal-analyze");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    const signalId = select("#analysis-signal-select").value;
    const out = must("#signal-analysis-out");
    out.replaceChildren(
      el("p", { class: "muted", text: "Berechne FFT, Spektrum und statistische Momente …" }),
    );

    try {
      const { analysis } = await api.fetchSignalAnalysis(signalId);
      out.replaceChildren();

      // Statistics card
      if (analysis.statistics) {
        const stats = analysis.statistics;
        const statsCard = el("div", { class: "card", style: "margin-top: 0.75rem;" }, [
          el("h4", { text: `Statistische Momente (${analysis.sampleCount} Samples)` }),
          el("dl", { class: "kv" }, [
            el("dt", { text: "Min / Max" }),
            el("dd", { text: `${stats.min.toFixed(2)} / ${stats.max.toFixed(2)}` }),
            el("dt", { text: "Mittelwert (Ø) / Median" }),
            el("dd", { text: `${stats.mean.toFixed(2)} / ${stats.median.toFixed(2)}` }),
            el("dt", { text: "Standardabweichung (σ)" }),
            el("dd", {
              text: `${stats.stdDev.toFixed(3)} (Varianz: ${stats.variance.toFixed(3)})`,
            }),
            el("dt", { text: "Schiefe (Skewness)" }),
            el("dd", { text: stats.skewness.toFixed(3) }),
            el("dt", { text: "Wölbung (Kurtosis)" }),
            el("dd", { text: stats.kurtosis.toFixed(3) }),
            el("dt", { text: "Perzentile (P5 / P50 / P95)" }),
            el("dd", {
              text: `${stats.p5.toFixed(2)} / ${stats.p50.toFixed(2)} / ${stats.p95.toFixed(2)}`,
            }),
          ]),
        ]);
        out.append(statsCard);
      }

      // Spectrum card
      if (analysis.spectrum) {
        const spec = analysis.spectrum;
        const specCard = el("div", { class: "card", style: "margin-top: 0.75rem;" }, [
          el("h4", { text: "Frequenzspektrum (Hann-FFT)" }),
          el("dl", { class: "kv" }, [
            el("dt", { text: "Dominante Frequenz" }),
            el("dd", { text: `${spec.dominantFrequency.toFixed(2)} Hz` }),
            el("dt", { text: "Dominante Amplitude" }),
            el("dd", { text: spec.dominantMagnitude.toFixed(2) }),
            el("dt", { text: "Signal-Rausch-Verhältnis (SNR)" }),
            el("dd", { text: `${spec.snrDb.toFixed(1)} dB` }),
          ]),
        ]);
        out.append(specCard);
      }

      // Anomalies card
      const anomalyCard = el("div", { class: "card", style: "margin-top: 0.75rem;" }, [
        el("h4", { text: `Erkannte Anomalien (${analysis.anomalies.length})` }),
      ]);
      if (analysis.anomalies.length === 0) {
        anomalyCard.append(
          el("p", {
            class: "muted small",
            text: "Keine physikalischen Anomalien erkannt (Signal stationär und fehlerfrei).",
          }),
        );
      } else {
        const ul = el("ul", { class: "plain small" });
        for (const anom of analysis.anomalies) {
          ul.append(
            el("li", {}, [
              el("span", { class: "pill pill-offline", text: anom.kind }),
              ` Schwere: ${anom.severity} | Wert: ${anom.value.toFixed(2)} — ${anom.description}`,
            ]),
          );
        }
        anomalyCard.append(ul);
      }
      out.append(anomalyCard);
    } catch (error) {
      onError(error);
      out.replaceChildren(el("p", { class: "warn", text: messageOf(error) }));
    }
  });
}
