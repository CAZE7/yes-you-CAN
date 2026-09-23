/**
 * What a harvest asks, as data (ADR 0058).
 *
 * A read-only sweep has to decide *what to ask* before it asks, and that decision
 * is the whole difference between a useful artifact and a flooded bus. It lives
 * here as a plan, not inside the driver's loops, so that:
 *
 * - the plan can be printed before the run ("this is what I am about to ask"),
 * - the harvest record can carry it, so a gap is distinguishable from an omission,
 * - and a test can assert that no plan entry is a write.
 *
 * Everything in the default plan is a **read**: `0x10` session probes with the
 * unassigned session type, `0x11`/`0x2E`/`0x31` probes with requests that fail
 * length or range validation before any action, `0x19` sub-functions and `0x22`
 * reads. The services that are never probed — `0x14`, `0x27`, `0x2F`, `0x34` —
 * are the ones `packages/core/src/diagnostics/ecu-session.ts` already refuses to
 * probe, and this plan does not restate them: it reuses the core's probe list.
 */

import { DID, DTC_REPORT, SESSION, SID } from "@vdp/protocols-uds";

/** A DID range to sweep, inclusive. Named so a record can say which range answered. */
export interface DidRange {
  /** Stable name, used in the record and in logs. */
  name: string;
  from: number;
  to: number;
  /** Why this range is worth asking — printed with the plan. */
  reason: string;
}

/**
 * The standardised identification block (ISO 14229-1 Annex D, F1xx).
 *
 * Small, universally present on UDS ECUs and read by name: these are the values
 * that identify a vehicle and its control units, which is exactly what a harvest
 * is for. The block is bounded so a run cannot wander into OEM ranges unasked.
 */
export const STANDARD_IDENTIFICATION_RANGE: DidRange = {
  name: "identification",
  from: 0xf180,
  to: 0xf1ff,
  reason:
    "ISO 14229-1 Annex D identification block (boot/software/hardware, serial, spare part, VIN)",
};

/**
 * The standardised OBD DID block (SAE J1979 / ISO 15031-5 mapping, F4xx).
 *
 * Present on many ECUs that also answer the emissions-related DIDs; reading them
 * costs one request each and often reveals what the module measures.
 */
export const STANDARD_OBD_RANGE: DidRange = {
  name: "obd",
  from: 0xf400,
  to: 0xf4ff,
  reason: "SAE J1979 / ISO 15031-5 emission-related data identifiers",
};

/** DIDs whose meaning is standardised, read by name and labelled as such. */
export const STANDARD_DIDS: ReadonlyArray<{ did: number; label: string }> = [
  { did: DID.BOOT_SOFTWARE_IDENTIFICATION, label: "Boot-Software" },
  { did: DID.APPLICATION_SOFTWARE_IDENTIFICATION, label: "Applikations-Software" },
  { did: DID.APPLICATION_DATA_IDENTIFICATION, label: "Applikations-Daten" },
  { did: DID.VEHICLE_MANUFACTURER_SPARE_PART_NUMBER, label: "Teilenummer" },
  { did: DID.ECU_SERIAL_NUMBER, label: "Seriennummer" },
  { did: DID.SYSTEM_NAME_OR_ENGINE_TYPE, label: "Systemname / Motortyp" },
  { did: DID.VEHICLE_IDENTIFIER_NUMBER, label: "VIN" },
  { did: DID.ACTIVE_DIAGNOSTIC_SESSION, label: "aktive Sitzung" },
];

/** Session types probed with `0x10` — the unassigned type 0x00 proves support without entering. */
export const PROBED_SESSIONS: readonly number[] = [
  SESSION.DEFAULT,
  SESSION.EXTENDED,
  SESSION.PROGRAMMING,
];

/**
 * `0x19` sub-functions a harvest reads, in the order that makes the later ones
 * cheap: the count first (is there anything at all), then the identification
 * (which codes have freeze frames), then the list, then the records themselves.
 */
