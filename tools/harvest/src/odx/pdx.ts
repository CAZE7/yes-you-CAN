/**
 * The PDX container of a harvest (ODX packaging, ADR 0058).
 *
 * A `.pdx` file is a ZIP whose `index.xml` is an ODX `CATALOG` listing the
 * documents inside it, each with its MIME type and creation date. That is the
 * layout the reference implementation writes and reads, so a harvest can hand its
 * ODX-D document to any ODX tool as a package instead of as a loose file.
 *
 * The ZIP itself comes from `@vdp/storage` (`createZip`) — the repository already
 * has a dependency-free writer with CRC-32, and a second ZIP implementation would
 * be a second place to get the container format wrong.
 */

import { createZip } from "@vdp/storage";
import type { HarvestReport } from "../observation.js";
import { containerShortNameOf, type OdxDiagLayerOptions, renderOdxHarvest } from "./diag-layer.js";
import { element, escapeXmlAttribute, renderXml, textElement, type XmlElement } from "./xml.js";

/** MIME types ODX documents carry inside a PDX. */
export const ODX_MIME_TYPES = {
  diagLayerContainer: "application/x-asam.odx.odx-d",
  catalog: "application/xml",
} as const;

/** One file inside the container. */
export interface PdxFile {
  /** Name inside the archive — also the name the catalog lists. */
  name: string;
  /** Document text, UTF-8. */
  content: string;
  /** MIME type the catalog states. */
  mimeType: string;
  /** Creation date the catalog states (ISO-8601, seconds precision). */
  creationDate: string;
}

/**
 * The `index.xml` catalog of a PDX.
 *
 * The shape follows the ODX catalog: one `ABLOCK` per file with its `FILE` entry,
 * `CREATION-DATE` and `MIME-TYPE`. A reader that resolves the catalog finds the
 * diagnostic data through the block's short name, so the block is named after the
 * container instead of after the file count.
 */
export function renderPdxIndex(shortName: string, files: readonly PdxFile[]): string {
  const blocks: XmlElement[] = files.map((file) =>
    element("ABLOCK", { UPD: "UNCHANGED" }, [
      textElement("SHORT-NAME", shortName),
      element("FILES", undefined, [
        {
          name: "FILE",
          attributes: {
            "CREATION-DATE": file.creationDate,
            "MIME-TYPE": file.mimeType,
          },
          text: file.name,
        },
      ]),
    ]),
  );
  const catalog = element(
    "CATALOG",
    {
      "xmlns:xsi": "http://www.w3.org/2001/XMLSchema-instance",
      "F-DTD-VERSION": "ODX-2.2.0",
    },
    [textElement("SHORT-NAME", shortName), element("ABLOCKS", undefined, blocks)],
  );
  return `<?xml version="1.0" encoding="UTF-8"?>\n${renderXml(catalog)}\n`;
}

/**
 * The files a harvest puts into its PDX.
 *
 * Two entries today: the catalog and the diagnostic-layer container. The ODX-C
 * communication-parameter document is absent on purpose — writing it means
 * carrying the standard's comparam subsets, which is a dependency decision
 * (ADR 0002/0010), and a container that lists a document it does not contain is
 * worse than one that states what it has. The gap is stated in the ODX-D
 * description and in the harvest notes.
 */
export function pdxFilesOf(report: HarvestReport, options: OdxDiagLayerOptions = {}): PdxFile[] {
  const shortName = options.containerShortName ?? containerShortNameOf(report);
  // ODX dates carry second precision; the harvest timestamp is ISO-8601 with
  // milliseconds and a zone, which a strict reader may reject.
  const creationDate = toOdxDate(report.startedAt);
  const odxDocument = renderOdxHarvest(report, { ...options, containerShortName: shortName });
  return [
    {
      name: `${shortName}.odx-d`,
      content: odxDocument,
      mimeType: ODX_MIME_TYPES.diagLayerContainer,
      creationDate,
    },
  ];
}

/** Build the PDX archive (ZIP bytes) of one harvest. */
export function createPdx(report: HarvestReport, options: OdxDiagLayerOptions = {}): Uint8Array {
  const shortName = options.containerShortName ?? containerShortNameOf(report);
  const files = pdxFilesOf(report, { ...options, containerShortName: shortName });
  const encoder = new TextEncoder();
  const entries = [
    { name: "index.xml", data: encoder.encode(renderPdxIndex(shortName, files)) },
    ...files.map((file) => ({ name: file.name, data: encoder.encode(file.content) })),
  ];
  return createZip(entries, `vdp harvest ${shortName}`);
}

/**
 * The catalog text of a PDX, on its own.
 *
 * Exported because a test can check the catalog without unzipping, and because a
 * caller that wants a directory of loose ODX files needs the same index.
 */
export function renderPdxCatalog(report: HarvestReport, options: OdxDiagLayerOptions = {}): string {
  const shortName = options.containerShortName ?? containerShortNameOf(report);
  return renderPdxIndex(
    shortName,
    pdxFilesOf(report, { ...options, containerShortName: shortName }),
  );
}

/** `2026-09-23T17:04:05.123Z` → `2026-09-23T17:04:05` (ODX date form). */
export function toOdxDate(timestamp: string): string {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/.exec(timestamp);
  return match?.[1] ?? timestamp;
}

/** Re-exported for callers that build their own catalog entries. */
export { escapeXmlAttribute };
