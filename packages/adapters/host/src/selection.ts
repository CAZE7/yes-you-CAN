/**
 * Adapter selection (AGENTS 4, 29).
 *
 * A selection is the user's answer to "which adapter on which port?" — parsed
 * from the command line, from an HTTP request body or from a settings file, and
 * validated in exactly one place. Parsing is deliberately pure so that the
 * error message a user sees is covered by a unit test instead of being
 * discovered on a car.
 */

import { BITRATES } from "@vdp/adapter-canable";
import { AdapterUnsupportedError } from "@vdp/shared";
import {
  type AdapterCatalog,
  type AdapterConfig,
  type AdapterEntry,
  missingRequiredSettings,
} from "./catalog.js";

export interface AdapterSelection {
  /** Catalog entry id, e.g. `elm327`, `slcan`, `socketcan`, `simulator`. */
  id: string;
  config: AdapterConfig;
}

export interface SelectionValidation {
  ok: boolean;
  errors: string[];
  selection: AdapterSelection;
  /** Config with the entry defaults applied. */
  resolved: AdapterConfig;
}

export interface ParsedAdapterOptions {
  selection: AdapterSelection;
  /** Arguments meant for the adapter layer but unusable as given. */
  errors: string[];
}

export const DEFAULT_ADAPTER_ID = "simulator";

/** Flags the adapter layer owns. Everything else belongs to the caller. */
const ADAPTER_FLAGS = [
  "adapter",
  "device",
  "channel",
  "bitrate",
  "baud",
  "trace",
  "listen-only",
  "configure-port",
] as const;

/**
 * Parse adapter related arguments out of an argv array.
 *
 * The caller keeps its own flags; this function only recognises the adapter
 * ones, so both parsers can walk the same argv without stepping on each other.
 */
export function parseAdapterArgv(
  argv: readonly string[],
  defaultId = DEFAULT_ADAPTER_ID,
): ParsedAdapterOptions {
  const config: AdapterConfig = {};
  const errors: string[] = [];
  let id = defaultId;

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] ?? "";
    if (!arg.startsWith("--")) continue;
    const withoutPrefix = arg.slice(2);
    const equals = withoutPrefix.indexOf("=");
    const name = equals >= 0 ? withoutPrefix.slice(0, equals) : withoutPrefix;
    if (!(ADAPTER_FLAGS as readonly string[]).includes(name)) continue;

    const inlineValue = equals >= 0 ? withoutPrefix.slice(equals + 1) : undefined;
    const nextValue = inlineValue === undefined ? argv[index + 1] : undefined;
    // `--flag value` is accepted as well, but only when the next token is not
    // itself a flag (otherwise `--listen-only --port=8080` would eat the port).
    const value =
      inlineValue ??
      (nextValue !== undefined && !nextValue.startsWith("--") ? nextValue : undefined);
    if (inlineValue === undefined && value !== undefined) index++;

    if (name === "listen-only" || name === "configure-port") {
      if (value !== undefined) {
        // Fail closed: a rejected argument must not silently take effect.
        errors.push(`--${name} does not take a value`);
        continue;
      }
      if (name === "listen-only") config.listenOnly = true;
      else config.configurePort = true;
      continue;
    }
    if (value === undefined || value.length === 0) {
      errors.push(
        `--${name} requires a value, e.g. --${name}=<${name === "adapter" ? "id" : "value"}>`,
      );
      continue;
    }
    if (name === "adapter") id = value;
    else if (name === "device") config.device = value;
    else if (name === "channel") config.channel = value;
    else if (name === "bitrate") config.bitrate = value;
    else if (name === "trace") config.trace = value;
    else if (name === "baud") {
      const baud = Number.parseInt(value, 10);
      if (!Number.isFinite(baud) || baud <= 0)
        errors.push(`--baud must be a positive integer, got "${value}"`);
      else config.baudRate = baud;
    }
  }

  return { selection: { id, config }, errors };
}

