/**
 * Fixture patches: `Partial<T>` that may also set an optional field to `undefined`.
 *
 * `exactOptionalPropertyTypes` separates two things the mappers in this
 * repository deliberately treat apart: a field that is *absent* and a field that
 * is *present and undefined*. A decoded signal may arrive with `unit: undefined`
 * (an ECU that answered without a unit), and the mapper's contract is to omit the
 * field from the projection — which is exactly what the tests assert with
 * `"unit" in reading === false`.
 *
 * A strict `Partial<T>` cannot express "pass `unit` as undefined on purpose"
 * (that is the point of the flag), so fixtures use this patch type instead: the
 * *input* of a fixture may carry an explicit `undefined`, while every production
 * type keeps the exact form. The type lives here once instead of in seven spec
 * files, and it is test-only code — package builds exclude specs and the
 * `tests` directory, so nothing under `src/` links against it.
 */
export type FixturePatch<T> = { [K in keyof T]?: T[K] | undefined };

/**
 * The same patch with every `undefined` entry removed.
 *
 * Used where a patch is spread straight into an options object (`new
 * UdsServer(link, { ..., ...dropUndefined(options) })`): the running code then
 * sees exactly what a caller who simply left the field out would produce.
 */
export function dropUndefined<T extends object>(patch: FixturePatch<T>): Partial<T> {
  const result: Partial<T> = {};
  for (const key of Object.keys(patch) as Array<keyof T>) {
    const value = patch[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}

/**
 * Build a fixture from `defaults`, overlaid by `patch` — where an `undefined` in
 * the patch **removes** the key from the result instead of blanking it.
 *
 * That is the difference the specs are about: `makeEcuSession({ lastError:
 * undefined })` says "this ECU never reported an error", and the assertion is
 * `"lastError" in summary === false`. Blanking the default (what a plain spread
 * does) would leave the key present and test nothing; keeping the default (what
 * {@link dropUndefined} does) would test the opposite. Removing is the only
 * spelling that produces the input the test names describe.
 */
export function patched<T extends object>(defaults: T, patch: FixturePatch<T> = {}): T {
  // The copy is mutated by key, so it is viewed as a plain record here; the
  // declared return type is restored by the cast at the end of the function.
  const result = { ...defaults } as Record<string, unknown>;
  for (const key of Object.keys(patch) as Array<keyof T>) {
    const value = patch[key];
    if (value === undefined) delete result[key as string];
    else result[key as string] = value;
  }
  return result as T;
}

/**
 * A copy of `value` without the named optional keys — the runtime counterpart of
 * {@link FixturePatch} for fixtures that are read by *production* functions
 * (`toMeasurementReading(sample)`, `decodedToReading(decoded)`), whose parameter
 * types stay exact.
 *
 * Deleting is the precise spelling of "this reading has no unit": assigning
 * `undefined` would leave the key present, and a test that builds its input that
 * way no longer demonstrates what the mapper does with a field that never came.
 */
export function without<T extends object, K extends keyof T>(value: T, ...keys: K[]): T {
  const copy = { ...value };
  for (const key of keys) delete copy[key];
  return copy;
}