export const DTC_READ_ORDER: ReadonlyArray<{
  subFunction: number;
  name: string;
  /** ISO 14229-1 clause, so the record can cite the standard instead of a guess (AGENTS 34.18). */
  clause: string;
}> = [
  {
    subFunction: DTC_REPORT.REPORT_NUMBER_OF_DTC_BY_STATUS_MASK,
    name: "reportNumberOfDTCByStatusMask",
    clause: "ISO 14229-1 §11.3.4.2",
  },
  {
    subFunction: DTC_REPORT.REPORT_DTC_SNAPSHOT_IDENTIFICATION,
    name: "reportDTCSnapshotIdentification",
    clause: "ISO 14229-1 §11.3.4.4",
  },
  {
    subFunction: DTC_REPORT.REPORT_DTC_BY_STATUS_MASK,
    name: "reportDTCByStatusMask",
    clause: "ISO 14229-1 §11.3.4.3",
  },
  {
    subFunction: DTC_REPORT.REPORT_SUPPORTED_DTC,
    name: "reportSupportedDTC",
    clause: "ISO 14229-1 §11.3.4.11",
  },
];

/**
 * Snapshot / extended-data record numbers requested per code.
 *
 * `0xff` means "all records of this code" in ISO 14229-1 §11.3.4.5 and is what an
 * ECU answers when it stores one record; `0x01` is the conventional first record.
 * Both are asked because an ECU may implement either reading of `0xff`.
 */
export const DTC_RECORD_NUMBERS: readonly number[] = [0xff, 0x01];

/** Extended data record numbers (ISO 14229-1 §11.3.4.7): 0x01 is the conventional first. */
export const EXTENDED_RECORD_NUMBERS: readonly number[] = [0x01, 0x02];

/** Default functional request identifier of a 11-bit sweep (ISO 15765-4). */
export const DEFAULT_FUNCTIONAL_ID = 0x7df;

/** How long discovery listens for answers before the single probes start. */
export const DEFAULT_DISCOVERY_WINDOW_MS = 120;

/** Defaults of {@link HarvestPlanOptions}; every one of them is a budget, not a guess. */
export const DEFAULT_HARVEST_BUDGET = {
  /** Per-ECU wall-clock budget. A real ECU answers a DID read in ~50 ms. */
  budgetPerEcuMs: 20_000,
  /** Pause between two requests so the bus is not flooded. */
  requestGapMs: 5,
  /** Read every DID twice to tell a stable value from a moving one. */
  repeatReadsForStability: true,
  /** Upper bound of DIDs swept per ECU — a runaway range must not run forever. */
  maxDidsPerEcu: 512,
} as const;

export interface HarvestPlanOptions {
  /** Functional request identifier used for discovery. */
  functionalId?: number;
  /** How long discovery listens for answers (ms). */
  windowMs?: number;
  /** DID ranges to sweep; defaults to the two standardised blocks. */
  didRanges?: readonly DidRange[];
  /** Extra DIDs to read that no range covers (from a definition package, say). */
  extraDids?: readonly number[];
  /**
   * Session types the plan offers to `--session`.
   *
   * Naming this "probed" would be a claim the sweep does not make: entering a
   * session changes ECU state, so it happens only on request, and the record then
   * lists the session that was entered (`planOfRecord`).
   */
  sessions?: readonly number[];
  /** Snapshot/extended record numbers to request. */
  dtcRecordNumbers?: readonly number[];
  extendedRecordNumbers?: readonly number[];
  budgetPerEcuMs?: number;
  requestGapMs?: number;
  repeatReadsForStability?: boolean;
  maxDidsPerEcu?: number;
  /**
   * Probe whether the ECU supports `0x2E` (WriteDataByIdentifier).
   *
   * Off by default. The probe core uses is a request that fails length validation
   * before any write, so it is safe — but "safe" is an argument a reader of the
   * record cannot check, and a harvest that never sends a write service at all is
   * a claim anybody can verify from the plan. Turning it on adds `0x2E` to the
   * probe list and says so in the record.
   */
  probeWriteSupport?: boolean;
  /** Read the fault memory at all; false for a pure identification sweep. */
  readDtcs?: boolean;
  /** Read freeze frames and extended records; false stops after the code list. */
  readDtcRecords?: boolean;
}

