/**
 * Extra definition packages as files — missing dir is empty, a broken file is named.
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "vitest";
import {
  findDefinitionsDir,
  loadDefinitionFiles,
  loadOptionalDefinitionPackages,
} from "../src/definition-source.js";

const EMPTY_PACKAGE = JSON.stringify({
  schemaVersion: 3,
  oem: "drop-in",
  name: "Drop-in pack",
  version: "1.0.0",
  provenance: { sourceType: "own", source: "test" },
  ecus: [],
  signals: [],
});

describe("loadDefinitionFiles", () => {
  test("a missing directory is no extras, not a startup failure", () => {
    assert.deepEqual(loadDefinitionFiles("/no/such/definitions-dir"), []);
    assert.deepEqual(loadOptionalDefinitionPackages("/no/such/definitions-dir"), []);
  });

  test("a valid json file becomes a package, a broken one names the file", () => {
    const dir = mkdtempSync(join(tmpdir(), "vdp-defs-"));
    writeFileSync(join(dir, "ok.json"), EMPTY_PACKAGE);
    writeFileSync(join(dir, "notes.md"), "not a package");
    const loaded = loadDefinitionFiles(dir);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0]?.file, "ok.json");
    assert.equal(loaded[0]?.pkg.oem, "drop-in");
    assert.equal(loadOptionalDefinitionPackages(dir)[0]?.name, "Drop-in pack");

    writeFileSync(join(dir, "broken.json"), "{ not json");
    assert.throws(
      () => loadDefinitionFiles(dir),
      /definition file broken.json is not a valid package/,
    );
  });
});

describe("findDefinitionsDir", () => {
  test("the repository's data/definitions directory is found by walking up", () => {
    const found = findDefinitionsDir();
    assert.ok(found?.endsWith("data/definitions"), `expected a data/definitions dir, got ${found}`);
  });

  test("VDP_DEFINITIONS_DIR that is not a directory is refused with the path", () => {
    const previous = process.env.VDP_DEFINITIONS_DIR;
    process.env.VDP_DEFINITIONS_DIR = "/no/such/override";
    try {
      assert.throws(
        () => findDefinitionsDir(),
        /VDP_DEFINITIONS_DIR="\/no\/such\/override" is not a directory/,
      );
    } finally {
      if (previous === undefined) delete process.env.VDP_DEFINITIONS_DIR;
      else process.env.VDP_DEFINITIONS_DIR = previous;
    }
  });
});
