/**
 * Graph board (AGENTS 16) — the analysis surface of the workbench.
 *
 * Responsibilities: hold one `ChartGroup` (the shared window/cursor/selection
 * state), render one canvas per signal, and translate toolbar and pointer
 * actions into group operations. The board contains no measurement logic and no
 * protocol knowledge: it receives decoded samples and draws them.
 *
 * Features required by AGENTS 16 and wired here:
 *   beliebig viele Signale · gemeinsame Zeitachse · Zoom · Pan · Cursor ·
 *   Marker · Zeitraum auswählen · automatische Skalierung · individuelle
 *   Y-Achsen · Ein-/Ausblenden · Min/Max/Durchschnitt · Delta · Event-Marker
 */

import { SignalChart } from "/chart.js";
import { $, el, on } from "/dom.js";
import { ChartGroup, formatClock, formatDuration, formatValue } from "/lib/index.js";

/** @typedef {import("../src/views.js").HistoryView} HistoryView */
/** @typedef {import("../src/views.js").SampleView} SampleView */
/** @typedef {import("../src/views.js").SignalInfoView} SignalInfoView */
/** @typedef {import("/lib/index.js").Marker} Marker */

/**
 * What a chart needs to know about a signal: identity plus the documented label
 * and unit. Criticality is an alerting property (`SignalInfoView`), not a drawing
 * one — a signal can be plotted without ever having been classified.
 *
 * @typedef {{ id: string, name?: string, unit?: string }} ChartSignal
 */

const PALETTE = [
  "#4f9cf9",
  "#f9a94f",
  "#4ff9a9",
  "#f94f9c",
  "#c74ff9",
  "#f9f14f",
  "#5ce1e6",
  "#f9f14f",
];

/** Window presets in ms — "all" is handled separately (fit). */
const WINDOW_PRESETS = [
  { label: "5 s", ms: 5_000 },
  { label: "20 s", ms: 20_000 },
  { label: "1 min", ms: 60_000 },
  { label: "5 min", ms: 300_000 },
];

export class GraphBoard {
  /**
   * @param {{ charts?: string, status?: string, readout?: string,
   *   selection?: string, markers?: string, follow?: string }} [selectors]
   *   CSS selectors of the panels; defaults match `index.html`, tests and
   *   embedders can point at their own markup.
   */
  constructor(selectors = {}) {
    this.host = $(selectors.charts ?? "#charts");
    this.statusHost = $(selectors.status ?? "#graph-status");
    this.readoutHost = $(selectors.readout ?? "#graph-readout");
    this.selectionHost = $(selectors.selection ?? "#graph-selection");
    this.markerHost = $(selectors.markers ?? "#graph-markers");
    this.followButton = $(selectors.follow ?? "#graph-follow");

    this.group = new ChartGroup({
      defaultSpanMs: 20_000,
      minSpanMs: 500,
      maxSpanMs: 30 * 60_000,
      follow: true,
      maxPointsPerSeries: 50_000,
    });
    /** @type {Map<string, {chart: SignalChart, card: HTMLElement, stats: HTMLElement, value: HTMLElement, toggle: HTMLElement}>} */
    this.charts = new Map();
    this.signalMeta = new Map();
    this.unsubscribe = this.group.subscribe((reason) => this.onChange(reason));
    if (this.host) this.host.replaceChildren();
    this.wireToolbar();
    this.renderStatus();
  }

  destroy() {
    this.unsubscribe();
    for (const entry of this.charts.values()) entry.chart.destroy();
    this.charts.clear();
  }

  // ------------------------------------------------------------------- input

  /**
   * Known signals from the definition package (id, name, unit, critical).
   *
   * @param {SignalInfoView[]} signals
   */
  setSignals(signals) {
    for (const signal of signals) {
      this.signalMeta.set(signal.id, signal);
      this.ensureChart(signal);
    }
    this.renderStatus();
  }

  /**
   * Replace the recording with a server-side history snapshot.
   *
   * @param {HistoryView | null} history
   */
  setHistory(history) {
    if (!history) return;
    if (this.charts.size === 0 && history.samples.length > 0) {
      // The graph view can be opened before the signal list arrives.
      for (const sample of history.samples) {
        if (!this.signalMeta.has(sample.signal))
          this.ensureChart({ id: sample.signal, name: sample.name, unit: sample.unit });
      }
    }
    this.group.clear();
    /** @type {Map<string, {points: {t:number,value:number,outOfRange?:boolean}[], name: string, unit?: string}>} */
    const bySignal = new Map();
    for (const sample of history.samples) {
      if (sample.numeric === null) continue;
      const entry = bySignal.get(sample.signal) ?? {
        points: /** @type {{t:number,value:number,outOfRange?:boolean}[]} */ ([]),
        name: sample.name,
        ...(sample.unit ? { unit: sample.unit } : {}),
      };
      entry.points.push({
        t: sample.t,
        value: sample.numeric,
        ...(sample.outOfRange ? { outOfRange: true } : {}),
      });
      bySignal.set(sample.signal, entry);
    }
    for (const [signal, entry] of bySignal) {
      this.group.push(signal, entry.points, {
        name: entry.name,
        ...(entry.unit ? { unit: entry.unit } : {}),
      });
      this.ensureChart({ id: signal, name: entry.name, unit: entry.unit });
    }
    this.group.setMarkers(history.markers ?? []);
    this.renderMarkers();
    this.renderStatus();
    for (const entry of this.charts.values()) entry.chart.draw();
  }

