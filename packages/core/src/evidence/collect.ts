/**
 * Evidence collection: what a session can say at one moment (master backlog
 * P0 #39; AGENTS 17, 22, 24).
 *
 * The point is not another model of the car — it is one addressable list of the
 * statements a diagnosis may rest on, each with the IR's own proof. Three consumers
 * read the same list and must not disagree: the workbench (what is measured, what
 * is missing), an analysis provider (what it may claim) and a report (what it must
 * print next to a claim so a reader can weigh it).
 *
 * Two rules hold it together:
 *
 * 1. **Everything an item says, the session already said.** The collector projects
 *    — stored records, statistics, the determination, the open questions. It never
 *    queries an ECU, never invents a value, and never resolves a conflict by
 *    picking a side; a disagreement between two items is reported as a
 *    {@link EvidenceConflict} instead of silently losing one of them.
 * 2. **An absent statement is an item too.** "the ABS never answered" and "nobody
 *    documents P0999" are `gap` items with unproven evidence, not missing rows —
 *    otherwise a reader cannot tell "nothing found" from "nothing looked for"
 *    (ADR 0033).
 *
 * Freeze frames are reported as *presence and length*, never decoded: decoding a
 * snapshot is the protocol's job (AGENTS 3), and an evidence item that guessed a
 * layout would be a second decoder.
 */

import {
  type DtcSeverity,
  type Evidence,
  type EvidenceConflict,
  type EvidenceItem,
  type EvidenceSet,
  evidenceItemId,
  proven,
  unproven,
} from "@vdp/diagnostic-ir";
import type { DtcVariantKnowledge, EnrichedDtc } from "../dtc/scanner.js";
import type { SignalStatistics } from "../measurements/types.js";
import { sessionGapsOf, storedBytes } from "../session/observation.js";
import type { VehicleSessionData } from "../session/session.js";

/** An anomaly as the recorder words it — kept structural so no reporter type leaks in. */
export interface EvidenceAnomaly {
  signal: string;
  reason: string;
  value?: number;
}

/**
 * The part of a fault-memory record the collector reads.
 *
 * Both the live projection (`EnrichedDtc`) and a stored record (`StoredDtcRecord`)
 * satisfy it, which is the point: an analysis of a session that is still running and
 * an analysis of the same session reloaded from disk have to be able to cite the
 * same items (AGENTS 12). `ecuName` is optional because a stored record may predate
 * the field — an evidence item then names the ECU by id rather than guessing a name.
 */
export interface EvidenceDtc {
  code: string;
  /** Absent on a record stored before the session keyed its ECUs — never guessed. */
  ecuId?: string;
  ecuName?: string;
  /** ISO 14229-1 status byte, as the ECU reported it. */
  status: number;
  statusBits: EnrichedDtc["statusBits"];
  /** Raw DTC value in hex — the bytes behind `code`. */
  raw: string;
  failureType: string;
  severity: DtcSeverity;
  description?: string;
  hint?: string;
  firstSeen?: string;
  lastSeen?: string;
  firstSeenInThisScan?: boolean;
  /** The scan's own evidence line (see `EnrichedDtc.evidence`). */
  evidence?: string;
  /** The same proof as data — what the `dtc` item's evidence *is* (ADR 0038). */
  enrichmentEvidence?: Evidence;
  knowledge?: DtcVariantKnowledge;
  /** Raw snapshot bytes, when the ECU sent a freeze frame with the record. */
  snapshot?: Uint8Array;
  /** The ECU's extra data bytes, when it sent any beside the code. */
  extendedData?: Uint8Array;
}

export interface EvidenceInput {
  session: VehicleSessionData;
  /**
   * The scan to cite. Defaults to the last stored snapshot of the session, so a
   * caller that has no live scan (a replay, a report) still gets the same items.
   */
  dtcs?: readonly EvidenceDtc[];
  /** Per-signal statistics from the recorder; absent means nothing was measured. */
  statistics?: readonly SignalStatistics[];
  anomalies?: readonly EvidenceAnomaly[];
  /** Timestamp of the set; defaults to "now" and is always injectable (AGENTS 19). */
  collectedAt?: string;
}

/**
 * Collect the evidence set of one session.
 *
 * The set is a snapshot of a moment: `collectedAt` is when it was taken, every item
 * carries when *it* was observed. Re-running the collector on a session that has
 * since recorded more therefore yields a different set — which is correct, and why
 * an analysis cites item ids instead of summarising them.
 */
