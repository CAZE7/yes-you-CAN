/**
 * The licence and the rights instrument are decisions, and decisions get a gate
 * (ADR 0061/0062; the same reason ADR 0029 exists).
 *
 * Two ways this drifts without a test:
 *
 * 1. **The licence becomes prose.** A badge says Apache-2.0, a manifest still says MIT —
 *    `manifests.test.ts` would catch *that* one, because it pins every package to the root
 *    value, but nothing would catch "root and all packages agree on MIT while the README
 *    advertises Apache". This file pins the **value**: Apache-2.0, the full text, not a
 *    stub, and a NOTICE that exists.
 * 2. **The rights instrument becomes a promise.** A CLA that no page links, a ledger
 *    without a version, a consent sentence that nobody can find — measured 2026-09-23 the
 *    repo had none of it (`grep -ri "dco\|signed-off" CONTRIBUTING.md .github/` → nothing),
 *    and the whole point of ADR 0062 is that this state cannot come back silently.
 *
 * What the tests deliberately do **not** do: judge the legal text. They check that the
 * text that was decided is the text that is there, that it is versioned, and that it is
 * reachable. A judge for legal wording does not exist, and a keyword scan pretending to be
 * one would be worse than no test.
 */

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";
import { repoRoot as root } from "./workspace.js";

const read = (rel: string): string => readFileSync(join(root, rel), "utf8");

/* ------------------------------------------------------------------- the licence */

test("LICENSE is the full Apache-2.0 text, not a stub and not a summary", () => {
  const license = read("LICENSE");
  // The nine sections and the end marker: a licence that lost one of them is a different
  // licence, and the failure would otherwise only surface in a legal review.
  for (const marker of [
    "Apache License",
    "Version 2.0, January 2004",
    "1. Definitions.",
    "2. Grant of Copyright License.",
    "3. Grant of Patent License.",
    "4. Redistribution.",
    "5. Submission of Contributions.",
    "6. Trademarks.",
    "7. Disclaimer of Warranty.",
    "8. Limitation of Liability.",
    "9. Accepting Warranty or Additional Liability",
    "END OF TERMS AND CONDITIONS",
  ]) {
    assert.ok(
      license.includes(marker),
      `LICENSE must contain "${marker}" — it is the decided text`,
    );
  }
  assert.ok(
    license.length > 10_000,
    `the full Apache-2.0 text is ~11 kB; found ${license.length} characters — a shortened licence is a different licence`,
  );
  assert.ok(
    license.includes("Copyright [yyyy] [name of copyright owner]"),
    "the canonical appendix belongs to the text (it is instructions, not terms — leaving it out is what a hand-written replacement does)",
  );
  // The old licence must be gone, not merely outnumbered: the MIT permission sentence is
  // the thing that would silently keep applying if somebody pasted it back.
  assert.ok(
    !license.includes("Permission is hereby granted, free of charge"),
    "the MIT grant sentence must not survive inside LICENSE (ADR 0061 replaced MIT)",
  );
});