  /**
   * One live sample from the SSE stream.
   *
   * @param {SampleView} sample
   */
  pushSample(sample) {
    if (sample.numeric === null) return; // textual/enum signals are not plottable
    this.group.push(
      sample.signal,
      [{ t: sample.t, value: sample.numeric, ...(sample.outOfRange ? { outOfRange: true } : {}) }],
      {
        name: sample.name,
        ...(sample.unit ? { unit: sample.unit } : {}),
        ...this.metaFor(sample.signal),
      },
    );
    this.ensureChart({ id: sample.signal, name: sample.name, unit: sample.unit });
  }

  /** @param {Marker} marker */
  addMarker(marker) {
    this.group.addMarker(marker);
  }

  /**
   * Replace the whole marker list (after a DTC scan).
   *
   * @param {Marker[] | null} markers
   */
  setMarkers(markers) {
    this.group.setMarkers(markers ?? []);
  }

  // ---------------------------------------------------------------- rendering

  /**
   * The chart card of one signal, created on first use.
   *
   * @param {ChartSignal} signal
   * @returns {{chart: SignalChart, card: HTMLElement, stats: HTMLElement, value: HTMLElement, toggle: HTMLElement} | undefined}
   */
  ensureChart(signal) {
    if (this.charts.has(signal.id) || !this.host) return this.charts.get(signal.id);
    this.signalMeta.set(signal.id, { ...(this.signalMeta.get(signal.id) ?? {}), ...signal });

    const index = this.charts.size;
    const color = PALETTE[index % PALETTE.length] ?? PALETTE[0];
    // `ensureSeries` fills metadata that a series auto-created by a live
    // sample does not carry yet (name, unit, colour) — without overwriting
    // values that were documented first (@vdp/charts, AGENTS 16).
    const series = this.group.ensureSeries(signal.id, {
      name: signal.name ?? signal.id,
      ...(signal.unit ? { unit: signal.unit } : {}),
      color,
    });

    const canvas = /** @type {HTMLCanvasElement} */ (el("canvas", { class: "chart" }));
    const value = el("span", { class: "chart-value" });
    const stats = el("span", { class: "chart-stats muted small" });
    const toggle = el(
      "button",
      {
        class: "chart-toggle",
        title: "Signal ein-/ausblenden",
        "aria-pressed": "true",
        onclick: (event) => {
          event.stopPropagation();
          this.group.toggleVisible(signal.id);
        },
      },
      [el("span", { class: "dot" })],
    );

    const card = el("div", { class: "chart-card" }, [
      el("div", { class: "chart-head" }, [
        toggle,
        el("span", { class: "chart-title", text: signal.name ?? signal.id }),
        el("span", { class: "chart-unit muted small", text: signal.unit ?? "" }),
        value,
        stats,
      ]),
      canvas,
    ]);

    this.host.append(card);
    const chart = new SignalChart({ group: this.group, series, canvas, color });
    const entry = { chart, card, stats, value, toggle };
    this.charts.set(signal.id, entry);
    this.renderStatus();
    return entry;
  }

  /** @param {import("/lib/index.js").ChartGroupChange} reason */
  onChange(reason) {
    for (const entry of this.charts.values()) {
      const visible = entry.chart.series.visible;
      entry.card.classList.toggle("hidden-series", !visible);
      entry.toggle.setAttribute("aria-pressed", String(visible));
      entry.chart.schedule();
    }
    this.renderReadout();
    this.renderSelection();
    if (reason === "markers") this.renderMarkers();
    this.renderStatus();
  }

  renderReadout() {
    if (!this.readoutHost) return;
    const readout = this.group.readout();
    const table = /** @type {HTMLTableElement} */ (this.readoutHost);
    const body = table.tBodies[0] ?? table.querySelector("tbody") ?? table;
    body.replaceChildren();
    for (const row of readout.rows) {
      const stats = row.stats;
      body.append(
        el("tr", { class: row.visible ? "" : "is-hidden" }, [
          el("td", {}, [
            el("span", { class: "swatch", style: `background:${row.color ?? PALETTE[0]}` }),
            row.name,
          ]),
          el("td", { class: "num", text: row.value === null ? "—" : formatValue(row.value) }),
          el("td", { class: "num", text: formatValue(stats.min) }),
          el("td", { class: "num", text: formatValue(stats.max) }),
          el("td", { class: "num", text: formatValue(stats.average) }),
          el("td", { class: "num", text: formatValue(stats.delta) }),
          el("td", { class: "muted", text: row.unit ?? "—" }),
        ]),
      );
    }
  }