export function collectEvidence(input: EvidenceInput): EvidenceSet {
  const session = input.session;
  const collectedAt = input.collectedAt ?? session.endedAt ?? session.startedAt;
  const dtcs = input.dtcs ?? lastScanRecords(session);
  const items: EvidenceItem[] = [];

  for (const dtc of dtcs) {
    items.push(dtcItem(dtc, collectedAt));
    if (storedBytes(dtc.snapshot) !== undefined) items.push(freezeFrameItem(dtc, collectedAt));
    for (const item of patternItems(dtc, collectedAt)) items.push(item);
  }
  for (const stat of input.statistics ?? []) items.push(signalItem(stat, collectedAt));
  for (const anomaly of input.anomalies ?? []) items.push(anomalyItem(anomaly, collectedAt));
  const vehicleItem = vehicleItemOf(session, collectedAt);
  if (vehicleItem !== undefined) items.push(vehicleItem);
  for (const gap of sessionGapsOf(session)) items.push(gapItem(gap, collectedAt));

  return {
    kind: "evidence",
    sessionId: session.id,
    collectedAt,
    items,
    conflicts: conflictsOf(items),
  };
}

/**
 * The records of the last stored scan, as far as they were kept.
 *
 * Byte fields go through `storedBytes` here, because this is the one place that
 * reads a *file's* records: after a reload the snapshot is a JSON object while its
 * type still says `Uint8Array`, and an evidence item that counted `.length` on it
 * would state "undefined byte(s)" (AGENTS 24).
 */
function lastScanRecords(session: VehicleSessionData): EvidenceDtc[] {
  const snapshot = session.dtcSnapshots.at(-1);
  if (snapshot === undefined) return [];
  return snapshot.records.map((record) => {
    const bytes = storedBytes(record.snapshot);
    return { ...record, ...(bytes !== undefined ? { snapshot: bytes } : {}) };
  });
}

/**
 * The item that states a code — and what its *wording* rests on.
 *
 * The ECU answering is not in question here (the record exists because it answered);
 * what an analysis builds on is the description, the hint and the severity, and their
 * source is the enrichment's own evidence. So this item carries that one, unchanged,
 * from the scan (P0 #39). A record with no `enrichmentEvidence` — stored by a build
 * that named none — is reported as unproven with that reason: "we cannot tell" is a
 * finding, and a default of `proven` would silently promote every old record.
 */
function dtcItem(dtc: EvidenceDtc, at: string): EvidenceItem {
  const statement =
    dtc.description ?? `failure type 0x${dtc.failureType}, status 0x${hex(dtc.status)}`;
  const evidence =
    dtc.enrichmentEvidence ??
    unproven("this record carries no enrichment evidence — its wording cannot be sourced here", {
      at,
      ...(dtc.ecuId !== undefined ? { ecuId: dtc.ecuId } : {}),
      serviceId: 0x19,
    });
  return {
    id: evidenceItemId("dtc", dtc.code, dtc.ecuId),
    kind: "dtc",
    subject: dtc.code,
    statement: `${statement} (${dtc.ecuName ?? dtc.ecuId ?? "unknown ECU"}, severity ${dtc.severity})`,
    at,
    ...(dtc.ecuId !== undefined ? { ecuId: dtc.ecuId } : {}),
    evidence,
  };
}

function freezeFrameItem(dtc: EvidenceDtc, at: string): EvidenceItem {
  const bytes = storedBytes(dtc.snapshot) ?? new Uint8Array(0);
  return {
    id: evidenceItemId("freeze-frame", dtc.code, dtc.ecuId),
    kind: "freeze-frame",
    subject: dtc.code,
    // Presence and length only: the layout is the protocol's to know (AGENTS 3).
    statement: `${bytes.length} snapshot byte(s) stored with the record`,
    at,
    ...(dtc.ecuId !== undefined ? { ecuId: dtc.ecuId } : {}),
    evidence: proven({
      origin: "ecu-response",
      at,
      ...(dtc.ecuId !== undefined ? { ecuId: dtc.ecuId } : {}),
      serviceId: 0x19,
    }),
  };
}

/**
 * One item per documented failure pattern.
 *
 * The pattern is a *claim the package makes*, so its provenance is the knowledge
 * source (variant entry or package wording), never the ECU: an ECU never said
 * "the catalyst ages" (AGENTS 24).
 */
function patternItems(dtc: EvidenceDtc, at: string): EvidenceItem[] {
  const knowledge = dtc.knowledge;
  if (knowledge === undefined) return [];
  return knowledge.patterns.map((pattern) => ({
    // The subject carries the code, because that is what makes a pattern
    // attributable: `P0420/catalyst-aged` is one pattern of one code.
    id: evidenceItemId("pattern", `${dtc.code}/${pattern.id}`, dtc.ecuId),
    kind: "pattern" as const,
    subject: `${dtc.code}/${pattern.id}`,
    statement: `${pattern.name} for ${dtc.code}${
      pattern.likelihood === undefined ? "" : ` (declared ${pattern.likelihood})`
    }`,
    at,
    ...(dtc.ecuId !== undefined ? { ecuId: dtc.ecuId } : {}),
    evidence: proven({
      origin: "definition",
      at,
      ...(dtc.ecuId !== undefined ? { ecuId: dtc.ecuId } : {}),
      note: [scopeClause(pattern.scope), sourceClause(knowledge)]
        .filter((p) => p !== "")
        .join(" · "),
    }),
  }));
}

