/** Deterministic-friendly id generation (injectable for tests). */

export type Clock = () => number;

export const systemClock: Clock = () => Date.now();

let counter = 0;

export function createId(prefix = 'id', clock: Clock = systemClock): string {
  counter = (counter + 1) % 0xffff;
  return `${prefix}_${clock().toString(36)}_${counter.toString(36)}`;
}

export function nowIso(clock: Clock = () => Date.now()): string {
  return new Date(clock()).toISOString();
}