/**
 * Validate a selection against the catalog.
 *
 * Returns the effective config (defaults applied) so callers never merge twice,
 * and collects *all* problems instead of failing on the first one — a user with
 * a typo in the adapter id and a missing device should learn both at once.
 */
export function validateSelection(
  catalog: AdapterCatalog,
  selection: AdapterSelection,
): SelectionValidation {
  const errors: string[] = [];
  let entry: AdapterEntry | undefined;
  try {
    entry = catalog.require(selection.id);
  } catch (error) {
    errors.push(error instanceof AdapterUnsupportedError ? error.message : String(error));
  }

  const resolved: AdapterConfig = { ...(entry?.defaults ?? {}), ...definedOnly(selection.config) };
  if (entry) {
    const missing = missingRequiredSettings(entry, selection.config);
    if (missing.length > 0) errors.push(`adapter "${entry.id}" needs ${missing.join(", ")}`);
    if (
      resolved.bitrate &&
      entry.supportedBitrates &&
      !entry.supportedBitrates.includes(resolved.bitrate)
    ) {
      errors.push(
        `unsupported bitrate "${resolved.bitrate}" for ${entry.id} (supported: ${entry.supportedBitrates.join(", ")})`,
      );
    }
    if (resolved.baudRate !== undefined && resolved.baudRate <= 0) {
      errors.push(`baud rate must be positive, got ${resolved.baudRate}`);
    }
  }

  return { ok: errors.length === 0, errors, selection, resolved };
}

/**
 * Parse an adapter selection from an untrusted JSON body (HTTP API).
 * Unknown fields are ignored by construction: only known settings are read.
 */
export function selectionFromPayload(
  payload: unknown,
  defaultId = DEFAULT_ADAPTER_ID,
): AdapterSelection {
  const record = (typeof payload === "object" && payload !== null ? payload : {}) as Record<
    string,
    unknown
  >;
  const config: AdapterConfig = {};
  const text = (key: string): string | undefined => {
    const value = record[key];
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
  };
  const device = text("device");
  const channel = text("channel");
  const bitrate = text("bitrate");
  const trace = text("trace");
  if (device) config.device = device;
  if (channel) config.channel = channel;
  if (bitrate) config.bitrate = bitrate;
  if (trace) config.trace = trace;
  if (record["listenOnly"] === true) config.listenOnly = true;
  if (record["configurePort"] === true) config.configurePort = true;
  const baud = record["baudRate"];
  if (typeof baud === "number" && Number.isFinite(baud)) config.baudRate = Math.trunc(baud);
  else if (typeof baud === "string" && /^\d+$/.test(baud))
    config.baudRate = Number.parseInt(baud, 10);
  return { id: text("id") ?? defaultId, config };
}

/** Supported slcan bitrates, for CLI help and the UI dropdown. */
export function supportedBitrates(): string[] {
  return Object.keys(BITRATES);
}

function definedOnly(config: AdapterConfig): AdapterConfig {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) if (value !== undefined) out[key] = value;
  return out as AdapterConfig;
}

/** Usage text for `--list-adapters` and `--help`. */
export function formatAdapterHelp(catalog: AdapterCatalog): string {
  const lines: string[] = [];
  lines.push("Adapter (--adapter=<id>):");
  for (const entry of catalog.list()) {
    const requirements: string[] = [];
    if (entry.requires.device) requirements.push("--device");
    if (entry.requires.channel) requirements.push("--channel");
    if (entry.requires.trace) requirements.push("--trace");
    const suffix = requirements.length > 0 ? `  (needs ${requirements.join(", ")})` : "";
    lines.push(`  ${entry.id.padEnd(10)} ${entry.displayName}${suffix}`);
  }
  lines.push("");
  lines.push(
    "Common settings: --device=<path> --channel=<iface> --bitrate=<500k|250k|...> --baud=<bits/s>",
  );
  lines.push("                 --trace=<file> --listen-only --configure-port");
  return lines.join("\n");
}
