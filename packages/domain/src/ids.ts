/**
 * Typed identifiers (target architecture §24: "IDs überall").
 *
 * Every entity gets a stable, prefixed id that travels through the whole
 * system — vehicle, session, ECU, trace, action, definition, measurement,
 * event. The brands below are zero-cost at runtime (plain strings); they
 * exist so the compiler refuses the classic mix-up of passing an ECU id
 * where a session id is expected.
 */

declare const idBrand: unique symbol;

/** A branded id: a plain string at runtime, a distinct type at compile time. */
export type Id<Tag extends string> = string & { readonly [idBrand]: Tag };

export type VehicleId = Id<"vehicle">;
export type SessionId = Id<"session">;
export type EcuId = Id<"ecu">;
export type TraceId = Id<"trace">;
export type ActionId = Id<"action">;
export type DefinitionId = Id<"definition">;
export type MeasurementId = Id<"measurement">;
export type EventId = Id<"event">;

/** Conventional prefix per id kind (`{prefix}_{time}_{counter}`). */
export const ID_PREFIXES = {
  vehicle: "veh",
  session: "session",
  ecu: "ecu",
  trace: "trace",
  action: "act",
  definition: "def",
  measurement: "meas",
  event: "evt",
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

/**
 * Adopt an existing string as a typed id without validation. Values produced
 * by an `IdGenerator` already carry the right prefix; this cast is for values
 * arriving from storage or the wire.
 */
export function asId<T extends Id<string>>(value: string): T {
  return value as T;
}

/** True when the id carries the conventional prefix for its kind. */
export function hasIdPrefix(value: string, kind: IdKind): boolean {
  return value.startsWith(`${ID_PREFIXES[kind]}_`);
}

/**
 * Adopt an id while asserting the conventional prefix — the variant for
 * boundaries where a malformed id must fail loudly instead of propagating.
 */
export function asIdOfKind<T extends Id<string>>(kind: IdKind, value: string): T {
  if (!hasIdPrefix(value, kind)) {
    throw new Error(`expected a ${kind} id with prefix "${ID_PREFIXES[kind]}_", got "${value}"`);
  }
  return value as T;
}
