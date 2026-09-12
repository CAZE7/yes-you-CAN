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

test("toggling visibility is idempotent and ignores unknown signals", () => {
  const group = new ChartGroup();
  group.ensureSeries("engine.rpm");
  const reasons: string[] = [];
  group.subscribe((reason) => reasons.push(reason));

  group.setVisible("engine.rpm", true);
  group.setVisible("no.such.signal", false);
  assert.deepEqual(reasons, [], "a no-op must not make every chart redraw");

  group.toggleVisible("engine.rpm");
  assert.equal(group.series("engine.rpm")?.visible, false);
  group.toggleVisible("engine.rpm");
  assert.equal(group.series("engine.rpm")?.visible, true);
  group.toggleVisible("no.such.signal");
  assert.deepEqual(reasons, ["series", "series"], "only the two real changes notify");
});

test("follow can be switched back on and jumps to the newest sample", () => {
  const group = new ChartGroup({ defaultSpanMs: 1000, follow: true });
  group.push("engine.rpm", line(0, 5000, 100));
  group.zoomBy(2);
  assert.equal(group.follow, false);

  const frozen = group.viewport.range;
  group.setFollow(false);
  assert.deepEqual(group.viewport.range, frozen, "setting the same value changes nothing");

  group.setFollow(true);
  assert.equal(group.follow, true);
  assert.ok(group.viewport.to >= 5000, "re-enabling follow jumps to the newest sample");

  const empty = new ChartGroup({ follow: false });
  empty.setFollow(true);
  assert.equal(empty.follow, true, "follow can be armed before any data exists");
  assert.equal(empty.dataBounds(), null);
});

test("panning by pixels and by time moves the shared window and stops follow", () => {
  const group = new ChartGroup({ defaultSpanMs: 1000, follow: true });
  group.push("engine.rpm", line(0, 10_000, 100));
  group.fitAll();
  // Zoom in first: a fitted window sits on both bounds, so every pan would be
  // clamped and the assertion would test the clamp instead of the pan.
  group.zoomAt(4, 5000);
  const before = group.viewport.range;
  assert.ok(before.to - before.from < 10_000, "the window is narrower than the recording");

  // Dragging right (positive pixel delta) moves the window back in time.
  group.panByPixels(100, 800);
  const panned = group.viewport.range;
  assert.equal(group.follow, false, "a manual pan means the user wants to inspect");
  assert.ok(panned.from < before.from, "the window moved back in time");
  assert.equal(panned.to - panned.from, before.to - before.from, "panning keeps the span");

  group.panByMs(500);
  assert.equal(group.viewport.from, panned.from + 500);

  group.showAround(5000);
  const centred = group.viewport.range;
  assert.ok(centred.from < 5000 && centred.to > 5000, "the marker sits inside the window");
  group.showAround(2000, 400);
  assert.deepEqual(group.viewport.range, { from: 1800, to: 2200 }, "an explicit span is honoured");
});

test("a repeated cursor and a degenerate selection are ignored", () => {
  const group = new ChartGroup();
  const reasons: string[] = [];
  group.subscribe((reason) => reasons.push(reason));
  group.setCursor(10);
  group.setCursor(10);
  group.setSelection({ from: 100, to: 100 });
  assert.equal(group.selection, null, "a zero-width selection is not a selection");
  group.setSelection({ from: 400, to: 100 });
  assert.deepEqual(group.selection, { from: 100, to: 400 });
  assert.deepEqual(reasons, ["cursor", "selection"]);
});

test("statistics of an unknown signal are empty instead of throwing", () => {
  const group = new ChartGroup();
  assert.deepEqual(group.stats("does.not.exist"), {
    count: 0,
    min: null,
    max: null,
    average: null,
    delta: null,
    first: null,
    last: null,
  });
});

test("addMarker keeps the list ordered and clear() drops data but keeps the setup", () => {
  const group = new ChartGroup({ defaultSpanMs: 1000, follow: false });
  group.ensureSeries("engine.rpm", { name: "Drehzahl", unit: "rpm" });
  group.push("engine.rpm", line(0, 2000, 100));
  group.addMarker({ id: "m2", t: 1500, label: "DTC P0420", kind: "dtc" });
  group.addMarker({ id: "m1", t: 250, label: "Lastwechsel", kind: "user" });
  assert.deepEqual(
    group.markers.map((marker) => marker.id),
    ["m1", "m2"],
    "a marker added later but earlier in time sorts in front",
  );

  group.setCursor(500);
  group.setSelection({ from: 100, to: 900 });
  const reasons: string[] = [];
  group.subscribe((reason) => reasons.push(reason));
  group.clear();

  assert.deepEqual(group.markers, []);
  assert.equal(group.cursor, null);
  assert.equal(group.selection, null);
  assert.equal(group.series("engine.rpm")?.length, 0, "the samples are gone");
  assert.equal(group.series("engine.rpm")?.name, "Drehzahl", "the metadata survives");
  assert.equal(group.dataBounds(), null, "the recording bounds are reset");
  assert.deepEqual(reasons, ["series"], "one change, one notification");
});

test("a throwing subscriber is isolated and reported, not swallowed (AGENTS 34.25)", () => {
  // Symptom before the fix: the group caught subscriber errors in an empty
  // `catch {}`. Isolation is correct — a broken renderer must not break the
  // others — but the failure disappeared without a trace.
  const reported: Array<{ reason: string; message: string }> = [];
  const group = new ChartGroup({
    onListenerError: (error, reason) =>
      reported.push({ reason, message: error instanceof Error ? error.message : String(error) }),
  });
  const seen: string[] = [];
  group.subscribe(() => {
    throw new Error("renderer exploded");
  });
  group.subscribe((reason) => seen.push(reason));

  group.ensureSeries("engine.rpm");
  assert.deepEqual(seen, ["series"], "the healthy renderer still runs");
  assert.deepEqual(reported, [{ reason: "series", message: "renderer exploded" }]);
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
