import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vitest";
import { GENERIC_PACKAGE_NAME, STANDARD_RECIPES } from "./recipes.js";

const FIXTURE_DIR = "tests/fixtures/golden-sessions";

test("every recipe has a unique id and a fixed recording time", () => {
  const ids = STANDARD_RECIPES.map((recipe) => recipe.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate recipe id");
  for (const recipe of STANDARD_RECIPES) {
    assert.match(recipe.id, /^[a-z0-9-]+$/, `${recipe.id} is not a file-name-safe id`);
    assert.equal(
      recipe.recordedAt,
      STANDARD_RECIPES[0]?.recordedAt,
      "a re-recording must not churn the timestamp",
    );
    assert.ok(recipe.title.length > 0);
    assert.ok((recipe.note ?? "").length > 0, `${recipe.id} does not say what it preserves`);
  }
});

test("every recipe names what it exercises instead of repeating the same setup", () => {
  const setups = STANDARD_RECIPES.map((recipe) => JSON.stringify(recipe.vehicle));
  assert.equal(new Set(setups).size, setups.length, "two recipes record the same vehicle");
});

test("the checked-in fixtures are exactly the recorded recipes", async () => {
  const files = await readdir(FIXTURE_DIR);
  const goldenFiles = files.filter((file) => file.endsWith(".golden.json")).sort();
  assert.deepEqual(
    goldenFiles,
    STANDARD_RECIPES.map((recipe) => `${recipe.id}.golden.json`).sort(),
    "a fixture without a recipe cannot be re-recorded — add a recipe or drop the file",
  );
  assert.equal(
    STANDARD_RECIPES.every((recipe) => recipe.vehicle.dynamic !== undefined),
    true,
    "each recipe states whether its signals move (the recorder's determinism depends on it)",
  );
});

test("the package the fixtures were recorded from is the one the tool reads", async () => {
  const { genericPackage } = await import("@vdp/definitions/generic");
  assert.equal(GENERIC_PACKAGE_NAME, "generic");
  assert.ok(genericPackage.version.length > 0);
  const fixture = await import("node:fs/promises").then((fs) =>
    fs.readFile(join(FIXTURE_DIR, "generic-baseline.golden.json"), "utf8"),
  );
  assert.equal(fixture.includes(`"package": "${GENERIC_PACKAGE_NAME}"`), true);
});
