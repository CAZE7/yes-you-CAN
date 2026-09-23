/**
 * From an observation to a definition candidate (ADR 0058, AGENTS 13/24).
 *
 * The harvest record is the evidence; this module turns the parts of it that a
 * definition package can carry — addresses, services, DIDs with their byte length,
 * fault codes — into a **candidate** package that `@vdp/definitions` validates with
 * the same rules as a hand-written one. Three decisions shape it, and each one
 * exists so a harvested package cannot look like documented knowledge:
 *
 * 1. **Provenance is `observed`, everywhere.** Package, ECU, DTC and signal each
 *    carry their own `Provenance` with the source, the date and what was seen. A
 *    reader can therefore tell "this ECU answered 0x7E8" from "VW documents this
 *    ECU" without opening the harvest record.
 * 2. **A signal is only emitted when its length has a documented encoding.** Four
 *    bytes become `uint32`, printable bytes become `ascii` — and eleven bytes of
 *    unknown meaning become *no signal*, listed in {@link DefinitionCandidate.skipped}
 *    with the reason. Inventing a `uint8` at offset 0 of an unknown record would be
 *    a decoding nobody documented (AGENTS 13: OEM knowledge is data, not a guess).
 * 3. **Names stay what they are.** A harvested ECU is named by its address unless a
 *    definition package already declared it; a harvested DTC's description says the
 *    code was *reported*, not what it means.
 *
 * The result is a candidate, not a package to ship: it is meant to be reviewed,
 * enriched from a documented source, and re-validated. `validateDefinitionPackage`
 * is run by the caller (`@vdp/definitions` owns the rules — this tool must not
 * restate them, the same boundary the DBC/CSV importer keeps).
 */

import {
  CURRENT_SCHEMA_VERSION,
  type DefinitionPackage,
  type DtcDefinition,
  type EcuDefinition,
  type Provenance,
  type SignalDefinition,
  type SignalEncoding,
} from "@vdp/definitions";
import type { HarvestedDid, HarvestedDtc, HarvestedEcu, HarvestReport } from "./observation.js";

export interface DefinitionCandidateOptions {
  /** Manufacturer key of the candidate package, e.g. `vag` or `harvest`. */
  oem: string;
  /** Package name; defaults to a name built from the harvest source and date. */
  name?: string;
  /** SemVer of the candidate; defaults to `0.1.0+<date>`. */
  version?: string;
  /** Operator note added to every provenance entry. */
  operator?: string;
}

/** One observation that did not become definition data, with the reason. */
export interface SkippedObservation {
  /** ECU the observation belongs to. */
  ecuId: string;
  /** What was observed: `did:0xf1a3`, `dtc:P1A23`, … */
  item: string;
  /** Why it stayed out of the candidate. */
  reason: string;
}

/** The candidate package plus everything that was left out, and why. */
export interface DefinitionCandidate {
  pkg: DefinitionPackage;
  skipped: SkippedObservation[];
  /** Provenance every entry of this candidate carries. */
  provenance: Provenance;
}

/**
 * Build the definition candidate of one harvest.
 *
 * The package is at the current schema version and carries no vehicles: a harvest
 * observes ECUs, it does not determine which model they belong to — that is the
 * vehicle resolver's job, with evidence (`packages/definitions/src/resolve.ts`).
 */
export function definitionCandidate(
  report: HarvestReport,
  options: DefinitionCandidateOptions,
): DefinitionCandidate {
  const provenance = harvestProvenance(report, options);
  const skipped: SkippedObservation[] = [];
  const ecus: EcuDefinition[] = [];
  const signals: SignalDefinition[] = [];

  for (const harvested of report.ecus) {
    ecus.push(ecuDefinition(harvested, report, provenance));
    for (const did of harvested.dids) {
      const signal = signalOf(harvested, did, provenance);
      if (signal) signals.push(signal);
      else {
        skipped.push({
          ecuId: harvested.id,
          item: `did:0x${did.did.toString(16)}`,
          reason:
            `${did.byteLength} byte(s) ohne dokumentierte Bedeutung — keine Kodierung passt ` +
            "(1/2/3/4 Byte → uintN, druckbar → ascii); der Wert bleibt im Ernte-Datensatz",
        });
      }
    }
    for (const dtc of harvested.dtcs) {
      const definition = dtcDefinition(harvested, dtc, report, provenance);
      if (definition) {
        const existing = ecus.find((ecu) => ecu.id === ecuId(harvested));
        if (existing) {
          existing.dtcs = [...(existing.dtcs ?? []), definition];
        }
      } else {
        skipped.push({
          ecuId: harvested.id,
          item: `dtc:${dtc.code}-${dtc.failureType}`,
          reason:
            "der Code entspricht nicht der SAE-J2012-Zeichenform, die das Schema prüft " +
            "(`^[PCBU]\\d[0-9A-F]{3}$`) — er bleibt als Beobachtung im Ernte-Datensatz",
        });
      }
    }
  }

  const pkg: DefinitionPackage = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    oem: options.oem,
    name: options.name ?? `Harvest ${report.identity.source} ${report.startedAt.slice(0, 10)}`,
    version: options.version ?? `0.1.0+${report.startedAt.slice(0, 10).replaceAll("-", "")}`,
    provenance,
    ecus,
    signals,
  };
  return { pkg, skipped, provenance };
}

