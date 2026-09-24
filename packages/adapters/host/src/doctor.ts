/**
 * Adapter doctor — the pre-flight check for day X (AGENTS 4, 29).
 *
 * Every adapter failure is one of a handful of causes: wrong setting, missing
 * device, wrong cable, dead link, vehicle side silent. The workbench invites
 * connecting first and failing somewhere deep inside; the doctor reverses the
 * order: it walks the adapter-specific checklist in the order a technician
 * would, so the *first* step that fails names the cause and its hints instead
 * of a timeout three layers up.
 *
 * Read-only by construction: the only frame ever sent is the functional
 * TesterPresent probe (ISO 14229-1 §9.4 `0x3E 0x00` as one ISO-TP Single
 * Frame, ISO 15765-2 §7.2) — the same least-invasive probe the discovery uses
 * (AGENTS 12). A listen-only selection never transmits anything.
 */

import { CanableAdapter } from "@vdp/adapter-canable";
import { Elm327Adapter } from "@vdp/adapter-elm327";
import { createLogger, type Logger, messageOf } from "@vdp/shared";
import type { CanBus, CanFrame } from "@vdp/transport-can";
import type {
  AdapterCatalog,
  AdapterConfig,
  AdapterEntry,
  AdapterProbe,
  HostContext,
} from "./catalog.js";
import { type AdapterSelection, validateSelection } from "./selection.js";

export interface AdapterDoctorStep {
  id: string;
  label: string;
  status: "ok" | "warn" | "fail" | "skip";
  detail: string;
  hints?: string[];
}

export interface AdapterDoctorReport {
  adapterId: string;
  selection: AdapterSelection;
  probe?: AdapterProbe;
  steps: AdapterDoctorStep[];
  /** "ready" unless a step failed; "blocked" when the selection itself is unusable. */
  verdict: "ready" | "needs-attention" | "blocked";
  /** True once open() succeeded and the bus was closed cleanly again. */
  openedAndClosed: boolean;
}

export interface AdapterDoctorOptions {
  /** Catalog override (tests). Defaults to no injection: entry.probe/create. */
  catalog?: AdapterCatalog;
  context?: HostContext;
  /** How long the vehicle-probe step listens for any answer (ms). */
  pingWindowMs?: number;
  logger?: Logger;
  /** Test hook: build the bus differently from entry.create. */
  createBus?: (entry: AdapterEntry, config: AdapterConfig, context: HostContext) => Promise<CanBus>;
}

/**
 * The functional TesterPresent probe frame (read-only).
 *
 * Encoding, fixed: ISO-TP Single Frame (PCI 0x02) carrying UDS TesterPresent
 * (SID 0x3E, sub-function 0x00 — with the suppressPositiveResponse bit 0x80
 * deliberately *unset*, so every listening ECU answers with `50 03`,
 * ISO 14229-1 §9.4). Functionally addressed to 0x7DF (ISO 15765-4). The frame
 * is padded to 8 bytes with 0x00, which is what ISO-TP connections on this
 * platform send for 3-byte payloads (padding handled the same as
 * ISO 15765-2 permits).
 */
