/**
 * Canvas renderer for one measurement signal (AGENTS 16).
 *
 * This file draws and only draws. Every decision that could be wrong — zoom
 * limits, cursor snapping, decimation, statistics, window clamping — lives in
 * `@vdp/charts` and is served to the browser as `/lib/index.js`, so the browser
 * runs exactly the module the unit tests run.
 *
 * Interaction map (per chart, but everything goes through the shared group so
 * all charts stay synchronous):
 *   wheel            zoom at the pointer
 *   drag             pan
 *   shift + drag     select a time range
 *   double click     fit the whole recording
 *   move             move the shared cursor
 */

import {
  computeYRange,
  decimate,
  formatClock,
  formatValue,
  niceTicks,
  niceTimeTicks,
} from "/lib/index.js";

const THEME = {
  grid: "rgba(141, 149, 167, 0.16)",
  axisText: "rgba(141, 149, 167, 0.85)",
  hint: "rgba(141, 149, 167, 0.55)",
  line: "#4f9cf9",
  cursor: "rgba(230, 233, 240, 0.75)",
  selection: "rgba(79, 156, 249, 0.18)",
  selectionEdge: "rgba(79, 156, 249, 0.6)",
  outOfRange: "#f9654f",
  marker: {
    dtc: "#f9654f",
    user: "#4ff9a9",
    action: "#4f9cf9",
    note: "#f9a94f",
    anomaly: "#f9a94f",
  },
};

const PADDING = { top: 10, right: 12, bottom: 20, left: 56 };

export class SignalChart {
  /**
   * @param {object} options
   * @param {import('/lib/index.js').ChartGroup} options.group shared state
   * @param {import('/lib/index.js').Series} options.series series to draw
   * @param {HTMLCanvasElement} options.canvas
   */
  constructor({ group, series, canvas, color = THEME.line }) {
    this.group = group;
    this.series = series;
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.color = series.color ?? color;
    this.decimationMode = "minmax";
    this.plot = { left: PADDING.left, width: 1, top: PADDING.top, height: 1 };
    this.frame = 0;
    this.drag = null;

    this.onWheel = this.onWheel.bind(this);
    this.onPointerDown = this.onPointerDown.bind(this);
    this.onPointerMove = this.onPointerMove.bind(this);
    this.onPointerUp = this.onPointerUp.bind(this);
    this.onDoubleClick = this.onDoubleClick.bind(this);
    this.onResize = this.onResize.bind(this);

    canvas.addEventListener("wheel", this.onWheel, { passive: false });
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointercancel", this.onPointerUp);
    canvas.addEventListener("dblclick", this.onDoubleClick);
    window.addEventListener("resize", this.onResize);
  }

  destroy() {
    this.canvas.removeEventListener("wheel", this.onWheel);
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("pointermove", this.onPointerMove);
    this.canvas.removeEventListener("pointerup", this.onPointerUp);
    this.canvas.removeEventListener("pointercancel", this.onPointerUp);
    this.canvas.removeEventListener("dblclick", this.onDoubleClick);
    window.removeEventListener("resize", this.onResize);
    if (this.frame) cancelAnimationFrame(this.frame);
  }

  /** One paint per animation frame, regardless of the sample rate. */
  schedule() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  onResize() {
    this.draw();
  }

  // ------------------------------------------------------------ interaction

  /** Time under a pointer event, computed from the last painted geometry. */
  timeAt(event) {
    const rect = this.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left - this.plot.left;
    return this.group.viewport.toT(x, this.plot.width);
  }

  onWheel(event) {
    event.preventDefault();
    const factor = event.deltaY < 0 ? 1.25 : 1 / 1.25;
    this.group.zoomAt(factor, this.timeAt(event));
  }

  onPointerDown(event) {
    this.canvas.setPointerCapture?.(event.pointerId);
    const t = this.timeAt(event);
    this.drag = {
      startX: event.clientX,
      lastX: event.clientX,
      startT: t,
      select: event.shiftKey,
      moved: false,
    };
    if (event.shiftKey) this.group.setSelection({ from: t, to: t });
    else this.group.setCursor(t);
  }

  onPointerMove(event) {
    if (!this.drag) {
      this.group.setCursor(this.timeAt(event));
      return;
    }
    const deltaX = event.clientX - this.drag.lastX;
    if (Math.abs(event.clientX - this.drag.startX) > 2) this.drag.moved = true;
    this.drag.lastX = event.clientX;
    if (this.drag.select) {
      const t = this.timeAt(event);
      this.group.setSelection({ from: this.drag.startT, to: t });
    } else {
      this.group.panByPixels(deltaX, this.plot.width);
    }
  }

  onPointerUp(event) {
    if (!this.drag) return;
    const drag = this.drag;
    this.drag = null;
    this.canvas.releasePointerCapture?.(event.pointerId);
    // A shift-click without movement is not a selection — drop it again.
    if (drag.select && !drag.moved) this.group.clearSelection();
  }

  onDoubleClick() {
    this.group.fitAll();
  }

  // ---------------------------------------------------------------- drawing

