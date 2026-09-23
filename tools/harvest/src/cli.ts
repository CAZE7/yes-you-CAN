#!/usr/bin/env node
/**
 * Harvest CLI: read a vehicle, keep what it answered (ADR 0058).
 *
 * ```
 * node tools/harvest/dist/src/cli.js --adapter socketcan --channel can0 --out ./harvest
 * node tools/harvest/dist/src/cli.js --simulator --out ./harvest --verify-odx
 * node tools/harvest/dist/src/cli.js --simulator --print-plan
 * ```
 *
 * The CLI is the only part of this tool that touches the file system and the only
 * part that spawns another program (the optional `odxtools` cross-check); the
 * library behind it takes a bus and returns data, so a workbench, a test or a
 * script can harvest without this file (the same boundary `@vdp/golden-sessions`
 * keeps between its recorder and its CLI).
 *
 * Exit codes are a contract, not a convention:
 *
 * - `0` — the harvest ran and its artifacts were written. A vehicle that refused
 *   everything still exits 0: the refusals are in the record.
 * - `2` — usage error (unknown flag, missing `--out`, no such adapter).
 * - `3` — the bus could not be opened (adapter missing, device busy).
 * - `4` — an artifact could not be written.
 * - `5` — `--verify-odx` was asked for and the reference implementation rejected
 *   the document.
 * - `6` — nothing answered: no ECU was reached, so there is nothing to describe.
 *   The record is still written, because "nobody answered" is the finding. `--verify-odx` without `odxtools` installed is **not** a failure:
 *   it reports `NOT RUN` and exits 0, because a check that cannot run has not
 *   failed, it has not happened (the honesty rule of `formal/README.md`).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type AdapterCatalog,
  createHostAdapterCatalog,
  parseAdapterArgv,
  validateSelection,
} from "@vdp/adapter-host";
import {
  type DefinitionPackage,
  parseDefinitionPackage,
  validateDefinitionPackage,
} from "@vdp/definitions";
import { createLogger, messageOf } from "@vdp/shared";
import { VirtualVehicle } from "@vdp/simulators";
import type { CanBus } from "@vdp/transport-can";
import { definitionCandidate } from "./definition.js";
import { harvestVehicle } from "./harvest.js";
import { summariseHarvest } from "./observation.js";
import { containerShortNameOf, expectationsOf, renderOdxHarvest } from "./odx/diag-layer.js";
import { createPdx } from "./odx/pdx.js";
import { verificationCounts, verifyOdxDocument } from "./odx/verify.js";
import { describeHarvestPlan, resolveHarvestPlan } from "./plan.js";

/** Exit codes of this CLI. */
export const EXIT = {
  ok: 0,
  usage: 2,
  noBus: 3,
  writeFailed: 4,
  odxRejected: 5,
  nothingAnswered: 6,
} as const;

/** Which artifacts to write. */
export type HarvestFormat = "json" | "odx" | "pdx" | "definition" | "all";

export interface CliOptions {
  argv: readonly string[];
  /** Where artifacts are written. */
  out?: string;
  /** Path of a definition package (JSON) that names the addresses to ask. */
  definitions?: string;
  formats?: readonly HarvestFormat[];
  /** Run against the simulator instead of an adapter. */
  simulator?: boolean;
  /** Manufacturer key of the definition candidate. */
  oem?: string;
  /** Print the plan and exit, without touching a bus. */
  printPlan?: boolean;
  keepVin?: boolean;
  /** Probe 0x2E support with a request that fails length validation first. */
  probeWrites?: boolean;
  readDtcs?: boolean;
  readDtcRecords?: boolean;
  /** Enter this session before reading (hex or decimal). */
  enterSession?: number;
  /** Cross-check the ODX document with odxtools when it is installed. */
  verifyOdx?: boolean;
  /** Interpreter for the cross-check; defaults to `python3`. */
  odxPython?: string;
  /** Per-request pause in ms; a real bus wants a non-zero one. */
  requestGapMs?: number;
  logLevel?: string;
}

