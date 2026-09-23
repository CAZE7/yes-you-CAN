/**
 * The ODX projection of a harvest (ISO 22901-1 / ASAM ODX 2.2, ADR 0058).
 *
 * ODX is an **exchange format for diagnostic descriptions**: what a manufacturer
 * publishes about an ECU so a tester can talk to it without knowing the ECU. A car
 * does not contain an ODX file, so a harvest cannot "extract" one — what it can do
 * is describe *what the car answered* in ODX's own vocabulary, and that is what
 * this module writes:
 *
 * - one `BASE-VARIANT` per ECU that answered, its addresses and timing in `SDGS`,
 * - one `DIAG-SERVICE` per observed request/response pair, as a **raw byte recipe**
 *   (`CODED-CONST` for the SID and the DID, a byte-field `VALUE` for the payload),
 *   so the file *encodes* the request that was sent and *decodes* the answer that
 *   came back — verified against the reference implementation (`odxtools`),
 * - one `DTC-DOP` per ECU with a `DTC` per observed code, its status byte, the
 *   availability mask and the snapshot count in `SDGS`,
 * - `ENV-DATA-DESC`/`ENV-DATA` for the freeze frames that were read, raw,
 * - and, everywhere, the provenance: `observed`, with the time and the source.
 *
 * What this file deliberately does **not** contain is meaning. No scaling, no
 * units, no physical types beyond "these bytes", no invented names: a harvested
 * DOP is a byte field, and a harvested DTC text says the code was reported, not
 * what it means. Turning an observation into knowledge is the definition package's
 * job (`../definition.ts`), with a source somebody can check (AGENTS 13, 24).
 *
 * Also deliberately absent: the ODX-C communication-parameter layer. Describing
 * ISO 15765 comparams properly means carrying the standard's comparam subsets,
 * which is a dependency decision, not a writer decision (ADR 0002/0010). The
 * addressing therefore travels in `SDGS` — readable by a human and by our own
 * importer, invisible to a D-Server that expects `COMPARAM-SPEC-REF`. That limit
 * is stated in the document itself, so nobody mistakes the artifact for a
 * complete vehicle description.
 */

import type { HarvestedDid, HarvestedDtc, HarvestedEcu, HarvestReport } from "../observation.js";
import {
  element,
  emptyElement,
  odxRoot,
  odxShortName,
  renderOdxDocument,
  textElement,
  type XmlElement,
  xsiType,
} from "./xml.js";

/** Short name of the container; derived from the source when the caller gives none. */
export interface OdxDiagLayerOptions {
  /** Container short name (ODX ID fragment). Defaults to `harvest_<source>`. */
  containerShortName?: string;
  /** Long, human readable container name. */
  containerLongName?: string;
}

/** The semantic ODX assigns to a service; a harvest only ever identifies or reads. */
type DiagSemantic = "IDENTIFICATION" | "CURRENT_DATA" | "STORED_DATA" | "FUNCTIONAL";

/** One observed request/response pair, ready to become a DIAG-SERVICE. */
export interface ObservedService {
  shortName: string;
  longName: string;
  semantic: DiagSemantic;
  /** Request bytes, e.g. `22 F1 90`. */
  request: Uint8Array;
  /** Response bytes including SID echo, e.g. `62 F1 90 …`. */
  response: Uint8Array;
  /** Where the payload starts inside the response (after SID + DID). */
  payloadOffset: number;
  /** Extra SDG entries describing the observation. */
  facts: Array<[string, string]>;
  description: string;
}

/**
 * Write the ODX-D document (a `DIAG-LAYER-CONTAINER`) for one harvest.
 *
 * The output is a complete, well-formed XML document as a string; `pdx.ts` puts it
 * into the container a PDX is.
 */
export function renderOdxHarvest(report: HarvestReport, options: OdxDiagLayerOptions = {}): string {
  return renderOdxDocument(odxDiagLayerContainer(report, options));
}