  draw() {
    const canvas = this.canvas;
    const rect = canvas.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;
    if (width < 10 || height < 10) return;

    const ratio = window.devicePixelRatio || 1;
    const pixelWidth = Math.round(width * ratio);
    const pixelHeight = Math.round(height * ratio);
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    const ctx = this.ctx;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.font = "10px system-ui, -apple-system, sans-serif";
    ctx.textBaseline = "middle";

    const plotW = width - PADDING.left - PADDING.right;
    const plotH = height - PADDING.top - PADDING.bottom;
    if (plotW <= 0 || plotH <= 0) return;
    this.plot = { left: PADDING.left, width: plotW, top: PADDING.top, height: plotH };

    const viewport = this.group.viewport;
    const range = viewport.range;
    const points = this.series.slice(range);
    const yRange = computeYRange(
      points.map((point) => point.value),
      {
        ...(this.series.min !== undefined ? { min: this.series.min } : {}),
        ...(this.series.max !== undefined ? { max: this.series.max } : {}),
      },
    );
    const x = (t) => PADDING.left + viewport.toX(t, plotW);
    const y = (value) =>
      PADDING.top + plotH - ((value - yRange.min) / (yRange.max - yRange.min)) * plotH;

    this.drawGrid(ctx, PADDING, plotW, plotH, yRange, range, x);
    this.drawSelection(ctx, PADDING, plotH, x);
    this.drawMarkers(ctx, PADDING, plotH, range, x);

    if (points.length === 0) {
      ctx.fillStyle = THEME.hint;
      ctx.fillText("keine Daten im gewählten Zeitraum", PADDING.left + 8, PADDING.top + plotH / 2);
    } else {
      this.drawSeries(ctx, points, x, y, plotW);
    }

    this.drawCursor(ctx, PADDING, plotW, plotH, x, y);

    // Frame last, so the plot area is clearly delimited.
    ctx.strokeStyle = THEME.grid;
    ctx.lineWidth = 1;
    ctx.strokeRect(PADDING.left, PADDING.top, plotW, plotH);
  }

  drawGrid(ctx, padding, plotW, plotH, yRange, range, x) {
    ctx.strokeStyle = THEME.grid;
    ctx.fillStyle = THEME.axisText;
    ctx.lineWidth = 1;

    for (const tick of niceTicks(yRange.min, yRange.max, 4)) {
      const y = padding.top + plotH - ((tick - yRange.min) / (yRange.max - yRange.min)) * plotH;
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(padding.left + plotW, y);
      ctx.stroke();
      ctx.fillText(formatValue(tick), 6, y);
    }

    ctx.textAlign = "center";
    for (const tick of niceTimeTicks(range.from, range.to, 6)) {
      const px = x(tick);
      if (px < padding.left || px > padding.left + plotW) continue;
      ctx.beginPath();
      ctx.moveTo(px, padding.top);
      ctx.lineTo(px, padding.top + plotH);
      ctx.stroke();
      ctx.fillText(formatClock(tick), px, padding.top + plotH + 10);
    }
    ctx.textAlign = "left";
  }

  drawSelection(ctx, padding, plotH, x) {
    const selection = this.group.selection;
    if (!selection) return;
    const from = Math.max(x(selection.from), padding.left);
    const to = Math.min(x(selection.to), padding.left + this.plot.width);
    if (to <= from) return;
    ctx.fillStyle = THEME.selection;
    ctx.fillRect(from, padding.top, to - from, plotH);
    ctx.strokeStyle = THEME.selectionEdge;
    ctx.beginPath();
    ctx.moveTo(from, padding.top);
    ctx.lineTo(from, padding.top + plotH);
    ctx.moveTo(to, padding.top);
    ctx.lineTo(to, padding.top + plotH);
    ctx.stroke();
  }

  drawMarkers(ctx, padding, plotH, range, x) {
    const markers = this.group.markersInWindow(range);
    let lastLabelRight = Number.NEGATIVE_INFINITY;
    for (const marker of markers) {
      const px = x(marker.t);
      ctx.strokeStyle = THEME.marker[marker.kind] ?? THEME.marker.note;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(px, padding.top);
      ctx.lineTo(px, padding.top + plotH);
      ctx.stroke();
      ctx.setLineDash([]);

      // Labels only when there is room — overlapping marker text is worse than
      // no text at all; the marker list next to the charts carries the details.
      const label = marker.label.length > 18 ? `${marker.label.slice(0, 17)}…` : marker.label;
      const textWidth = ctx.measureText(label).width;
      if (px + 4 > lastLabelRight && px + textWidth + 6 < padding.left + this.plot.width) {
        ctx.fillStyle = THEME.marker[marker.kind] ?? THEME.marker.note;
        ctx.fillText(label, px + 3, padding.top + 7);
        lastLabelRight = px + textWidth + 8;
      }
    }
  }

  drawSeries(ctx, points, x, y, plotW) {
    // Out-of-range samples are drawn before decimation: dropping them would
    // hide exactly the anomaly the operator is looking for (AGENTS 14).
    ctx.fillStyle = THEME.outOfRange;
    for (const point of points) {
      if (!point.outOfRange) continue;
      ctx.fillRect(x(point.t) - 1.5, y(point.value) - 1.5, 3, 3);
    }

    const drawn = decimate(points, Math.max(32, Math.round(plotW * 2)), this.decimationMode);
    ctx.strokeStyle = this.color;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    let started = false;
    for (const point of drawn) {
      const px = x(point.t);
      const py = y(point.value);
      if (!started) {
        ctx.moveTo(px, py);
        started = true;
      } else {
        ctx.lineTo(px, py);
      }
    }
    ctx.stroke();
  }

  drawCursor(ctx, padding, plotW, plotH, x, y) {
    const t = this.group.cursor;
    if (t === null) return;
    const px = x(t);
    if (px < padding.left || px > padding.left + plotW) return;
    ctx.strokeStyle = THEME.cursor;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(px, padding.top);
    ctx.lineTo(px, padding.top + plotH);
    ctx.stroke();
    ctx.setLineDash([]);

    const point = this.series.valueAt(t);
    if (!point) return;
    ctx.fillStyle = this.color;
    ctx.beginPath();
    ctx.arc(px, y(point.value), 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
}