/** One parsed argument list. */
export interface ParsedCli {
  options: CliOptions;
  /** Usage problems, each one a sentence an operator can act on. */
  errors: string[];
  /** Adapter arguments, handed to `@vdp/adapter-host` unchanged. */
  adapterArgv: readonly string[];
}

const FLAGS_WITH_VALUE = new Set([
  "out",
  "format",
  "oem",
  "session",
  "odx-python",
  "gap",
  "log-level",
  "definitions",
]);

const KNOWN_FLAGS = new Set([
  ...FLAGS_WITH_VALUE,
  "simulator",
  "print-plan",
  "keep-vin",
  "probe-writes",
  "no-dtcs",
  "no-dtc-records",
  "verify-odx",
  "help",
]);

/**
 * Parse the harvest's own flags.
 *
 * Adapter flags (`--adapter`, `--device`, `--channel`, `--bitrate`, `--baud`,
 * `--trace`, …) are **not** interpreted here: they are passed to
 * `parseAdapterArgv` from `@vdp/adapter-host`, so one parser owns the adapter
 * vocabulary instead of two agreeing about it.
 */
export function parseCli(argv: readonly string[]): ParsedCli {
  const options: CliOptions = { argv };
  const errors: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (!arg.startsWith("--")) {
      errors.push(`unerwartetes Argument "${arg}" — jeder Parameter ist ein --Flag`);
      continue;
    }
    const body = arg.slice(2);
    const equals = body.indexOf("=");
    const name = equals >= 0 ? body.slice(0, equals) : body;
    const inlineValue = equals >= 0 ? body.slice(equals + 1) : undefined;
    if (!KNOWN_FLAGS.has(name) && !isAdapterFlag(name)) {
      errors.push(`unbekanntes Flag "--${name}"`);
      continue;
    }
    if (isAdapterFlag(name)) {
      // An adapter flag with a value consumes the next argument; skipping it here is
      // what keeps `--channel can0` from being read as a stray word "can0".
      if (ADAPTER_FLAGS_WITH_VALUE.has(name) && inlineValue === undefined) index += 1;
      continue;
    }
    const value = inlineValue ?? (FLAGS_WITH_VALUE.has(name) ? argv[index + 1] : undefined);
    if (FLAGS_WITH_VALUE.has(name) && inlineValue === undefined) index += 1;
    switch (name) {
      case "out":
        if (value === undefined) errors.push("--out braucht ein Verzeichnis als Wert");
        else options.out = value;
        break;
      case "format":
        options.formats = parseFormats(value, errors);
        break;
      case "oem":
        if (value === undefined) errors.push("--oem braucht einen Schlüssel als Wert");
        else options.oem = value;
        break;
      case "simulator":
        options.simulator = true;
        break;
      case "print-plan":
        options.printPlan = true;
        break;
      case "keep-vin":
        options.keepVin = true;
        break;
      case "probe-writes":
        options.probeWrites = true;
        break;
      case "no-dtcs":
        options.readDtcs = false;
        break;
      case "no-dtc-records":
        options.readDtcRecords = false;
        break;
      case "verify-odx":
        options.verifyOdx = true;
        break;
      case "odx-python":
        if (value === undefined) errors.push("--odx-python braucht einen Pfad als Wert");
        else options.odxPython = value;
        break;
      case "gap": {
        const parsed = value === undefined ? Number.NaN : Number.parseInt(value, 10);
        if (!Number.isFinite(parsed) || parsed < 0) {
          errors.push(`--gap braucht eine Zahl in Millisekunden, gefunden: "${value ?? ""}"`);
        } else options.requestGapMs = parsed;
        break;
      }
      case "session": {
        const parsed = parseSession(value);
        if (parsed === null) {
          errors.push(
            `--session braucht einen Sitzungstyp (0x03, 3, extended), gefunden: "${value ?? ""}"`,
          );
        } else options.enterSession = parsed;
        break;
      }
      case "log-level":
        if (value === undefined) errors.push("--log-level braucht einen Wert");
        else options.logLevel = value;
        break;
      case "definitions":
        if (value === undefined) errors.push("--definitions braucht eine JSON-Datei als Wert");
        else options.definitions = value;
        break;
      case "help":
        break;
      default:
        break;
    }
  }
  return { options, errors, adapterArgv: argv };
}