/** The `DIAG-LAYER-CONTAINER` element of one harvest. */
export function odxDiagLayerContainer(
  report: HarvestReport,
  options: OdxDiagLayerOptions = {},
): XmlElement {
  const container = options.containerShortName ?? containerShortNameOf(report);
  const children: XmlElement[] = [
    textElement("SHORT-NAME", container),
    textElement(
      "LONG-NAME",
      options.containerLongName ?? `Harvest ${report.startedAt} — ${report.identity.source}`,
    ),
    description([
      "Read-only harvest of one vehicle: every statement in this file is an observation",
      "of what an ECU answered, not documentation of what it means.",
      "",
      `Quelle: ${report.identity.source}`,
      `Zeit: ${report.startedAt} … ${report.finishedAt}`,
      `VIN: ${report.identity.vin ?? "nicht gelesen"}${report.identity.vinRedacted === true ? " (maskiert)" : ""}`,
      `Steuergeräte: ${report.counts.ecusAnswered} gelesen, ${report.counts.addressesUnread} ohne Antwort`,
      `DIDs: ${report.counts.didsRead} gelesen, ${report.counts.didsRefused} verweigert`,
      `Fehlercodes: ${report.counts.dtcsFound}, Freeze Frames: ${report.counts.snapshotsRead}`,
      "",
      "Nicht enthalten: die ODX-C-Kommunikationsparameter (COMPARAM-SPEC) — die",
      "Adressierung steht als SDG je Variante. Keine Skalierung, keine Einheiten,",
      "keine erfundenen Bedeutungen.",
    ]),
    provenanceSdg(report),
    adminData(),
  ];

  const variants = report.ecus.map((ecu) => baseVariant(ecu, container, report));
  children.push(element("BASE-VARIANTS", undefined, variants));

  return odxRoot([
    {
      name: "DIAG-LAYER-CONTAINER",
      attributes: { ID: container },
      children,
    },
  ]);
}

/** One ECU as a `BASE-VARIANT`. */
function baseVariant(ecu: HarvestedEcu, container: string, report: HarvestReport): XmlElement {
  const id = `${container}.${ecu.id}`;
  const services = observedServicesOf(ecu);
  const dtcDop = dtcDopElement(ecu, id);
  const envDescs = environmentDescriptions(ecu, id);

  const children: XmlElement[] = [
    textElement("SHORT-NAME", ecu.id),
    textElement("LONG-NAME", ecu.name),
    description([
      `Beobachtet auf ${report.identity.source} am ${report.startedAt}.`,
      `Adresse: Tx 0x${ecu.txId.toString(16)}, Rx 0x${ecu.rxId.toString(16)}${ecu.extended ? " (29-bit)" : " (11-bit)"}.`,
      ecu.definitionEcuId !== undefined
        ? `Definition: ${ecu.definitionEcuId} — die Namen aus dem Paket sind dort belegt, nicht hier.`
        : "Kein Definitionspaket hat diese Adresse deklariert: Name und Dienste sind beobachtet.",
      ecu.gaps.length > 0
        ? `Nicht lesbar: ${ecu.gaps.map((gap) => `${gap.stage} (${gap.reason})`).join("; ")}`
        : "Alle geplanten Stufen haben geantwortet.",
    ]),
    ecuFactsSdg(ecu, report),
  ];

  children.push(
    element(
      "DIAG-COMMS",
      undefined,
      services.map((service) => diagService(service, id)),
    ),
  );
  children.push(
    element(
      "REQUESTS",
      undefined,
      services.map((service) => requestStructure(service, id)),
    ),
  );
  children.push(
    element(
      "POS-RESPONSES",
      undefined,
      services.map((service) => positiveResponseStructure(service, id)),
    ),
  );

  const dictionary: XmlElement[] = [
    element(
      "DATA-OBJECT-PROPS",
      undefined,
      services
        .filter((service) => service.response.length > service.payloadOffset)
        .map((service) => payloadDop(service, id)),
    ),
  ];
  if (dtcDop) dictionary.push(element("DTC-DOPS", undefined, [dtcDop]));
  if (envDescs.length > 0) dictionary.push(element("ENV-DATA-DESCS", undefined, envDescs));
  children.push(element("DIAG-DATA-DICTIONARY-SPEC", undefined, dictionary));

  return { name: "BASE-VARIANT", attributes: { ID: id }, children };
}