test("NOTICE names the project, and every manifest declares Apache-2.0", () => {
  assert.ok(
    existsSync(join(root, "NOTICE")),
    "Apache-2.0 §4(d) expects a NOTICE when attributions exist",
  );
  const notice = read("NOTICE");
  assert.match(notice, /yes-you-CAN/, "NOTICE names the project");
  assert.match(notice, /Copyright \d{4}/, "NOTICE carries the copyright line");

  // The decision, not just consistency: `manifests.test.ts` keeps the packages equal to the
  // root, this keeps the root honest about *which* licence that is (ADR 0061).
  const rootManifest = JSON.parse(read("package.json")) as { license?: string };
  assert.equal(rootManifest.license, "Apache-2.0", "the root manifest carries the decision");

  const packageDirs = [
    ...readdirSync(join(root, "packages"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => [
        `packages/${entry.name}`,
        ...(existsSync(join(root, "packages", entry.name, "package.json"))
          ? []
          : readdirSync(join(root, "packages", entry.name), { withFileTypes: true })
              .filter(
                (inner) =>
                  inner.isDirectory() &&
                  existsSync(join(root, "packages", entry.name, inner.name, "package.json")),
              )
              .map((inner) => `packages/${entry.name}/${inner.name}`)),
      ])
      .filter((dir) => existsSync(join(root, dir, "package.json"))),
    ...["tools", "apps"].flatMap((base) =>
      readdirSync(join(root, base), { withFileTypes: true })
        .filter(
          (entry) =>
            entry.isDirectory() && existsSync(join(root, base, entry.name, "package.json")),
        )
        .map((entry) => `${base}/${entry.name}`),
    ),
  ];
  assert.ok(
    packageDirs.length >= 25,
    `the sweep found ${packageDirs.length} packages — it must cover the workspace`,
  );
  for (const dir of packageDirs) {
    const manifest = JSON.parse(read(join(dir, "package.json"))) as { license?: string };
    assert.equal(manifest.license, "Apache-2.0", `${dir} carries the decided licence`);
  }
});

/* ---------------------------------------------------------- the rights instrument */

test("the CLA exists, is versioned, and states the German point it must not get wrong", () => {
  const cla = read("docs/legal/cla.md");
  assert.match(
    cla,
    /\*\*Fassung:\*\*\s*1\.0/,
    "the agreement carries a version — a consent without a version is a consent to something unknown",
  );
  assert.match(
    cla,
    /§ 29 Abs\. 1 UrhG/,
    "the text says the copyright is not transferable (the reason it grants rights)",
  );
  assert.match(cla, /§ 31/, "it grants Nutzungsrechte, not an assignment");
  assert.match(
    cla,
    /Patentlizenz/,
    "the patent grant belongs to a contribution agreement (ADR 0062 §3)",
  );
  // The word "Assignment" may (and should) appear where the text explains what it does
  // *not* do — a *clause* promising the transfer must not exist, because it would be void
  // (§ 29 Abs. 1 UrhG) and it would be the promise the whole agreement avoids.
  assert.match(
    cla,
    /Du bleibst Urheber/,
    "the text states that the contributor keeps the copyright",
  );
  assert.ok(
    !/Abtretung (des|deines) Urheberrechts|überträgt dir (sein |das )?Urheberrecht|assigns? (the|your) copyright/i.test(
      cla,
    ),
    "no clause may promise a transfer of the copyright (void under § 29 UrhG) — the explanation may name the term, the granting clause must not exist",
  );
  assert.match(
    cla,
    /I have read the CLA/,
    "the consent sentence is spelled out — a contributor has to be able to copy it",
  );
});

test("the consent is traceable: ledger, link from CONTRIBUTING, and marks kept apart", () => {
  const ledger = read("docs/legal/contributors.md");
  assert.match(ledger, /Fassung 1\.0/, "the ledger names the version it records consents to");
  assert.match(
    ledger,
    /keine[\s\S]{0,120}Zustimmung/,
    "the ledger states honestly that there is no consent yet (no external contribution exists)",
  );

  const contributing = read("CONTRIBUTING.md");
  assert.ok(
    contributing.includes("docs/legal/cla.md"),
    "CONTRIBUTING must link the agreement — a rule nobody finds is not a rule",
  );
  assert.match(contributing, /Apache-2\.0/, "CONTRIBUTING states the licence");
  assert.match(
    contributing,
    /git commit -s/,
    "the DCO line is documented (it is provenance, not a replacement)",
  );

  // Licence ≠ marks: Apache-2.0 §6 grants no trademark rights, and the repo says so where
  // a reader looks for it (ADR 0061, decision 4).
  const trademark = read("TRADEMARK.md");
  assert.match(trademark, /§ 6/, "the marks page names the licence section it rests on");
  assert.match(trademark, /docs\/legal\/cla\.md/, "and it points at the agreement");
});
