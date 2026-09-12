/**
 * Definition importer (AGENTS 3, 24).
 *
 * Turns externally produced descriptions into a validated DefinitionPackage.
 * Whatever the source, the result must state its provenance — a definition of
 * unknown origin must never look authoritative in the UI.
 */

import {
  type DefinitionPackage,
  type EcuDefinition,
  type Provenance,
  type SignalDefinition,
  type SignalEncoding,
  validateDefinitionPackage,
} from "@vdp/definitions";
import { DefinitionError, type Logger, createLogger, messageOf } from "@vdp/shared";

export interface ImportOptions {
  oem: string;
  name: string;
  version?: string;
  /** Provenance is mandatory (AGENTS 24). */
  provenance: Provenance;
  logger?: Logger;
}

export interface ImportResult {
  pkg: DefinitionPackage;
  valid: boolean;
  errors: string[];
  warnings: string[];
  /** Source lines that could not be understood — reported, never silently dropped. */
  skipped: Array<{ line: number; text: string; reason: string }>;
}

const ENCODINGS: ReadonlySet<string> = new Set([
  "uint8",
  "uint16",
  "uint24",
  "uint32",
  "int8",
  "int16",
  "int32",
  "float32",
  "ascii",
  "bool",
  "bitmask",
  "bcd",
]);

/**
 * Minimal DBC reader.
 *
 * Supports the message (`BO_`) and signal (`SG_`) records that matter for
 * diagnostics, including start bit, length, byte order, factor and offset:
 *   BO_ 2016 EngineData: 8 Vector__XXX
 *    SG_ EngineSpeed : 0|16@1+ (0.25,0) [0|16383.75] "rpm" Vector__XXX
 */
export function importDbc(content: string, options: ImportOptions): ImportResult {
  const log = logger(options);
  const ecus = new Map<number, EcuDefinition>();
  const signals: SignalDefinition[] = [];
  const skipped: ImportResult["skipped"] = [];
  let currentEcuId: string | null = null;
  let currentMessageId = 0;
  let lineNumber = 0;

  for (const rawLine of content.split("\n")) {
    lineNumber++;
    const line = rawLine.trim();
    if (!line || line.startsWith("//")) continue;

    const message = /^BO_\s+(\d+)\s+([A-Za-z0-9_]+)\s*:\s*(\d+)/.exec(line);
    if (message) {
      const id = Number.parseInt(message[1] ?? "0", 10);
      const name = message[2] ?? "Unknown";
      currentMessageId = id;
      const extended = id > 0x7ff;
      const txId = diagnosticRequestFor(id, extended);
      if (txId === null) {
        // A DBC message is usually a broadcast bus message, not a diagnostic
        // response. Turning it into an ECU would invent a request identifier
        // that the vehicle never answers, so it is reported instead (AGENTS 34.6).
        currentEcuId = null;
        skipped.push({
          line: lineNumber,
          text: line.slice(0, 120),
          reason: "message id is not a diagnostic response identifier",
        });
        continue;
      }
      currentEcuId = `ecu_${name.toLowerCase()}`;
      ecus.set(id, {
        id: currentEcuId,
        name,
        address: { txId, rxId: id, extended },
        protocol: "uds",
        services: [0x22],
      });
      continue;
    }

    const signal =
      /^SG_\s+([A-Za-z0-9_]+)\s*(?:M\d*)?\s*:\s*(\d+)\|(\d+)@(\d)([+-])\s*\(([^,]+),([^)]+)\)\s*\[([^|]*)\|([^\]]*)\]\s*"([^"]*)"/.exec(
        line,
      );
    if (signal && currentEcuId) {
      const bitStart = Number.parseInt(signal[2] ?? "0", 10);
      const bitLength = Number.parseInt(signal[3] ?? "0", 10);
      // The definition schema supports bit ranges of 1..32 bits. Longer DBC
      // signals (a VIN stored as one 136 bit signal, for example) are reported
      // rather than silently truncated into an invalid package.
      if (bitLength < 1 || bitLength > 32) {
        skipped.push({
          line: lineNumber,
          text: line.slice(0, 120),
          reason: `bitLength ${bitLength} exceeds the supported 1..32 bit range`,
        });
        continue;
      }
      const littleEndian = (signal[4] ?? "1") === "1";
      const unit = (signal[10] ?? "").trim();
      const signalName = signal[1] ?? "Signal";
      signals.push({
        id: `${currentEcuId}.${signalName.toLowerCase()}`,
        name: signalName,
        ecu: currentEcuId,
        did: currentMessageId,
        byteOffset: Math.floor(bitStart / 8),
        length: Math.max(1, Math.ceil(bitLength / 8)),
        bitOffset: bitStart % 8,
        bitLength,
        endianness: littleEndian ? "little" : "big",
        encoding: encodingFor(bitLength, unit),
        scale: Number.parseFloat(signal[6] ?? "1"),
        offsetValue: Number.parseFloat(signal[7] ?? "0"),
        ...(unit ? { unit } : {}),
      });
      continue;
    }

    if (
      !/^(VERSION|NS_|BS_:|BU_:|CM_|BA_|BA_DEF|VAL_|BO_TX_BU_|SIG_GROUP_|EV_|SIG_VALTYPE)/.test(
        line,
      )
    ) {
      skipped.push({
        line: lineNumber,
        text: line.slice(0, 120),
        reason: "unsupported DBC record",
      });
    }
  }

  return finish(Array.from(ecus.values()), signals, options, log, skipped);
}

/**
 * CSV importer for hand maintained tables:
 *   ecu,txId,rxId,did,byteOffset,length,encoding,name,unit,scale,offset
 */