/**
 * The adapter flags `@vdp/adapter-host` owns — recognised here only so the harvest
 * parser can skip them (and their values) instead of reporting them as stray
 * arguments. Their meaning is decided by `parseAdapterArgv`, not here: one parser
 * per vocabulary.
 */
const ADAPTER_FLAGS = new Set([
  "adapter",
  "device",
  "channel",
  "bitrate",
  "baud",
  "trace",
  "listen-only",
  "configure-port",
]);

/** The adapter flags that consume the following argument as their value. */
const ADAPTER_FLAGS_WITH_VALUE = new Set([
  "adapter",
  "device",
  "channel",
  "bitrate",
  "baud",
  "trace",
]);

function isAdapterFlag(name: string): boolean {
  return ADAPTER_FLAGS.has(name);
}

const FORMATS: readonly HarvestFormat[] = ["json", "odx", "pdx", "definition", "all"];

function parseFormats(value: string | undefined, errors: string[]): readonly HarvestFormat[] {
  if (value === undefined || value.length === 0) return ["all"];
  const wanted = value.split(",").map((entry) => entry.trim());
  const formats: HarvestFormat[] = [];
  for (const entry of wanted) {
    if ((FORMATS as readonly string[]).includes(entry)) formats.push(entry as HarvestFormat);
    else errors.push(`--format kennt "${entry}" nicht — möglich: ${FORMATS.join(", ")}`);
  }
  return formats.length > 0 ? formats : ["all"];
}

/** `0x03`, `3`, `extended` → session type; anything else → `null`. */
export function parseSession(value: string | undefined): number | null {
  if (value === undefined || value.length === 0) return null;
  const named: Record<string, number> = {
    default: 0x01,
    programming: 0x02,
    extended: 0x03,
  };
  const lowered = value.toLowerCase();
  if (named[lowered] !== undefined) return named[lowered] ?? null;
  const parsed = lowered.startsWith("0x")
    ? Number.parseInt(lowered.slice(2), 16)
    : Number.parseInt(lowered, 10);
  if (!Number.isFinite(parsed) || parsed < 0x01 || parsed > 0xff) return null;
  return parsed;
}

/** The help text — also what `--help` prints. */
export function usage(): string {
  return [
    "harvest — ein Fahrzeug read-only auslesen und die Beobachtung speichern (ADR 0058)",
    "",
    "Aufruf:",
    "  harvest --adapter <id> [--device <pfad>] [--channel <name>] --out <verzeichnis>",
    "  harvest --simulator --out <verzeichnis> [--verify-odx]",
    "  harvest --print-plan",
    "",
    "Flaggen:",
    "  --out <verzeichnis>      Artefakte schreiben (harvest.json, *.odx-d, *.pdx, *.definition.json)",
    "  --format <liste>         json, odx, pdx, definition, all (Default: all)",
    "  --simulator              virtuelles Fahrzeug statt Adapter — ohne Hardware",
    "  --oem <schlüssel>        OEM-Schlüssel des Definitions-Kandidaten (Default: harvest)",
    "  --definitions <datei>    Definitions-Paket (JSON) mit den Adressen, die gefragt werden",
    "  --print-plan             den Frageplan zeigen und beenden, ohne einen Bus zu öffnen",
    "  --keep-vin               VIN im Klartext speichern (Default: maskiert — personenbezogen)",
    "  --probe-writes           0x2E-Unterstützung sondieren (fehlerhafte Anfrage; Default: aus)",
    "  --no-dtcs                Fehlerspeicher nicht lesen",
    "  --no-dtc-records         Freeze Frames und erweiterte Aufzeichnungen nicht lesen",
    "  --session <typ>          Sitzung betreten (0x03 | 3 | extended) — ändert den Zustand des ECUs",
    "  --gap <ms>               Pause zwischen zwei Anfragen (Default: 5)",
    "  --verify-odx             das ODX-Dokument mit odxtools gegenprüfen, falls installiert",
    "  --odx-python <pfad>      Interpreter für die Gegenprüfung (Default: python3)",
    "  --log-level <level>      DEBUG | INFO | WARN | ERROR (Default: INFO)",
    "",
    "Read-only: gesendet werden 0x10/0x11/0x19/0x22/0x31/0x3E als sichere Sonden.",
    "0x14 (Löschen), 0x27 (Security Access), 0x2F (I/O-Control) und 0x34 (Download)",
    "werden nie gesendet — die Ernte kann nichts am Fahrzeug ändern.",
    "",
    "Exit: 0 ok · 2 Benutzung · 3 kein Bus · 4 Schreiben fehlgeschlagen · 5 ODX abgelehnt",
  ].join("\n");
}