/**
 * The observed services of one ECU.
 *
 * One service per DID that answered — that is where a harvest has both a request
 * and a response to describe — plus the fault-memory read when codes were seen.
 * A DID that refused has no response to describe; it stays in the ECU's `SDGS`
 * (and, when asked for, becomes a service with a request only), because a
 * `POS-RESPONSE` nobody observed would be invented.
 */
export function observedServicesOf(ecu: HarvestedEcu): ObservedService[] {
  const services: ObservedService[] = [];
  for (const did of ecu.dids) {
    // Only identifiers the ECU answered become services: a refused read has no
    // positive response to describe, and inventing one would put a statement in
    // the file that the vehicle never made. The refusals are stated in the ECU's
    // SDGs, as counts with their NRC and the range they cover.
    const payload = fromHex(did.rawHex);
    services.push({
      shortName: `read_did_${hex4(did.did)}`,
      longName: `ReadDataByIdentifier 0x${hex4(did.did)}`,
      semantic: semanticOf(did),
      request: new Uint8Array([0x22, (did.did >> 8) & 0xff, did.did & 0xff]),
      response: concat([new Uint8Array([0x62, (did.did >> 8) & 0xff, did.did & 0xff]), payload]),
      payloadOffset: 3,
      facts: [
        ["observed", "positive-response"],
        ["byte-length", String(did.byteLength)],
        ["origin", did.origin],
        ...(did.stable !== undefined
          ? ([["stable", did.stable ? "yes" : "no"]] as Array<[string, string]>)
          : []),
        ...(did.asciiHint !== undefined
          ? ([["ascii-hint", did.asciiHint]] as Array<[string, string]>)
          : []),
      ],
      description:
        did.asciiHint !== undefined
          ? `Observed ${did.byteLength} byte(s) at DID 0x${hex4(did.did)}; every byte is printable ASCII ("${did.asciiHint}"), which is a hint at a string, not a decoding.`
          : `Observed ${did.byteLength} byte(s) at DID 0x${hex4(did.did)}. The bytes are the observation; their meaning is not documented here.`,
    });
  }

  if (ecu.dtcs.length > 0) {
    const list = ecu.dtcs
      .map((dtc) => `${dtc.code} status 0x${dtc.status.toString(16).padStart(2, "0")}`)
      .join(", ");
    services.push({
      shortName: "read_dtc_by_status_mask",
      longName: "ReadDTCInformation reportDTCByStatusMask (0x19 0x02)",
      semantic: "STORED_DATA",
      request: new Uint8Array([0x19, 0x02, 0xff]),
      response: dtcListResponse(ecu),
      payloadOffset: 3,
      facts: [
        ["observed", "positive-response"],
        ["availability-mask", `0x${(ecu.dtcAvailabilityMask ?? 0).toString(16).padStart(2, "0")}`],
        ["dtc-count", String(ecu.dtcs.length)],
        ...(ecu.dtcCount !== undefined
          ? ([["reported-count", String(ecu.dtcCount)]] as Array<[string, string]>)
          : []),
      ],
      description: `The fault memory as this ECU reported it: ${list}. Each record is DTC(3 bytes) + status(1 byte); the third header byte is the DTC status availability mask (ISO 14229-1 §11.3.4.2).`,
    });
  }
  return services;
}

/**
 * One expected round trip: the bytes the ECU sent and the service that describes them.
 *
 * The ODX file claims to describe an observed conversation; this list is what that
 * claim is checked against, by a reader that did not write the file
 * ({@link verifyOdxDocument}). It is derived from the same observations the writer
 * uses, so a document that loses or invents a byte fails the cross-check instead of
 * only failing a test written by the same author.
 */
export interface OdxExpectation {
  /** Base-variant short name, i.e. the harvested ECU id. */
  variant: string;
  /** Service short name inside that variant. */
  service: string;
  /** The request bytes the harvest sent, as uppercase hex without separators. */
  requestHex: string;
  /** The response bytes the ECU answered with, as uppercase hex. */
  responseHex: string;
}

