/**
 * Unit tests for the chart core (AGENTS 16, 31, 34.8).
 *
 * Every rule that makes the graphs trustworthy lives in a pure function here:
 * zoom limits, cursor snapping, decimation that cannot hide a spike, and the
 * shared state that keeps several charts synchronised.
 */

import assert from "node:assert/strict";
import { test } from "vitest";
import {
  ChartGroup,
  type Point,
  Series,
  TimeViewport,
  computeYRange,
  decimate,
  decimateMinMax,
  formatClock,
  niceTicks,
  niceTimeTicks,
} from "./index.js";

function line(
  from: number,
  to: number,
  step: number,
  fn: (t: number) => number = (t) => t,
): Point[] {
  const points: Point[] = [];
  for (let t = from; t <= to; t += step) points.push({ t, value: fn(t) });
  return points;
}

/* -------------------------------------------------------------------- series */

test("series stays sorted even when samples arrive out of order", () => {
  const series = new Series({ id: "engine.rpm" });
  series.pushMany([
    { t: 0, value: 800 },
    { t: 200, value: 2400 },
    { t: 100, value: 1600 },
  ]);
  series.push({ t: 50, value: 1200 });
  assert.deepEqual(
    series.all.map((p) => p.t),
    [0, 50, 100, 200],
  );
});

test("series statistics return min/max/average/delta over a window (AGENTS 16)", () => {
  const series = new Series({ id: "engine.coolant_temperature", unit: "°C" });
  series.pushMany(line(0, 1000, 100, (t) => t / 10));
  const stats = series.stats();
  assert.equal(stats.count, 11);
  assert.equal(stats.min, 0);
  assert.equal(stats.max, 100);
  assert.equal(stats.delta, 100);
  assert.equal(stats.average, 50);

  const window = series.stats({ from: 0, to: 300 });
  assert.equal(window.max, 30);
  assert.equal(window.count, 4);
});

test("valueAt snaps to the nearest sample and respects a tolerance", () => {
  const series = new Series({ id: "engine.rpm" });
  series.pushMany(line(0, 1000, 100, (t) => t));
  assert.equal(series.valueAt(240)?.t, 200);
  assert.equal(series.valueAt(260)?.t, 300);
  // A cursor far outside the recording must not show a stale value.
  assert.equal(series.valueAt(5000, 50), null);
});

test("series slice uses inclusive bounds and stays empty outside the data", () => {
  const series = new Series({ id: "vehicle.speed" });
  series.pushMany(line(100, 500, 100));
  assert.deepEqual(
    series.slice({ from: 200, to: 300 }).map((p) => p.t),
    [200, 300],
  );
  assert.deepEqual(series.slice({ from: 600, to: 700 }), []);
  assert.deepEqual(series.extent(), { from: 100, to: 500 });
});

test("series respects its ring buffer limit", () => {
  const series = new Series({ id: "engine.rpm", maxPoints: 5 });
  series.pushMany(line(0, 900, 100));
  assert.equal(series.length, 5);
  assert.equal(series.first?.t, 500);
  assert.equal(series.last?.t, 900);
});

/* ----------------------------------------------------------------- decimation */

test("min/max decimation keeps spikes that naive sampling would hide", () => {
  const points = line(0, 9999, 1, () => 0);
  points[5000] = { t: 5000, value: 1000 };
  points[7500] = { t: 7500, value: -1000 };
  const reduced = decimateMinMax(points, 100);
  assert.ok(reduced.length <= 100, `expected at most 100 points, got ${reduced.length}`);
  const values = reduced.map((p) => p.value);
  assert.ok(values.includes(1000), "the positive spike must survive decimation");
  assert.ok(values.includes(-1000), "the negative spike must survive decimation");
  assert.equal(reduced[0]?.t, 0);
  assert.equal(reduced[reduced.length - 1]?.t, 9999);
});

test("decimation output stays chronologically sorted and bounded", () => {
  const points = line(0, 50_000, 7, (t) => Math.sin(t / 500) * 100);
  for (const mode of ["minmax", "lttb"] as const) {
    const reduced = decimate(points, 200, mode);
    assert.ok(reduced.length <= 200, `${mode}: expected at most 200 points, got ${reduced.length}`);
    for (let i = 1; i < reduced.length; i++) {
      assert.ok(
        (reduced[i]?.t ?? 0) >= (reduced[i - 1]?.t ?? 0),
        `${mode}: output must stay sorted`,
      );
    }
    assert.equal(reduced[0]?.t, 0, `${mode}: first point is kept`);
    assert.equal(reduced[reduced.length - 1]?.t, 49_994, `${mode}: last point is kept`);
  }
});

test("decimation is a no-op for small series and for maxPoints <= 0", () => {
  const points = line(0, 10, 1);
  assert.equal(decimate(points, 100).length, points.length);
  assert.deepEqual(decimate(points, 0), []);
});

/* ------------------------------------------------------------------- viewport */