/** Which document the variant statement came from, when the package names one. */
function sourceClause(knowledge: DtcVariantKnowledge): string {
  if (knowledge.provenanceSource === undefined) return "";
  return knowledge.provenanceType === undefined
    ? `source: ${knowledge.provenanceSource}`
    : `source: ${knowledge.provenanceSource} (${knowledge.provenanceType})`;
}

function scopeClause(scope: string): string {
  if (scope === "package") return "package-wide wording, nothing variant-specific";
  return `variant knowledge (${scope})`;
}

function signalItem(stat: SignalStatistics, at: string): EvidenceItem {
  const spread =
    stat.min === null || stat.max === null
      ? "no numeric value recorded"
      : `min ${round(stat.min)} / max ${round(stat.max)} / avg ${round(stat.average ?? 0)}${
          stat.unit ? ` ${stat.unit}` : ""
        }`;
  return {
    id: evidenceItemId("signal", stat.signal),
    kind: "signal",
    subject: stat.signal,
    statement: `${stat.name}: ${stat.samples} sample(s), ${spread}, ${stat.outOfRangeCount} out of range`,
    at,
    // Statistics are derived from readings the ECU answered — proven, with no
    // single raw payload to point at, which is why no `raw` is claimed here.
    evidence: proven({ origin: "derived", at }),
  };
}

function anomalyItem(anomaly: EvidenceAnomaly, at: string): EvidenceItem {
  return {
    id: evidenceItemId("anomaly", anomaly.signal),
    kind: "anomaly",
    subject: anomaly.signal,
    statement: `${anomaly.signal}: ${anomaly.reason}${
      anomaly.value === undefined ? "" : ` (value ${round(anomaly.value)})`
    }`,
    at,
    evidence: proven({ origin: "derived", at }),
  };
}

/**
 * How firmly this session knows which car it is looking at.
 *
 * Absent determination is an item with unproven evidence, not a missing item: a
 * manufacturer-wide statement about an unidentified car is the case where an
 * analysis most needs to be told (AGENTS 11.1 rule 3, ADR 0026).
 */
function vehicleItemOf(session: VehicleSessionData, at: string): EvidenceItem | undefined {
  const determination = session.determination;
  const match = determination?.match;
  if (match === undefined) {
    if (determination?.reason === undefined) return undefined;
    return {
      id: evidenceItemId("vehicle", "determination"),
      kind: "vehicle",
      subject: "determination",
      statement: determination.reason,
      at,
      evidence: unproven("no vehicle matched the recorded identifiers", { at }),
    };
  }
  return {
    id: evidenceItemId("vehicle", match.vehicleId),
    kind: "vehicle",
    subject: match.vehicleId,
    statement:
      `${match.vehicleId} matched on ${Math.round(match.score * 100)} % of the evaluated criteria` +
      (match.provenanceType === undefined ? "" : ` · source ${match.provenanceType}`),
    at,
    // The strength of the match is provenance, not a separate field: a statement
    // about a car nobody identified rests on the same evidence as one about a
    // misidentified one (AGENTS 24).
    evidence: proven({
      origin: "definition",
      at,
      ...(match.provenanceType === undefined
        ? {}
        : { note: `source ${match.provenanceType} · score ${Math.round(match.score * 100)} %` }),
    }),
  };
}

function gapItem(gap: ReturnType<typeof sessionGapsOf>[number], at: string): EvidenceItem {
  return {
    id: evidenceItemId("gap", `${gap.kind}:${gap.subject}`),
    kind: "gap",
    subject: gap.subject,
    statement: gap.detail,
    at,
    evidence: unproven(gap.detail, { at }),
  };
}

/**
 * Two statements about one subject that do not agree.
 *
 * The case this finds is real and specific: a variant entry documents *patterns*
 * for a code while the package's fault-memory list says nothing about it, so the
 * `dtc` item is unproven ("nobody documented this code") and the `pattern` item is
 * proven. Picking either side would throw away the asymmetry — the reason a
 * workshop answer for that code exists although the generic catalog has none.
 */
function conflictsOf(items: readonly EvidenceItem[]): EvidenceConflict[] {
  const conflicts: EvidenceConflict[] = [];
  const dtcs = items.filter((item) => item.kind === "dtc");
  for (const dtc of dtcs) {
    if (dtc.evidence.kind !== "unproven") continue;
    const patterns = items.filter(
      (item) => item.kind === "pattern" && item.evidence.kind === "proven",
    );
    for (const pattern of patterns) {
      // Same ECU, and the pattern names this code in its statement.
      // Two records without an ECU id are treated as one ECU — the session had only
      // one, and a missing id must not silently split the finding.
      if (pattern.ecuId !== dtc.ecuId) continue;
      if (!pattern.subject.startsWith(`${dtc.subject}/`)) continue;
      conflicts.push({
        subject: dtc.subject,
        left: dtc.id,
        right: pattern.id,
        note: "the code is undocumented in the fault-memory catalog while variant knowledge describes a failure pattern for it",
      });
    }
  }
  return conflicts;
}

function hex(value: number): string {
  return value.toString(16).padStart(2, "0");
}

function round(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}