/** The round trips one harvest expects its ODX document to reproduce. */
export function expectationsOf(report: HarvestReport): OdxExpectation[] {
  const expectations: OdxExpectation[] = [];
  for (const ecu of report.ecus) {
    for (const service of observedServicesOf(ecu)) {
      expectations.push({
        variant: ecu.id,
        service: service.shortName,
        requestHex: toHexText(service.request),
        responseHex: toHexText(service.response),
      });
    }
  }
  return expectations;
}

/** Uppercase hex without separators — the form the cross-check compares in. */
export function toHexText(bytes: ArrayLike<number>): string {
  let text = "";
  for (let index = 0; index < bytes.length; index += 1) {
    text += (bytes[index] ?? 0).toString(16).padStart(2, "0");
  }
  return text.toUpperCase();
}

/** The observed `0x19 0x02` response bytes, rebuilt from the records. */
function dtcListResponse(ecu: HarvestedEcu): Uint8Array {
  const body: number[] = [0x59, 0x02, ecu.dtcAvailabilityMask ?? 0xff];
  for (const dtc of ecu.dtcs) {
    const raw = fromHex(dtc.raw);
    body.push(raw[0] ?? 0, raw[1] ?? 0, raw[2] ?? 0, dtc.status & 0xff);
  }
  return new Uint8Array(body);
}

/** One `DIAG-SERVICE` with its request and response references. */
function diagService(service: ObservedService, id: string): XmlElement {
  const serviceId = `${id}.${service.shortName}`;
  return {
    name: "DIAG-SERVICE",
    attributes: { ID: serviceId, SEMANTIC: service.semantic },
    children: [
      textElement("SHORT-NAME", service.shortName),
      textElement("LONG-NAME", service.longName),
      description([service.description]),
      factSdg(service.facts),
      { name: "REQUEST-REF", attributes: { "ID-REF": `${serviceId}.request` } },
      element("POS-RESPONSE-REFS", undefined, [
        { name: "POS-RESPONSE-REF", attributes: { "ID-REF": `${serviceId}.response` } },
      ]),
    ],
  };
}

/** The request structure: SID and DID as coded constants, payload as a byte field. */
function requestStructure(service: ObservedService, id: string): XmlElement {
  const request = service.request;
  const params: XmlElement[] = [codedConstParam("sid", 0, request[0] ?? 0, 8, "SERVICE-ID")];
  if (request.length >= 3) {
    // The DID is one 16-bit field, not two bytes: a tester that wants to change
    // the identifier changes one value.
    params.push(
      codedConstParam("data_id", 1, ((request[1] ?? 0) << 8) | (request[2] ?? 0), 16, "DATA-ID"),
    );
  } else if (request.length === 2) {
    params.push(codedConstParam("sub_function", 1, request[1] ?? 0, 8, "SUBFUNCTION"));
  }
  if (request.length > 3) {
    // Anything behind the DID (a status mask, a record number, a routine type) is
    // one coded constant of the length that was actually sent — the harvest does
    // not split fields it cannot prove are fields.
    const tail = Array.from(request.subarray(3));
    params.push({
      name: "PARAM",
      attributes: xsiType("CODED-CONST"),
      children: [
        textElement("SHORT-NAME", "request_options"),
        textElement("BYTE-POSITION", "3"),
        textElement("CODED-VALUE", String(bytesToNumber(tail))),
        diagCodedType("A_UINT32", tail.length * 8),
      ],
    });
  }
  return {
    name: "REQUEST",
    attributes: { ID: `${id}.${service.shortName}.request` },
    children: [
      textElement("SHORT-NAME", `${service.shortName}_request`),
      element("PARAMS", undefined, params),
    ],
  };
}

