# Runbook: Veröffentlichen (Scope, Zugang, Artefakt, Provenance)

> **Status: Runbook-Entwurf (2026-09-23). Nicht normativ, solange kein Paket
> veröffentlicht ist.** Es beschreibt den Weg, den die erste Veröffentlichung nehmen
> *soll* — mit dem, was davon schon gemessen ist (Trockenlauf), und dem, was noch
> Zugang oder Entscheidung braucht. Phase 0/3 des Konzepts:
> [`docs/architecture/open-core-dual-licensing.md`](../architecture/open-core-dual-licensing.md),
> die Rechtefragen stehen in
> [`docs/architecture/open-core-phase-0-rights.md`](../architecture/open-core-phase-0-rights.md).

**Heute gilt:** 29 Pakete, 29× `private: true`, keine Veröffentlichung, kein Registry-Zugang.
Dieses Runbook ist deshalb ein *Plan mit Messungen*, kein Protokoll.

---

## 1. Scope und Namen (Entscheidung E4)

| Frage | Empfehlung | Warum |
|---|---|---|
| Registry | **GitHub Packages** zuerst, selbstgehostetes **Verdaccio** ab Airgap-/Offline-Kunden | GitHub Packages liegt an der bestehenden Authentifizierung (kein zweiter Schlüsselbund), Verdaccio löst den Fall „Kunde ohne Internet“ |
| Scope öffentlich | `@vdp/*` (wie heute) | Vertragspakete und Werkzeuge bleiben unter einem Namen |
| Scope geschlossen | `@vdp-enterprise/*` | **anderer Scope**, nicht nur ein anderer Name im selben: `npm`-Berechtigungen lassen sich dann pro Scope vergeben (und ein versehentliches Publish in den öffentlichen Scope bleibt sichtbar falsch) |
| Sichtbarkeit | Verträge `public`, Closed `private` | Ein Closed-Paket darf nicht versehentlich im öffentlichen Scope landen — die Sichtbarkeit ist Teil des Schutzes, nicht Bequemlichkeit |

## 2. Zugang (Phase 0.4 — offen, braucht den Inhaber)

- [ ] npm-Organisation (oder GitHub-Org mit Packages-Recht) anlegen; Inhaber als Owner
- [ ] **2FA Pflicht für alle Mitglieder** (Publishing-Token nur mit 2FA)
- [ ] **Trusted Publishing (OIDC)** statt langlebiger Tokens: die CI bekommt ein kurzlebiges
      OIDC-Token, `npm publish --provenance` signiert die Herkunft. Kein Token im Repo,
      kein Token in den Secrets, das man rotieren müsste
- [ ] `publishConfig` in den veröffentlichbaren Paketen auf die Registry zeigen lassen
      (heute: nirgends vorhanden — gemessen, siehe §3)
- [ ] Rollen: Wer darf veröffentlichen? Empfehlung: eine Person + CI, kein Gruppenrecht

## 3. Was ein veröffentlichtes Paket enthalten muss (gemessen 2026-09-23)

Der Trockenlauf vor jeder Veröffentlichung ist `npm pack --dry-run --json` **je Paket** —
und das Ergebnis für dieses Repo war ein Fund:

```text
$ cd packages/domain && npm pack --dry-run --json
Dateien im Tarball: 20 · dist: 0 · src: 17 (inkl. *.spec.ts)

$ cd tools/harvest && npm pack --dry-run --json
Dateien: 24 · dist: 0 · src: 21 · spec: 9
```

**Ursache:** kein Paket deklariert `files`; npm fällt auf `.gitignore` zurück, und dort steht
`dist/` (der lokale Build-Ordner). Ergebnis: Quelltext samt Tests, kein Build.

**Das Gate existiert jetzt** (`check-package-manifests.mjs`, drei Regeln, Biss-Tests in
`tests/architecture/manifests.test.ts`):

| Regel | Verlangt |
|---|---|
| `publishable-without-files` | Ein veröffentlichbares Paket nennt `files` |
| `publishable-ships-sources` | `files` enthält kein `src`, kein `*`, kein `**` |
| `publishable-without-dist` | `files` liefert `dist/`, wenn `main`/`types`/`exports` dorthin zeigen |

