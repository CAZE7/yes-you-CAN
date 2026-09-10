/**
 * Chart group: the coordination layer behind "synchronisierte Graphen"
 * (AGENTS 16).
 *
 * One group owns one time viewport, one cursor and one selection, and any
 * number of series. Individual charts only *read* that state — so a zoom or a
 * cursor move in one chart is instantly visible in all charts without any
 * chart-to-chart messaging. That is also why this class is worth unit-testing:
 * the synchronisation is state, not pixels.
 */

import { Series, type SeriesOptions } from './series.js';
import { TimeViewport } from './viewport.js';
import type { Marker, Point, TimeRange, WindowStats } from './types.js';

export type ChartGroupChange = 'viewport' | 'cursor' | 'selection' | 'series' | 'markers' | 'follow';

export interface ChartGroupOptions {
  /** Initial visible span in ms. */
  defaultSpanMs?: number;
  minSpanMs?: number;
  maxSpanMs?: number;
  /** Follow the newest sample while recording (AGENTS 16 "Live Dashboard"). */
  follow?: boolean;
  paddingFraction?: number;
  /** Ring-buffer size per series. */
  maxPointsPerSeries?: number;
}

export interface ReadoutRow {
  id: string;
  name: string;
  unit?: string;
  color?: string;
  visible: boolean;
  /** Value at the cursor, `null` when the cursor is outside this series. */
  value: number | null;
  stats: WindowStats;
}

export interface Readout {
  t: number | null;
  rows: ReadoutRow[];
}

export class ChartGroup {
  readonly viewport: TimeViewport;

  private readonly seriesMap = new Map<string, Series>();
  private markerList: Marker[] = [];
  private cursorT: number | null = null;
  private selectionRange: TimeRange | null = null;
  private followEnabled: boolean;
  private readonly listeners = new Set<(reason: ChartGroupChange) => void>();
  private readonly maxPoints: number;

  constructor(options: ChartGroupOptions = {}) {
    this.viewport = new TimeViewport({
      ...(options.defaultSpanMs !== undefined ? { span: options.defaultSpanMs } : {}),
      ...(options.minSpanMs !== undefined ? { minSpan: options.minSpanMs } : {}),
      ...(options.maxSpanMs !== undefined ? { maxSpan: options.maxSpanMs } : {}),
      ...(options.paddingFraction !== undefined ? { paddingFraction: options.paddingFraction } : {}),
    });
    this.followEnabled = options.follow ?? true;
    this.maxPoints = options.maxPointsPerSeries ?? 200_000;
  }

  // ------------------------------------------------------------------ series

  get seriesList(): readonly Series[] {
    return Array.from(this.seriesMap.values());
  }

  get visibleSeries(): readonly Series[] {
    return this.seriesList.filter((series) => series.visible);
  }

  series(id: string): Series | undefined {
    return this.seriesMap.get(id);
  }

  addSeries(options: SeriesOptions): Series {
    const series = new Series({ ...options, maxPoints: options.maxPoints ?? this.maxPoints });
    this.seriesMap.set(series.id, series);
    this.refreshBounds();
    this.notify('series');
    return series;
  }

  /** Get-or-create, so live samples can arrive before the signal list does. */
  ensureSeries(id: string, options: Partial<SeriesOptions> = {}): Series {
    return this.seriesMap.get(id) ?? this.addSeries({ id, ...options });
  }

  /** Append live samples; moves the viewport when following. */
  push(id: string, points: readonly Point[], options: Partial<SeriesOptions> = {}): Series {
    const series = this.ensureSeries(id, options);
    series.pushMany(points);
    this.refreshBounds();
    this.notify('series');
    return series;
  }

  setVisible(id: string, visible: boolean): void {
    const series = this.seriesMap.get(id);
    if (!series || series.visible === visible) return;
    series.visible = visible;
    this.notify('series');
  }

  toggleVisible(id: string): void {
    const series = this.seriesMap.get(id);
    if (series) this.setVisible(id, !series.visible);
  }

  // ---------------------------------------------------------------- viewport

  get follow(): boolean {
    return this.followEnabled;
  }

  setFollow(enabled: boolean): void {
    if (this.followEnabled === enabled) return;
    this.followEnabled = enabled;
    if (enabled) {
      const latest = this.dataBounds()?.to;
      if (latest !== undefined) this.viewport.followTo(latest);
    }
    this.notify('follow');
  }

  /** Time extent of all series combined — the recording length. */
  dataBounds(): TimeRange | null {
    let from = Infinity;
    let to = -Infinity;
    for (const series of this.seriesMap.values()) {
      const extent = series.extent();
      if (!extent) continue;
      if (extent.from < from) from = extent.from;
      if (extent.to > to) to = extent.to;
    }
    if (from === Infinity) return null;
    return { from, to };
  }

  /** Recompute bounds from the data and re-apply follow/clamping. */
  refreshBounds(): void {
    const bounds = this.dataBounds();
    this.viewport.bounds = bounds;
    if (this.followEnabled && bounds) this.viewport.followTo(bounds.to);
    else this.viewport.clamp();
  }