/** The resolved plan a harvest runs with — this is what the record carries. */
export interface ResolvedHarvestPlan {
  functionalId: number;
  discoveryWindowMs: number;
  didRanges: readonly DidRange[];
  /** Every DID the plan will ask about, deduplicated and sorted. */
  dids: readonly number[];
  standardDids: readonly number[];
  sessions: readonly number[];
  dtcRecordNumbers: readonly number[];
  extendedRecordNumbers: readonly number[];
  budgetPerEcuMs: number;
  requestGapMs: number;
  repeatReadsForStability: boolean;
  probeWriteSupport: boolean;
  readDtcs: boolean;
  readDtcRecords: boolean;
}

/**
 * Services whose support is only probed on request.
 *
 * Each entry names the service and what the probe would prove — the record shows
 * both, so "not asked" is distinguishable from "asked and refused".
 */
export const OPT_IN_PROBES: ReadonlyArray<{ service: number; name: string; proves: string }> = [
  {
    service: SID.WRITE_DATA_BY_IDENTIFIER,
    name: "writeDataByIdentifier",
    proves:
      "whether the ECU accepts a write at all (probed with a request that fails length validation first)",
  },
];

/**
 * Resolve a plan: expand the ranges, deduplicate, apply the budgets.
 *
 * The DID list is materialised here rather than inside the sweep loop because the
 * plan has to be printable and recordable before a single request goes out — and
 * because a range that is too wide has to hit {@link DEFAULT_HARVEST_BUDGET}'s
 * `maxDidsPerEcu` at one visible place instead of silently truncating mid-run.
 */
export function resolveHarvestPlan(options: HarvestPlanOptions = {}): ResolvedHarvestPlan {
  const ranges = options.didRanges ?? [STANDARD_IDENTIFICATION_RANGE, STANDARD_OBD_RANGE];
  const maxDids = options.maxDidsPerEcu ?? DEFAULT_HARVEST_BUDGET.maxDidsPerEcu;
  const dids = new Set<number>(options.extraDids ?? []);
  for (const did of STANDARD_DIDS) dids.add(did.did);
  for (const range of ranges) {
    for (let did = range.from; did <= range.to; did += 1) {
      if (dids.size >= maxDids) break;
      dids.add(did);
    }
  }
  return {
    functionalId: options.functionalId ?? DEFAULT_FUNCTIONAL_ID,
    discoveryWindowMs: options.windowMs ?? DEFAULT_DISCOVERY_WINDOW_MS,
    didRanges: ranges,
    dids: [...dids].sort((a, b) => a - b),
    standardDids: STANDARD_DIDS.map((entry) => entry.did),
    sessions: options.sessions ?? PROBED_SESSIONS,
    dtcRecordNumbers: options.dtcRecordNumbers ?? DTC_RECORD_NUMBERS,
    extendedRecordNumbers: options.extendedRecordNumbers ?? EXTENDED_RECORD_NUMBERS,
    budgetPerEcuMs: options.budgetPerEcuMs ?? DEFAULT_HARVEST_BUDGET.budgetPerEcuMs,
    requestGapMs: options.requestGapMs ?? DEFAULT_HARVEST_BUDGET.requestGapMs,
    repeatReadsForStability:
      options.repeatReadsForStability ?? DEFAULT_HARVEST_BUDGET.repeatReadsForStability,
    probeWriteSupport: options.probeWriteSupport ?? false,
    readDtcs: options.readDtcs ?? true,
    readDtcRecords: options.readDtcRecords ?? true,
  };
}

/**
 * The service identifiers a harvest may send, with the read that justifies each.
 *
 * A service outside this list is not sent — the list is the guardrail, and
 * `assertReadOnlyPlan` fails a plan that contains a write. `0x3E` (TesterPresent)
 * is included because a long sweep would otherwise be dropped by S3 timeout
 * (ISO 14229-2 §7), and it changes nothing.
 */
