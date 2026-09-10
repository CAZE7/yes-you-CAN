/**
 * Canvas chart with a shared time axis (AGENTS 16: "synchronisierte Graphen").
 *
 * No chart library: a few hundred lines of canvas code are easier to audit than
 * a dependency, and the axis has to line up exactly across charts anyway.
 */

const PALETTE = ['#4f9cf9', '#f9a94f', '#4ff9a9', '#f94f9c', '#c74ff9', '#f9f14f'];

export class LineChart {
  /** @type {Map<string, {t:number, value:number}[]>} */
  #series = new Map();
  #canvas;
  #ctx;
  #windowMs;
  #now = 0;
  #frame = 0;
  #label;
  #unit;

  constructor(canvas, { label = '', unit = '', windowMs = 20000 } = {}) {
    this.#canvas = canvas;
    this.#ctx = canvas.getContext('2d');
    this.#windowMs = windowMs;
    this.#label = label;
    this.#unit = unit;
    this.#resize();
    window.addEventListener('resize', () => this.#resize());
  }

  #resize() {
    const ratio = window.devicePixelRatio || 1;
    const rect = this.#canvas.getBoundingClientRect();
    this.#canvas.width = Math.max(1, Math.round(rect.width * ratio));
    this.#canvas.height = Math.max(1, Math.round(rect.height * ratio));
    this.#ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    this.draw();
  }

  /** Append a decoded sample. Values are already physical — the UI never scales. */
  push(signal, t, value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return;
    const points = this.#series.get(signal) ?? [];
    points.push({ t, value });
    this.#series.set(signal, points);
    this.#now = Math.max(this.#now, t);
    this.#trim();
  }

  #trim() {
    const cutoff = this.#now - this.#windowMs;
    for (const [signal, points] of this.#series) {
      const kept = points.filter((point) => point.t >= cutoff);
      if (kept.length === 0) this.#series.delete(signal);
      else this.#series.set(signal, kept);
    }
  }

  clear() {
    this.#series.clear();
    this.draw();
  }

  get signals() {
    return Array.from(this.#series.keys());
  }

  draw() {
    const ctx = this.#ctx;
    const rect = this.#canvas.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;
    ctx.clearRect(0, 0, width, height);

    const padding = { top: 10, right: 12, bottom: 20, left: 46 };
    const plotW = width - padding.left - padding.right;
    const plotH = height - padding.top - padding.bottom;
    if (plotW <= 0 || plotH <= 0) return;

    const t1 = this.#now || this.#windowMs;
    const t0 = t1 - this.#windowMs;
    let min = Infinity;
    let max = -Infinity;
    for (const points of this.#series.values()) {
      for (const point of points) {
        if (point.t < t0) continue;
        min = Math.min(min, point.value);
        max = Math.max(max, point.value);
      }
    }
    if (!Number.isFinite(min)) {
      min = 0;
      max = 1;
    }
    if (min === max) {
      min -= 1;
      max += 1;
    }
    const span = max - min;
    min -= span * 0.08;
    max += span * 0.08;

    // Grid + axis labels.
    ctx.strokeStyle = 'rgba(128,128,128,0.22)';
    ctx.fillStyle = 'rgba(128,128,128,0.9)';
    ctx.font = '10px system-ui, sans-serif';
    ctx.lineWidth = 1;
    const rows = 4;
    for (let i = 0; i <= rows; i++) {
      const y = padding.top + (plotH * i) / rows;
      const value = max - ((max - min) * i) / rows;
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(padding.left + plotW, y);
      ctx.stroke();
      ctx.fillText(formatAxis(value), 4, y + 3);
    }
    const cols = 4;
    for (let i = 0; i <= cols; i++) {
      const x = padding.left + (plotW * i) / cols;
      const t = t0 + ((t1 - t0) * i) / cols;
      ctx.beginPath();
      ctx.moveTo(x, padding.top);
      ctx.lineTo(x, padding.top + plotH);
      ctx.stroke();
      ctx.fillText(`${((t - t1) / 1000).toFixed(0)}s`, x - 8, height - 6);
    }

    // Series.
    let index = 0;
    for (const [signal, points] of this.#series) {
      const color = PALETTE[index % PALETTE.length] ?? '#4f9cf9';
      index += 1;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      let started = false;
      for (const point of points) {
        if (point.t < t0) continue;
        const x = padding.left + ((point.t - t0) / (t1 - t0)) * plotW;
        const y = padding.top + plotH - ((point.value - min) / (max - min)) * plotH;
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.stroke();
      ctx.fillStyle = color;
      const last = points.at(-1);
      if (last) ctx.fillText(`${signal}: ${formatAxis(last.value)}${this.#unit ? ` ${this.#unit}` : ''}`, padding.left + 4, padding.top + 10 + index * 11);
    }

    if (this.#label && this.#series.size === 0) {
      ctx.fillStyle = 'rgba(128,128,128,0.6)';
      ctx.fillText('waiting for data…', padding.left + 6, padding.top + 14);
    }
  }

  /** Throttled redraw — one paint per animation frame regardless of sample rate. */
  schedule() {
    if (this.#frame) return;
    this.#frame = requestAnimationFrame(() => {
      this.#frame = 0;
      this.draw();
    });
  }
}

function formatAxis(value) {
  const abs = Math.abs(value);
  if (abs >= 10000) return value.toFixed(0);
  if (abs >= 100) return value.toFixed(0);
  if (abs >= 1) return value.toFixed(1);
  return value.toFixed(2);
}
