/**
 * The read-only harvest driver (ADR 0058).
 *
 * One vehicle, one sweep, no writes. The driver answers four questions per ECU:
 *
 * 1. **Who is there?** — functional discovery plus single probes
 *    (`EcuDiscovery` from `@vdp/core`, which reports unknown responders too).
 * 2. **What does it do?** — safe service probes. The probe set and the list of
 *    services that must never be probed come from core
 *    (`probeSupportedServices`, `NON_PROBEABLE_SERVICES`); this module does not
 *    restate them, because a second copy of "which request is safe" is a second
 *    place to be wrong about a vehicle.
 * 3. **What does it know?** — identification DIDs, the swept DID ranges, the
 *    fault memory with its availability mask, the snapshot identification and
 *    the records behind it.
 * 4. **What did it refuse?** — every NRC, every timeout, every address that never
 *    answered, as data in the report (ADR 0049's argument, one layer down).
 *
 * The seam is a {@link CanBus}: the driver builds ISO-TP and UDS itself, exactly
 * as the engine's transport seam does, so a harvest runs against a real adapter,
 * the simulator or a replayed trace without knowing which one it got.
 */

import { DEFAULT_SERVICE_PROBES, type DiscoveredEcu, EcuDiscovery } from "@vdp/core";
import type { DefinitionPackage } from "@vdp/definitions";
import { DID, NRC, nrcName, SESSION, SID, UdsClient } from "@vdp/protocols-uds";
import { createLogger, type Logger, messageOf, toHex } from "@vdp/shared";
import type { CanBus } from "@vdp/transport-can";
import { IsoTpConnection } from "@vdp/transport-iso-tp";
import { readFaultMemory } from "./fault-memory.js";
import { isOrdinaryRefusal, nrcOf } from "./nrc.js";
import {
  type DidRefusalGroup,
  ecuIdOf,
  HARVEST_VERSION,
  type HarvestBus,
  type HarvestCounts,
  type HarvestedDid,
  type HarvestedEcu,
  type HarvestIdentity,
  type HarvestPlan,
  type HarvestReport,
  type HarvestUnread,
  printableAscii,
  redactVin,
} from "./observation.js";
import {
  type HarvestPlanOptions,
  OPT_IN_PROBES,
  type ResolvedHarvestPlan,
  resolveHarvestPlan,
} from "./plan.js";

export interface HarvestOptions {
  /** The bus the sweep runs on — real adapter, simulator or replay. */
  bus: CanBus;
  /** Definition packages, used to name ECUs and to add their DIDs to the plan. */
  definitions?: readonly DefinitionPackage[];
  /** Plan overrides (ranges, budgets, whether to read the fault memory). */
  plan?: HarvestPlanOptions;
  /** Where the bytes came from, in words; defaults to the bus info. */
  identity?: Partial<HarvestIdentity>;
  /** Keep the VIN in clear text. Default false — the record masks it (AGENTS 30). */
  keepVin?: boolean;
  /**
   * Enter a non-default session before reading.
   *
   * Off by default: `0x10` changes ECU state, and a harvest that stays in the
   * default session cannot enable a write it does not intend. Turning it on is
   * recorded in the report's notes, because it changes what the ECU was willing
   * to answer.
   */
  enterSession?: number;
  logger?: Logger;
  /** Injectable clock, so a test does not depend on `Date.now()`. */
  now?: () => number;
  /** Injectable timestamp, so a record is reproducible in a test. */
  timestamp?: () => string;
  sleep?: (ms: number) => Promise<void>;
}

/** What one ECU sweep produced before it is folded into the report. */
interface EcuSweep {
  ecu: HarvestedEcu;
  requests: number;
}

/**
 * Harvest one vehicle.
 *
 * The function never throws for a vehicle that refuses something: a refusal is a
 * result. It throws only when the bus itself cannot be used (closed adapter), so
 * "no answer" and "no bus" stay different statements.
 */