  zoomAt(factor: number, anchorT: number): void {
    // A manual zoom means the user wants to look at something — stop following.
    this.followEnabled = false;
    this.viewport.zoomAt(factor, anchorT);
    this.notify('viewport');
  }

  zoomBy(factor: number): void {
    this.zoomAt(factor, this.viewport.from + this.viewport.span / 2);
  }

  panByPixels(deltaPixels: number, widthPx: number): void {
    this.followEnabled = false;
    this.viewport.panByPixels(deltaPixels, widthPx);
    this.notify('viewport');
  }

  panByMs(deltaMs: number): void {
    this.followEnabled = false;
    this.viewport.panByMs(deltaMs);
    this.notify('viewport');
  }

  /** Show the whole recording. */
  fitAll(): void {
    this.followEnabled = false;
    this.viewport.fit();
    this.notify('viewport');
  }

  /**
   * Zoom to an absolute span (window presets like "20 s"), keeping the right
   * edge where it is so the view does not jump away from what the user sees.
   */
  setSpan(spanMs: number): void {
    if (!Number.isFinite(spanMs) || spanMs <= 0) return;
    this.followEnabled = false;
    const to = this.viewport.to;
    this.viewport.setRange(to - spanMs, to);
    this.notify('viewport');
  }

  /** Jump the window to a span around `t` (used by marker click-to-jump). */
  showAround(t: number, spanMs = this.viewport.span): void {
    this.followEnabled = false;
    this.viewport.setRange(t - spanMs / 2, t + spanMs / 2);
    this.notify('viewport');
  }

  // ----------------------------------------------------------------- cursor

  get cursor(): number | null {
    return this.cursorT;
  }

  setCursor(t: number | null): void {
    if (this.cursorT === t) return;
    this.cursorT = t;
    this.notify('cursor');
  }

  get selection(): TimeRange | null {
    return this.selectionRange;
  }

  setSelection(range: TimeRange | null): void {
    const normalized = range ? { from: Math.min(range.from, range.to), to: Math.max(range.from, range.to) } : null;
    if (normalized && normalized.to - normalized.from < 1e-9) return;
    this.selectionRange = normalized;
    this.notify('selection');
  }

  clearSelection(): void {
    this.setSelection(null);
  }

  // ---------------------------------------------------------------- markers

  get markers(): readonly Marker[] {
    return this.markerList;
  }

  addMarker(marker: Marker): Marker {
    this.markerList.push(marker);
    this.markerList.sort((a, b) => a.t - b.t);
    this.notify('markers');
    return marker;
  }

  setMarkers(markers: readonly Marker[]): void {
    this.markerList = [...markers].sort((a, b) => a.t - b.t);
    this.notify('markers');
  }

  markersInWindow(range: TimeRange = this.viewport.range): readonly Marker[] {
    return this.markerList.filter((marker) => marker.t >= range.from && marker.t <= range.to);
  }

  // ------------------------------------------------------------- evaluation

  /** Statistics of one series over an explicit or the visible window. */
  stats(seriesId: string, range?: TimeRange): WindowStats {
    const series = this.seriesMap.get(seriesId);
    if (!series) return { count: 0, min: null, max: null, average: null, delta: null, first: null, last: null };
    return series.stats(range ?? this.viewport.range);
  }

  /**
   * Statistics over the selected range — the "Zeitraum auswählen" feature.
   * Returns null when nothing is selected or the signal is unknown, so the UI
   * can tell "no selection" apart from "no samples in the selection".
   */
  selectionStats(seriesId: string): WindowStats | null {
    if (!this.selectionRange || !this.seriesMap.has(seriesId)) return null;
    return this.stats(seriesId, this.selectionRange);
  }

  /** Cursor value + window statistics for every series — drives the readout. */
  readout(t: number | null = this.cursorT): Readout {
    const range = this.viewport.range;
    const rows: ReadoutRow[] = this.seriesList.map((series) => {
      const point = t === null ? null : series.valueAt(t);
      return {
        id: series.id,
        name: series.name,
        ...(series.unit ? { unit: series.unit } : {}),
        ...(series.color ? { color: series.color } : {}),
        visible: series.visible,
        value: point ? point.value : null,
        stats: series.stats(range),
      };
    });
    return { t, rows };
  }

  // ------------------------------------------------------------ observation

  subscribe(listener: (reason: ChartGroupChange) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Drop all data but keep viewport settings and listeners. */
  clear(): void {
    for (const series of this.seriesMap.values()) series.clear();
    this.markerList = [];
    this.cursorT = null;
    this.selectionRange = null;
    this.viewport.bounds = null;
    this.notify('series');
  }

  private notify(reason: ChartGroupChange): void {
    for (const listener of this.listeners) {
      try {
        listener(reason);
      } catch {
        // A broken renderer must not break the other renderers.
      }
    }
  }
}
