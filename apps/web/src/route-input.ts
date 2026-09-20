/**
 * The grammar of what an operator types into the workbench (AGENTS 34.21, 0.E E23/E24).
 *
 * Two things live here because they are one rule seen from both sides: an input that is not
 * what it claims to be is refused with a sentence, and the refusal carries the status the
 * route answers with. Both are here rather than inline in `server.ts` for a reason each:
 * `parseCanId` is handed seven routes (a grammar per route is seven grammars), and `server.ts`
 * crossed its size budget the moment the chaos switches got their validation — which is the
 * gate saying this seam wants to be a module (ADR 0014: a route stays a route).
 *
 * Why the strictness is not decoration: `Number.parseInt` stops at the first character it
 * cannot read, so `"7e8xyz"` used to answer as 0x7E8 and an id typed one key too long read
 * another ECU's freeze frame; a number was not range-checked at all, so `2 ** 33` reached the
 * bus as a truncated id. A burst of `NaN` frames arms a rule that never ends, and a rate
 * outside 0…1 is a probability that does not mean what the field says. Refusing with the
 * offending text quoted is the only honest answer, and it is what makes these fields worth
 * typing into.
 */

/** Error carrying the HTTP status the request should fail with. */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/** Parse a CAN identifier from the UI (`0x7E8`, `7e8` or `2024`). */
export function parseCanId(value: unknown): number {
  // One grammar for both spellings. A number is not exempt from the range, and hex text
  // is not exempt from being hex: refusing is what keeps a typo from addressing a
  // different control unit than the one the operator meant.
  const isAddress = (id: number): boolean => Number.isInteger(id) && id >= 0 && id <= 0x1fffffff;
  if (typeof value === "number") {
    if (!isAddress(value)) throw new HttpError(400, `"${value}" is not a CAN identifier`);
    return value;
  }
  if (typeof value !== "string" || value.trim().length === 0)
    throw new HttpError(400, "an ECU response id (rxId) is required");
  const text = value.trim().toLowerCase().replace(/^0x/, "");
  const parsed = /^[0-9a-f]+$/.test(text) ? Number.parseInt(text, 16) : Number.NaN;
  if (Number.isNaN(parsed) || !isAddress(parsed)) {
    throw new HttpError(400, `"${value}" is not a CAN identifier`);
  }
  return parsed;
}

/** A burst is N frames, N a positive integer — `NaN` would arm a rule that never ends. */
export function parseBurstCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new HttpError(400, `a burst needs a whole number of frames, got "${String(value)}"`);
  }
  return value;
}

/** A drop rate is a fraction: 0 takes nothing, 1 takes everything, nothing outside that. */
export function parseDropRate(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new HttpError(400, `a drop rate is a fraction between 0 and 1, got "${String(value)}"`);
  }
  return value;
}

/**
 * Optional shared secret for write POSTs (`VDP_WRITE_TOKEN` / `X-VDP-Write-Token`).
 *
 * Loopback default is tokenless so a local demo and the existing HTTP specs keep
 * working. The moment the process is started with a token, every write needs the
 * matching header — including 127.0.0.1. A missing env var is not a guessed
 * secret (ADR 0009: no invented authentication).
 */
export const WRITE_TOKEN_HEADER = "x-vdp-write-token";

/** The configured token, or `undefined` when writes stay open. */
export function configuredWriteToken(
  env: NodeJS.Dict<string | undefined> = process.env,
): string | undefined {
  const value = env.VDP_WRITE_TOKEN;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function headerValue(
  headers: NodeJS.Dict<string | string[] | undefined>,
  name: string,
): string | undefined {
  const raw = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

/**
 * Refuse a write that arrived without the token this process was started with.
 * No token configured → no check (the localhost demo).
 */
export function assertWriteAllowed(
  headers: NodeJS.Dict<string | string[] | undefined>,
  env: NodeJS.Dict<string | undefined> = process.env,
): void {
  const expected = configuredWriteToken(env);
  if (expected === undefined) return;
  const got = headerValue(headers, WRITE_TOKEN_HEADER)?.trim();
  if (got !== expected) {
    throw new HttpError(
      403,
      "this write needs the X-VDP-Write-Token this process was started with",
    );
  }
}