export async function harvestVehicle(options: HarvestOptions): Promise<HarvestReport> {
  const log = options.logger ?? createLogger("harvest", { level: "INFO" });
  const plan = resolveHarvestPlan({
    ...options.plan,
    ...(options.plan?.extraDids
      ? { extraDids: [...options.plan.extraDids, ...definitionDids(options.definitions ?? [])] }
      : { extraDids: definitionDids(options.definitions ?? []) }),
  });
  const now = options.now ?? (() => Date.now());
  const timestamp = options.timestamp ?? (() => new Date().toISOString());
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const startedMs = now();
  const startedAt = timestamp();
  const notes: string[] = [];

  const channel = channelOf(options.bus);
  const bus: HarvestBus = {
    // Filled in after discovery: the addressing width is a property of what
    // answered, not of the plan. A 29-bit responder swept with an 11-bit
    // functional identifier would otherwise be recorded as an 11-bit vehicle.
    addressing: "11-bit",
    functionalId: plan.functionalId,
    ...(channel !== undefined ? { channel } : {}),
    canFd: options.bus.capabilities.canFd,
  };

  const discovery = new EcuDiscovery(options.bus, {
    functionalId: bus.functionalId,
    candidates: discoveryCandidates(options.definitions ?? []),
    probeDelayMs: 0,
    windowMs: plan.discoveryWindowMs,
    logger: log,
    sleep,
  });
  const discovered = await discovery.discover();
  log.info("discovery finished", { answered: discovered.length });
  if (discovered.some((target) => target.extended)) {
    bus.addressing = "29-bit";
    notes.push(
      "Mindestens ein Steuergerät hat mit einer 29-bit-Adresse geantwortet — die funktionale Anfrage lief über die 11-bit-Kennung, einzelne 29-bit-Module können daher unentdeckt geblieben sein (ISO 15765-2)",
    );
  }

  const ecus: HarvestedEcu[] = [];
  const unread: HarvestUnread[] = [];
  const counts: HarvestCounts = {
    ecusAnswered: 0,
    addressesUnread: 0,
    didsRead: 0,
    didsRefused: 0,
    dtcsFound: 0,
    snapshotsRead: 0,
    requestsSent: 0,
  };

  for (const target of discovered) {
    const sweep = await sweepEcu(target, {
      bus: options.bus,
      plan,
      definitions: options.definitions ?? [],
      ...(options.enterSession !== undefined ? { enterSession: options.enterSession } : {}),
      logger: log,
      sleep,
      timestamp,
    });
    ecus.push(sweep.ecu);
    counts.ecusAnswered += 1;
    counts.requestsSent += sweep.requests;
    counts.didsRead += sweep.ecu.dids.length;
    counts.didsRefused += sweep.ecu.didRefusals.reduce((total, group) => total + group.count, 0);
    counts.dtcsFound += sweep.ecu.dtcs.length;
    counts.snapshotsRead += sweep.ecu.dtcs.reduce(
      (total, dtc) => total + (dtc.snapshots?.length ?? 0),
      0,
    );
  }

  // Addresses a definition package declares but nobody answered: the same evidence
  // duty as a scan that names the modules it could not read (ADR 0049).
  for (const candidate of discoveryCandidates(options.definitions ?? [])) {
    if (discovered.some((target) => target.rxId === candidate.rxId)) continue;
    unread.push({
      rxId: candidate.rxId,
      txId: candidate.txId,
      extended: candidate.extended ?? false,
      reason: "keine Antwort auf die funktionale Anfrage und auf die Einzelanfrage",
    });
  }
  counts.addressesUnread = unread.length;

  if (options.enterSession !== undefined) {
    notes.push(
      `Sitzung 0x${options.enterSession.toString(16)} wurde betreten — das ändert den Zustand des Steuergeräts und damit, was es antwortet`,
    );
  } else {
    notes.push(
      "Die Ernte blieb in der Default-Sitzung: DIDs und Dienste, die erst in einer erweiterten Sitzung antworten, erscheinen als Verweigerung (NRC 0x7F/0x31) statt als Wert",
    );
  }
  if (!plan.readDtcs) notes.push("Fehlerspeicher wurde nicht gelesen (--no-dtcs)");
  if (plan.readDtcs && !plan.readDtcRecords) {
    notes.push(
      "Freeze Frames und erweiterte Aufzeichnungen wurden nicht gelesen (--no-dtc-records)",
    );
  }
  if (options.keepVin !== true) {
    notes.push(
      "VIN ist maskiert (--keep-vin schreibt sie im Klartext — personenbezogenes Datum, AGENTS 30)",
    );
  }
  if (unread.length > 0) {
    notes.push(
      `${unread.length} deklarierte Adresse(n) haben nicht geantwortet — die Liste steht in "unread", nicht im Protokoll`,
    );
  }

  const finishedMs = now();
  const identity: HarvestIdentity = {
    source: options.identity?.source ?? sourceOf(options.bus),
    platformVersion: options.identity?.platformVersion ?? "0.1.0",
    ...(options.identity?.operator !== undefined ? { operator: options.identity.operator } : {}),
  };
  const vin = findVin(ecus);
  if (vin !== undefined) {
    if (options.keepVin === true) identity.vin = vin;
    else {
      identity.vin = redactVin(vin);
      identity.vinRedacted = true;
    }
  }

  return {
    kind: "vdp.harvest",
    version: HARVEST_VERSION,
    identity,
    bus,
    startedAt,
    finishedAt: timestamp(),
    durationMs: finishedMs - startedMs,
    plan: planOfRecord(plan, options.enterSession),
    ecus,
    unread,
    counts,
    notes,
  };
}

