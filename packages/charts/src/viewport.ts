/**
 * Shared time viewport: zoom, pan, follow and pixel mapping.
 *
 * One instance is shared by every chart of a group, which is what makes the
 * graphs "synchronised" (AGENTS 16): they do not redraw each other, they read
 * the same viewport. All mutations are clamped, so a viewport can never end up
 * empty, inverted or infinitely zoomed.
 */

import type { TimeRange } from "./types.js";

export interface TimeViewportOptions {
  /** Initial visible span in ms. */
  span?: number;
  /** Smallest zoom level in ms — guards against zooming into nothing. */
  minSpan?: number;
  /** Largest zoom level in ms. */
  maxSpan?: number;
  /** Time domain the viewport is allowed to show (recording extent). */
  bounds?: TimeRange | null;
  /** Fraction of the span added as slack when following live data. */
  paddingFraction?: number;
}

export class TimeViewport {
  from: number;
  to: number;
  minSpan: number;
  maxSpan: number;
  bounds: TimeRange | null;
  paddingFraction: number;

  constructor(options: TimeViewportOptions = {}) {
    this.minSpan = options.minSpan ?? 50;
    this.maxSpan = options.maxSpan ?? 24 * 3600_000;
    this.paddingFraction = options.paddingFraction ?? 0.05;
    const span = Math.max(this.minSpan, options.span ?? 20_000);
    this.bounds = options.bounds ?? null;
    this.from = 0;
    this.to = span;
  }

  get span(): number {
    return this.to - this.from;
  }

  /** Copy of the current window — renderers should not mutate the viewport. */
  get range(): TimeRange {
    return { from: this.from, to: this.to };
  }

  includes(t: number): boolean {
    return t >= this.from && t <= this.to;
  }

  /** Set the window; span and position are clamped to min/max span and bounds. */
  setRange(from: number, to: number): void {
    if (!Number.isFinite(from) || !Number.isFinite(to)) return;
    let start = Math.min(from, to);
    let end = Math.max(from, to);

    let span = end - start;
    const upper = this.spanLimit();
    if (span < this.minSpan) {
      const center = (start + end) / 2;
      span = this.minSpan;
      start = center - span / 2;
      end = center + span / 2;
    } else if (span > upper) {
      const center = (start + end) / 2;
      span = upper;
      start = center - span / 2;
      end = center + span / 2;
    }

    const bounds = this.bounds;
    if (bounds) {
      const domainSpan = Math.max(0, bounds.to - bounds.from);
      if (span >= domainSpan) {
        start = bounds.from;
        end = bounds.to;
      } else {
        // Slide the window back into the domain, never shrink it below the
        // limits we just applied.
        if (start < bounds.from) {
          start = bounds.from;
          end = start + span;
        }
        if (end > bounds.to) {
          end = bounds.to;
          start = end - span;
        }
        if (start < bounds.from) start = bounds.from;
      }
    }

    this.from = start;
    this.to = Math.max(start + this.minSpan, end);
  }

  /** Zoom by `factor` (>1 = in, <1 = out), keeping `anchorT` in place. */
  zoomAt(factor: number, anchorT: number): void {
    if (!Number.isFinite(factor) || factor <= 0) return;
    const span = this.clampSpan(this.span / factor);
    const ratio = this.span > 0 ? (anchorT - this.from) / this.span : 0.5;
    const from = anchorT - ratio * span;
    this.setRange(from, from + span);
  }

  /** Zoom around the centre of the window. */
  zoomBy(factor: number): void {
    this.zoomAt(factor, this.from + this.span / 2);
  }

  panByMs(deltaMs: number): void {
    this.setRange(this.from + deltaMs, this.to + deltaMs);
  }

  /**
   * Pan by a pixel delta: dragging the content to the right moves the window
   * back in time, so the sign is inverted on purpose.
   */
  panByPixels(deltaPixels: number, widthPx: number): void {
    if (widthPx <= 0) return;
    this.panByMs((-deltaPixels / widthPx) * this.span);
  }

  /** Show everything in `bounds` (or keep the span if no bounds are known). */
  fit(paddingFraction = this.paddingFraction): void {
    const bounds = this.bounds;
    if (!bounds) return;
    const span = Math.max(this.minSpan, bounds.to - bounds.from);
    const pad = span * paddingFraction;
    this.setRange(bounds.from - pad, bounds.to + pad);
  }

  /** Follow live data: keep the span, move the window so `t` sits at the right. */
  followTo(t: number): void {
    const span = this.clampSpan(this.span);
    const to = t + span * this.paddingFraction;
    this.setRange(to - span, to);
  }

  /** Apply the current limits after bounds or span limits changed. */
  clamp(): void {
    this.setRange(this.from, this.to);
  }

  toX(t: number, widthPx: number): number {
    if (this.span <= 0) return 0;
    return ((t - this.from) / this.span) * widthPx;
  }

  toT(x: number, widthPx: number): number {
    if (widthPx <= 0) return this.from;
    return this.from + (x / widthPx) * this.span;
  }

  private spanLimit(): number {
    if (!this.bounds) return this.maxSpan;
    const domainSpan = Math.max(this.minSpan, this.bounds.to - this.bounds.from);
    return Math.min(this.maxSpan, Math.max(this.minSpan, domainSpan * 1.2));
  }

  private clampSpan(span: number): number {
    const upper = this.spanLimit();
    return Math.min(upper, Math.max(this.minSpan, span));
  }
}