/** The positive response: SID echo, DID echo, and the observed payload as a byte field. */
function positiveResponseStructure(service: ObservedService, id: string): XmlElement {
  const response = service.response;
  const params: XmlElement[] = [codedConstParam("sid", 0, response[0] ?? 0, 8, "SERVICE-ID")];
  if (service.shortName.startsWith("read_did_") && response.length >= 3) {
    params.push(
      codedConstParam("data_id", 1, ((response[1] ?? 0) << 8) | (response[2] ?? 0), 16, "DATA-ID"),
    );
  } else if (response.length >= 3 && !service.shortName.startsWith("read_did_")) {
    params.push(
      codedConstParam("sub_function", 1, response[1] ?? 0, 8, "SUBFUNCTION"),
      codedConstParam("availability_mask", 2, response[2] ?? 0, 8, undefined),
    );
  }
  const payloadLength = response.length - service.payloadOffset;
  if (payloadLength > 0) {
    params.push({
      name: "PARAM",
      attributes: xsiType("VALUE"),
      children: [
        textElement("SHORT-NAME", "payload"),
        textElement("BYTE-POSITION", String(service.payloadOffset)),
        { name: "DOP-SNREF", attributes: { "SHORT-NAME": `${service.shortName}_payload` } },
      ],
    });
  }
  return {
    name: "POS-RESPONSE",
    attributes: { ID: `${id}.${service.shortName}.response` },
    children: [
      textElement("SHORT-NAME", `${service.shortName}_response`),
      element("PARAMS", undefined, params),
    ],
  };
}

/**
 * The byte-field DOP of one observed payload.
 *
 * `MIN-LENGTH` equals `MAX-LENGTH` because the harvest saw exactly that many bytes:
 * the description is a statement about one observation, not about a field whose
 * length may vary. An ECU that answers with another length another day is a
 * different observation and gets a different file.
 */
function payloadDop(service: ObservedService, id: string): XmlElement {
  const length = service.response.length - service.payloadOffset;
  return {
    name: "DATA-OBJECT-PROP",
    attributes: { ID: `${id}.${service.shortName}.payload` },
    children: [
      textElement("SHORT-NAME", `${service.shortName}_payload`),
      description([
        `${length} byte(s) observed in the response to ${service.longName}.`,
        "A byte field, not a value: no scaling, no unit, no physical type beyond raw bytes.",
      ]),
      element("COMPU-METHOD", undefined, [textElement("CATEGORY", "IDENTICAL")]),
      byteFieldCodedType(length),
      { name: "PHYSICAL-TYPE", attributes: { "BASE-DATA-TYPE": "A_BYTEFIELD" } },
    ],
  };
}

/** The `DTC-DOP` holding every observed code of one ECU. */
function dtcDopElement(ecu: HarvestedEcu, id: string): XmlElement | undefined {
  if (ecu.dtcs.length === 0) return undefined;
  const dopId = `${id}.dtcs`;
  return {
    name: "DTC-DOP",
    attributes: { ID: dopId },
    children: [
      textElement("SHORT-NAME", `${ecu.id}_dtcs`),
      description([
        `${ecu.dtcs.length} code(s) this ECU reported, with the status availability mask it sent`,
        `(0x${(ecu.dtcAvailabilityMask ?? 0).toString(16).padStart(2, "0")}). The text of each entry says the code was`,
        "reported; it does not say what the code means — that would need a documented source.",
      ]),
      linearCompuMethod(),
      diagCodedType("A_UINT32", 24),
      { name: "PHYSICAL-TYPE", attributes: { "BASE-DATA-TYPE": "A_UINT32" } },
      element(
        "DTCS",
        undefined,
        ecu.dtcs.map((dtc) => dtcElement(dtc, dopId, ecu)),
      ),
    ],
  };
}

/** One observed `DTC`. */
function dtcElement(dtc: HarvestedDtc, dopId: string, ecu: HarvestedEcu): XmlElement {
  const troubleCode = dtcNumber(dtc);
  return {
    name: "DTC",
    attributes: { ID: `${dopId}.${odxShortName(dtc.code, "dtc")}` },
    children: [
      textElement("SHORT-NAME", `dtc_${odxShortName(dtc.code, "unknown")}`),
      textElement("TROUBLE-CODE", String(troubleCode)),
      textElement("DISPLAY-TROUBLE-CODE", `${dtc.code}-${dtc.failureType}`),
      textElement(
        "TEXT",
        `Reported by ${ecu.name} (0x${ecu.rxId.toString(16)}) with status 0x${dtc.status
          .toString(16)
          .padStart(2, "0")}. Meaning not documented in this file: it is a harvest observation.`,
      ),
      factSdg([
        ["status-byte", `0x${dtc.status.toString(16).padStart(2, "0")}`],
        [
          "status-bits-set",
          Object.entries(dtc.statusBits)
            .filter(([, set]) => set === true)
            .map(([name]) => name)
            .join(",") || "none",
        ],
        [
          "availability-mask",
          `0x${(dtc.availabilityMask ?? ecu.dtcAvailabilityMask ?? 0).toString(16).padStart(2, "0")}`,
        ],
        ["severity-as-graded", dtc.severity],
        ["raw", dtc.raw],
        ...(dtc.snapshotRecordCount !== undefined
          ? ([["snapshot-records", String(dtc.snapshotRecordCount)]] as Array<[string, string]>)
          : []),
        ...(dtc.snapshots !== undefined
          ? ([["snapshot-hex", dtc.snapshots.map((s) => s.rawHex).join("|")]] as Array<
              [string, string]
            >)
          : []),
      ]),
    ],
  };
}