interface SweepOptions {
  bus: CanBus;
  plan: ResolvedHarvestPlan;
  definitions: readonly DefinitionPackage[];
  enterSession?: number;
  logger: Logger;
  sleep: (ms: number) => Promise<void>;
  timestamp: () => string;
}

/**
 * Sweep one ECU: services, identification, DID ranges, fault memory.
 *
 * Every stage catches its own failure and turns it into a `gaps` entry, because
 * one refused stage must not hide the other four — and because the gap is the
 * evidence that the question was asked.
 */
async function sweepEcu(target: DiscoveredEcu, options: SweepOptions): Promise<EcuSweep> {
  const { plan, logger } = options;
  const log = logger.child(ecuIdOf(target.rxId, target.extended));
  const isoTp = new IsoTpConnection(
    options.bus,
    { txId: target.txId, rxId: target.rxId, extended: target.extended },
    log,
  );
  const client = new UdsClient(isoTp, {
    name: ecuIdOf(target.rxId, target.extended),
    logger: log,
  });
  let requests = 0;
  const gaps: HarvestedEcu["gaps"] = [];
  const count = (): void => {
    requests += 1;
  };
  const gap = (stage: string, error: unknown): void => {
    const reason = messageOf(error);
    gaps.push({ stage, reason });
    log.debug("harvest stage failed", { stage, reason });
  };

  const definitionEcu = findDefinitionEcu(target, options.definitions);
  const name = definitionEcu?.name ?? `ECU 0x${target.rxId.toString(16)}`;
  const ecu: HarvestedEcu = {
    id: ecuIdOf(target.rxId, target.extended),
    name,
    txId: target.txId,
    rxId: target.rxId,
    extended: target.extended,
    ...(definitionEcu ? { definitionEcuId: definitionEcu.id } : {}),
    acceptedSessions: [],
    serviceProbes: [],
    supportedServices: [],
    identification: [],
    dids: [],
    didRefusals: [],
    dtcs: [],
    gaps,
  };

  try {
    // 1. Services: the safe probe set from core, including the ones core refuses
    //    to probe — their refusal reason is part of the answer (AGENTS 24).
    try {
      const probes = await probeServices(client, count, options);
      ecu.serviceProbes = probes.map((probe) => ({
        service: probe.service,
        outcome: probe.outcome,
        ...(probe.detail !== undefined ? { detail: probe.detail } : {}),
      }));
      ecu.supportedServices = probes
        .filter((probe) => probe.outcome === "supported")
        .map((probe) => probe.service);
    } catch (error) {
      gap("service-probe", error);
    }

    // 2. Timing and session: entering a session is opt-in, reading the timing is not.
    if (options.enterSession !== undefined) {
      try {
        count();
        const session = await client.diagnosticSessionControl(options.enterSession);
        ecu.acceptedSessions = [options.enterSession];
        ecu.timing = {
          ...(session.p2Ms !== undefined ? { p2Ms: session.p2Ms } : {}),
          ...(session.p2StarMs !== undefined ? { p2StarMs: session.p2StarMs } : {}),
        };
      } catch (error) {
        gap(`session-0x${options.enterSession.toString(16)}`, error);
      }
    }

    // 3. Identification DIDs, read by name so the record can label them.
    for (const entry of identificationDids(definitionEcu, plan)) {
      const read = await readDid(client, entry.did, count, options, "identification");
      if (read.kind !== "answered") continue;
      ecu.identification.push({
        did: entry.did,
        label: entry.label,
        rawHex: read.did.rawHex,
        ...(read.did.asciiHint !== undefined ? { asciiHint: read.did.asciiHint } : {}),
      });
    }

    // 4. The DID sweep. Every DID is asked once; a DID that answered is read a
    //    second time when the plan asks for stability, so a moving value is
    //    labelled instead of being stored as if it were a constant.
    const refusals = new Map<string, DidRefusalGroup>();
    for (const did of plan.dids) {
      const origin = originOf(did, plan);
      const first = await readDid(client, did, count, options, origin);
      if (first.kind === "silent") continue;
      if (first.kind === "refused") {
        addRefusal(refusals, origin, first.nrc, did);
        continue;
      }
      let stable: boolean | undefined;
      if (plan.repeatReadsForStability) {
        await options.sleep(plan.requestGapMs);
        const second = await readDid(client, did, count, options, origin);
        stable = second.kind === "answered" && second.did.rawHex === first.did.rawHex;
      }
      ecu.dids.push({
        ...first.did,
        ...(stable !== undefined ? { stable } : {}),
      });
    }
    ecu.didRefusals = [...refusals.values()].sort(
      (a, b) => a.origin.localeCompare(b.origin) || a.nrc - b.nrc || a.firstDid - b.firstDid,
    );

    // 5. Fault memory, in the order the plan gives: count, identification, list.
    if (plan.readDtcs) {
      await readFaultMemory(client, ecu, {
        plan,
        count,
        sleep: options.sleep,
        gap,
      });
    }
  } finally {
    isoTp.close();
  }

  return { ecu, requests };
}