test("zoom keeps the anchor point under the cursor", () => {
  const viewport = new TimeViewport({ span: 1000, minSpan: 10 });
  viewport.setRange(0, 1000);
  viewport.zoomAt(2, 750);
  // 750 was at 75 % of the window; after zooming in by 2 it still is.
  assert.equal(viewport.span, 500);
  assert.ok(Math.abs((750 - viewport.from) / viewport.span - 0.75) < 1e-9);
});

test("zoom clamps to min and max span instead of collapsing", () => {
  const viewport = new TimeViewport({ span: 1000, minSpan: 100, maxSpan: 2000 });
  viewport.setRange(0, 1000);
  for (let i = 0; i < 50; i++) viewport.zoomBy(2);
  assert.equal(viewport.span, 100, "zoom in stops at minSpan");
  for (let i = 0; i < 50; i++) viewport.zoomBy(0.5);
  assert.equal(viewport.span, 2000, "zoom out stops at maxSpan");
});

test("the viewport never leaves the recording bounds", () => {
  const viewport = new TimeViewport({ span: 500, minSpan: 100, bounds: { from: 0, to: 1000 } });
  viewport.setRange(-5000, -4000);
  assert.ok(viewport.from >= 0, "panning before the start clamps to the start");
  viewport.setRange(9000, 9500);
  assert.ok(viewport.to <= 1000, "panning past the end clamps to the end");
  viewport.panByMs(-100_000);
  assert.equal(viewport.from, 0);
  assert.equal(viewport.span, 500, "clamping slides the window instead of shrinking it");
});

test("dragging right moves the window back in time", () => {
  const viewport = new TimeViewport({ span: 1000, bounds: { from: 0, to: 10_000 } });
  viewport.setRange(5000, 6000);
  viewport.panByPixels(100, 500); // drag 100 px right on a 500 px wide chart
  assert.equal(viewport.from, 4800);
  assert.equal(viewport.to, 5800);
});

test("fit shows the whole recording, follow keeps the span at the newest sample", () => {
  const viewport = new TimeViewport({
    span: 1000,
    bounds: { from: 200, to: 1200 },
    paddingFraction: 0.1,
  });
  viewport.fit();
  assert.ok(viewport.from <= 200 && viewport.to >= 1200, "fit must cover the data");

  const following = new TimeViewport({ span: 1000, paddingFraction: 0.05 });
  following.followTo(5000);
  assert.equal(following.span, 1000, "following must not change the zoom level");
  assert.equal(following.to, 5050, "the newest sample sits just left of the right edge");
});

test("pixel mapping round-trips", () => {
  const viewport = new TimeViewport({ span: 2000 });
  viewport.setRange(1000, 3000);
  const x = viewport.toX(2000, 800);
  assert.equal(x, 400);
  assert.equal(viewport.toT(x, 800), 2000);
});

/* ---------------------------------------------------------------------- group */

test("one group keeps every chart on the same window and cursor (AGENTS 16)", () => {
  const group = new ChartGroup({ defaultSpanMs: 1000, follow: false });
  group.ensureSeries("engine.rpm", { name: "Drehzahl", unit: "rpm" });
  group.ensureSeries("vehicle.speed", { name: "Geschwindigkeit", unit: "km/h" });
  group.push("engine.rpm", line(0, 2000, 100));
  group.push("vehicle.speed", line(0, 2000, 100));

  group.fitAll();
  const first = group.viewport.range;
  group.zoomAt(2, 1000);
  const second = group.viewport.range;
  assert.ok(second.to - second.from < first.to - first.from, "zoom must shrink the window");

  group.setCursor(1000);
  const readout = group.readout();
  assert.equal(readout.t, 1000);
  assert.equal(readout.rows.length, 2);
  assert.equal(readout.rows[0]?.value, 1000, "the cursor reads both series at the same time");
  assert.equal(readout.rows[1]?.value, 1000);
});

test("following live data moves the shared window, a manual zoom stops it", () => {
  const group = new ChartGroup({ defaultSpanMs: 1000, follow: true });
  group.push("engine.rpm", line(0, 5000, 100));
  assert.ok(group.viewport.to >= 5000, "a following viewport shows the newest sample");
  assert.equal(group.follow, true);

  group.zoomBy(2);
  assert.equal(group.follow, false, "zooming means the user wants to inspect — stop following");
  const frozen = group.viewport.range;
  group.push("engine.rpm", line(5100, 9000, 100));
  assert.deepEqual(group.viewport.range, frozen, "a frozen window must not move");
});

test("window presets change the span without moving the right edge", () => {
  const group = new ChartGroup({ defaultSpanMs: 10_000, follow: false });
  group.push("engine.rpm", line(0, 60_000, 100));
  group.fitAll();
  const right = group.viewport.to;
  group.setSpan(5000);
  assert.equal(group.viewport.span, 5000);
  assert.equal(group.viewport.to, right, "the right edge stays put");
  assert.equal(group.follow, false);
  assert.equal(group.setSpan(0), undefined, "an invalid span is ignored");
  assert.equal(group.viewport.span, 5000);
});