/** The provenance every entry of a harvested candidate carries. */
export function harvestProvenance(
  report: HarvestReport,
  options: DefinitionCandidateOptions,
): Provenance {
  const notes = [
    "read-only harvest; every entry is an observation of one vehicle at one point in time",
    `ECUs answered: ${report.counts.ecusAnswered}; addresses without an answer: ${report.counts.addressesUnread}`,
    `VIN ${report.identity.vinRedacted === true ? "masked" : report.identity.vin !== undefined ? "in clear text" : "not read"}`,
    ...report.notes,
    ...(options.operator !== undefined ? [`operator: ${options.operator}`] : []),
  ];
  return {
    sourceType: "observed",
    source: `${report.identity.source} (${report.bus.addressing}, functional 0x${report.bus.functionalId.toString(16)})`,
    retrievedAt: report.startedAt.slice(0, 10),
    version: `harvest v${report.version}, platform ${report.identity.platformVersion}`,
    notes: notes.join(" · "),
  };
}

/** Stable ECU id inside the candidate package. */
export function ecuId(harvested: HarvestedEcu): string {
  return harvested.definitionEcuId ?? harvested.id;
}

/** One harvested ECU as an {@link EcuDefinition}. */
function ecuDefinition(
  harvested: HarvestedEcu,
  report: HarvestReport,
  provenance: Provenance,
): EcuDefinition {
  const ecu: EcuDefinition = {
    id: ecuId(harvested),
    name: harvested.name,
    address: {
      txId: harvested.txId,
      rxId: harvested.rxId,
      ...(harvested.extended ? { extended: true } : {}),
      functionalId: report.bus.functionalId,
    },
    protocol: "uds",
    ...(harvested.timing
      ? {
          timing: {
            ...(harvested.timing.p2Ms !== undefined ? { p2Ms: harvested.timing.p2Ms } : {}),
            ...(harvested.timing.p2StarMs !== undefined
              ? { p2StarMs: harvested.timing.p2StarMs }
              : {}),
          },
        }
      : {}),
    // Only the services the ECU actually answered for: a probe that was not sent
    // is not a supported service, and the record says which probes were skipped.
    ...(harvested.supportedServices.length > 0
      ? { services: [...harvested.supportedServices].sort((a, b) => a - b) }
      : {}),
    ...(harvested.identification.length > 0
      ? {
          identification: harvested.identification.map((entry) => ({
            label: entry.label,
            did: entry.did,
            ...(entry.asciiHint !== undefined ? { encoding: "ascii" as SignalEncoding } : {}),
          })),
        }
      : {}),
    description:
      harvested.definitionEcuId !== undefined
        ? `Adresse aus dem Definitionspaket (${harvested.definitionEcuId}); am ${report.startedAt.slice(0, 10)} beobachtet auf ${report.identity.source}`
        : `Am ${report.startedAt.slice(0, 10)} auf ${report.identity.source} beobachtet: Tx 0x${harvested.txId.toString(16)}, Rx 0x${harvested.rxId.toString(16)}. Name und Dienste sind Beobachtung, keine Dokumentation.`,
    provenance: {
      ...provenance,
      source: `${provenance.source}, ECU 0x${harvested.rxId.toString(16)}`,
      notes:
        harvested.gaps.length > 0
          ? `${provenance.notes ?? ""} · nicht lesbar: ${harvested.gaps.map((gap) => `${gap.stage}: ${gap.reason}`).join("; ")}`
          : (provenance.notes ?? ""),
    },
  };
  return ecu;
}

/**
 * One harvested DID as a {@link SignalDefinition}, or `null` when no documented
 * encoding fits its length.
 *
 * A refused DID yields nothing: there is no value to describe, and the refusal is
 * already an observation in the harvest record.
 */
