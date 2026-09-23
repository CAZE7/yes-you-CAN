/**
 * The harvest observation: what a vehicle answered, and nothing more (ADR 0058).
 *
 * A harvest is a **read-only** sweep of one vehicle. Its result is a record of
 * observations — addresses that answered, services that exist, DIDs that returned
 * bytes and how long those bytes were, fault codes with their status bytes and
 * snapshot counts — plus, for every question the vehicle refused or never
 * answered, the refusal itself.
 *
 * Three rules shape this module, and they are the reason it exists as its own
 * type instead of reusing a definition package:
 *
 * 1. **An observation is not knowledge.** A DID that answered 17 printable bytes
 *    is not a VIN, it is "17 printable bytes at DID 0xF190". The `asciiHint`
 *    field is labelled a hint for exactly that reason: standardised DIDs have a
 *    documented meaning, everything else is a guess until a definition package
 *    says otherwise (AGENTS 13, ADR 0033).
 * 2. **A refusal is a result.** `nrc`, `unread` and `gaps` carry what could not be
 *    read with the reason the bus gave. A harvest that dropped them would look
 *    like a car with fewer functions (ADR 0049 is the same argument one layer up).
 * 3. **Everything carries provenance.** The report names its source, its clock and
 *    its platform version, and every item that becomes definition data becomes
 *    `sourceType: "observed"` with a retrieval date — so a harvested package can
 *    never be mistaken for documented data (AGENTS 24).
 */

import type { DtcSeverity, DtcStatusBits } from "@vdp/protocols-uds";

/** Format version of a harvest record. Bumped when the shape changes, never edited in place. */
export const HARVEST_VERSION = 1;

/** What the harvest was pointed at, in words an operator can check later. */
export interface HarvestIdentity {
  /**
   * Where the bytes came from: `adapter:socketcan:can0`, `simulator-5ecu`,
   * `replay:session-….json`. Named, never inferred from the data.
   */
  source: string;
  /** Vehicle identification as read from DID 0xF190 — redacted unless asked for. */
  vin?: string;
  /** True when the VIN was masked before it reached this record. */
  vinRedacted?: boolean;
  /** Operator note, e.g. "customer car, ignition on, engine off". */
  operator?: string;
  /** Platform version that produced the record (the same constant an analysis cites). */
  platformVersion: string;
}

/** The bus the harvest ran on — part of the observation, because it changes what "no answer" means. */
export interface HarvestBus {
  /** CAN identifier width used for the sweep. */
  addressing: "11-bit" | "29-bit";
  /** Functional request identifier used for discovery (e.g. 0x7DF). */
  functionalId: number;
  /** Bus name as the adapter reported it (can0, vcan0, virtual). */
  channel?: string;
  /** True when the adapter reported CAN FD capability. */
  canFd?: boolean;
}

/** One data identifier as the ECU answered it. */
export interface HarvestedDid {
  did: number;
  /** Response payload after the SID/DID echo, as uppercase hex — the evidence. */
  rawHex: string;
  /** Length of that payload in bytes. This is what a multi-DID request needs. */
  byteLength: number;
  /**
   * Printable-ASCII reading of the payload, when every byte is printable.
   *
   * A hint, not a decoding: it is what makes `F190 → "WVWZZZ…"` readable to a
   * human without claiming the ECU meant a VIN. Absent when any byte is not
   * printable, so a reader never sees half a string.
   */
  asciiHint?: string;
  /** True when two consecutive reads returned identical bytes. */
  stable?: boolean;
  /** Why this DID was asked about: `standard`, `identification`, `range`, `definition`. */
  origin: DidOrigin;
}

/**
 * DIDs the ECU refused, aggregated by the part of the plan that asked and the NRC
 * it answered with.
 *
 * A sweep of the identification block asks 128 identifiers and a real ECU answers
 * perhaps ten of them. Storing 118 near-identical refusals would bury the ten
 * answers; dropping them would claim the block was never asked. So the refusal is
 * kept as a **group** with its count and the DID range it covers: "0xF180–0xF1FF,
 * 116 refused with NRC 0x31 (requestOutOfRange)" says both halves in one line.
 */
export interface DidRefusalGroup {
  /** Which part of the plan asked. */
  origin: DidOrigin;
  /** Negative response code the ECU answered with. */
  nrc: number;
  /** How many identifiers were refused with this code. */
  count: number;
  /** Lowest and highest refused identifier, so the group can be checked. */
  firstDid: number;
  lastDid: number;
}

/** Where a DID under test came from — a plan is data, and this says which part of it. */
export type DidOrigin = "standard" | "identification" | "range" | "definition";

/** One fault code as the ECU reported it, with the mask that makes its status readable. */
export interface HarvestedDtc {
  code: string;
  raw: string;
  failureType: string;
  status: number;
  statusBits: DtcStatusBits;
  /** Graded from the status bits the ECU says it implements (ADR 0058, §11.3.4.2). */
  severity: DtcSeverity;
  /** DTC status availability mask reported with the code. */
  availabilityMask?: number;
  /** `0x19 0x03`: how many snapshot records the ECU stores for this code. */
  snapshotRecordCount?: number;
  /** Snapshot (freeze frame) records that were read, raw — layout is OEM knowledge. */
  snapshots?: Array<{ recordNumber: number; rawHex: string }>;
  /** Extended data records that were read, raw. */
  extendedRecords?: Array<{ recordNumber: number; rawHex: string }>;
}

/** One identification value read from a standardised or definition-declared DID. */
export interface HarvestedIdentification {
  did: number;
  label: string;
  rawHex: string;
  asciiHint?: string;
}