/**
 * The three-byte DTC number as the integer ODX expects.
 *
 * ISO 14229-1 transmits a DTC as `[high, low, failureType]`; ODX's `TROUBLE-CODE`
 * is that 24-bit value as a number, which is why `P0420-00` becomes 0x042000.
 */
export function dtcNumber(dtc: Pick<HarvestedDtc, "raw">): number {
  const bytes = fromHex(dtc.raw);
  return ((bytes[0] ?? 0) << 16) | ((bytes[1] ?? 0) << 8) | (bytes[2] ?? 0);
}

/** `ENV-DATA-DESC` + `ENV-DATA` for the freeze frames that were read. */
function environmentDescriptions(ecu: HarvestedEcu, id: string): XmlElement[] {
  const withSnapshots = ecu.dtcs.filter((dtc) => dtc.snapshots !== undefined);
  if (withSnapshots.length === 0) return [];
  const descId = `${id}.snapshot_desc`;
  const envDatas: XmlElement[] = [];
  for (const dtc of withSnapshots) {
    for (const snapshot of dtc.snapshots ?? []) {
      const bytes = fromHex(snapshot.rawHex);
      envDatas.push({
        name: "ENV-DATA",
        attributes: { ID: `${descId}.${odxShortName(dtc.code, "dtc")}_r${snapshot.recordNumber}` },
        children: [
          textElement(
            "SHORT-NAME",
            `env_${odxShortName(dtc.code, "unknown")}_record_${snapshot.recordNumber}`,
          ),
          element("DTC-VALUES", undefined, [textElement("DTC-VALUE", String(dtcNumber(dtc)))]),
          element("PARAMS", undefined, [
            {
              name: "PARAM",
              attributes: xsiType("CODED-CONST"),
              children: [
                textElement("SHORT-NAME", `record_${snapshot.recordNumber}`),
                textElement("BYTE-POSITION", "0"),
                textElement("CODED-VALUE", String(bytesToNumber(bytes))),
                byteFieldCodedType(bytes.length),
              ],
            },
          ]),
        ],
      });
    }
  }
  return [
    {
      name: "ENV-DATA-DESC",
      attributes: { ID: descId },
      children: [
        textElement("SHORT-NAME", `${ecu.id}_snapshots`),
        description([
          "Freeze-frame records this ECU returned, as the bytes it sent. ISO 14229-1 §11.3.4.5",
          "defines the request and leaves the record layout to the manufacturer, so nothing here",
          "claims which byte is which signal.",
        ]),
        { name: "DTC-DOP-REF", attributes: { "ID-REF": `${id}.dtcs` } },
        element("ENV-DATAS", undefined, envDatas),
      ],
    },
  ];
}

/* ------------------------------------------------------------------ shared pieces */

/** `<DESC><p>…</p></DESC>`, one paragraph per line. */
function description(lines: readonly string[]): XmlElement {
  return element(
    "DESC",
    undefined,
    lines.map((line) => textElement("p", line)),
  );
}

/**
 * Provenance as ODX special data (SDG/SD).
 *
 * ODX has no provenance element, and `SDGS` is the standard's own place for
 * information a schema does not model. The group is named `harvest` so a reader
 * can find it, and the keys are the ones `HarvestReport` uses — one vocabulary.
 */
