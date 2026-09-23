/**
 * Guided Diagnosis Panel (ADR 0056 / Task 6).
 *
 * Visualizes active diagnostic hypotheses, confidence scores, and recommended tests.
 */

import * as api from "/api.js";
import { button, el, must, row } from "/dom.js";

/** @typedef {import("../src/views.js").GuidedDiagnosisView} GuidedDiagnosisView */

/** @type {GuidedDiagnosisView | null} */
let guidedDiagnosisState = null;

/** @param {GuidedDiagnosisView} view */
export function renderGuidedDiagnosis(view) {
  guidedDiagnosisState = view;
  const badge = must("#guided-status-badge");
  badge.textContent = view.status;
  badge.className = "pill";
  if (view.status === "resolved") badge.classList.add("pill-online");
  else if (view.status === "in-progress") badge.classList.add("pill-live");
  else badge.classList.add("pill-possible");

  must("#guided-summary-text").textContent =
    `${view.summary} · ${view.stepsCompleted} Schritte abgeschlossen`;

  const testContent = must("#guided-next-test-content");
  const testActions = must("#guided-next-test-actions");

  if (view.nextRecommendedTest) {
    const next = view.nextRecommendedTest;
    testContent.replaceChildren(
      el("p", {}, [el("strong", { text: "Warum dieser Test: " }), next.rationale]),
      el("p", {
        class: "mono small",
        text: `Signal: ${next.test.signal} | Erwartung: ${next.test.expect} (Min: ${next.test.min ?? "—"}, Max: ${next.test.max ?? "—"}, Fenster: ${next.test.windowMs ?? 1000} ms)`,
      }),
      next.discriminatesAgainst && next.discriminatesAgainst.length > 0
        ? el("p", {
            class: "muted small",
            text: `Grenzt ab gegen: ${next.discriminatesAgainst.join(", ")}`,
          })
        : el("span"),
    );
    testActions.hidden = false;
  } else {
    testContent.replaceChildren(
      el("p", {
        class: "muted",
        text: "Kein weiterer diskriminierender Prüfschritt erforderlich (Diagnose abgeschlossen oder keine weiteren Tests definiert).",
      }),
    );
    testActions.hidden = true;
  }

  const rows = must("#guided-hypotheses-rows");
  rows.replaceChildren();
  if (view.hypotheses.length === 0) {
    rows.append(row(["Keine Hypothesen formuliert."]));
    return;
  }

  for (const hyp of view.hypotheses) {
    const tr = el("tr");

    const tdClaim = el("td", {}, [
      el("strong", { text: hyp.claim }),
      el("div", { class: "muted small mono", text: `ID: ${hyp.id}` }),
    ]);

    const pct = Math.round(hyp.confidence * 100);
    const scoreFill = el("div", {
      class: hyp.confidence >= 0.7 ? "score-fill" : "score-fill score-fill-weak",
    });
    scoreFill.style.width = `${pct}%`;
    const tdConf = el("td", {}, [
      el("span", { class: "mono small", text: `${pct} %` }),
      el("div", { class: "score" }, [scoreFill]),
    ]);

    const statusPill = el("span", {
      class: `pill pill-${hyp.outcome}`,
      text:
        hyp.outcome === "confirmed"
          ? "bestätigt"
          : hyp.outcome === "refuted"
            ? "widerlegt"
            : "offen",
    });
    const tdStatus = el("td", {}, [statusPill]);

    const checksList = hyp.checks.map((c) => `${c.signal}: ${c.expect} → ${c.outcome}`).join(" · ");
    const tdChecks = el("td", {
      class: "small",
      text: checksList || "Noch keine Prüfschritte ausgeführt",
    });

    tr.append(tdClaim, tdConf, tdStatus, tdChecks);
    rows.append(tr);
  }
}

/**
 * @param {(error: unknown) => void} [onError]
 */
export async function refreshGuidedDiagnosis(onError) {
  try {
    const { state: gdState } = await api.fetchGuidedDiagnosis();
    renderGuidedDiagnosis(gdState);
  } catch (error) {
    if (onError) onError(error);
  }
}

/**
 * Mount guided diagnosis controls.
 *
 * @param {(error: unknown) => void} onError
 */
export function mountGuidedDiagnosisPanel(onError) {
  button("#btn-guided-refresh").addEventListener("click", () => {
    void refreshGuidedDiagnosis(onError);
  });

  button("#btn-guided-step").addEventListener("click", async () => {
    if (!guidedDiagnosisState?.nextRecommendedTest) return;
    const next = guidedDiagnosisState.nextRecommendedTest;
    try {
      const { state: gdState } = await api.stepGuidedDiagnosis({
        signalId: next.test.signal,
        value:
          next.test.min !== undefined
            ? next.test.min
            : next.test.max !== undefined
              ? next.test.max
              : 1.0,
      });
      renderGuidedDiagnosis(gdState);
    } catch (error) {
      onError(error);
    }
  });
}