test("selections are normalized and reported per series", () => {
  const group = new ChartGroup({ defaultSpanMs: 10_000, follow: false });
  group.push(
    "engine.rpm",
    line(0, 5000, 100, (t) => t),
  );
  group.setSelection({ from: 3000, to: 1000 });
  assert.deepEqual(group.selection, { from: 1000, to: 3000 }, "a selection is order independent");
  const stats = group.selectionStats("engine.rpm");
  assert.equal(stats?.min, 1000);
  assert.equal(stats?.max, 3000);
  assert.equal(group.selectionStats("unknown"), null);
  group.clearSelection();
  assert.equal(group.selection, null);
});

test("markers are time ordered and filtered to the visible window", () => {
  const group = new ChartGroup({ defaultSpanMs: 1000, follow: false });
  // A recording that spans both markers, so "fit" really shows both.
  group.push("engine.rpm", line(0, 3000, 100));
  group.setMarkers([
    { id: "m2", t: 2000, label: "DTC P0420", kind: "dtc" },
    { id: "m1", t: 500, label: "Lastwechsel", kind: "user" },
  ]);
  assert.deepEqual(
    group.markers.map((m) => m.id),
    ["m1", "m2"],
    "markers are time ordered regardless of insertion order",
  );
  group.fitAll();
  assert.deepEqual(
    group.markersInWindow().map((m) => m.id),
    ["m1", "m2"],
  );
  assert.deepEqual(
    group.markersInWindow({ from: 600, to: 2500 }).map((m) => m.id),
    ["m2"],
    "only markers inside the window are drawn",
  );
});

test("hidden series stay in the group but leave the plot", () => {
  const group = new ChartGroup();
  group.ensureSeries("engine.rpm");
  group.ensureSeries("vehicle.speed");
  group.setVisible("vehicle.speed", false);
  assert.deepEqual(
    group.visibleSeries.map((s) => s.id),
    ["engine.rpm"],
  );
  assert.equal(group.stats("vehicle.speed").count, 0, "hidden series still hold their data");
  assert.equal(group.readout().rows.length, 2, "the readout lists every known signal");
});

test("subscribers learn what changed", () => {
  const group = new ChartGroup();
  const reasons: string[] = [];
  const unsubscribe = group.subscribe((reason) => reasons.push(reason));
  group.ensureSeries("engine.rpm");
  group.setCursor(10);
  group.addMarker({ id: "m1", t: 10, label: "x", kind: "user" });
  unsubscribe();
  group.setCursor(20);
  assert.deepEqual(reasons, ["series", "cursor", "markers"]);
});

test("metadata that arrives late fills gaps without overwriting documented values", () => {
  // Symptom (found by front end type checking): a live sample auto-creates a
  // series that only carries its id; the colour/name assigned later by the
  // chart setup was silently dropped, so the readout lost the series colour
  // and the UI had to mutate a readonly field to work around it.
  const group = new ChartGroup();
  const byLiveSample = group.push("engine.rpm", [{ t: 0, value: 800 }]);
  assert.equal(byLiveSample.name, "engine.rpm", "auto-created series fall back to the id");
  assert.equal(byLiveSample.color, undefined);

  const ensured = group.ensureSeries("engine.rpm", {
    name: "Drehzahl",
    unit: "rpm",
    color: "#4f9cf9",
  });
  assert.equal(ensured, byLiveSample, "ensureSeries returns the very same series");
  assert.equal(ensured.name, "Drehzahl", "a still-default name may be replaced");
  assert.equal(ensured.unit, "rpm");
  assert.equal(ensured.color, "#4f9cf9", "late colour lands on the existing series");

  group.ensureSeries("engine.rpm", { name: "andere Quelle", color: "#000000" });
  assert.equal(ensured.name, "Drehzahl", "documented values are never overwritten");
  assert.equal(ensured.color, "#4f9cf9", "documented values are never overwritten");
});

/* ---------------------------------------------------------------------- scale */

test("nice ticks stay inside the range and keep a readable count", () => {
  const ticks = niceTicks(0, 100, 5);
  assert.deepEqual(ticks, [0, 20, 40, 60, 80, 100]);
  const small = niceTicks(0, 0.4, 4);
  assert.ok(small.length >= 3 && small.length <= 8, `readable tick count, got ${small.length}`);
  assert.ok(small.every((t) => t >= 0 && t <= 0.4));
  assert.deepEqual(niceTicks(5, 5), [5], "a degenerate range still yields one tick");
});

test("time ticks use round millisecond steps", () => {
  const ticks = niceTimeTicks(0, 10_000, 5);
  assert.ok(ticks.length >= 3);
  assert.ok(ticks.every((t) => Number.isInteger(t)));
  assert.equal(formatClock(65_432), "01:05.432");
});

test("y range widens a flat line and honours declared limits", () => {
  const flat = computeYRange([50, 50, 50]);
  assert.ok(flat.max > flat.min, "a constant signal still needs a scale");

  const limited = computeYRange([10, 20], { min: 0, max: 100 });
  assert.ok(
    limited.min <= 0 && limited.max >= 100,
    "declared limits are always visible (AGENTS 14)",
  );

  const empty = computeYRange([]);
  assert.ok(empty.max > empty.min);
});
