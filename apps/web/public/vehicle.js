/**
 * Fahrzeugbestimmung (AGENTS 11) — the vehicle panel of the workbench.
 *
 * Renders what the backend weighed: ranked candidates, each one a hypothesis with
 * the evidence that carries it and the contradictions against it, plus where the
 * data came from. This module contains no resolution logic of its own — it must
 * not decide what a score means, only show it (AGENTS 5, 24).
 *
 * Like `graphs.js` it is a plain ES module with its own DOM helper: the front end
 * ships without a bundler, so every module stays self-contained.
 */

const $ = (selector) => document.querySelector(selector);

const el = (tag, attrs = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child == null) continue;
    node.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
};

/**
 * Render a vehicle resolution into `#vehicle-resolution`.
 *
 * @param {any} view the `VehicleResolutionView` the backend sent
 */
export function renderVehicleResolution(view) {
  const host = $("#vehicle-resolution");
  const headline = $("#vehicle-resolution-headline");
  const summary = $("#vehicle-resolution-summary");
  if (!host || !headline || !summary) return; // panel not on this page
  headline.textContent = view?.headline ?? "";
  host.replaceChildren();

  const candidates = view?.candidates ?? [];
  if (candidates.length === 0) {
    summary.textContent = view?.vinLookup
      ? `kein Treffer in den installierten Definitionen — VIN-Lookup: ${describeVinLookup(view.vinLookup)}`
      : "kein Treffer in den installierten Definitionen";
    for (const note of [...(view?.notes ?? []), ...(view?.unexplained ?? [])])
      host.append(el("p", { class: "muted small", text: note }));
    return;
  }

  summary.textContent = `${candidates.length} Kandidat${candidates.length === 1 ? "" : "en"} · beste Übereinstimmung zuerst`;
  candidates.forEach((candidate, index) => host.append(renderCandidate(candidate, index === 0)));
  for (const note of view?.notes ?? []) host.append(el("p", { class: "muted small", text: note }));
  for (const observation of view?.unexplained ?? [])
    host.append(
      el("p", { class: "muted small", text: `Von keiner Definition erklärt: ${observation}` }),
    );
}

/** One line for the VIN reference table — including "not in it". */
function describeVinLookup(lookup) {
  const maker = lookup.manufacturer ?? "unbekannter Hersteller";
  const country = lookup.country ? ` (${lookup.country})` : "";
  const known = lookup.known ? "" : " — nicht in der Referenztabelle";
  return `WMI ${lookup.wmi} → ${maker}${country}${known}`;
}

/**
 * One candidate: what it is, how much of the checked evidence speaks for it, and
 * the criteria behind that number.
 */
function renderCandidate(candidate, best) {
  const powertrain = [];
  if (candidate.engineIds.length > 0) powertrain.push(`Motor: ${candidate.engineIds.join(", ")}`);
  if (candidate.gearboxIds.length > 0)
    powertrain.push(`Getriebe: ${candidate.gearboxIds.join(", ")}`);

  const notes = el("ul", { class: "plain check-list" });
  notes.append(
    el("li", {
      class: best ? "ok" : "info",
      text: `${candidate.scoreLabel} · ${candidate.coverageLabel}`,
    }),
  );
  notes.append(
    el("li", {
      // Placeholder data has to be visible as such: a match on invented values is
      // not vehicle truth (AGENTS 24).
      class: candidate.placeholder ? "warn" : "info",
      text: `Datenquelle: ${candidate.provenanceLabel} · Paket ${candidate.oem} ${candidate.packageVersion} · Vertrauen ${Math.round(candidate.trust * 100)} %`,
    }),
  );
  if (powertrain.length > 0)
    notes.append(el("li", { class: "info", text: powertrain.join(" · ") }));
  if (candidate.missingEcus.length > 0)
    notes.append(
      el("li", { class: "warn", text: `Nicht geantwortet: ${candidate.missingEcus.join(", ")}` }),
    );
  for (const conflict of candidate.conflicts)
    notes.append(
      el("li", {
        class: "fail",
        text: `Widerspruch · ${conflict.label}: gelesen ${conflict.observed}, erwartet ${conflict.expected}`,
      }),
    );

  return el("div", { class: best ? "candidate candidate-best" : "candidate" }, [
    el("div", { class: "candidate-head" }, [
      el("strong", { text: candidate.title }),
      candidate.platform ? el("span", { class: "muted small", text: candidate.platform }) : null,
      el("span", {
        class: best ? "pill pill-online" : "pill pill-offline",
        text: `${candidate.scorePercent} %`,
      }),
    ]),
    el("div", { class: "score" }, [
      el("div", {
        class: best ? "score-fill" : "score-fill score-fill-weak",
        style: `width: ${Math.max(2, candidate.scorePercent)}%`,
      }),
    ]),
    notes,
    evidenceTable(candidate),
  ]);
}

/** Every criterion that was weighed — supporting and contradicting alike. */
function evidenceTable(candidate) {
  const body = el("tbody");
  const add = (items, verdict, cls) => {
    for (const item of items)
      body.append(
        el("tr", { class: cls }, [
          el("td", { text: item.label }),
          el("td", { class: "mono", text: item.observed }),
          el("td", { class: "mono", text: item.expected }),
          el("td", { text: verdict }),
          el("td", { text: String(item.weight) }),
          el("td", { class: "muted small", text: item.reason }),
        ]),
      );
  };
  add(candidate.evidence, "bestätigt", "ok");
  add(candidate.conflicts, "Widerspruch", "out-of-range");
  const head = ["Kriterium", "Gelesen", "Erwartet", "Bewertung", "Gewicht", "Begründung"].map(
    (text) => el("th", { text }),
  );
  return el("table", { class: "grid" }, [el("thead", {}, [el("tr", {}, head)]), body]);
}
