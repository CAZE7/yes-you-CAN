/**
 * The XML writer (ADR 0058).
 *
 * Small module, strict rules: escaping cannot be forgotten, `undefined` attributes
 * disappear instead of rendering as the word "undefined", element order is kept
 * exactly as given (ODX is a sequence-typed schema), and a short name that would be
 * an illegal XML ID is cleaned instead of written.
 */

import assert from "node:assert/strict";
import { test } from "vitest";
import {
  element,
  emptyElement,
  escapeXmlAttribute,
  escapeXmlText,
  odxRoot,
  odxShortName,
  renderOdxDocument,
  renderXml,
  textElement,
  XML_DECLARATION,
} from "./xml.js";

test("text content escapes the three characters that end a document", () => {
  assert.equal(escapeXmlText("a & b"), "a &amp; b");
  assert.equal(escapeXmlText("<tag>"), "&lt;tag&gt;");
  assert.equal(escapeXmlText("quote \" and ' stay"), "quote \" and ' stay");
});

test("attribute values escape the quotes too", () => {
  assert.equal(escapeXmlAttribute('say "hi"'), "say &quot;hi&quot;");
  assert.equal(escapeXmlAttribute("it's"), "it&apos;s");
  assert.equal(escapeXmlAttribute("a & b < c"), "a &amp; b &lt; c");
});

test("control characters are removed — a document containing them is not well-formed", () => {
  assert.equal(escapeXmlText("a\u0000b\u0007c"), "abc");
  assert.equal(escapeXmlText("tab\there\nnewline\rreturn"), "tab\there\nnewline\rreturn");
});

test("an undefined attribute disappears instead of rendering as text", () => {
  const rendered = renderXml(element("SD", { SI: "vin", MISSING: undefined }, []));
  assert.equal(rendered, '<SD SI="vin"/>');
  assert.equal(rendered.includes("undefined"), false);
});

test("booleans render the way ODX writes them, numbers as numbers", () => {
  assert.equal(
    renderXml(element("X", { A: true, B: false, C: 12 })),
    '<X A="true" B="false" C="12"/>',
  );
});

test("a text element renders inline, a child element renders on its own line", () => {
  assert.equal(renderXml(textElement("SHORT-NAME", "ecu_7e8")), "<SHORT-NAME>ecu_7e8</SHORT-NAME>");
  assert.equal(
    renderXml(element("FILES", undefined, [textElement("FILE", "a.odx-d")])),
    "<FILES>\n <FILE>a.odx-d</FILE>\n</FILES>",
  );
});

test("an empty element is self-closing unless the caller says otherwise", () => {
  assert.equal(renderXml(emptyElement("DIAG-COMMS")), "<DIAG-COMMS/>");
  assert.equal(renderXml({ name: "DIAG-COMMS", selfClosing: false }), "<DIAG-COMMS></DIAG-COMMS>");
});

test("element order is kept exactly as given — ODX is a sequence-typed schema", () => {
  const rendered = renderXml(
    element("BASE-VARIANT", { ID: "x" }, [
      textElement("SHORT-NAME", "ecu"),
      textElement("LONG-NAME", "ECU"),
      element("DIAG-COMMS", undefined, []),
    ]),
  );
  const positions = [
    rendered.indexOf("SHORT-NAME"),
    rendered.indexOf("LONG-NAME"),
    rendered.indexOf("DIAG-COMMS"),
  ];
  assert.deepEqual(
    positions,
    [...positions].sort((a, b) => a - b),
    "nothing was reordered",
  );
});

test("the document carries the declaration and the ODX model version", () => {
  const document = renderOdxDocument(odxRoot([textElement("SHORT-NAME", "x")]));
  assert.equal(document.startsWith(`${XML_DECLARATION}\n<ODX `), true);
  assert.match(document, /MODEL-VERSION="2\.2\.0"/);
  assert.match(document, /xmlns:xsi="http:\/\/www\.w3\.org\/2001\/XMLSchema-instance"/);
  assert.equal(document.endsWith("</ODX>\n"), true);
});

test("a short name becomes a legal XML name, whatever it was built from", () => {
  assert.equal(odxShortName("ecu_7e8"), "ecu_7e8");
  assert.equal(odxShortName("Motorsteuerung 1.5 TSI (EA211)"), "Motorsteuerung_1_5_TSI_EA211");
  assert.equal(odxShortName("1st-ecu"), "_1st_ecu", "a name may not start with a digit");
  assert.equal(
    odxShortName("---"),
    "item",
    "nothing left falls back instead of producing an empty name",
  );
  assert.equal(odxShortName(""), "item");
  assert.equal(odxShortName("ÄÖÜ-ecu"), "AOU_ecu", "diacritics are folded, not dropped");
  assert.match(odxShortName("harvest adapter:socketcan (can0)"), /^[A-Za-z][A-Za-z0-9_]*$/);
});