const TESTER_PRESENT_FRAME = Uint8Array.from([0x02, 0x3e, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);

/**
 * A bus created through the catalog owns (and closes) its serial stream, and
 * the wrapper deliberately hides the adapter instance. The doctor needs the
 * adapter's own status (firmware version, voltage, errors), so the wrapper
 * keeps the source reachable *through the catalog's own vocabulary*: a plain
 * property, deliberately not part of the CanBus contract.
 */
export interface BusWithSource extends CanBus {
  readonly wrappedByCatalog?: CanBus;
}

function sourceAdapterOf(bus: CanBus): CanBus {
  const marked = bus as BusWithSource;
  return marked.wrappedByCatalog ?? bus;
}

function step(
  id: string,
  label: string,
  status: AdapterDoctorStep["status"],
  detail: string,
  hints?: string[],
): AdapterDoctorStep {
  return { id, label, status, detail, ...(hints && hints.length > 0 ? { hints } : {}) };
}

/** Run the full pre-flight check for one adapter selection. */
export async function runAdapterDoctor(
  selection: AdapterSelection,
  options: AdapterDoctorOptions = {},
): Promise<AdapterDoctorReport> {
  const log = (
    options.logger ??
    options.context?.logger ??
    createLogger("can", { level: "INFO" })
  ).child("doctor");
  const catalog = options.catalog;
  const context: HostContext = { ...(options.context ?? {}) };
  if (!context.logger) context.logger = log;
  const steps: AdapterDoctorStep[] = [];
  const report = (finalize: Partial<AdapterDoctorReport> = {}): AdapterDoctorReport => {
    const verdict: AdapterDoctorReport["verdict"] = steps.some(
      (s) => s.status === "fail" && s.id === "settings",
    )
      ? "blocked"
      : steps.some((s) => s.status === "fail")
        ? "needs-attention"
        : "ready";
    return {
      adapterId: selection.id,
      selection,
      steps,
      verdict,
      openedAndClosed: false,
      ...finalize,
    };
  };

  // 1 ─ settings validate (everything the CLI/UI would reject).
  const validation = catalog ? validateSelection(catalog, selection) : null;
  if (validation && !validation.ok) {
    steps.push(
      step("settings", "Einstellungen", "fail", validation.errors.join("; "), [
        "Einstellung korrigieren und erneut prüfen",
      ]),
    );
    return report();
  }
  steps.push(step("settings", "Einstellungen", "ok", "Auswahl und Werte sind formal gültig"));

  if (!catalog) {
    steps.push(step("probe", "Katalog", "skip", "kein Katalog übergeben"));
    return report();
  }

  // Validation above already enforces the id against this same catalog, so a
  // cannot-find branch here would be a second copy of the same truth.
  const entry = catalog.require(selection.id);

  // 2 ─ side-effect-free probe (device node, binding, interface truth).
  const probe = await catalog.describe(selection.id, selection.config, context);
  if (!probe.probe.available) {
    steps.push(step("probe", "Verfügbarkeit", "fail", probe.probe.detail, probe.probe.hints ?? []));
    return report({ probe: probe.probe });
  }
  steps.push(step("probe", "Verfügbarkeit", "ok", probe.probe.detail));
  log.info("doctor probe ok", { adapter: entry.id, detail: probe.probe.detail });

  if (entry.managedBy) {
    steps.push(
      step(
        "managed",
        "Verwalter",
        "skip",
        `"${entry.id}" wird von der Anwendung bereitgestellt (${entry.managedBy}) — keine Hardware-Prüfung möglich`,
      ),
    );
    return report({ probe: probe.probe });
  }

  // 3 ─ open the adapter (this is where baud rate, firmware, handshake matter).
  const createBus =
    options.createBus ??
    ((e: AdapterEntry, c: AdapterConfig, ctx: HostContext) => e.create(c, ctx));
  let bus: CanBus;
  try {
    bus = await createBus(entry, { ...selection.config }, context);
  } catch (error) {
    steps.push(
      step("open", "Adapter öffnen", "fail", `Erstellen fehlgeschlagen: ${messageOf(error)}`, [
        "Probe-Hinweise oben prüfen (Pfad, Baudrate, Interface)",
      ]),
    );
    return report({ probe: probe.probe });
  }

  let openedAndClosed = false;
  const source = sourceAdapterOf(bus);
  try {
    try {
      await bus.open();
    } catch (error) {
      steps.push(
        step("open", "Adapter öffnen", "fail", messageOf(error), openFailureHints(entry.id)),
      );
      return report({ probe: probe.probe });
    }
    steps.push(step("open", "Adapter öffnen", "ok", `Adapter "${entry.displayName}" geöffnet`));

    // 4 ─ firmware/identity: who did we actually reach?
    steps.push(identityStep(entry.id, source));

    // 5 ─ voltage (ELM327): the OBD side tells us whether the car is there.
    if (source instanceof Elm327Adapter) {
      steps.push(await voltageStep(source));
    }

    // 6 ─ vehicle probe: does anything on the bus answer TesterPresent?
    if (selection.config.listenOnly) {
      steps.push(
        step(
          "ping",
          "Fahrzeug-Ping",
          "skip",
          "Listen-only ist aktiv — der Modus sendet absichtlich nichts auf den Bus",
        ),
      );
    } else {
      steps.push(await vehiclePingStep(entry.id, bus, options.pingWindowMs ?? 600, log));
    }
  } finally {
    try {
      await bus.close();
      openedAndClosed = true;
    } catch (error) {
      log.debug("doctor close failed", { error: messageOf(error) });
    }
  }
  return report({ probe: probe.probe, openedAndClosed });
}

function openFailureHints(adapterId: string): string[] {
  if (adapterId === "elm327" || adapterId === "slcan") {
    return [
      "richtiger Port? (ls -l /dev/ttyUSB* /dev/ttyACM*)",
      "Baudrate stimmt? (Standard 38400 bei elm327, 115200 bei slcan — anderes Gerät? --baud=…)",
      "elm327 und slcan antworten nicht auf das Hello des jeweils anderen — Adaptertyp prüfen",
      "--configure-port versuchen, falls die Leitung noch nie gesetzt wurde",
    ];
  }
  if (adapterId === "socketcan") {
    return [
      "Interface existiert und ist up? (ip -details link show can0)",
      "kein natives Modul nötig? sudo apt install can-utils reicht für die Fallback-Verbindung",
    ];
  }
  return [];
}

/** Who is on the other end — as far as the adapter itself can tell. */
function identityStep(adapterId: string, source: CanBus): AdapterDoctorStep {
  if (adapterId === "elm327" && source instanceof Elm327Adapter) {
    const version = source.status.version?.trim();
    const protocol = source.status.protocol?.trim();
    const details = [
      version ? `Firmware: ${version}` : "Firmware unbekannt (Adapter hat auf ATZ nichts gemeldet)",
      ...(protocol ? [`Protokoll: ${protocol}`] : []),
    ];
    return step(
      "identify",
      "Adapter-Identität",
      "ok",
      details.join(" · "),
      version ? [] : ["kein Standard-ELM327? (Klon ohne Versionsmeldung)"],
    );
  }
  if (adapterId === "slcan" && source instanceof CanableAdapter) {
    const version = source.version;
    return step(
      "identify",
      "Adapter-Identität",
      version ? "ok" : "warn",
      version ? `slcan-Firmware: ${version}` : "slcan-Firmware unbekannt",
      version ? [] : ["das Gerät hat V nicht beantwortet"],
    );
  }
  return step(
    "identify",
    "Adapter-Identität",
    "skip",
    `${adapterId} — keine Firmwareabfrage möglich`,
  );
}

/** Battery voltage: the OBD side is powered by the vehicle, so ATRV answers "is the car there?". */
async function voltageStep(adapter: Elm327Adapter): Promise<AdapterDoctorStep> {
  let volts: number | null = null;
  let error: string | null = null;
  try {
    volts = await adapter.readVoltage();
  } catch (caught) {
    error = messageOf(caught);
  }
  if (error !== null) {
    return step("voltage", "Fahrzeugspannung", "warn", `ATRV fehlgeschlagen: ${error}`, [
      "steckt der Adapter am Fahrzeug-OBD-Stecker?",
      "Zündung an?",
    ]);
  }
  if (volts === null) {
    return step("voltage", "Fahrzeugspannung", "warn", "keine Spannungsantwort vom Adapter", [
      "steckt der Adapter am Fahrzeug-OBD-Stecker? (ohne Fahrzeugseite meldet er ~0 V)",
    ]);
  }
  if (volts < 11) {
    return step(
      "voltage",
      "Fahrzeugspannung",
      "warn",
      `${volts.toFixed(1)} V — wenig für ein Fahrzeug`,
      [
        "steckt der Adapter am Fahrzeug-OBD-Stecker?",
        "Fahrzeugspannung prüfen (steht das Fahrzeug lange?)",
      ],
    );
  }
  return step(
    "voltage",
    "Fahrzeugspannung",
    "ok",
    `${volts.toFixed(1)} V — Fahrzeugversorgung liegt an`,
  );
}

/** Does any ECU answer? — functional TesterPresent, one frame out, then listen. */
async function vehiclePingStep(
  adapterId: string,
  bus: CanBus,
  windowMs: number,
  log: Logger,
): Promise<AdapterDoctorStep> {
  const responders = new Set<number>();
  const off = bus.subscribe((frame: CanFrame) => {
    if (frame.direction === "tx") return;
    responders.add(frame.id);
  });
  try {
    await bus.send({
      timestamp: Date.now(),
      id: 0x7df,
      extended: false,
      fd: false,
      dlc: TESTER_PRESENT_FRAME.length,
      payload: TESTER_PRESENT_FRAME,
      channel: bus.info.channels[0] ?? "can0",
      direction: "tx",
    });
  } catch (error) {
    const message = messageOf(error);
    if (/NO DATA/.test(message)) {
      return step("ping", "Fahrzeug-Ping", "warn", `keine ECU hat geantwortet (${message})`, [
        "Zündung an?",
        "richtiges Protokoll? (11-Bit/500k Standard; sonst --protocol=7..9)",
        "OBD-Pins/Sitz des Steckers prüfen",
      ]);
    }
    return step("ping", "Fahrzeug-Ping", "fail", `Senden fehlgeschlagen: ${message}`, [
      "Adapter-Verbindung prüfen (siehe Schritt „Adapter öffnen“)",
    ]);
  }
  // Listen for any responder for the window.
  const deadline = Date.now() + windowMs;
  while (responders.size === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  off();
  if (responders.size === 0) {
    if (adapterId === "socketcan") {
      return step("ping", "Fahrzeug-Ping", "warn", "keine Antwort auf TesterPresent im Fenster", [
        "auf einem leeren vcan0 ist genau das die korrekte Antwort — hier zu Hause: nichts kaputt",
        "am Fahrzeug: Zündung an? richtiger Bus (can0 vs. can1)?",
      ]);
    }
    return step(
      "ping",
      "Fahrzeug-Ping",
      "warn",
      `keine Antwort auf TesterPresent nach ${windowMs} ms`,
      [
        "Zündung an?",
        "Fahrzeug überhaupt per CAN an diesem Stecker? (manch Hersteller routet OBD anders)",
        "richtige Baudrate/Protokoll gewählt?",
      ],
    );
  }
  log.info("doctor ping answered", { responders: responders.size });
  return step(
    "ping",
    "Fahrzeug-Ping",
    "ok",
    `Antwort von ${responders.size} ECU(s): ${[...responders]
      .map((id) => `0x${id.toString(16).padStart(3, "0").toUpperCase()}`)
      .join(", ")}`,
  );
}