/** One ECU that answered, with everything that could be read from it. */
export interface HarvestedEcu {
  /** Stable identifier derived from the address, e.g. `ecu-7e8`. */
  id: string;
  /** Human readable name — from a definition package when one matched, else the address. */
  name: string;
  txId: number;
  rxId: number;
  extended: boolean;
  /** Definition package ECU id, when discovery matched a package. */
  definitionEcuId?: string;
  /** Session types the ECU accepted (0x10 probe), including the default session. */
  acceptedSessions: number[];
  /** Timing the ECU reported for the session it is in (ISO 14229-2 §7.2.2). */
  timing?: { p2Ms?: number; p2StarMs?: number };
  /** Every service probe with its outcome — including the ones deliberately not probed. */
  serviceProbes: Array<{ service: number; outcome: string; detail?: string }>;
  supportedServices: number[];
  identification: HarvestedIdentification[];
  /** DIDs that answered. Refusals are aggregated in {@link HarvestedEcu.didRefusals}. */
  dids: HarvestedDid[];
  /** DIDs that were asked and refused, grouped by plan origin and NRC. */
  didRefusals: DidRefusalGroup[];
  /** DTC status availability mask, when a fault memory was read. */
  dtcAvailabilityMask?: number;
  /** Number reported by `0x19 0x01`, when the ECU answered it. */
  dtcCount?: number;
  dtcs: HarvestedDtc[];
  /** What could not be read from this ECU, with the reason the bus gave. */
  gaps: Array<{ stage: string; reason: string }>;
}

/** An address that was asked and never answered — the other half of a sweep (ADR 0049). */
export interface HarvestUnread {
  rxId: number;
  txId: number;
  extended: boolean;
  reason: string;
}

/** The plan the harvest ran with, so a reader can tell a gap from an omission. */
export interface HarvestPlan {
  /** Service identifiers probed. */
  services: readonly number[];
  /** Session types probed. */
  sessions: readonly number[];
  /** DID ranges swept, as inclusive pairs. */
  didRanges: ReadonlyArray<{ from: number; to: number }>;
  /** Standardised DIDs read by name. */
  standardDids: readonly number[];
  /** Snapshot/extended record numbers requested per code. */
  dtcRecordNumbers: readonly number[];
  /** Per-ECU time budget in ms; the sweep stops asking when it is spent. */
  budgetPerEcuMs: number;
  /** Pause between two requests, so a real bus is not flooded. */
  requestGapMs: number;
}

/** Summary counts — what a report prints before the details. */
export interface HarvestCounts {
  ecusAnswered: number;
  addressesUnread: number;
  didsRead: number;
  didsRefused: number;
  dtcsFound: number;
  snapshotsRead: number;
  requestsSent: number;
}

/** A complete harvest of one vehicle. */
export interface HarvestReport {
  kind: "vdp.harvest";
  version: number;
  identity: HarvestIdentity;
  bus: HarvestBus;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  plan: HarvestPlan;
  ecus: HarvestedEcu[];
  unread: HarvestUnread[];
  counts: HarvestCounts;
  /** What the harvest did not do, and why — never a silent omission. */
  notes: string[];
}

/**
 * Stable ECU identifier from its response address.
 *
 * One rule, used by the harvest, the ODX projection and the definition candidate:
 * two artifacts naming the same ECU differently would not be mergeable.
 */
export function ecuIdOf(rxId: number, extended: boolean): string {
  return `ecu-${rxId.toString(16).padStart(extended ? 8 : 3, "0")}`;
}

/**
 * The VIN as a harvest stores it: masked unless the operator asked for the clear text.
 *
 * A VIN is personal data (it identifies a vehicle and, through registration data,
 * its keeper — AGENTS 30). The default is therefore the middle masked, keeping the
 * WMI and the model-year/plant positions, which are the ones a definition package
 * actually matches on. The rule mirrors the golden-session redaction
 * (`tools/golden-sessions/src/redact.ts`), which works on ISO-TP bytes instead of
 * a decoded string; both keep the same positions.
 */
export function redactVin(vin: string): string {
  const trimmed = vin.trim();
  if (trimmed.length < 9) return "*".repeat(trimmed.length);
  const head = trimmed.slice(0, 3);
  const tail = trimmed.slice(-4);
  return `${head}${"*".repeat(trimmed.length - 7)}${tail}`;
}

/** True when every byte of the payload is a printable ASCII character. */
export function printableAscii(bytes: readonly number[]): string | undefined {
  if (bytes.length === 0) return undefined;
  let text = "";
  for (const byte of bytes) {
    if (byte < 0x20 || byte > 0x7e) return undefined;
    text += String.fromCharCode(byte);
  }
  return text;
}

/**
 * Summary of a harvest in operator language.
 *
 * Both halves are always named: how many modules answered *and* how many did not.
 * Reporting only the first is the defect ADR 0049 exists to prevent.
 */
export function summariseHarvest(report: HarvestReport): string {
  const parts = [
    `${report.counts.ecusAnswered} ECU(s) gelesen`,
    `${report.counts.addressesUnread} Adresse(n) ohne Antwort`,
    `${report.counts.didsRead} DID(s) gelesen`,
    `${report.counts.didsRefused} DID(s) verweigert`,
    `${report.counts.dtcsFound} Fehlercode(s)`,
    `${report.counts.snapshotsRead} Freeze-Frame(s)`,
    `${report.counts.requestsSent} Anfragen`,
  ];
  return parts.join(" · ");
}