/**
 * Probe the services the core deems safe to probe, and report the ones it refuses.
 *
 * The probe requests come from core's own table (an unassigned session type, an
 * unassigned reset type, DID 0x0000, a truncated write) — this module sends
 * nothing core has not already decided is harmless. The services core refuses to
 * probe at all are reported as `not-probed` with core's reason, so the record
 * says "we did not ask" instead of implying "the ECU cannot".
 */
async function probeServices(
  client: UdsClient,
  count: () => void,
  options: SweepOptions,
): Promise<Array<{ service: number; outcome: string; detail?: string }>> {
  const probes: Array<{ service: number; outcome: string; detail?: string }> = [];
  for (const service of probeListOf(options.plan)) {
    const notProbed = notProbedReason(service, options.plan);
    if (notProbed !== undefined) {
      probes.push({ service, outcome: "not-probed", detail: notProbed });
      continue;
    }
    const request = SAFE_PROBES[service];
    if (!request) {
      probes.push({
        service,
        outcome: "not-probed",
        detail: "no safe probe known for this service",
      });
      continue;
    }
    count();
    try {
      await client.raw(request);
      probes.push({ service, outcome: "supported", detail: "answered positively to a safe probe" });
    } catch (error) {
      const nrc = nrcOf(error);
      if (nrc === NRC.SERVICE_NOT_SUPPORTED) {
        probes.push({ service, outcome: "unsupported", detail: "serviceNotSupported (0x11)" });
      } else if (nrc !== undefined) {
        probes.push({
          service,
          outcome: "supported",
          detail: `negative response 0x${nrc.toString(16)} (${nrcName(nrc)}) proves the service exists`,
        });
      } else {
        probes.push({ service, outcome: "unsupported", detail: messageOf(error) });
      }
    }
    await options.sleep(options.plan.requestGapMs);
  }
  return probes;
}