function factSdg(facts: ReadonlyArray<[string, string]>): XmlElement {
  return element("SDGS", undefined, [
    element("SDG", undefined, [
      textElement("SHORT-NAME", "harvest"),
      ...facts.map(([key, value]) => ({
        name: "SD",
        attributes: { SI: key },
        text: value,
      })),
    ]),
  ]);
}

/** The container-level provenance group. */
function provenanceSdg(report: HarvestReport): XmlElement {
  return factSdg([
    ["provenance", "observed"],
    ["source", report.identity.source],
    ["retrieved-at", report.startedAt],
    ["finished-at", report.finishedAt],
    ["platform-version", report.identity.platformVersion],
    ["vin", report.identity.vin ?? "not-read"],
    ["vin-redacted", report.identity.vinRedacted === true ? "true" : "false"],
    ["operator", report.identity.operator ?? ""],
    ["ecus-answered", String(report.counts.ecusAnswered)],
    ["addresses-unread", String(report.counts.addressesUnread)],
    ["functional-id", `0x${report.bus.functionalId.toString(16)}`],
    ["addressing", report.bus.addressing],
    ["notes", report.notes.join(" | ")],
  ]);
}

/** The per-ECU facts: addressing, timing, supported services, gaps, unread DIDs. */
function ecuFactsSdg(ecu: HarvestedEcu, report: HarvestReport): XmlElement {
  return factSdg([
    ["provenance", "observed"],
    ["source", report.identity.source],
    ["retrieved-at", report.startedAt],
    ["tx-id", `0x${ecu.txId.toString(16)}`],
    ["rx-id", `0x${ecu.rxId.toString(16)}`],
    ["extended", ecu.extended ? "true" : "false"],
    ["functional-id", `0x${report.bus.functionalId.toString(16)}`],
    ["definition-ecu", ecu.definitionEcuId ?? ""],
    ["p2-ms", ecu.timing?.p2Ms !== undefined ? String(ecu.timing.p2Ms) : ""],
    ["p2-star-ms", ecu.timing?.p2StarMs !== undefined ? String(ecu.timing.p2StarMs) : ""],
    ["accepted-sessions", ecu.acceptedSessions.map((s) => `0x${s.toString(16)}`).join(",")],
    ["supported-services", ecu.supportedServices.map((s) => `0x${s.toString(16)}`).join(",")],
    [
      "service-probes",
      ecu.serviceProbes.map((p) => `0x${p.service.toString(16)}:${p.outcome}`).join(","),
    ],
    [
      "identification",
      ecu.identification.map((entry) => `0x${hex4(entry.did)}=${entry.rawHex}`).join(","),
    ],
    ["dids-read", String(ecu.dids.length)],
    [
      "dids-refused",
      ecu.didRefusals
        .map(
          (group) =>
            `${group.origin} 0x${hex4(group.firstDid)}-0x${hex4(group.lastDid)}: ${group.count}× NRC 0x${group.nrc.toString(16).padStart(2, "0")}`,
        )
        .join(" | "),
    ],
    ["dtc-availability-mask", `0x${(ecu.dtcAvailabilityMask ?? 0).toString(16).padStart(2, "0")}`],
    ["dtc-count-reported", ecu.dtcCount !== undefined ? String(ecu.dtcCount) : ""],
    ["gaps", ecu.gaps.map((gap) => `${gap.stage}: ${gap.reason}`).join(" | ")],
  ]);
}

/**
 * `<ADMIN-DATA>` with the document language.
 *
 * Nothing else: a `DOC-REVISION` names its author through a `TEAM-MEMBER-REF`,
 * which is an ODX link into company data a harvest does not have, and a reference
 * that resolves to nothing makes the whole document unreadable for a conformant
 * reader. The provenance a harvest *can* state — source, time, platform, VIN
 * handling — is in the `SDGS` group, which is the standard's own place for
 * information its schema does not model.
 */
function adminData(): XmlElement {
  return element("ADMIN-DATA", undefined, [textElement("LANGUAGE", "de-DE")]);
}

