/**
 * The strict plumbing every vector parser shares (ADR 0045).
 *
 * Typed reading of untrusted JSON with a *path* in every error (`vectors[3].peer[1]`)
 * and one meta-rule the conformance gate lives or dies by: nothing is accepted
 * silently. Unknown keys, wrong types, out-of-range numbers, and — above all —
 * a dropped vector without a recorded reason are errors, never coercion.
 */

export interface Report {
  readonly errors: string[];
}

export function fail(report: Report, path: string, message: string): void {
  report.errors.push(`${path}: ${message}`);
}

export type Json = Record<string, unknown>;

export function record(value: unknown, path: string, report: Report): Json | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(report, path, "expected an object");
    return undefined;
  }
  return value as Json;
}

export function array(value: unknown, path: string, report: Report): unknown[] | undefined {
  if (!Array.isArray(value)) {
    fail(report, path, "expected an array");
    return undefined;
  }
  return value;
}

export function bytes(
  value: unknown,
  path: string,
  report: Report,
  max: number,
  min = 1,
): number[] | undefined {
  const list = array(value, path, report);
  if (!list) return undefined;
  if (list.length < min)
    fail(report, path, min === 1 ? "must not be empty" : "length below minimum");
  if (list.length > max) fail(report, path, `at most ${max} entries`);
  const out: number[] = [];
  for (let i = 0; i < list.length; i++) {
    const entry = list[i];
    if (typeof entry !== "number" || !Number.isInteger(entry) || entry < 0 || entry > 255) {
      fail(report, `${path}[${i}]`, "expected a byte 0..255");
      continue;
    }
    out.push(entry);
  }
  return out;
}

export function integer(
  value: unknown,
  path: string,
  report: Report,
  min: number,
  max: number,
): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    fail(report, path, `expected an integer ${min}..${max}`);
    return undefined;
  }
  return value;
}

export function bool(value: unknown, path: string, report: Report): boolean | undefined {
  if (typeof value !== "boolean") {
    fail(report, path, "expected true or false");
    return undefined;
  }
  return value;
}

export function str(value: unknown, path: string, report: Report): string | undefined {
  if (typeof value !== "string" || value.length === 0) {
    fail(report, path, "expected a non-empty string");
    return undefined;
  }
  return value;
}

export function oneOf<T extends string>(
  value: unknown,
  path: string,
  report: Report,
  allowed: readonly T[],
): T | undefined {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    fail(report, path, `expected one of ${allowed.map((a) => JSON.stringify(a)).join(", ")}`);
    return undefined;
  }
  return value as T;
}

export function rejectExtras(
  obj: Json,
  allowed: readonly string[],
  path: string,
  report: Report,
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) fail(report, path, `unknown key ${JSON.stringify(key)}`);
  }
}

/* ------------------------------------------------------------------ isotp */