/**
 * The probe requests, copied from core's table in
 * `packages/core/src/diagnostics/ecu-session.ts` — the same six requests, so a
 * harvest cannot be more invasive than the platform's own service probe.
 */
const SAFE_PROBES: Readonly<Record<number, Uint8Array>> = {
  [SID.DIAGNOSTIC_SESSION_CONTROL]: new Uint8Array([0x10, 0x00]),
  [SID.ECU_RESET]: new Uint8Array([0x11, 0x00]),
  [SID.READ_DTC_INFORMATION]: new Uint8Array([0x19, 0x0a]),
  [SID.READ_DATA_BY_IDENTIFIER]: new Uint8Array([0x22, 0x00, 0x00]),
  [SID.WRITE_DATA_BY_IDENTIFIER]: new Uint8Array([0x2e, 0x00, 0x00]),
  [SID.ROUTINE_CONTROL]: new Uint8Array([0x31, 0x00, 0x00, 0x00]),
  [SID.TESTER_PRESENT]: new Uint8Array([0x3e, 0x00]),
};

/**
 * Services a harvest never sends, with the reason it states in the record.
 *
 * These are the ones where even a malformed request can have consequences, so they
 * are not probed at all — the record says "not asked, because …" instead of
 * implying the ECU lacks them (AGENTS 24).
 */
const NEVER_PROBED: Readonly<Record<number, string>> = {
  [SID.CLEAR_DIAGNOSTIC_INFORMATION]:
    "clearing fault memory destroys diagnostic history — never sent (AGENTS 34.11)",
  [SID.SECURITY_ACCESS]: "a failed security access attempt can lock the ECU — never sent",
  [SID.COMMUNICATION_CONTROL]: "changes what the ECU transmits on the bus — never sent",
  [SID.INPUT_OUTPUT_CONTROL_BY_IDENTIFIER]: "input/output control actuates hardware — never sent",
  [SID.REQUEST_DOWNLOAD]: "a download request can modify ECU memory — never sent",
  [SID.CONTROL_DTC_SETTING]: "changes whether faults are recorded at all — never sent",
};

/**
 * The services this sweep asks about: core's safe probe list, plus every service
 * the harvest refuses to send (so the record names them), sorted.
 */
function probeListOf(plan: ResolvedHarvestPlan): number[] {
  const services = new Set<number>(DEFAULT_SERVICE_PROBES);
  for (const service of Object.keys(NEVER_PROBED)) services.add(Number(service));
  for (const probe of OPT_IN_PROBES) services.add(probe.service);
  return [...services]
    .sort((a, b) => a - b)
    .filter((service) => {
      // A write-support probe only appears when it was asked for; otherwise the plan
      // does not mention 0x2E at all, which keeps "no write service is sent" literal.
      if (OPT_IN_PROBES.some((entry) => entry.service === service)) return plan.probeWriteSupport;
      return true;
    });
}