/**
 * Run the CLI.
 *
 * Takes `argv` and returns an exit code instead of calling `process.exit`, so a
 * test can drive the whole program — including its failure modes — in process.
 */
export async function runCli(argv: readonly string[], io: CliIo = consoleIo()): Promise<number> {
  const parsed = parseCli(argv);
  if (argv.includes("--help")) {
    io.write(usage());
    return EXIT.ok;
  }
  if (parsed.errors.length > 0) {
    for (const error of parsed.errors) io.error(error);
    io.error(usage());
    return EXIT.usage;
  }
  const { options } = parsed;

  const plan = resolveHarvestPlan({
    ...(options.requestGapMs !== undefined ? { requestGapMs: options.requestGapMs } : {}),
    ...(options.readDtcs !== undefined ? { readDtcs: options.readDtcs } : {}),
    ...(options.readDtcRecords !== undefined ? { readDtcRecords: options.readDtcRecords } : {}),
    ...(options.probeWrites !== undefined ? { probeWriteSupport: options.probeWrites } : {}),
  });
  if (options.printPlan === true) {
    io.write(describeHarvestPlan(plan));
    return EXIT.ok;
  }
  const formats = options.formats ?? ["all"];
  if (options.out === undefined) {
    io.error("--out fehlt: wohin sollen die Artefakte?");
    io.error(usage());
    return EXIT.usage;
  }

  const logger = createLogger("harvest", { level: logLevelOf(options.logLevel) });
  const source = options.simulator === true ? "simulator" : adapterSource(parsed.adapterArgv);
  let definitions: DefinitionPackage[] = [];
  if (options.definitions !== undefined) {
    try {
      definitions = [parseDefinitionPackage(JSON.parse(readFileSync(options.definitions, "utf8")))];
    } catch (error) {
      io.error(`--definitions konnte nicht gelesen werden: ${messageOf(error)}`);
      return EXIT.usage;
    }
  }
  let bus: CanBus;
  let release: () => Promise<void>;
  try {
    if (options.simulator === true) {
      const vehicle = new VirtualVehicle({
        logger,
        ...(definitions.length > 0 ? { definitions: definitions[0] } : {}),
      });
      await vehicle.start();
      bus = vehicle.testerBus;
      // The simulator's ECUs answer their physical address; discovery needs the
      // package that declares them, which is the one the vehicle was built with.
      if (definitions.length === 0) definitions = [vehicle.definitionPackage];
      release = async () => {
        await vehicle.stop();
      };
    } else {
      const opened = await openAdapterBus(parsed.adapterArgv, logger);
      if (opened.error !== undefined) {
        io.error(opened.error);
        return EXIT.noBus;
      }
      bus = opened.bus;
      release = opened.release;
    }
  } catch (error) {
    io.error(`der Bus konnte nicht geöffnet werden: ${messageOf(error)}`);
    return EXIT.noBus;
  }

  try {
    const report = await harvestVehicle({
      bus,
      logger,
      definitions,
      identity: { source, platformVersion: PLATFORM_VERSION },
      plan: {
        ...(options.requestGapMs !== undefined ? { requestGapMs: options.requestGapMs } : {}),
        ...(options.readDtcs !== undefined ? { readDtcs: options.readDtcs } : {}),
        ...(options.readDtcRecords !== undefined ? { readDtcRecords: options.readDtcRecords } : {}),
        ...(options.probeWrites !== undefined ? { probeWriteSupport: options.probeWrites } : {}),
      },
      ...(options.keepVin === true ? { keepVin: true } : {}),
      ...(options.enterSession !== undefined ? { enterSession: options.enterSession } : {}),
    });

    io.write(summariseHarvest(report));
    for (const note of report.notes) io.write(`  · ${note}`);

    // Nothing answered: the record is still worth writing (it is the evidence that
    // the bus was silent), but there is no ECU to describe, so ODX/PDX are skipped
    // instead of producing a document with no variant in it.
    if (report.ecus.length === 0) {
      io.error(
        "kein Steuergerät hat geantwortet — die Ernte schreibt nur den Datensatz, kein ODX/PDX",
      );
      io.error(
        "  Prüfpunkte: Zündung an? richtiger Kanal/Adapter? funktionale Adresse " +
          `0x${report.bus.functionalId.toString(16)}? --definitions mit den Adressen dieses Fahrzeugs?`,
      );
      const written = writeArtifacts(
        report,
        resolve(options.out),
        formats.filter(
          (format) => format === "json" || format === "all" || format === "definition",
        ),
        options,
        io,
      );
      for (const artifact of written) io.write(`geschrieben: ${artifact}`);
      return EXIT.nothingAnswered;
    }

    const written = writeArtifacts(report, resolve(options.out), formats, options, io);
    if (written.length === 0 && formats.length > 0) return EXIT.writeFailed;
    for (const artifact of written) io.write(`geschrieben: ${artifact}`);

    if (options.verifyOdx === true) {
      const document = renderOdxHarvest(report);
      const verification = verifyOdxDocument(document, {
        ...(options.odxPython !== undefined ? { checker: options.odxPython } : {}),
        expectations: expectationsOf(report),
      });
      const counts = verificationCounts(verification);
      if (verification.state === "not-run") {
        io.write(
          `odxtools NOT RUN — ${verification.reason ?? "kein Interpreter mit odxtools gefunden"}`,
        );
        io.write(
          "  die Gegenprüfung ist ein optionaler externer Prüfer (pip install odxtools), kein Bestandteil dieses Repos",
        );
      } else if (verification.state === "failed") {
        io.error(`odxtools hat das Dokument abgelehnt: ${verification.reason ?? "siehe Befunde"}`);
        for (const finding of verification.findings.filter((line) => line.startsWith("finding="))) {
          io.error(`  ${finding}`);
        }
        return EXIT.odxRejected;
      } else {
        io.write(
          `odxtools ${counts.variants} Variante(n), ${counts.services} Dienste, ${counts.dtcs} DTC(s) — ` +
            `${counts.encodeOk} Anfrage(n) codiert, ${counts.decodeOk} Antwort(en) decodiert, ${counts.mismatch} Abweichung(en)`,
        );
      }
    }
    return EXIT.ok;
  } catch (error) {
    io.error(`die Ernte ist fehlgeschlagen: ${messageOf(error)}`);
    return EXIT.noBus;
  } finally {
    await release().catch((error: unknown) => {
      io.error(`der Bus konnte nicht geschlossen werden: ${messageOf(error)}`);
    });
  }
}