/** A `CODED-CONST` parameter: one fixed value the observation saw. */
function codedConstParam(
  shortName: string,
  bytePosition: number,
  value: number,
  bitLength: number,
  semantic: string | undefined,
): XmlElement {
  return {
    name: "PARAM",
    attributes: {
      ...(semantic !== undefined ? { SEMANTIC: semantic } : {}),
      "xsi:type": "CODED-CONST",
    },
    children: [
      textElement("SHORT-NAME", shortName),
      textElement("BYTE-POSITION", String(bytePosition)),
      textElement("CODED-VALUE", String(value)),
      diagCodedType("A_UINT32", bitLength),
    ],
  };
}

/** `<DIAG-CODED-TYPE>` of fixed bit length. */
function diagCodedType(baseDataType: string, bitLength: number): XmlElement {
  return {
    name: "DIAG-CODED-TYPE",
    attributes: {
      "BASE-TYPE-ENCODING": "NONE",
      "BASE-DATA-TYPE": baseDataType,
      "xsi:type": "STANDARD-LENGTH-TYPE",
    },
    children: [textElement("BIT-LENGTH", String(bitLength))],
  };
}

/** A byte-field coded type of exact length, terminated by the end of the PDU. */
function byteFieldCodedType(byteLength: number): XmlElement {
  return {
    name: "DIAG-CODED-TYPE",
    attributes: {
      "BASE-TYPE-ENCODING": "NONE",
      "BASE-DATA-TYPE": "A_BYTEFIELD",
      TERMINATION: "END-OF-PDU",
      "xsi:type": "MIN-MAX-LENGTH-TYPE",
    },
    children: [
      textElement("MIN-LENGTH", String(byteLength)),
      textElement("MAX-LENGTH", String(byteLength)),
    ],
  };
}

/** A linear 1:1 compu method — what "the bytes are the value" means in ODX. */
function linearCompuMethod(): XmlElement {
  return element("COMPU-METHOD", undefined, [
    textElement("CATEGORY", "LINEAR"),
    element("COMPU-INTERNAL-TO-PHYS", undefined, [
      element("COMPU-SCALES", undefined, [
        element("COMPU-SCALE", undefined, [
          { name: "LOWER-LIMIT", attributes: { "INTERVAL-TYPE": "INFINITE" } },
          { name: "UPPER-LIMIT", attributes: { "INTERVAL-TYPE": "INFINITE" } },
          element("COMPU-RATIONAL-COEFFS", undefined, [
            element("COMPU-NUMERATOR", undefined, [textElement("V", "0"), textElement("V", "1")]),
            element("COMPU-DENOMINATOR", undefined, [textElement("V", "1")]),
          ]),
        ]),
      ]),
    ]),
  ]);
}

/** Which ODX semantic an observed DID read has — from the DID block, not from a guess. */
function semanticOf(did: HarvestedDid): DiagSemantic {
  if (did.origin === "identification" || did.origin === "standard") return "IDENTIFICATION";
  if (did.did >= 0xf400 && did.did <= 0xf4ff) return "CURRENT_DATA";
  return "FUNCTIONAL";
}

/* ------------------------------------------------------------------ byte helpers */

/** Uppercase hex of a 16-bit identifier, four digits. */
function hex4(value: number): string {
  return value.toString(16).padStart(4, "0").toUpperCase();
}

/** Parse an even-length hex string into bytes; an odd length yields what fits. */
export function fromHex(text: string): Uint8Array {
  const clean = text.replace(/[^0-9a-fA-F]/g, "");
  const pairs = Math.floor(clean.length / 2);
  const out = new Uint8Array(pairs);
  for (let index = 0; index < pairs; index += 1) {
    out[index] = Number.parseInt(clean.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Big-endian integer value of a byte field, for a `CODED-VALUE` of raw bytes. */
export function bytesToNumber(bytes: ArrayLike<number>): number {
  let value = 0;
  for (let index = 0; index < bytes.length; index += 1) value = value * 256 + (bytes[index] ?? 0);
  return value;
}

/** Container short name derived from the harvest source. */
export function containerShortNameOf(report: HarvestReport): string {
  return odxShortName(`harvest_${report.identity.source}`, "harvest");
}

/** Re-exported so the PDX writer and the tests build elements the same way. */
export { element, emptyElement, textElement };