/** Why one service is reported as `not-probed`, when it is. */
function notProbedReason(service: number, plan: ResolvedHarvestPlan): string | undefined {
  if (NEVER_PROBED[service] !== undefined) return NEVER_PROBED[service];
  if (service === SID.WRITE_DATA_BY_IDENTIFIER && plan.probeWriteSupport !== true) {
    return "a write-support probe is opt-in (--probe-writes): by default no write service is sent";
  }
  if (SAFE_PROBES[service] === undefined) return "no safe probe known for this service";
  return undefined;
}

/**
 * The three outcomes of one DID read.
 *
 * They are kept apart because they mean different things: `answered` is a value,
 * `refused` is the ECU saying "not here" with a code that belongs in the record,
 * and `silent` is a transport failure — a timeout or a broken frame — which is
 * *not* an answer about the DID and must not be counted as one (ADR 0033).
 */
export type DidReadResult =
  | { kind: "answered"; did: HarvestedDid }
  | { kind: "refused"; nrc: number }
  | { kind: "silent"; reason: string };

/** Read one DID. */
async function readDid(
  client: UdsClient,
  did: number,
  count: () => void,
  options: SweepOptions,
  origin: HarvestedDid["origin"] = "range",
): Promise<DidReadResult> {
  count();
  try {
    const payload = await client.readDid(did);
    if (!payload) return { kind: "silent", reason: "empty payload" };
    const asciiHint = printableAscii(Array.from(payload));
    return {
      kind: "answered",
      did: {
        did,
        rawHex: toHex(payload, ""),
        byteLength: payload.length,
        ...(asciiHint !== undefined ? { asciiHint } : {}),
        origin,
      },
    };
  } catch (error) {
    const nrc = nrcOf(error);
    // requestOutOfRange / serviceNotSupported(InActiveSession) are the normal
    // answers of a DID sweep: the ECU says "not here". They are recorded as a
    // refusal, not as a gap, because the question was answered.
    if (isOrdinaryRefusal(nrc)) {
      return { kind: "refused", nrc: nrc ?? 0 };
    }
    const reason = messageOf(error);
    options.logger.debug("DID read failed", { did: `0x${did.toString(16)}`, reason });
    return { kind: "silent", reason };
  } finally {
    await options.sleep(options.plan.requestGapMs);
  }
}

/** Fold one refusal into its group, keeping the DID range the group covers. */
function addRefusal(
  refusals: Map<string, DidRefusalGroup>,
  origin: HarvestedDid["origin"],
  nrc: number,
  did: number,
): void {
  const key = `${origin}|${nrc}`;
  const existing = refusals.get(key);
  if (existing === undefined) {
    refusals.set(key, { origin, nrc, count: 1, firstDid: did, lastDid: did });
    return;
  }
  existing.count += 1;
  existing.firstDid = Math.min(existing.firstDid, did);
  existing.lastDid = Math.max(existing.lastDid, did);
}

/** Which part of the plan asked about this DID. */
function originOf(did: number, plan: ResolvedHarvestPlan): HarvestedDid["origin"] {
  if (plan.standardDids.includes(did)) return "standard";
  for (const range of plan.didRanges) {
    if (did >= range.from && did <= range.to) {
      return range.name === "identification" ? "identification" : "range";
    }
  }
  return "definition";
}

/** The identification DIDs of this ECU: the definition's, or the standard block. */
function identificationDids(
  definitionEcu: { identification?: Array<{ label: string; did: number }> } | undefined,
  plan: ResolvedHarvestPlan,
): Array<{ did: number; label: string }> {
  if (definitionEcu?.identification && definitionEcu.identification.length > 0) {
    return definitionEcu.identification.map((entry) => ({ did: entry.did, label: entry.label }));
  }
  return [
    { did: DID.VEHICLE_IDENTIFIER_NUMBER, label: "VIN" },
    { did: DID.VEHICLE_MANUFACTURER_SPARE_PART_NUMBER, label: "Teilenummer" },
    { did: DID.APPLICATION_SOFTWARE_IDENTIFICATION, label: "Software" },
  ].filter((entry) => plan.dids.includes(entry.did));
}