**Checkliste vor dem ersten Publish (Phase 3.2):**

- [ ] `files: ["dist"]` in jedem zu veröffentlichenden Paket
- [ ] `private: false` **im selben PR** (die Regeln prüfen dann genau diesen Zustand)
- [ ] `npm pack --dry-run` gegenlesen: **nur** `dist/**`, `package.json`, `README.md`,
      `LICENSE` — kein `src`, keine `*.spec.*`, kein `tsconfig.json`, keine `*.tsbuildinfo`
- [ ] `npm run check:manifests` + `npm run check:api -- --update` (der Vertragsrecord
      ändert sich beim Umstieg **nicht** — die Fläche ist die `.d.ts`-Fläche; wenn er sich
      ändert, ist etwas anderes passiert)
- [ ] Veröffentlichung mit `--provenance`; `npm view <pkg> dist.integrity` gegen den
      lokalen Tarball prüfen

## 4. Verträge und Versionen

Das Repo läuft im Gleichschritt (`manifests.test.ts` pinnt alle Pakete auf die
Root-Version). Für die erste Veröffentlichung heißt das:

1. **Version `1.0.0` für die Vertragspakete** (Konzept 3.3) — vorher: Entscheidung, ob der
   Workspace weiter im Gleichschritt bleibt oder Verträge einen eigenen Stand bekommen
   (offene Entscheidung E3/E6 des Konzepts). Ohne diese Entscheidung bleibt
   `version-drift` in `check:api` ein Hilfsmittel, keine Versionszusage.
2. **Das Closed-Repo pinnt die Verträge** auf die *veröffentlichte* Version (nicht auf einen
   Pfad, nicht auf `workspace:*`) — sonst ist die Grenze beim Build schon durchlässig, und
   `check:api` hat nichts zu messen.
3. **Vertragsänderung nach der Veröffentlichung:** Version entscheiden, `npm run check:api
   -- --update`, Record + Änderung in denselben PR, Migrationshinweis in `CHANGELOG.md`
   (ADR 0059).

## 5. Was nie passiert

- **`npm publish` aus einem Entwicklungsbaum.** Veröffentlicht wird aus der CI, mit
  Provenance, aus einem Commit, dessen `npm run ci` grün war.
- **Ein Closed-Paket im öffentlichen Scope.** Eigener Scope, eigene Rechte, eigene Prüfung
  (`private: false` im öffentlichen Baum ist die Ausnahme, die man begründet).
- **Ein Token im Repo oder in einer geteilten Datei.** OIDC statt Token.
- **`src` im Tarball.** Nicht „harmlos“, sondern eine Offenlegung, die niemand entschieden
  hat — und genau die Regel, die oben steht.
- **Daten in ein npm-Paket packen, die lizenziert sind** (OEM-Definitionen, ODX): Daten
  werden beim Kunden ausgeliefert oder über einen eigenen Kanal, nie über den
  öffentlichen npm-Scope (AGENTS 24).

## 6. Erste Veröffentlichung — Reihenfolge

```text
Rechte geklärt (phase-0-rights.md, E1/E2 entschieden)          ← Voraussetzung
   ▼
Registry-Zugang: Org, 2FA, OIDC, Rollen                          ← §2, Inhaber
   ▼
`files` + `private: false` je Vertragspaket (1 PR, Regeln grün)  ← §3
   ▼
Trockenlauf gegenlesen: `npm pack --dry-run` an jedem Paket      ← §3
   ▼
`--provenance`-Publish aus der CI; `npm view` gegenprüfen        ← §3
   ▼
Closed-Repo: Verträge gepinnt, Build gegen die Registry          ← Phase 3.1/3.5
```

**Zugehörig:** [`docs/architecture/open-core-phase-0-rights.md`](../architecture/open-core-phase-0-rights.md),
[`docs/flows/open-core-boundary.md`](../flows/open-core-boundary.md),
`CONTRIBUTING.md` („Contracts, licences and versions“), ADR [0059](../adr/0059-contracts-are-frozen-and-measured.md)/[0060](../adr/0060-third-party-licences-are-checked.md).
