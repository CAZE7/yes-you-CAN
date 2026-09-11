import assert from "node:assert/strict";
import { DefinitionError } from "@vdp/shared";
import { test } from "vitest";
import { genericPackage } from "./generic/generic-package.js";
import { parseDefinitionPackage, parseDefinitionPackageJson } from "./json.js";
import { validateDefinitionPackage } from "./validate.js";

test("a built-in package round-trips through JSON", () => {
  const json = JSON.stringify(genericPackage);
  const parsed = parseDefinitionPackageJson(json);
  assert.equal(parsed.oem, genericPackage.oem);
  assert.equal(parsed.version, genericPackage.version);
  assert.equal(parsed.ecus.length, genericPackage.ecus.length);
  assert.equal(parsed.signals.length, genericPackage.signals.length);
  assert.equal(validateDefinitionPackage(parsed).valid, true);
});

test("parseDefinitionPackage accepts a plain object and preserves signal detail", () => {
  const parsed = parseDefinitionPackage(JSON.parse(JSON.stringify(genericPackage)));
  const original = genericPackage.signals[0];
  const round = parsed.signals.find((s) => s.id === original?.id);
  assert.ok(original && round);
  assert.equal(round.did, original.did);
  assert.equal(round.byteOffset, original.byteOffset);
  assert.equal(round.encoding, original.encoding);
});

test("structural problems are collected into one DefinitionError", () => {
  assert.throws(
    () =>
      parseDefinitionPackage({
        schemaVersion: 1,
        // oem missing
        name: "broken",
        version: "1.0.0",
        provenance: { sourceType: "own", source: "test" },
        ecus: [],
        signals: [
          { id: "x", name: "x", ecu: "e", did: 1, byteOffset: 0, length: 1 /* encoding missing */ },
        ],
      }),
    (error: unknown) => {
      assert.ok(error instanceof DefinitionError);
      const details = error.details as { errors: string[] };
      assert.ok(details.errors.some((e) => e.includes("oem")));
      assert.ok(details.errors.some((e) => e.includes("encoding")));
      return true;
    },
  );
});

test("semantic problems are rejected like built-in validation", () => {
  assert.throws(
    () =>
      parseDefinitionPackage({
        schemaVersion: 1,
        oem: "test",
        name: "bad-version",
        version: "not-semver",
        provenance: { sourceType: "own", source: "test" },
        ecus: [],
        signals: [],
      }),
    /not valid SemVer/,
  );
});

test("malformed JSON raises a DefinitionError, not a SyntaxError", () => {
  assert.throws(() => parseDefinitionPackageJson("{ not json"), DefinitionError);
});

test("non-object input is rejected", () => {
  assert.throws(() => parseDefinitionPackage("a string"), DefinitionError);
  assert.throws(() => parseDefinitionPackage(null), DefinitionError);
  assert.throws(() => parseDefinitionPackage([1, 2, 3]), DefinitionError);
});