function signalOf(
  harvested: HarvestedEcu,
  did: HarvestedDid,
  provenance: Provenance,
): SignalDefinition | null {
  if (did.byteLength === 0) return null;
  const encoding = encodingOf(did);
  if (encoding === null) return null;
  const id = `${ecuId(harvested)}.did_${did.did.toString(16).padStart(4, "0")}`;
  return {
    id,
    name: `DID 0x${did.did.toString(16).padStart(4, "0").toUpperCase()}`,
    ecu: ecuId(harvested),
    did: did.did,
    service: 0x22,
    byteOffset: 0,
    length: did.byteLength,
    encoding,
    ...(did.byteLength > 1 && encoding !== "ascii" ? { endianness: "big" as const } : {}),
    description:
      did.asciiHint !== undefined
        ? `Beobachtet: ${did.byteLength} druckbare ASCII-Byte(s) "${did.asciiHint}" — ein Hinweis, keine Dekodierung`
        : `Beobachtet: ${did.byteLength} Byte(s), roh${did.stable === false ? ", bei Doppellesung nicht stabil" : did.stable === true ? ", bei Doppellesung stabil" : ""}`,
    provenance: {
      ...provenance,
      source: `${provenance.source}, DID 0x${did.did.toString(16)} an ECU 0x${harvested.rxId.toString(16)}`,
      notes: `${provenance.notes} · roh ${did.rawHex}`,
    },
  };
}

/**
 * The encoding a length and a byte pattern justify — and `null` when none does.
 *
 * Printable bytes are `ascii` whatever their length, because that is the one
 * statement the bytes themselves support. Otherwise only the four natural integer
 * widths are emitted: a five-byte record is not a `uint32` plus a stray byte, and
 * pretending otherwise would put an invented decoding into a validated package.
 */
export function encodingOf(
  did: Pick<HarvestedDid, "byteLength" | "asciiHint">,
): SignalEncoding | null {
  if (did.asciiHint !== undefined) return "ascii";
  switch (did.byteLength) {
    case 1:
      return "uint8";
    case 2:
      return "uint16";
    case 3:
      return "uint24";
    case 4:
      return "uint32";
    default:
      return null;
  }
}

/** The J2012 character form the schema accepts; anything else is skipped, not bent. */
const VALID_DTC_CODE = /^[PCBU]\d[0-9A-Fa-f]{3}$/;

/** One harvested fault code as a {@link DtcDefinition}. */
function dtcDefinition(
  harvested: HarvestedEcu,
  dtc: HarvestedDtc,
  report: HarvestReport,
  provenance: Provenance,
): DtcDefinition | null {
  if (!VALID_DTC_CODE.test(dtc.code)) return null;
  const snapshotNote =
    dtc.snapshots !== undefined && dtc.snapshots.length > 0
      ? ` Freeze Frames: ${dtc.snapshots.map((entry) => `#${entry.recordNumber} ${entry.rawHex}`).join(", ")}.`
      : dtc.snapshotRecordCount === 0
        ? " Das Steuergerät meldet keinen Freeze Frame zu diesem Code."
        : "";
  return {
    code: dtc.code,
    description:
      `Am ${report.startedAt.slice(0, 10)} von ${harvested.name} (0x${harvested.rxId.toString(16)}) ` +
      `mit Status 0x${dtc.status.toString(16).padStart(2, "0")} gemeldet ` +
      `(Failure-Type ${dtc.failureType}). Bedeutung nicht dokumentiert — dies ist eine Beobachtung.${snapshotNote}`,
    severity: dtc.severity,
    ...(dtc.snapshots !== undefined && dtc.snapshots.length > 0
      ? {
          // The layout stays unknown, so the record is one field of raw bytes: a
          // split into DIDs would be invented (AGENTS 13, freeze-frame.ts).
          freezeFrame: dtc.snapshots.map((entry) => ({
            did: 0x0000,
            name: `Aufzeichnung 0x${entry.recordNumber.toString(16)} (roh, Layout undokumentiert)`,
            length: entry.rawHex.length / 2,
          })),
        }
      : {}),
    provenance: {
      ...provenance,
      source: `${provenance.source}, DTC ${dtc.code}-${dtc.failureType} an ECU 0x${harvested.rxId.toString(16)}`,
      notes: `${provenance.notes} · Status 0x${dtc.status.toString(16).padStart(2, "0")}, Verfügbarkeitsmaske 0x${(
        dtc.availabilityMask ?? 0
      )
        .toString(16)
        .padStart(
          2,
          "0",
        )}${dtc.snapshotRecordCount !== undefined ? `, ${dtc.snapshotRecordCount} Snapshot-Aufzeichnung(en)` : ""}`,
    },
  };
}