/** Where the CLI writes; injected in tests instead of captured from stdout. */
export interface CliIo {
  write(line: string): void;
  error(line: string): void;
}

function consoleIo(): CliIo {
  return {
    write: (line) => process.stdout.write(`${line}\n`),
    error: (line) => process.stderr.write(`${line}\n`),
  };
}

/** The version the record cites — the workspace version, as every package carries it. */
const PLATFORM_VERSION = "0.1.0";

/** Open a bus through the host adapter catalog. */
async function openAdapterBus(
  argv: readonly string[],
  logger: ReturnType<typeof createLogger>,
): Promise<{ bus: CanBus; release: () => Promise<void>; error?: string }> {
  const catalog: AdapterCatalog = createHostAdapterCatalog();
  const parsedAdapter = parseAdapterArgv(argv, "socketcan");
  if (parsedAdapter.errors.length > 0) {
    return {
      bus: undefined as unknown as CanBus,
      release: async () => {},
      error: parsedAdapter.errors.join("\n"),
    };
  }
  const validation = validateSelection(catalog, parsedAdapter.selection);
  if (!validation.ok) {
    return {
      bus: undefined as unknown as CanBus,
      release: async () => {},
      error: validation.errors.join("\n"),
    };
  }
  const entry = catalog.get(parsedAdapter.selection.id);
  if (!entry) {
    return {
      bus: undefined as unknown as CanBus,
      release: async () => {},
      error: `Adapter "${parsedAdapter.selection.id}" ist im Katalog nicht vorhanden`,
    };
  }
  const probe = await entry.probe(validation.resolved, { logger });
  if (!probe.available) {
    return {
      bus: undefined as unknown as CanBus,
      release: async () => {},
      error: `Adapter "${entry.id}" ist auf diesem Rechner nicht verfügbar: ${probe.detail}`,
    };
  }
  const bus = await entry.create(validation.resolved, { logger });
  await bus.open();
  return { bus, release: async () => bus.close() };
}