test("every optional field survives the round-trip", () => {
  const parsed = parseDefinitionPackage({
    schemaVersion: 1,
    oem: "rich",
    name: "rich-package",
    version: "2.1.0",
    provenance: {
      sourceType: "licensed",
      source: "manufacturer",
      license: "internal",
      version: "2026-01",
      retrievedAt: "2026-09-11T00:00:00Z",
    },
    ecus: [
      {
        id: "gateway",
        name: "Gateway",
        protocol: "kwp2000",
        description: "central gateway",
        address: {
          txId: 0x7b0,
          rxId: 0x7b8,
          extended: true,
          addressing: "extended",
          functionalId: 0x7df,
        },
        identification: [{ label: "Part number", did: 0xf187, encoding: "ascii" }],
        services: [0x10, 0x22],
        dtcs: [{ code: "U0100", description: "lost communication" }],
        timing: { p2Ms: 50, p2StarMs: 500 },
      },
    ],
    signals: [
      {
        id: "gateway.mode",
        name: "Mode",
        ecu: "gateway",
        did: 0x2000,
        service: 0x22,
        byteOffset: 0,
        length: 2,
        bitOffset: 4,
        bitLength: 3,
        encoding: "bitmask",
        endianness: "little",
        scale: 0.5,
        offsetValue: -40,
        unit: "°C",
        min: -40,
        max: 215,
        enumMapping: { 0: "off", 1: "on" },
        description: "gateway operating mode",
        critical: true,
      },
    ],
  });

  const signal = parsed.signals[0];
  assert.ok(signal);
  assert.equal(signal?.endianness, "little");
  assert.equal(signal?.scale, 0.5);
  assert.equal(signal?.offsetValue, -40);
  assert.equal(signal?.unit, "°C");
  assert.equal(signal?.critical, true);
  assert.equal(signal?.enumMapping?.[1], "on");

  const ecu = parsed.ecus[0];
  assert.ok(ecu);
  assert.equal(ecu?.protocol, "kwp2000");
  assert.equal(ecu?.address.extended, true);
  assert.equal(ecu?.address.functionalId, 0x7df);
  assert.equal(ecu?.timing?.p2StarMs, 500);
  assert.equal(parsed.provenance.license, "internal");
});

test("invalid enums and wrong-typed optional fields are reported, not guessed", () => {
  assert.throws(
    () =>
      parseDefinitionPackage({
        schemaVersion: 1,
        oem: "t",
        name: "t",
        version: "1.0.0",
        provenance: { sourceType: "not-a-type", source: "x" },
        ecus: [{ id: "e", name: "E", protocol: "other", address: { txId: "nope", rxId: 2 } }],
        signals: [
          { id: "s", name: "S", ecu: "e", did: "x", byteOffset: 0, length: 1, encoding: 42 },
        ],
      }),
    (error: unknown) => {
      assert.ok(error instanceof DefinitionError);
      const errors = (error.details as { errors: string[] }).errors;
      assert.ok(errors.some((e) => e.includes("sourceType")));
      assert.ok(errors.some((e) => e.includes("protocol")));
      assert.ok(errors.some((e) => e.includes("txId")));
      assert.ok(errors.some((e) => e.includes("did")));
      assert.ok(errors.some((e) => e.includes("encoding")));
      return true;
    },
  );
});

test("a missing provenance object is a structural error", () => {
  assert.throws(
    () =>
      parseDefinitionPackage({
        schemaVersion: 1,
        oem: "t",
        name: "t",
        version: "1.0.0",
        ecus: [],
        signals: [],
      }),
    /provenance/,
  );
});

test("non-object entries inside ecus/signals and a scalar provenance are reported", () => {
  assert.throws(
    () =>
      parseDefinitionPackage({
        schemaVersion: 1,
        oem: "t",
        name: "t",
        version: "1.0.0",
        provenance: 42,
        ecus: ["not-an-ecu-object"],
        signals: [7, null],
      }),
    (error: unknown) => {
      assert.ok(error instanceof DefinitionError);
      const errors = (error.details as { errors: string[] }).errors;
      assert.ok(errors.some((e) => e.includes("ecus[0]")));
      assert.ok(errors.some((e) => e.includes("signals[0]")));
      assert.ok(errors.some((e) => e.includes("signals[1]")));
      assert.ok(errors.some((e) => e.includes("provenance")));
      return true;
    },
  );
});

test("omitted ecus/signals arrays are reported as structural errors", () => {
  assert.throws(
    () =>
      parseDefinitionPackage({
        schemaVersion: 1,
        oem: "t",
        name: "t",
        version: "1.0.0",
        provenance: { sourceType: "own", source: "x" },
      }),
    (error: unknown) => {
      assert.ok(error instanceof DefinitionError);
      const errors = (error as DefinitionError & { details: { errors: string[] } }).details.errors;
      assert.ok(errors.some((e) => e.includes("ecus")));
      assert.ok(errors.some((e) => e.includes("signals")));
      return true;
    },
  );
});
