/**
 * @vdp/charts — DOM-free chart mathematics for the measurement graphs
 * (AGENTS 16).
 *
 * Kept free of any DOM or canvas reference so every rule that makes the graphs
 * useful (zoom limits, cursor snapping, decimation, statistics, synchronisation)
 * is unit-testable without a browser (AGENTS 34.8). The canvas renderer in
 * `apps/web/public/chart.js` consumes this package and does nothing but draw.
 */

export * from './types.js';
export * from './scale.js';
export * from './decimate.js';
export * from './series.js';
export * from './viewport.js';
export * from './group.js';