/** How the adapter selection is named in the record. */
function adapterSource(argv: readonly string[]): string {
  const parsed = parseAdapterArgv(argv, "socketcan");
  const config = Object.entries(parsed.selection.config)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(",");
  return `adapter:${parsed.selection.id}${config.length > 0 ? ` (${config})` : ""}`;
}

/** Write the artifacts of one harvest; returns the paths written. */
export function writeArtifacts(
  report: Parameters<typeof summariseHarvest>[0],
  outDir: string,
  formats: readonly HarvestFormat[],
  options: CliOptions,
  io: CliIo,
): string[] {
  const want = (format: HarvestFormat): boolean =>
    formats.includes("all") || formats.includes(format);
  const written: string[] = [];
  const container = containerShortNameOf(report);
  try {
    mkdirSync(outDir, { recursive: true });
  } catch (error) {
    io.error(`das Ausgabeverzeichnis konnte nicht angelegt werden: ${messageOf(error)}`);
    return written;
  }
  const write = (name: string, data: string | Uint8Array): void => {
    const path = join(outDir, name);
    try {
      writeFileSync(path, data);
      written.push(path);
    } catch (error) {
      io.error(`${name} konnte nicht geschrieben werden: ${messageOf(error)}`);
    }
  };

  if (want("json")) write("harvest.json", `${JSON.stringify(report, null, 2)}\n`);
  if (want("odx")) write(`${container}.odx-d`, renderOdxHarvest(report));
  if (want("pdx")) write(`${container}.pdx`, createPdx(report));
  if (want("definition")) {
    const candidate = definitionCandidate(report, { oem: options.oem ?? "harvest" });
    const validation = validateDefinitionPackage(candidate.pkg);
    write(
      `${options.oem ?? "harvest"}-definition.json`,
      `${JSON.stringify(candidate.pkg, null, 2)}\n`,
    );
    io.write(
      `Definitions-Kandidat: ${candidate.pkg.ecus.length} ECU(s), ${candidate.pkg.signals.length} Signal(e), ` +
        `gültig=${validation.valid}, ${validation.errors.length} Fehler, ${validation.warnings.length} Warnungen, ` +
        `${candidate.skipped.length} Beobachtung(en) nicht übernommen`,
    );
    for (const error of validation.errors) io.error(`  Kandidat-Fehler: ${error}`);
    for (const skipped of candidate.skipped) {
      io.write(`  übersprungen: ${skipped.ecuId} ${skipped.item} — ${skipped.reason}`);
    }
  }
  return written;
}

function logLevelOf(value: string | undefined): "DEBUG" | "INFO" | "WARN" | "ERROR" {
  switch (value?.toUpperCase()) {
    case "DEBUG":
      return "DEBUG";
    case "WARN":
      return "WARN";
    case "ERROR":
      return "ERROR";
    default:
      return "INFO";
  }
}

/** Process entry: only run when this file *is* the program, not when it is imported. */
const invokedDirectly =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  import.meta.url === `file://${resolve(process.argv[1])}`;

if (invokedDirectly) {
  runCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`harvest: ${messageOf(error)}\n`);
      process.exitCode = EXIT.writeFailed;
    });
}
