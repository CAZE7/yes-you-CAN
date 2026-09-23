/**
 * A minimal XML writer (ADR 0058).
 *
 * ODX is XML (ISO 22901-1 Annex C), and this repository has no XML dependency and
 * is not going to get one for a writer: `@vdp/definitions`, `@vdp/shared` and the
 * transports stay dependency-free (ADR 0002), and a tool that emits a document it
 * fully controls does not need a DOM. What it does need is **escaping that cannot
 * be forgotten**, because a harvested ASCII value is arbitrary bytes from a car —
 * a `&` in a spare-part number would otherwise produce a file no parser accepts.
 *
 * The writer is a small element builder with three rules:
 *
 * 1. Text and attribute values are escaped on the way in, never by the caller.
 * 2. Element order is the caller's responsibility — ODX is a sequence-typed schema,
 *    so `<SHORT-NAME>` before `<DESC>` before the rest. The builder does not sort.
 * 3. Nothing is invented: an absent optional element stays absent, which is what
 *    makes the output a faithful projection of the observation.
 */

/** Characters XML forbids in character data, mapped to their entity. */
const TEXT_ESCAPES: ReadonlyArray<[RegExp, string]> = [
  [/&/g, "&amp;"],
  [/</g, "&lt;"],
  [/>/g, "&gt;"],
];

/** The same plus the characters that end an attribute value. */
const ATTRIBUTE_ESCAPES: ReadonlyArray<[RegExp, string]> = [
  ...TEXT_ESCAPES,
  [/"/g, "&quot;"],
  [/'/g, "&apos;"],
];

/** Escape text content. */
export function escapeXmlText(value: string): string {
  let out = value;
  for (const [pattern, replacement] of TEXT_ESCAPES) out = out.replace(pattern, replacement);
  // XML 1.0 forbids the control characters except tab, newline and carriage return;
  // a harvested byte string can contain them, and a file containing them is not
  // well-formed no matter how carefully it was escaped.
  return out.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
}

/** Escape an attribute value. */
export function escapeXmlAttribute(value: string): string {
  let out = value;
  for (const [pattern, replacement] of ATTRIBUTE_ESCAPES) out = out.replace(pattern, replacement);
  return out.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
}

/** An attribute value: string, number or boolean (ODX writes booleans as 0/1). */
export type XmlAttributeValue = string | number | boolean;

/** Attributes of one element; `undefined` values are omitted. */
export type XmlAttributes = Record<string, XmlAttributeValue | undefined>;

/** One element: a name, its attributes and its children (elements or text). */
export interface XmlElement {
  name: string;
  attributes?: XmlAttributes;
  children?: ReadonlyArray<XmlElement | string>;
  /** Text content when the element has no children. */
  text?: string;
  /** Emit `<NAME/>` even with no content (default: yes). */
  selfClosing?: boolean;
}

/** Build an element. */
export function element(
  name: string,
  attributes?: XmlAttributes,
  children?: ReadonlyArray<XmlElement | string>,
): XmlElement {
  return children === undefined
    ? { name, ...(attributes ? { attributes } : {}) }
    : { name, ...(attributes ? { attributes } : {}), children };
}

/** A leaf element with text content: `<SHORT-NAME>ecu_7e8</SHORT-NAME>`. */
export function textElement(name: string, text: string, attributes?: XmlAttributes): XmlElement {
  return { name, ...(attributes ? { attributes } : {}), text };
}

/** An explicitly empty element: `<DIAG-COMMS/>`. */
export function emptyElement(name: string, attributes?: XmlAttributes): XmlElement {
  return { name, ...(attributes ? { attributes } : {}), selfClosing: true };
}

/** Attributes of an `xsi:type`-carrying element, with the namespace declared once at the root. */
export function xsiType(type: string, extra?: XmlAttributes): XmlAttributes {
  return { "xsi:type": type, ...extra };
}

/** Render attributes, dropping every `undefined` value. */
function renderAttributes(attributes: XmlAttributes | undefined): string {
  if (!attributes) return "";
  const parts: string[] = [];
  for (const [name, value] of Object.entries(attributes)) {
    if (value === undefined) continue;
    const rendered = typeof value === "boolean" ? (value ? "true" : "false") : String(value);
    parts.push(`${name}="${escapeXmlAttribute(rendered)}"`);
  }
  return parts.length === 0 ? "" : ` ${parts.join(" ")}`;
}

/**
 * Render a tree to XML text, indented.
 *
 * Indentation matters for a document a human reads next to a report; it costs
 * nothing here because ODX character data in the elements this writer produces is
 * either a name, a number or a hex string — no element where leading whitespace
 * would change the value.
 */
export function renderXml(root: XmlElement, indent = ""): string {
  const attributes = renderAttributes(root.attributes);
  const opening = `${indent}<${root.name}${attributes}>`;

  if (root.text !== undefined && (root.children === undefined || root.children.length === 0)) {
    return `${indent}<${root.name}${attributes}>${escapeXmlText(root.text)}</${root.name}>`;
  }
  if (root.children === undefined || root.children.length === 0) {
    return root.selfClosing === false
      ? `${opening}</${root.name}>`
      : `${indent}<${root.name}${attributes}/>`;
  }

  const lines: string[] = [opening];
  for (const child of root.children) {
    if (typeof child === "string") lines.push(`${indent} ${escapeXmlText(child)}`);
    else lines.push(renderXml(child, `${indent} `));
  }
  lines.push(`${indent}</${root.name}>`);
  return lines.join("\n");
}

/** XML declaration of an ODX file (UTF-8, standalone). */
export const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="no" ?>';

/**
 * The ODX root element, with the model version and the schema-instance namespace.
 *
 * `MODEL-VERSION="2.2.0"` is the version ISO 22901-1:2008 normative annex and the
 * ASAM ODX 2.2 maintenance release describe, and the one the reference
 * implementation (`odxtools`) writes; a file claiming another version would be
 * checked against another schema.
 */
export const ODX_MODEL_VERSION = "2.2.0";

/** Wrap content elements in the `<ODX>` root. */
export function odxRoot(children: ReadonlyArray<XmlElement>): XmlElement {
  return {
    name: "ODX",
    attributes: {
      "MODEL-VERSION": ODX_MODEL_VERSION,
      "xmlns:xsi": "http://www.w3.org/2001/XMLSchema-instance",
    },
    children,
  };
}

/** Render a complete ODX document, declaration included. */
export function renderOdxDocument(root: XmlElement): string {
  return `${XML_DECLARATION}\n${renderXml(root)}\n`;
}

/**
 * An ODX short name: letters, digits and underscore, starting with a letter.
 *
 * The standard restricts short names because they are XML ID fragments and link
 * targets; a harvested ECU name like "Motorsteuerung 1.5 TSI (EA211)" is not one.
 * Everything that becomes a short name goes through here, so an illegal character
 * becomes `_` instead of producing a file that no reader accepts.
 */
export function odxShortName(value: string, fallback = "item"): string {
  const cleaned = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  const named = cleaned.length === 0 ? fallback : cleaned;
  return /^[A-Za-z]/.test(named) ? named : `_${named}`;
}