  renderSelection() {
    if (!this.selectionHost) return;
    const selection = this.group.selection;
    const body = this.selectionHost.querySelector("tbody") ?? this.selectionHost;
    body.replaceChildren();
    if (!selection) {
      this.selectionHost.classList.add("empty");
      body.append(
        el("tr", {}, [
          el("td", {
            colspan: "6",
            class: "muted",
            text: "Umschalt + Ziehen im Graphen wählt einen Zeitraum aus.",
          }),
        ]),
      );
      return;
    }
    this.selectionHost.classList.remove("empty");
    for (const series of this.group.visibleSeries) {
      const stats = this.group.selectionStats(series.id);
      if (!stats) continue;
      body.append(
        el("tr", {}, [
          el("td", { text: series.name }),
          el("td", { class: "num", text: formatValue(stats.min) }),
          el("td", { class: "num", text: formatValue(stats.max) }),
          el("td", { class: "num", text: formatValue(stats.average) }),
          el("td", { class: "num", text: formatValue(stats.delta) }),
          el("td", { class: "num muted", text: String(stats.count) }),
        ]),
      );
    }
  }

  renderMarkers() {
    if (!this.markerHost) return;
    this.markerHost.replaceChildren();
    const markers = this.group.markers;
    if (markers.length === 0) {
      this.markerHost.append(
        el("li", {
          class: "muted",
          text: "keine Marker — Fehlerspeicher lesen erzeugt DTC-Marker",
        }),
      );
      return;
    }
    for (const marker of markers.slice(-40).reverse()) {
      this.markerHost.append(
        el("li", { class: `marker marker-${marker.kind}` }, [
          el("button", {
            class: "link",
            title: marker.detail ?? marker.label,
            onclick: () => this.group.showAround(marker.t),
            text: formatClock(marker.t),
          }),
          el("span", { class: "marker-kind", text: marker.kind }),
          el("span", { text: marker.label }),
        ]),
      );
    }
  }

  renderStatus() {
    if (!this.statusHost) return;
    const range = this.group.viewport.range;
    const parts = [
      `Fenster ${formatClock(range.from)} – ${formatClock(range.to)} (${formatDuration(this.group.viewport.span)})`,
      `${this.group.visibleSeries.length}/${this.group.seriesList.length} Signale sichtbar`,
      `${this.group.markers.length} Marker`,
    ];
    if (this.group.follow) parts.push("folgt live");
    if (this.group.cursor !== null) parts.push(`Cursor ${formatClock(this.group.cursor)}`);
    this.statusHost.textContent = parts.join(" · ");
    if (this.followButton) {
      this.followButton.textContent = this.group.follow ? "Live folgen: an" : "Live folgen: aus";
      this.followButton.classList.toggle("primary", this.group.follow);
    }
  }

  // ------------------------------------------------------------------ toolbar

  wireToolbar() {
    on("#graph-follow", "click", () => this.group.setFollow(!this.group.follow));
    on("#graph-fit", "click", () => this.group.fitAll());
    on("#graph-zoom-in", "click", () => this.group.zoomBy(1.5));
    on("#graph-zoom-out", "click", () => this.group.zoomBy(1 / 1.5));
    on("#graph-clear-selection", "click", () => this.group.clearSelection());
    on("#graph-clear-cursor", "click", () => this.group.setCursor(null));

    const windowSelect = /** @type {HTMLSelectElement | null} */ (
      on("#graph-window", "change", (event) => {
        const value = /** @type {HTMLSelectElement} */ (event.target).value;
        if (value === "all") {
          this.group.fitAll();
          return;
        }
        const ms = Number.parseInt(value, 10);
        if (Number.isFinite(ms)) this.group.setSpan(ms);
      })
    );
    if (windowSelect && windowSelect.options.length === 0) {
      for (const preset of WINDOW_PRESETS)
        windowSelect.append(el("option", { value: String(preset.ms), text: preset.label }));
      windowSelect.append(el("option", { value: "all", text: "gesamte Aufnahme" }));
      windowSelect.value = "20000";
    }

    const decimateSelect = /** @type {HTMLSelectElement | null} */ (
      on("#graph-decimate", "change", (event) => {
        const chosen = /** @type {HTMLSelectElement} */ (event.target).value;
        const mode = chosen === "lttb" ? "lttb" : "minmax";
        for (const entry of this.charts.values()) {
          entry.chart.decimationMode = mode;
          entry.chart.schedule();
        }
      })
    );
    if (decimateSelect) decimateSelect.value = "minmax";
  }

  /**
   * Series metadata for a signal, as far as the definition package documented it.
   *
   * @param {string} signalId
   * @returns {Partial<import("/lib/index.js").SeriesOptions>}
   */
  metaFor(signalId) {
    const meta = this.signalMeta.get(signalId);
    if (!meta) return {};
    return { name: meta.name ?? signalId, ...(meta.unit ? { unit: meta.unit } : {}) };
  }

  /** Redraw now — used when the tab becomes visible (charts have no size while hidden). */
  refresh() {
    for (const entry of this.charts.values()) entry.chart.draw();
    this.renderReadout();
    this.renderSelection();
    this.renderStatus();
  }
}