export const HARVEST_SERVICES: ReadonlyArray<{ service: number; name: string; why: string }> = [
  {
    service: SID.DIAGNOSTIC_SESSION_CONTROL,
    name: "diagnosticSessionControl",
    why: "read timing, probe session support",
  },
  {
    service: SID.ECU_RESET,
    name: "ecuReset",
    why: "probed only with the unassigned reset type 0x00 — no reset is performed",
  },
  {
    service: SID.READ_DTC_INFORMATION,
    name: "readDtcInformation",
    why: "fault memory, counts, snapshot identification",
  },
  {
    service: SID.READ_DATA_BY_IDENTIFIER,
    name: "readDataByIdentifier",
    why: "identification and DID sweep",
  },
  {
    service: SID.ROUTINE_CONTROL,
    name: "routineControl",
    why: "probed only with the unassigned routine type 0x00 — nothing is started",
  },
  {
    service: SID.TESTER_PRESENT,
    name: "testerPresent",
    why: "keeps the session alive during a long sweep",
  },
];

/** Services that must never appear in a harvest plan, with the reason. */
export const FORBIDDEN_HARVEST_SERVICES: Readonly<Record<number, string>> = {
  [SID.CLEAR_DIAGNOSTIC_INFORMATION]: "clears fault memory — destroys diagnostic history",
  [SID.SECURITY_ACCESS]: "a failed attempt can lock the ECU out",
  [SID.COMMUNICATION_CONTROL]: "changes what the ECU transmits on the bus",
  [SID.WRITE_DATA_BY_IDENTIFIER]: "writes to the ECU",
  [SID.INPUT_OUTPUT_CONTROL_BY_IDENTIFIER]: "actuates hardware",
  [SID.REQUEST_DOWNLOAD]: "can modify ECU memory",
  [SID.CONTROL_DTC_SETTING]: "changes whether faults are recorded",
};

/** The service identifiers of {@link HARVEST_SERVICES} — what the record prints. */
export function harvestServiceIds(): number[] {
  return HARVEST_SERVICES.map((entry) => entry.service);
}

/**
 * Assert that a plan is read-only.
 *
 * Returns the violations instead of throwing, because the caller (a test, the CLI
 * `--print-plan`) has to *show* them: "this plan would write" is a finding with a
 * reason, not an exception to be caught and logged away (AGENTS 26).
 */
export function findWriteRequests(services: readonly number[]): string[] {
  const violations: string[] = [];
  for (const service of services) {
    const reason = FORBIDDEN_HARVEST_SERVICES[service];
    if (reason) {
      violations.push(
        `service 0x${service.toString(16).padStart(2, "0")} is not read-only: ${reason}`,
      );
    }
  }
  return violations;
}

/** Human readable plan, for `--print-plan` and the harvest log. */
export function describeHarvestPlan(plan: ResolvedHarvestPlan): string {
  const lines = [
    `DIDs: ${plan.dids.length} (${plan.didRanges.map((range) => `${range.name} 0x${range.from.toString(16)}–0x${range.to.toString(16)}`).join(", ") || "keine Bereiche"})`,
    `Sitzungen (wählbar mit --session, ohne das Flag bleibt der Lauf in der Default-Sitzung): ${plan.sessions.map((session) => `0x${session.toString(16)}`).join(", ")}`,
    `Dienste: ${HARVEST_SERVICES.map((entry) => `0x${entry.service.toString(16)} ${entry.name}`).join(", ")}`,
    `Fehlerspeicher: ${plan.readDtcs ? "ja" : "nein"} · Aufzeichnungen: ${plan.readDtcRecords ? "ja" : "nein"}`,
    `Schreib-Unterstützung sondieren: ${plan.probeWriteSupport ? "ja (0x2E wird als fehlerhafte Anfrage gesendet)" : "nein — es wird kein Schreibdienst gesendet"}`,
    `Snapshot-Records: ${plan.dtcRecordNumbers.map((n) => `0x${n.toString(16)}`).join(", ")} · erweiterte: ${plan.extendedRecordNumbers.map((n) => `0x${n.toString(16)}`).join(", ")}`,
    `Budget: ${plan.budgetPerEcuMs} ms je ECU · Abstand ${plan.requestGapMs} ms · Doppellesung ${plan.repeatReadsForStability ? "ja" : "nein"}`,
  ];
  return lines.join("\n");
}