/** Definition ECU matching a discovered address, when a package declares one. */
function findDefinitionEcu(
  target: DiscoveredEcu,
  definitions: readonly DefinitionPackage[],
): DefinitionPackage["ecus"][number] | undefined {
  for (const pkg of definitions) {
    for (const ecu of pkg.ecus) {
      if (ecu.address.rxId === target.rxId) return ecu;
    }
  }
  return undefined;
}

/** Addresses a definition package declares, as discovery candidates. */
function discoveryCandidates(
  definitions: readonly DefinitionPackage[],
): Array<{ txId: number; rxId: number; extended?: boolean }> {
  const seen = new Set<number>();
  const candidates: Array<{ txId: number; rxId: number; extended?: boolean }> = [];
  for (const pkg of definitions) {
    for (const ecu of pkg.ecus) {
      if (seen.has(ecu.address.rxId)) continue;
      seen.add(ecu.address.rxId);
      candidates.push({
        txId: ecu.address.txId,
        rxId: ecu.address.rxId,
        ...(ecu.address.extended !== undefined ? { extended: ecu.address.extended } : {}),
      });
    }
  }
  return candidates;
}

/** DIDs a definition package declares, added to the sweep. */
function definitionDids(definitions: readonly DefinitionPackage[]): number[] {
  const dids = new Set<number>();
  for (const pkg of definitions) {
    for (const signal of pkg.signals) dids.add(signal.did);
    for (const ecu of pkg.ecus) {
      for (const entry of ecu.identification ?? []) dids.add(entry.did);
    }
  }
  return [...dids].sort((a, b) => a - b);
}

/** The VIN, if any ECU reported one at the standardised DID. */
function findVin(ecus: readonly HarvestedEcu[]): string | undefined {
  for (const ecu of ecus) {
    for (const did of ecu.dids) {
      if (did.did === DID.VEHICLE_IDENTIFIER_NUMBER && did.asciiHint !== undefined) {
        return did.asciiHint;
      }
    }
    for (const entry of ecu.identification) {
      if (entry.did === DID.VEHICLE_IDENTIFIER_NUMBER && entry.asciiHint !== undefined) {
        return entry.asciiHint;
      }
    }
  }
  return undefined;
}

function channelOf(bus: CanBus): string | undefined {
  return bus.info.channels[0];
}

/** Where the bytes came from, named from the bus when the caller did not say. */
function sourceOf(bus: CanBus): string {
  const channel = channelOf(bus);
  return `bus:${bus.info.kind}${channel !== undefined ? `:${channel}` : ""}`;
}

/**
 * The plan as it is recorded — what was **asked**, not what the plan would allow.
 *
 * Two fields are deliberately narrower than the resolved plan:
 *
 * - `services` lists only the identifiers whose probe was actually sent; a service
 *   reported as `not-probed` is in `serviceProbes` with its reason, never here.
 * - `sessions` lists only the session that was entered (`--session`). A harvest that
 *   stayed in the default session records an empty list, because `0x10` with the
 *   unassigned type proves *support* without entering anything — writing
 *   `[0x01, 0x02, 0x03]` here would claim three session changes that never happened.
 */
function planOfRecord(plan: ResolvedHarvestPlan, enteredSession?: number): HarvestPlan {
  return {
    services: probeListOf(plan).filter((service) => notProbedReason(service, plan) === undefined),
    sessions: enteredSession !== undefined ? [enteredSession] : [],
    didRanges: plan.didRanges.map((range) => ({ from: range.from, to: range.to })),
    standardDids: plan.standardDids,
    dtcRecordNumbers: plan.dtcRecordNumbers,
    budgetPerEcuMs: plan.budgetPerEcuMs,
    requestGapMs: plan.requestGapMs,
  };
}

/** Session constant re-exported for the CLI's `--session` parser. */
export { SESSION };