export function importCsv(content: string, options: ImportOptions): ImportResult {
  const log = logger(options);
  const ecus = new Map<string, EcuDefinition>();
  const signals: SignalDefinition[] = [];
  const skipped: ImportResult["skipped"] = [];
  const lines = content.split("\n").filter((line) => line.trim().length > 0);
  const header = (lines[0] ?? "").split(",").map((cell) => cell.trim());
  const column = (name: string): number => header.indexOf(name);
  for (const required of ["ecu", "did", "byteOffset", "length", "encoding", "name"]) {
    if (column(required) < 0)
      throw new DefinitionError(`CSV import requires a "${required}" column`, { columns: header });
  }

  for (let i = 1; i < lines.length; i++) {
    const cells = (lines[i] ?? "").split(",").map((cell) => cell.trim());
    const ecuName = cells[column("ecu")] ?? "";
    const ecuId = `ecu_${ecuName.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
    if (!ecus.has(ecuId)) {
      const txId = Number.parseInt(cells[column("txId")] ?? "", 16) || 0x7e0;
      const rxId = Number.parseInt(cells[column("rxId")] ?? "", 16) || txId + 8;
      ecus.set(ecuId, {
        id: ecuId,
        name: ecuName,
        address: { txId, rxId, extended: txId > 0x7ff },
        protocol: "uds",
        services: [0x10, 0x22, 0x19],
      });
    }
    const encoding = cells[column("encoding")] ?? "uint8";
    if (!ENCODINGS.has(encoding)) {
      skipped.push({
        line: i + 1,
        text: (lines[i] ?? "").slice(0, 120),
        reason: `unknown encoding "${encoding}"`,
      });
      continue;
    }
    const unit = cells[column("unit")] ?? "";
    const scale = cells[column("scale")];
    const offset = cells[column("offset")];
    const name = cells[column("name")] ?? "Signal";
    signals.push({
      id: `${ecuId}.${name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`,
      name,
      ecu: ecuId,
      did: Number.parseInt(cells[column("did")] ?? "0", 16),
      byteOffset: Number.parseInt(cells[column("byteOffset")] ?? "0", 10),
      length: Number.parseInt(cells[column("length")] ?? "1", 10),
      encoding: encoding as SignalEncoding,
      ...(unit ? { unit } : {}),
      ...(scale ? { scale: Number.parseFloat(scale) } : {}),
      ...(offset ? { offsetValue: Number.parseFloat(offset) } : {}),
    });
  }

  return finish(Array.from(ecus.values()), signals, options, log, skipped);
}

/** JSON importer: a `{ ecus, signals }` fragment or a complete package. */
export function importJson(content: string, options: ImportOptions): ImportResult {
  const log = logger(options);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content) as Record<string, unknown>;
  } catch (error) {
    throw new DefinitionError(`JSON definition is not valid: ${messageOf(error)}`);
  }
  const ecus = (parsed["ecus"] as EcuDefinition[] | undefined) ?? [];
  const signals = (parsed["signals"] as SignalDefinition[] | undefined) ?? [];
  return finish(ecus, signals, options, log, []);
}

function finish(
  ecus: EcuDefinition[],
  signals: SignalDefinition[],
  options: ImportOptions,
  log: Logger,
  skipped: ImportResult["skipped"],
): ImportResult {
  if (skipped.length > 0) {
    log.warn("definition import skipped lines", { count: skipped.length, first: skipped[0] });
  }
  const pkg: DefinitionPackage = {
    schemaVersion: 1,
    oem: options.oem,
    name: options.name,
    version: options.version ?? "0.1.0",
    provenance: options.provenance,
    ecus,
    signals,
  };
  const validation = validateDefinitionPackage(pkg);
  log.info("definition package imported", {
    oem: pkg.oem,
    ecus: ecus.length,
    signals: signals.length,
    provenance: pkg.provenance.sourceType,
    valid: validation.valid,
    warnings: validation.warnings.length,
  });
  return { pkg, skipped, ...validation };
}

/**
 * DBC carries a bit length and a unit string but no application encoding, so the
 * encoding has to be inferred. Text values are detected through the unit field
 * (DBC files often repurpose the unit to say what a value means); everything
 * else maps to the smallest unsigned integer that holds the bit length.
 */
function encodingFor(bitLength: number, unit: string): SignalEncoding {
  if (/^(ascii|text|string|vin)$/i.test(unit)) return "ascii";
  if (bitLength === 1) return "bool";
  if (bitLength <= 8) return "uint8";
  if (bitLength <= 16) return "uint16";
  if (bitLength <= 24) return "uint24";
  return "uint32";
}

/**
 * Derive the ISO 15765-4 request identifier for a diagnostic response id.
 *
 * 11-bit: responses 0x7E8–0x7EF answer requests 0x7E0–0x7E7 (response − 8).
 * 29-bit: the tester and ECU address bytes are swapped between the two
 * directions (0x18DA<tester><ecu> → 0x18DA<ecu><tester>).
 *
 * Returns null when the id is not a diagnostic response identifier at all.
 */
export function diagnosticRequestFor(rxId: number, extended: boolean): number | null {
  if (!extended) {
    return rxId >= 0x7e8 && rxId <= 0x7ef ? rxId - 8 : null;
  }
  const tester = (rxId >> 8) & 0xff;
  const ecu = rxId & 0xff;
  if (((rxId >> 24) & 0xff) !== 0x18 || ((rxId >> 16) & 0xff) !== 0xda) return null;
  return ((0x18 << 24) | (0xda << 16) | (ecu << 8) | tester) >>> 0;
}

function logger(options: ImportOptions): Logger {
  return (options.logger ?? createLogger("definition-importer", { level: "INFO" })).child(
    "definition-importer",
  );
}
