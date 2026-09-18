/**
 * The vector parsers, one barrel (ADR 0045).
 *
 * The file was split at its natural seam — shared strict primitives, the
 * ISO-TP reader and the write-safety reader each live in one module and stay
 * under the size budget (`ausgelagert statt ausgenommen`, the precedent of
 * `apps/web/src/route-input.ts`); consumers keep importing `./vectors.js`
 * because the two families remain one contract: the vector files.
 */

export * from "./isotp-vectors.js";
export * from "./safety-vectors.js";
