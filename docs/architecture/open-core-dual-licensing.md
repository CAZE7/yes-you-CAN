# Open-Core und Dual-Licensing — Architektur- und Sicherheitskonzept

> **Status: Entwurf zur Entscheidung (2026-09-23). Nicht normativ.**
> Dieses Dokument ist ein Vorschlag, keine Regel. Verbindlich wird es erst mit
> ADR (Template ADR 0043), `architecture/architecture.yaml`, `ARCHITECTURE.md`
> und den betroffenen Package-`README.md` **im selben PR** (Regel 34.24,
> AGENTS 0.0). Kapitel 5 nennt die Entscheidungen, die dafür fallen müssen.
>
> **Grundlage:** Ist-Zustand des Repositorys am Stand `23d72de`
> (`arena/01a0cfd9-yes-you-can`). Jede Aussage über den Code trägt einen Beleg
> (Datei/Zeile oder Kommando-Ausgabe) — Regel 34.21 gilt auch für Konzepte.
>
> **Umsetzungsstand (2026-09-23, gemessen; ✅ markiert die Aufgaben, die inzwischen
> gebaut sind):** Aus Phase 1/2 ist der erste Teil umgesetzt — **1.1 + 1.2** (ADR 0059:
> `contracts` in `architecture/architecture.yaml`, `architecture/public-api.json`,
> `npm run check:api`; umgesetzt als `contracts`-Abschnitt statt als neuer Layer —
> ADR 0059, *Alternatives* 1/2; gemessen **7 Verträge / 49 Flächen-Dateien / 5 externe
> Typquellen**, Record-Format 2 misst **jeden** Typ-Einstiegspunkt inkl. Subpfad-`exports`),
> **2.3** (Verteilungsregel `private-dependency-leak` in
> `tools/architecture/check-package-manifests.mjs`, Biss-Test in
> `tests/architecture/manifests.test.ts`) und **2.5** (ADR 0060: `licenses` in
> `architecture.yaml`, `npm run check:licenses`; gemessen **108 Drittpakete — 0
> Produktion / 108 Entwicklung**). **Teilweise:** **1.4 🟡** — die Regeln stehen in
> `CONTRIBUTING.md` („Contracts, licences and versions"), die Entscheidung über
> Vertragsversionen nach der ersten Veröffentlichung ist offen. **Weiter Vorschlag,
> nicht gebaut:** Phase 0, die
> Enterprise-Pakete und die Kantenregel **2.2** (ein `layerRules`-Präfix ohne Treffer
> ist ein Verstoß — sie kann erst mit dem ersten `@vdp/enterprise-*`-Paket landen),
> Phase 3–6, die Native-Härtung und die Lizenzausstellung.

---

## 0. Kurzfassung

### 0.1 Der Ist-Zustand, auf dem aufgebaut wird

Gemessen am 2026-09-23 in diesem Arbeitsbaum (`node v22.22.3`):

| Befund | Beleg | Bedeutung für dieses Konzept |
|---|---|---|
| **29 Pakete, 92 Kanten, 6 Regeln, 0 Verstöße** | `node tools/architecture/check-dependencies.mjs` → `no violations`, EXIT 0 | Der Importgraph ist bereits ein maschinelles Gesetz. Eine Open/Closed-Regel wird **eine Zeile in `architecture.yaml`**, kein neues Werkzeug. |
| **Alle 29 Pakete:** `private: true`, `license: MIT`, `0.1.0` | Schleife über `packages/**/package.json`, `tools/*`, `apps/*` | Veröffentlichung ist heute nirgends möglich — und nirgends verboten. Beides muss entschieden werden. |
| **0 Laufzeit-Abhängigkeiten** (ADR 0002) | jedes `dependencies`-Feld enthält ausschließlich `@vdp/*` | Kontaminationsfläche durch Fremdcode = **0**. Das ist der stärkste Lizenz-Hebel, den das Projekt hat. |
| **Fertige Nähte (Ports/SPI) an genau den Stellen, die „Closed" werden sollen** | `SeedKeyAlgorithm`, `OemProtocol`, `DefinitionPackage`, `AnalysisProvider`, `IntegrityPort`, `EcuLinkFactory` | Die Trennung ist **nicht zu bauen, sondern zu benennen und zu erzwingen**. |
| **ed25519 + kanonisches Binding + `keyId`-Fingerprint** | `packages/storage/src/manifest-signer.ts`, `packages/core/src/logging/integrity.ts` | Signatur-/Lizenzmechanik existiert als Muster (aber prozessflüchtig → für Lizenzen **nicht** wiederverwendbar, siehe §2.4.2). |
| **Rust-Kern mit Release-Härtung** | `crates/yes_you_can_core/Cargo.toml`: `lto=true`, `codegen-units=1`, `panic="abort"` | Präzedenzfall für native Closed-Module — inkl. der im Repo dokumentierten Befunde (0.E E25: kein Tor, keine Tests). |
| **Browser-Frontend als Vanilla-ESM** | `apps/web/public/*.js`, ADR 0006 | Jede Logik, die dorthin gelangt, ist **öffentlich**. Harte Regel in §2.5. |
| **Bestehende Vertrauensgrenzen dokumentiert** | `docs/standards/iso-21434-cybersecurity.md` §1 (Browser↔Workbench, Workbench↔Bus, Datei↔Sitzung) | Die neue Grenze „Open ↔ Closed" ist eine **vierte** Zeile in derselben Tabelle — die TARA muss sie erben. |

Drei Reibungspunkte, die dieses Konzept auflösen muss:

1. **`private: true` + MIT überall** heißt: heute gibt es weder eine Veröffentlichung
   noch eine Rechte-Konsolidierung. Ein Dual-Licensing-Modell ohne CLA ist ein
   Absichtserklärung ohne Grundbuch (§3.4).
2. **Ein offenes Browser-Frontend** verträgt keine geheime Logik. Der Schutz kann
   deshalb nur hinter Ports liegen, nie in der UI.
3. **Das Produkt ist offline-first** (`docs/standards/iso-21434-cybersecurity.md`,
   AGENTS 27: lokale Speicherung als Standard). Eine reine Cloud-Lösung wäre ein
   Produktbruch — die Schutzstrategie muss **zweigleisig** sein (Server *und*
   lokal), nicht einseitig.

### 0.2 Die vier Leitentscheidungen

| # | Entscheidung | Kern |
|---|---|---|
| **L1** | **Der Vertrag ist offen, die Implementierung ist es nicht.** | Der geschlossene Teil **implementiert** Interfaces, die im offenen Kern definiert sind, und wird am Composition Root injiziert. Der offene Kern importiert **nie** geschlossenen Code. |
| **L2** | **Zwei Veröffentlichungsdomänen, nicht zwei Wahrheiten.** | Ein öffentliches Repository (Quelle + Verträge) und ein privates Repository (Implementierungen), verbunden über eine **private Registry mit Build-Artefakten** (`dist` + `.d.ts`), nicht über Quellcode. |
| **L3** | **Schutz = Dienst + Daten + Vertrag; Obfuskation ist Zusatz, nie Fundament.** | Was den Wert trägt (Entitlement, OEM-Daten, Modell/Orchestrierung), gehört auf den Server. Was lokal laufen *muss*, läuft nativ und lizenzgebunden. Alles andere ist Theater. |
| **L4** | **Apache-2.0 für den offenen Kern, proprietär für Module und Daten, AGPL nur für den Dienst.** | Nicht MIT (kein Patentgrant, keine Markenschranke), nicht AGPL für den Kern (blockiert das Closed-Plugin-Modell, das dieser Plan gerade will). |

### 0.3 Die roten Linien, die dieses Konzept **nicht** verschiebt

Diese Punkte sind nicht verhandelbar, weil sie schon heute Repo-Recht sind — ein
Open-Core-Konzept, das sie aufweicht, wäre kein Fortschritt, sondern ein Defekt:

- **Kein Umgehen von Hersteller-Schutzmechanismen.** AGENTS 26 („Keine frühen
  Implementierungen zum Umgehen von SFD/SFD2 oder anderer
  Sicherheits-/Authentifizierungsmechanismen"), AGENTS 34.12. Der
  `refuseAllSecurityAccess`-Default in `packages/protocols/uds/src/security.ts:38`
  ist genau deshalb ein *Verweigerer* und kein Platzhalter: „Registering one
  requires explicit authorization for this ECU/manufacturer."
  → **Ein geschlossenes Modul darf hier nichts ermöglichen, was ein offenes nicht
  auch dürfte.** Es darf lizenzierte Algorithmen enthalten, für die der Kunde eine
  Berechtigung hat — es darf keine „Crack"-Funktion sein. (Konsequenz: der
  Lizenzprüfer schützt **Wissen**, nicht **Zugang zu fremden Steuergeräten**.)
- **Keine ungeklärten Fremddaten aus Wettbewerbsprodukten** (AGENTS 24). Ein
  „Closed Pack", das aus VCDS/ODIS/XENTRY abgeleitet ist, ist keine Lizenzfrage,
  sondern ein Rechtsverstoß — und der Validator kennt den Unterschied bereits
  (`provenance.sourceType === "licensed"` erzwingt `license` + `version` +
  `retrievedAt`, `packages/definitions/src/validate.ts:141-151`).
- **Der Schreibpfad bleibt offen und prüfbar** (ADR 0032, AGENTS 26). Ein
  Sicherheitsmechanismus, den niemand lesen darf, ist kein Sicherheitsmechanismus.
  Closed-Module dürfen `WritePort` **nicht** ersetzen, nur bedienen.
- **Kein stilles Fehlschlagen** (Regel 34.25). Aggressives Anti-Debugging, das
  Fehler verschluckt oder Abstürze erzeugt, verstößt gegen diese Regel und gegen
  die Diagnostizierbarkeit (AGENTS 33). Ein „geschütztes" Modul, das den Support
  blind macht, kostet mehr als es einbringt (§2.4.5).

---

## 1. Modulare Schnittstellentrennung

### 1.1 Was offen bleibt und was geschlossen wird — am Code entschieden

Die Zuordnung folgt **nicht** dem Geschmack, sondern der Frage: *Ist der Wert
dieses Bausteins seine Geheimhaltung oder seine Nachvollziehbarkeit?*
Alles, wo Nachvollziehbarkeit gewinnt, bleibt offen — auch wenn es wehtut.

| Baustein | Heute | Vorschlag | Begründung |
|---|---|---|---|
| `@vdp/shared`, `@vdp/charts` | offen | **offen** | Fundament, ohne Diagnosewissen. |
| `@vdp/domain` (Ports, Capabilities, Risk) | offen | **offen — Vertrag** | Die Ports sind die Sprache, in der Closed-Module überhaupt sprechen. Ein geschlossener Port wäre ein Widerspruch. |
| `@vdp/diagnostic-ir` | offen | **offen — eingefrorener Vertrag** | Die IR ist die Grenze zwischen „was gemessen wurde" und „was jemand daraus ableitet". Genau hier liegt die Open/Closed-Naht: **Closed-Module konsumieren IR und liefern Bewertungen, nie Hardware-Zugriff.** |
| `@vdp/application`, `@vdp/runtime` | offen | **offen — Composition Root** | `createDiagnosticRuntime` ist der **einzige** Injektionspunkt. Wer hier nichts einhängen kann, hat keine Closed-Erweiterung. |
| `@vdp/transport/*`, `@vdp/adapter/*` | offen | **offen** | „Hardware-Anbindung" ist laut Auftrag Teil des offenen Kerns. Ein proprietärer Adapter wäre eine Community-Bremse. |
| `@vdp/protocols-uds`, `-kwp2000` | offen | **offen** (Protokoll), **Closed-Kandidat** (konkrete `SeedKeyAlgorithm`-Implementierungen) | Die Norm ist öffentlich; ein lizenzierter Herstelleralgorithmus ist es nicht. Die Naht existiert (`security.ts:20`). |
| `@vdp/protocols-oem` | offen, registry ohne Imports | **offen als Vertrag + Registry** | `OemProtocol`-Hooks sind der Katalog dessen, was ein Closed-Modul liefern darf (`identifyEcu`, `identificationDids`, `interpretDtc`). Die *Implementierungen* sind Closed-Kandidaten. |
| `@vdp/definitions` (Schema, Validator, Migrate) | offen | **offen** | Der Vertrag für Daten. Er ist die Versicherung, dass ein Closed-Datenpaket dieselben Provenance-Regeln erfüllen muss wie ein offenes. |
| Definitions**daten** (VAG/Mercedes) | Platzhalter | **Daten = eigener Rechtsraum** (§3.2) | Code-Lizenz ≠ Daten-Lizenz. Heute `example-placeholder`; künftig `licensed` mit `license`/`version`/`retrievedAt`. |
| `@vdp/core` (Engine, Evidence, Safety, Writes) | offen | **offen** | §0.3. Die Heuristiken in `core/src/evidence/hypotheses.ts` sind **nicht** der Closed-Kandidat — sie sind die nachrechenbare Regel, die AGENTS 22 verspricht. |
| `@vdp/storage`, `@vdp/reports` | offen | **offen** | Exportierbarkeit ist Vertrauensbildung. Ein geschlossener Report wäre ein Kundenproblem (Dateneigentum!). |
| `@vdp/ai` (Provider-Gerüst, lokaler Provider, Prompt-Version) | offen | **offen** (Gerüst + lokale Heuristik), **Closed-Kandidat** (Premium-Provider, Ranking-Gewichte, kuratierte Muster) | Der Provider ist die Naht (`AnalysisProvider`, Registrierung über `AnalysisService.registerProvider`). Was den Wert trägt, ist im Gateway ohnehin serverseitig (§2.3). |
| `apps/web` | offen | **offen** | §2.5: was im Browser läuft, ist lesbar. Enterprise-Panels sind offene UI **gegen** eine geschlossene API. |
| `tools/*` | offen, importiert nichts | **offen** | Simulator, Golden Sessions, Harvest sind Vertrauensgüter und Vertriebsargumente. |
| **neu:** `@vdp-enterprise/*` | — | **geschlossen** | Vorschlag für eine eigene Scope, damit die Regel mechanisch prüfbar ist: `entitlement`, `oem-routines`, `analysis-premium`, `knowledge-premium`, `native-core`, `secure-store`. |

**Der Scope-Name ist kein Kosmetikdetail.** `@vdp-enterprise-*` lässt sich mit der
*bestehenden* Werkzeugmaschinerie prüfen: `prefixMatches(name, prefix)` in
`tools/architecture/check-dependencies.mjs` erkennt `@vdp/enterprise-core` als
Präfixfamilie von `@vdp/enterprise`. Damit sind Regeln wie „nur der
Composition Root darf Enterprise importieren" **eine Zeile YAML**, kein
Sonderfall im Checker.

### 1.2 Die Naht existiert bereits: sieben SPI-Punkte

| # | Naht | Datei | Vertrag (Kurzform) | Injektion |
|---|---|---|---|---|
| 1 | `SeedKeyAlgorithm` | `packages/protocols/uds/src/security.ts:20` | `{ id, provenance, computeKey(ctx) }` | ECU-Session; Default verweigert |
| 2 | `OemProtocol` + `OemProtocolRegistry` | `packages/protocols/oem/src/index.ts` | `{ oem, displayName, provenance, identifyEcu?, identificationDids?, interpretDtc? }` | `createDiagnosticRuntime({ oemProtocols })` |
| 3 | `DefinitionPackage` / `DefinitionProvider` | `packages/definitions/src/schema.ts`, `packages/domain/src/ports/definition-provider.ts` | versionierte Daten + `source`-Herkunft | Provider am Composition Root |
| 4 | `AnalysisProvider` | `packages/ai/src/types.ts`, `service.ts` | `{ id, label, sendsDataOffBox, analyze(input) }` | `AnalysisService.registerProvider()` |
| 5 | `IntegrityPort` | `packages/core/src/logging/integrity.ts` | `{ algorithm, createDigest() }` | `@vdp/storage` liefert `nodeIntegrityPort` |
| 6 | `ManifestSigner`/`ManifestVerifier` | `packages/core` ↔ `packages/storage/src/manifest-signer.ts` | `sign(identity)`, `verify(binding, sig)` | Storage/Prozess |
| 7 | `EcuLinkFactory` / `CanBus` | `packages/core`, `packages/domain/src/ports/connection.ts` | Transportvertrag | Runtime / Adapter |

**Das Playbook, das daraus folgt (und als Regel festgeschrieben gehört):**

1. Ein Closed-Modul **implementiert** einen dieser Verträge. Es definiert **keine**
   neuen Typen, die der offene Kern kennen müsste — sonst wandert Closed-Wissen in
   die offene Typfläche.
2. Der offene Kern **importiert** das Closed-Modul nie; er bekommt es übergeben.
   Die Abhängigkeitsrichtung wird durchbrochen (Dependency Inversion) — und der
   Entry Point ist ausschließlich `createDiagnosticRuntime()`.
3. Der Vertrag, den ein Closed-Modul erfüllt, ist **versioniert** und liegt in
   einem Contract-Paket (§1.3). Kein Closed-Modul konsumiert Interna.
4. **Closed-Module erhalten keine neue Autorität.** Ein geschlossener Provider
   bekommt `AnalysisInput` — er bekommt keinen Bus, keinen `WritePort`, kein
   Steuergerät. Der bestehende Guardrail, dass die AI-Schicht niemals
   Schreibfähigkeit erreicht (ADR 0038; `@vdp/ai` darf nur `@vdp/shared` und
   `@vdp/diagnostic-ir` importieren), **gilt für Closed-Module unverändert**.

### 1.3 Verträge versionieren und prüfen

Offene Kerne scheitern selten an der Idee, sondern an der **Vertragsdrift**: das
geschlossene Modul kennt eine Signatur, die der offene Kern zwei Releases später
nicht mehr hat. Was dagegen gebaut werden muss:

| Maßnahme | Artefakt | Gate (Beleg) |
|---|---|---|
| Contract-Pakete benennen | `docs/api/`-Index + Markierung in `architecture.yaml` (neues Feld `contract: true` oder eigener Layer `contract`) | `check-dependencies` + `dependencies.test.ts` |
| **Nur Build-Artefakte über die Grenze** | Closed-Repo konsumiert `dist/**/*.d.ts` + `dist/**/*.js` aus der Registry, **nie** Quellpfade | Wird durch die Registry erzwungen (Paketinhalt), nicht durch gute Absicht |
| API-Diff als Gate (✅ gebaut, ADR 0059) | `tools/architecture/check-api.mjs`: hüllt die emittierte `.d.ts`-Fläche transitiv aus, normalisiert Kommentare/Whitespace, hasht je Datei und schreibt den Record nach `architecture/public-api.json` | Ändert sich ein Hash → EXIT 1; `--update` schreibt den Record und **zeigt**, was sich geändert hat, statt still zu sein. Die Version im Record bewacht `version-drift`. Genau der Stil von ADR 0042 („`package.json` ist eine Behauptung über Importe"). |
| Semver-Disziplin | `0.1.0` → `1.0.0` erst, wenn die Verträge stehen; danach: Major = brechende Änderung | Version-Policy in `CONTRIBUTING.md` + `check:manifests` (Lockstep existiert schon: „the workspace moves in lockstep") |
| Kompatibilitätstest des Closed-Moduls **gegen den Vertrag** (nicht umgekehrt) | Im privaten Repo: Testprojekt, das gegen die veröffentlichte Contract-Version kompiliert | Läuft in der privaten CI; der öffentliche Baum braucht dafür keine Kenntnis |

**Wichtig:** `check:deps` und `check:manifests` werden **erweitert**, nicht
ersetzt. Das Repo hat mit ADR 0029/0031/0042 die Regel „ein Werkzeug, eine
Quelle" durchgesetzt; ein zweites Regelsystem für Open/Closed wäre genau die
Duplizierung, die dieses Projekt verbietet.

### 1.4 Repository-Topologie: die vier Optionen

| Option | Wie | Bewertung |
|---|---|---|
| **A. Monorepo mit privatem Verzeichnis** | `private/` im selben Repo, `private: true`, nie veröffentlicht | ❌ **Scheitert am Schutzziel.** Git-Historie ist öffentlich; „nicht veröffentlicht" ist nicht „geheim". Nur brauchbar, wenn das Geschlossene *keine* Quelle ist (z.B. reine Build-Artefakte), und selbst dann mit Risiko. |
| **B. Git-Submodule** | Privates Repo als Submodul unter `closed/` | ❌ **Bricht die Werkzeuge.** `WORKSPACE_ROOTS` in `check-dependencies.mjs` und `check-package-manifests.mjs` findet `packages/`, `tools/`, `apps/` — ein Submodul an anderer Stelle wird **nicht geprüft**, also ist die Grenze ungeprüft. Zusätzlich: Submodul-Historie verrät Struktur, `tsc -b`-Projektreferenzen über Repo-Grenzen sind fragil, und jeder Klon braucht Zugangsdaten. |
| **C. Zwei Repos + private Registry (Empfehlung)** | Öffentliches Monorepo (Quelle + Verträge, publiziert `@vdp/*`) · privates Repo (Quelle, publiziert `@vdp/enterprise-*` als **Build-Artefakte**) · Registry: GitHub Packages (npm) mit OIDC-Publishing, alternativ selbstgehostetes Verdaccio für Offline-/Airgap-Kunden | ✅ Einzige Variante, die das Schutzziel *und* die Werkzeugkette erfüllt: das Geheimnis liegt nie im öffentlichen Baum, die Grenze ist eine echte Verteilungsgrenze, und der Vertrag ist erzwingbar, weil das Closed-Repo nur gegen die *veröffentlichte* API kompiliert. |
| **D. Public Monorepo + Closed nur als Dienst** | Kein Closed-Code beim Kunden; alles Geschlossene ist HTTP | ✅ als **Teilmenge** immer richtig (siehe §2.3), ❌ als **Ganzes** für dieses Produkt: Offline-Werkstatt, DoIP im abgeschotteten Netz, Datenschutzversprechen (§27) und die eigene Baseline „localhost als Default" (ADR 0009) vertragen keinen Cloud-Zwang. |

**Empfehlung: C, mit einem ehrlichen Übergang.**

Der Übergang ist der wichtigste Teil, weil er die Reihenfolge festlegt:

- **C1 (Übergang, Wochen 0–4):** Zuerst **innerhalb** des heutigen Monorepos
  arbeiten — Closed-Kandidaten in `packages/enterprise/*` verschieben, als
  `@vdp/enterprise-*` benennen, `private: true` behalten, **keine Veröffentlichung
  des öffentlichen Kerns**. In dieser Phase ist nichts geheim, aber **alles
  gemessen**: die Kanten, die Verbote, die Tests.
  Warum nicht sofort splitten? Weil ein Repo-Split vor der Vertragsklärung zwei
  driftende Wahrheiten erzeugt und jede Architekturänderung doppelt kostet
  (Regel „ein Thema je PR", AGENTS 0.C.1).
- **C2 (Cut, ab Woche 5):** Auszug des Inhalts von `packages/enterprise/*` in das
  private Repo, Registry-Publishing, Konsum über Versions-Pin. Der öffentliche
  Baum behält die Verträge und einen **Test-Fixture**, der die verbotenen Kanten
  beweist (§1.5).

**Registry-Wahl, konkret:**

| Kriterium | GitHub Packages | Verdaccio (selbst) |
|---|---|---|
| Betrieb | keiner | einer mehr (Version, Backup, TLS) |
| Zugang | an die Org gebunden, Token mit Scope | frei definierbar, auch für Kunden-Spiegel |
| Airgap/Offline-Kunden | ❌ | ✅ (`npm pack` + Datei-Installation als Notweg) |
| Provenance/OIDC | ✅ `npm publish --provenance` | teilweise |
| Empfehlung | **Start** (Wochen 1–26) | **ab** erstem Kunden mit Offline-Anforderung |

### 1.5 Wie die Trennung erzwungen wird — nicht nur dokumentiert

Ein Konzept ohne Gate ist eine Meinung. Vier Gates, in dieser Reihenfolge:

1. **`architecture.yaml` — die Kantenregel.**
   `@vdp/enterprise` erhält einen eigenen Layer (`enterprise`, oberhalb von
   `runtime`). Jedes öffentliche Paket bleibt ohne Kante dorthin;
   `@vdp/runtime` und `@vdp/web` sind die **einzigen**, die
   `mayImport: ["@vdp/enterprise-…"]` bekommen. Zusätzlich eine `layerRules`-Zeile
   `{ from: "@vdp", forbidden: ["@vdp/enterprise"], why: "…" }`, damit auch ein
   später hinzugefügtes Paket die Grenze nicht versehentlich überschreitet.
2. **`check:manifests` — die Verteilungsregel.**
   Neue Regel im vorhandenen Werkzeug: **ein Paket mit `private: false` darf
   keine Abhängigkeit auf ein `private: true`-Paket deklarieren.** Damit kann
   niemals ein öffentliches Paket versehentlich ein Closed-Paket mitziehen — die
   häufigste Ursache für „Open-Core, aber der Build bricht beim Kunden".
3. **Der Biss-Test (ADR 0029).** Eine Fixture in `tests/architecture/` prüft, dass
   die Regel **fällt**, wenn man sie verletzt (ein temporärer Import in einem
   Testfall). Das Repo macht das für Coverage- und Haskell-Gates bereits so; ein
   Gate, dessen Schärfe nicht nachgewiesen ist, ist Dekoration.
4. **Das Closed-Repo prüft sich gegen den Vertrag**, nicht der offene Baum gegen
   das Closed-Modul. Der öffentliche Kern weiß von seinem Zusatz **nichts** —
   auch nicht in Tests. (Konsequenz: keine goldenen Sitzungen, die ein Closed-Modul
   voraussetzen. `tests/fixtures/golden-sessions/` bleiben offen.)

---

## 2. Schutz gegen Reverse Engineering und Cracks

### 2.1 Die ehrliche Vorbemerkung

**Jeder Code, der beim Kunden ausgeführt wird, kann extrahiert werden.** Das ist
keine Meinung, sondern die Definition des Angriffsmodells: wer den Speicher und
den Prozessor kontrolliert, kontrolliert die Software. Schutzziel ist deshalb
nicht „Unmöglichkeit", sondern eine **Kostenfunktion**: der Angriff soll teurer
sein als der Preis der Lizenz — und der *legale* Weg soll bequemer sein als der
illegale. Wer einem Open-Core-Konzept „unknackbar" verspricht, verkauft eine
Illusion und beschädigt damit die Glaubwürdigkeit des ganzen Plans.

Aus dieser Ehrlichkeit folgen zwei Regeln für dieses Kapitel:

- Jede Maßnahme nennt **Restrisiko und Aufwand**, nicht nur „verhindert".
- Behauptungen über Wirkung sind als **Plausibilität** markiert, solange sie nicht
  gemessen wurden (Regel 34.21). Beispiel: „Rust lässt sich schlechter
  dekompilieren als JavaScript" ist plausibel, aber in diesem Repo **nicht
  gemessen** — und `cargo`/`rustc` fehlen in der Umgebung (0.E E25, ADR 0053 §4).

### 2.2 Was den Wert trägt — und was daraus für den Schutz folgt

| Wertträger | Ist er kopierbar? | Konsequenz |
|---|---|---|
| **Der Dienst** (Serverantworten, Modell, Datenaktualität) | Nein, solange die Antwort nur gegen Entitlement kommt | Höchste Schutzklasse → Server |
| **Die Daten** (lizenzierte OEM-Pakete, kuratiertes Wissen) | Ja, sobald entschlüsselt | Schutz durch Vertrag, Entitlement, Rotation — **nicht** durch Verschlüsselung allein |
| **Der Algorithmus** (Routinen, Ranking) | Ja, wenn er lokal läuft | Zwischenlösung: nativ + lizenzgebunden (§2.4) |
| **Der Code selbst** (UI, Protokolle, IR) | Ja, und das ist gewollt | Offen — er *ist* das Vertriebsargument |

Daraus folgt die Kernarchitektur des Schutzes: **die Wertschöpfung verschieben,
nicht den Code verstecken** („Verschieben statt Verstecken"). Wer ein
Diagnose-Werkzeug 2026 kopieren will, kopiert Code; wer eine *aktuelle,
lizenzierte Wissensbasis* will, muss sie kaufen.

### 2.3 Serverseitig — was zwingend dort bleiben muss

Das Repo hat den Server schon: `apps/web/src/server.ts` (37 API-Pfade, gemessen in
`docs/standards/iso-21434-cybersecurity.md` §2), Token-Tor (ADR 0051), TLS-Option
und Rate-Limit (ADR 0054). Der Cloud-Dienst ist damit **eine zweite Instanz
desselben Servers**, kein Fremdkörper.

| Was **muss** serverseitig bleiben | Warum | Wenn es doch clientseitig läuft |
|---|---|---|
| **Entitlement-Ausstellung** (welche Rechte, welcher Kunde, bis wann) | Ein Client, der sein eigenes Recht ausstellt, ist kein Client | Lizenzprüfung ist Dekoration; jede Lizenz wird zur Empfehlung |
| **Der Lizenzschlüssel / die Signatur-Infrastruktur** | Ein Signierschlüssel auf der Kundenmaschine ist ein öffentlicher Schlüssel | Jeder kann sich Lizenzen „ausstellen"; Widerruf unmöglich |
| **OEM-Datenpakete: Auslieferung, Verschlüsselung, Schlüsselrotation** | Daten sind das teuerste Gut (Art. 61/63 VO (EU) 2018/858-Zugang ist gebührenpflichtig — so steht es im Repo, AGENTS 1.46) | Datenpaket wandert in den Umlauf; Herstellervertrag bricht |
| **Das Modell und die Prompt-Orchestrierung** | Das ist der IP-Kern der Analyse; die Naht existiert (`packages/ai/src/http.ts`) | Ein lokaler Provider mit gestohlenem Prompt ist ein Wettbewerbsprodukt |
| **Kuratierte, querschnittliche Wissensbasis** (Muster über viele Fahrzeuge) | Entsteht nur durch Aggregation | Die „Intelligenz" ist kopierbar, die Aktualität nicht |
| **Attestierung/Signatur** (z.B. signierte Premiumberichte, Audit-Nachweise) | Eine Signatur beweist nur, wenn der Aussteller es tut | Nachweis „sieht echt aus", ist es aber nicht |
| **Missbrauchs-/Missbrauchs-Raten** (Entitlement-Ledger, Auffälligkeiten) | Zentrale Sicht | Ein entkoppelter Client kann nichts erkennen |

**Was ausdrücklich *nicht* server-seitig sein darf** (sonst bricht das Produkt):

- **Rohtrace, Sitzungsdaten, Fahrzeugdaten** — lokale Speicherung als Standard,
  Cloud optional (AGENTS 27), VIN-Redaktion vor dem Gateway
  (`redactVin` in `packages/ai/src/http.ts`).
- **Der Schreibpfad** — eine Wolke darf nie der einzige Weg sein, ein Steuergerät
  zu codieren; `WritePort` + `SafetyManager` bleiben lokal (ADR 0032; „fail-closed",
  AGENTS 26/33).
- **Die Sicherheitsschicht** — sie bleibt offen und prüfbar (§0.3).

**Zero-Trust-Härtung der API (Ausbaustufe), auf bestehendem Fundament:**

| Baustein | Heute | Ergänzung |
|---|---|---|
| Authentifizierung | Bearer-Token/`httpOnly`-Cookie (ADR 0051), konstanter Vergleich über SHA-256 | OAuth2-Client-Credentials oder mTLS für Maschinen (Werkstatt-Server), kurzlebige Access-Tokens |
| Transport | TLS-Option `--cert`/`--key`, HSTS (ADR 0054) | Für die Cloud: **Zertifikatspinning ist bereits vorgesehen** — `HttpClient` ist in `packages/ai/src/http.ts` injizierbar („so an installation can pin a specific client, proxy or certificate bundle"). Dasselbe Muster für Lizenz- und Update-Endpunkte. |
| Autorität | Client meldet Zustand | **Server entscheidet, Client liefert Belege.** Der Client meldet nie „ich bin lizenziert", sondern fragt; die Antwort trägt die Entscheidung. |
| Replay/Manipulation | — | Nonce + Zeitfenster + Request-Signatur auf demselben kanonischen Binding-Muster wie `canonicalManifestBinding` (`packages/core/src/logging/integrity.ts`) |
| Fehlerantworten | `statusFor(error)`, Sätze statt Stacktraces | Zusätzlich: keine Unterscheidung „Lizenz ungültig" vs. „Funktion existiert" in der Antwort (kein Orakel für Feature-Enumeration) |
| Mandant | — | Jede Anfrage trägt einen Tenant-Scope; Auswertung ausschließlich innerhalb des Scopes |

### 2.4 Lokal und offline — die Steigerungsleiter

Werkstätten sind offline (ADR 0002: „Ein Diagnose-Werkzeug läuft in
Werkstattnetzen, die offline sind und bleiben"). Also muss ein Teil geschützter
Logik beim Kunden laufen. Diese Leiter ist nach **Nutzen/Aufwand** sortiert; sie
ist nicht kumulativ zu verstehen, sondern als Auswahl.

#### 2.4.1 Stufe 1 — Native Module statt JavaScript (Fundament)

Das Repo hat den Präzedenzfall: `crates/yes_you_can_core` mit
`crate-type = ["cdylib", "rlib"]` und Release-Härtung
(`opt-level = 3`, `lto = true`, `codegen-units = 1`, `panic = "abort"`).

| Maßnahme | Status | Begründung |
|---|---|---|
| N-API/`.node`-Binding für Closed-Logik | Vorschlag | Ein nativer Bindungspunkt ist eine Binärgrenze; die JS-Seite sieht nur die Signatur. |
| `strip = true` + Symbolverbergung + `--remap-path-prefix` | **fehlt heute** | `Cargo.toml` härtet Codegen, aber nicht die Symbole. Ohne `strip` trägt das Binary Datei-/Pfadnamen und Funktionsnamen — das ist eine Landkarte für den Angreifer. Kleine Änderung, große Wirkung. |
| Kein Debug-Build an Kunden | fehlt konzeptionell | `panic = "abort"` ist gesetzt; `debug = false` explizit machen. |
| Der Rust-Crate bleibt **Referenz/Experimental** (0.E E25) | Befund | **Ein Closed-Modul darf nicht auf einem ungetesteten Modul aufbauen.** Vor jeder Nutzung: Permit-Fix, Tests, Vektor-Kopplung an `tools/formal-conformance/vectors/` (ADR 0045). Ein Sicherheitsmodul ohne Tor ist ein Sicherheitsrisiko, kein Schutz. |

**Ehrliche Bewertung:** Rust ist **keine** Obfuskation. Kontrollfluss, Konstanten
und Zeichenketten bleiben rekonstruierbar; der Unterschied zu JavaScript ist der
**Aufwand**, nicht die Möglichkeit. In der Praxis ist die entscheidende Wirkung
nicht „unlesbar", sondern: man kann die Logik nicht mehr mit zwei Mausklicks
ändern und neu laden. Das ist der eigentliche Kopierschutz gegen Gelegenheitsnutzer.

#### 2.4.2 Stufe 2 — Lizenzbindung (der wirtschaftlich wichtigste Teil)

**Wichtige Präzisierung gegenüber dem vorhandenen Code:** der
`createNodeManifestSigner` (`packages/storage/src/manifest-signer.ts`) erzeugt pro
Prozess ein **frisches** Schlüsselpaar, das „nie den Prozess verlässt und nie
persistiert wird" (ADR 0057). Das ist für Sitzungs-Attestierung richtig und für
Lizenzen **unbrauchbar**: eine Lizenz braucht eine **stabile** Identität. Es wird
also nicht der Signer wiederverwendet, sondern das **Muster** (Port im Core,
kryptografische Umsetzung in der Persistenz-/Infrastrukturschicht, `keyId` als
Fingerprint, Verifizierer rechnet den Fingerprint nach, „a name cannot lie about
a fingerprint").

Vorschlag `EntitlementPort` nach dem Muster von `IntegrityPort`:

```text
@vdp/core (offen)            →  entwirft den Vertrag, kennt keine Schlüssel
  interface EntitlementPort {
    readonly issuer: string;                 // Fingerprint des Ausstellers
    verify(license: LicenseFile, context: MachineFingerprint): EntitlementVerdict;
    capabilities(verdict): DiagnosticCapabilities;  // Anknüpfung an @vdp/domain
  }
@vdp/enterprise-entitlement  →  liefert die Implementierung (geheim)
```

| Baustein | Ausführung |
|---|---|
| Lizenzformat | ed25519-signiertes JSON (dieselbe Primitive wie der vorhandene Signer: `node:crypto`, ADR-0002-konform) mit `licenseId`, `customer`, `capabilities[]`, `notBefore`, `notAfter`, `machineBinding?`, `issuerFingerprint` |
| Maschinenbindung | TPM 2.0 (EK/AK) auf Windows/Linux, sonst stabiler Fingerprint (`machine-id` + Dateisystem-UUID). **Ehrlich: das ist eine Hürde, keine Wand** — ein kopierter Fingerprint lässt sich fälschen. |
| Offline-Betrieb | Lizenz ist **offline verifizierbar**; Verlängerung per Leasing-Datei (z.B. 30/90 Tage) oder Online-Abruf, wenn Netz da ist. Kein Zwang zum Online-Sein. |
| Uhrenmanipulation | Liszensenster + „zuletzt gesehen"-Zähler, signiert; Uhr-Rücksprung verlängert **nicht** (monotoner Zähler in `@vdp/storage`), Grace Period explizit statt still. |
| Widerruf | Kurze Lease-Intervalle statt „ewige" Lizenz; Widerrufsliste bei Online-Kontakt |
| Nachvollziehbarkeit | Lizenzprüfung **loggt strukturiert** (Regel 34.25/33) — aber ohne Schlüssel, ohne personenbezogene Daten |
| Anknüpfung an die UI | `DiagnosticCapability` (`packages/domain/src/capabilities.ts`) existiert bereits mit `coding`, `adaptation`, `flash`. **Entitlement → Capabilities → UI-Aktionen.** Damit ist die Lizenzschicht **kein neuer Mechanismus**, sondern eine Quelle für ein vorhandenes Vokabular. |

**Unverhandelbar:** Capabilities steuern, was die UI *anbietet*. Sie steuern **nicht**,
was sicher ist. `WritePort` + `SafetyManager` bleiben die Instanz (ADR 0032,
AGENTS 26/33: „unproven blockiert wie eine Verletzung"). Eine Lizenz hebt keine
Vorbedingung auf — **Lizenz ≠ Safety-Override**, und das ist ein Satz, der in den
ADR gehört.

#### 2.4.3 Stufe 3 — TPM / Secure Element / Attestierung

| Maßnahme | Wirkt gegen | Aufwand | Restrisiko |
|---|---|---|---|
| TPM-gebundene Lizenz (Schlüssel im TPM, Seal an PCR) | Kopieren der Lizenz auf andere Maschinen | mittel (Treiber/Plattformabhängigkeit) | Patch im laufenden Prozess umgeht es |
| Remote Attestation (Server prüft PCR-Werte) | Manipulierte Client-Umgebung | hoch (Server + PKI + Support) | Nur online wirksam — im Offline-Fall unmöglich |
| Secure Enclave / HSM für den Aussteller-Schlüssel | Schlüsselklau beim Hersteller | gering für uns, hoch für Angreifer | — (klar empfohlen) |

**Empfehlung:** TPM ja, aber **optional und ohne Produktbruch** (Fallback auf
Fingerprint), Remote Attestation nur für Enterprise-/OEM-Verträge mit
Online-Anteil. Attestation ist ein Vertriebsargument, kein Massenmechanismus.

#### 2.4.4 Stufe 4 — Obfuskation und Anti-Debugging: die ehrliche Einordnung

| Behauptung | Bewertung |
|---|---|
| „Obfuskiertes JavaScript schützt Logik" | **Nein.** Im Browser (`apps/web/public/*.js`) ist der Quelltext konstruktionsbedingt lesbar; DevTools, Pretty-Print und Quellkarten machen jede Verschleierung zu Kosmetik. Obfuskation in einem Node-Stack schützt **nichts**, was ein Angreifer haben will — sie kostet nur Support. |
| „Anti-Debugging erkennt Angriffe" | **Teilweise**, und mit Nebenwirkungen: Debugger-Erkennung, `ptrace`-Prüfung oder Zeitmessung erzeugen **False Positives** (Virenscanner, Profiler, CI) und kollidieren mit Regel 34.25 (kein stilles Fehlschlagen) und AGENTS 33 (Observability). Wenn überhaupt: nur in klar benannten Closed-Modulen (nie im Schreib- oder Sicherheitspfad), mit **lautem** Fehlerbild und Support-Anleitung. |
| „Control-Flow-Flattening/String-Verschlüsselung in nativen Modulen" | **Ja, als Zusatz.** In Rust/C++ erhöht es den Aufwand deutlich. Es macht Debugging und Crash-Reports aber schlechter → nur in Modulen, die **nicht** sicherheitsrelevant sind, und nie ohne Absturz-Symbolik (Mapping-Tabelle für Absturzberichte ist Pflicht, sonst ist der Support blind). |
| „WASM als Schutz" | **Nein.** WASM ist eine weitere Kompilat-Ebene; Decompiler existieren. Nutzen: Portabilität, nicht Geheimhaltung. |

**Merksatz für die Umsetzung:** Obfuskation ist eine **Zusatzschicht auf nativen
Modulen**, kein Ersatz für Server-Ausführung und keine Maßnahme in JavaScript.

#### 2.4.5 Stufe 5 — Hardware-Dongle

| | Bewertung |
|---|---|
| Wirkt gegen | Kopieren auf andere Maschinen (physisch), Lauffähigkeit ohne Lizenz |
| Kosten | Stückkosten, Logistik, RMA, verlorene Dongles, Treiberinstallation in der Werkstatt |
| Kundenakzeptanz | schlecht — jede Werkstatt kennt verlorene Dongles |
| Empfehlung | **Nur** bei OEM-/Flottenverträgen mit Volumen und Nachweisbedarf („dieser Tester darf diese Marke freischalten"). Für den Standardvertrieb: **TPM + Lease + Marke** ist billiger und schmerzfreier. |

### 2.5 Der Sonderfall Browser: nie Closed-Logik in `apps/web/public/*.js`

Die Workbench ist Vanilla-ESM und wird an den Browser ausgeliefert (ADR 0006).
Daraus folgt **als harte Regel**:

- Kein Enterprise-Algorithmus, kein Lizenzgeheimnis, kein Modell-Prompt in
  `apps/web/public/**`.
- Ein Enterprise-Panel ist **offene UI gegen eine geschlossene API** (lokaler
  Dienst oder Cloud). Was im Browser landet, ist veröffentlicht — auch wenn es
  „nur" minifiziert ist.
- Die Prüfung: `apps/web/public/*.js` läuft bereits im Typecheck
  (`tsconfig.frontend.json`, `checkJs`). Ergänzend gehört ein Gate, das im
  öffentlichen Baum die Zeichenketten des Closed-Scopes verbietet (billig,
  mechanisch, im Stil der Hygiene-Tests).

### 2.6 Realistisches Bedrohungsmodell

Akteure: **A1** Gelegenheitsnutzer (will sparen) · **A2** findiger Bastler (will
lernen, teilt) · **A3** Wettbewerber (will Zeit sparen) · **A4** Grauzonen-Shop
(verkauft „freigeschaltete" Versionen) · **A5** Auftraggeber/Regulator (will
Sicherheit prüfen) · **A6** Innentäter/Beitragender (will Daten oder Rechte).

| ID | Angriff | Akteur | Wirkung, wenn ungeschützt | Gegenmaßnahme | Restrisiko |
|---|---|---|---|---|---|
| T1 | **API-Emulation**: geschlossene API nachbauen, Client umbiegen | A3, A4 | Wettbewerber liefert Antworten ohne Lizenz | Entscheidungslogik **serverseitig**; Antwort ohne Server = keine Wahrheit. Der Client hält keine Regeln. | Wenn der Wert in einer trivialen Transformation läge, wäre er ohnehin keiner — Wert auf Daten/Aktualität legen |
| T2 | **Binary-Patching** der Lizenzprüfung (Sprung umschreiben) | A2, A4 | Lizenz beliebig nutzbar | Prüfung **im** nativen Modul, nicht im JS davor; Integritäts-Selbsttest; signierte Lizenz; mehrere unabhängige Prüfpunkte | **Nicht verhinderbar** — nur verteuern; Wirkung: A1/A2 aufhalten, A4 verlangsamen |
| T3 | **Dump/Dekompilierung** des nativen Moduls | A3 | Algorithmus kopiert | `strip`, LTO, Symbolverbergung, keine Debug-Infos; wertvolle Teile **server-seitig** | Plausibilität, nicht Messung: Aufwand steigt, Möglichkeit bleibt |
| T4 | **MITM** auf Lizenz-/Update-Verkehr | A3, A4 | Lizenz antwortet beliebig, Entitlement gefälscht | TLS + **Pinning** über die injizierbare `HttpClient`-Naht; signierte Antworten (der Client prüft **Inhalt**, nicht nur Transport) | Root-Zertifikat auf der Maschine — deshalb Inhalts-Signatur zusätzlich zum Transport |
| T5 | **Uhr zurückstellen**, um die Lizenz zu verlängern | A1, A2 | Lizenz läuft nie ab | Monotoner Zähler + „zuletzt gesehen" signiert + explizite Grace Period (laut, nicht still) | Erstnutzer können die Uhr einmal zurückstellen — Schaden klein |
| T6 | **Lizenz kopieren** auf viele Maschinen | A4 | Ein Seat, viele Werkstätten | Maschinenbindung (TPM/Fingerprint), Seat-Ledger am Server, kurze Lease | Kopieren des Fingerprints möglich; Erkennung über Nutzungsmuster nötig |
| T7 | **Extraktion lizenzierter Daten** nach Entschlüsselung | A3, A4 | OEM-Datenpaket kursiert frei | Vertrag + Entitlement + **Rotation** + Wasserzeichen (Paketkennung in Auslieferungs-Chiffre) + serverseitige Auslieferung; Sichtbarkeit im `provenance`-Feld (`license`) | **Kein technischer Schutz möglich** — nach der Entschlüsselung ist sie passiert. Erkennbarkeit statt Verhinderung. |
| T8 | **Leak über die Lieferkette** (Token-Leak, versehentliche Veröffentlichung des Closed-Pakets) | A6 | Geschlossener Code öffentlich | Getrennte Registry-Scopes, OIDC-Publishing mit Provenance, `private: true` als Default, ein CI-Gate, das Veröffentlichung außerhalb der Allowlist verweigert, Secret-Scanning (Dependabot existiert) | Menschliche Fehler bleiben möglich |
| T9 | **Rechte-Kontamination** durch Beitrag | A6 | Projekt kann Teile nicht mehr dual lizenzieren | CLA + DCO + Provenance-Pflicht + „keine Wettbewerberdaten" (AGENTS 24) | Nur durch Prozess beherrschbar |
| T10 | **Missbrauch als Umgehungswerkzeug** (Closed-Modul als SFD-Crack) | A4 | Rechtsverstoß, Reputationsschaden | **Produktdesign** (§0.3): die Software *kann* es nicht. `refuseAllSecurityAccess` bleibt Default. | Vertraglich/technisch ausgeschlossen, nicht nur verboten |
| T11 | **Crack-erzeugte Schreibfehler am Fahrzeug** | A1 | Fahrzeugschaden, Schuldfrage | Schreibpfad bleibt offen, `SafetyManager` nicht umgehbar, „unproven blockiert" (ADR 0033), Audit + Signatur (`manifest-signer`) | Ein gepatchtes Binary kann lokal alles — deshalb: Auditspur *signiert* und exportierbar |
| T12 | **Verkauf gefälschter „Lizenzen"** an Werkstätten | A3 | Endkunde zahlt, wir bekommen nichts, Supportfälle landen bei uns | Verifizierbare Aussteller-Signatur → **jede** Lizenz ist prüfbar (Key-Fingerprint); öffentliche Liste widerrufener Aussteller | Betrugsopfer brauchen Support — Serviceprozess |

**Was aus dieser Tabelle folgt:** Der Schutz ist ein **Bündel**, keine Einzelmaßnahme.
Die stärkste Einzelzeile ist T1 (Server-Ausführung), weil sie den Angriff wirtschaftlich
sinnlos macht; die billigste wirksame Zeile ist T2/T3 (nativ + `strip`); die teuerste
und am wenigsten wirksame ist T7-Versuche (Datenverschlüsselung als Alleinlösung).

### 2.7 Erkennung statt Verhinderung — und ihre Grenzen

- **Opt-in-Telemetrie** (Lizenzprüfungen, Version, keine Fahrzeugdaten). DSGVO:
  Einwilligung, Zweckbindung, Löschfristen, Empfänger benannt — und **ausschaltbar**
  bleiben; die Repo-Regel „Datenlöschung/Export" (AGENTS 27) gilt weiter.
- **Wasserzeichen** in ausgelieferten Datenpaketen (Paket-ID, kein Fahrzeugbezug):
  eine Kursierende Kopie ist einem Auslieferungsvorgang zuzuordnen → Grundlage für
  Vertragsgespräche, nicht für Strafverfolgung.
- **Was nicht geht:** „Phone-home"-Zwang in einem Offline-Produkt. Ein
  Lizenzierungsmodell, das Online sein *muss*, ist mit dem Kernversprechen dieses
  Repos unvereinbar.

---

## 3. Lizenzierung und Compliance

### 3.1 Welche Lizenz für den offenen Kern

| Kriterium | MIT | **Apache-2.0 (Empfehlung)** | AGPL-3.0 |
|---|---|---|---|
| Kompatibilität mit Closed-Modulen (Plugin-Modell) | ✅ | ✅ (getrennte Werke über eine definierte Schnittstelle) | ⚠️ umstritten — Kombinationswerk-Frage, in DE/EU nicht geklärt |
| Patentgrant der Beitragenden | ❌ **fehlt** | ✅ explizit + Patentvergeltung | ✅ |
| Markenschutz | §6 fehlt (Marke nur über allg. Recht) | ✅ Markenparagraph | ✅ |
| „Änderung kennzeichnen"/NOTICE | ❌ | ✅ | ✅ |
| Kann ein Dritter den Kern schließen und selbst verkaufen? | ✅ ja (legal) | ✅ ja (legal) — **Unterschied liegt bei Patenten und Marke, nicht beim Verkauf** | ❌ nein (Copyleft) |
| Eignung für das Open-Core-Modell **dieses** Produkts | ✅ minimal | ✅ **beste Balance** | ❌ erschwert genau das Closed-Plugin |
| Akzeptanz in Einkaufs-/Rechtsabteilungen | ✅ | ✅ | ❌ häufig pauschal ausgeschlossen („AGPL kommt nicht ins Haus") |
| Wirksamkeit der Netzwerkklausel | — | — | ⚠️ **schwacher Treffer**: ein lokales Offline-Werkzeug ist kein Netzwerkdienst → man zahlt den Preis ohne den Nutzen |

**Empfehlung (dreigeteilt, nach Werk):**

1. **Offener Kern (alles Lokale: `@vdp/protocols-*`, `transport-*`, `adapter-*`,
   `core`, `runtime`, `storage`, `reports`, `apps/web`, `tools/*`): Apache-2.0.**
   Begründung in einem Satz: Bei einem **normbasierten** System (ISO 14229,
   ISO 15765-2, ISO 13400, ISO 22901) ist die **Patentfrage** real, und MIT gibt
   sie nicht weiter. Dazu kommt der Markenparagraph, der dem Open-Core-Modell
   nicht widerspricht, sondern es trägt (§3.5).
2. **Cloud-Dienst / Wissensdatenbank (Server, der Mandanten bedient): AGPL-3.0
   oder Source-Available (z.B. BUSL mit Ablauf auf Apache).** Hier greift die
   Netzwerkklausel wirklich, und hier ist der Wettbewerber, der den Dienst
   hostet, das Problem.
3. **Enterprise-Module und Datenpakete: proprietär** (kommerzielle Lizenz je
   Kunde, keine Veröffentlichung, nur Build-Artefakte in der privaten Registry).

**Warum nicht MIT behalten?** Drei Gründe, in dieser Reihenfolge:
(a) kein Patentgrant — bei einem standardbasierten System ein reales Risiko,
(b) kein Markenparagraph — der einzige Hebel, der bei Open-Core wirklich greift,
(c) Wechselkosten: von MIT **weg** ist teuer (jede/r Beitragende muss
zustimmen), von Apache **weg** ist es noch teurer. **Die Lizenzierung ist die
Reihenfolge-Entscheidung mit der längsten Halbwertszeit im ganzen Plan.**
Wer Apache will, sollte es **vor** der ersten externen Veröffentlichung wählen.

**Warum nicht AGPL für den Kern?** Nicht aus Dogmatik, sondern aus Zielkonflikt:
AGPL verbietet genau das, was dieses Konzept will — ein geschlossenes Modul, das
gegen einen offenen Kern läuft. Man kann diesen Konflikt durch eine kommerzielle
Ausnahme auflösen (AGPL + Commercial Exception, wie es andere Anbieter tun), aber
das erzeugt **mehr** Rechte-Komplexität (CLA zwingend, Ausnahme-Wortlaut,
Kundenverhandlung bei jeder Integration) und verliert Adoptionspotenzial bei
OEMs/Zulieferern, die AGPL standardmäßig ausschließen. Der Nutzen (kein
geschlossener Fork) ist bei einem Offline-Werkzeug ohnehin klein.

### 3.2 Daten sind nicht Code — zwei Rechtsräume sauber trennen

Der häufigste teure Fehler im Open-Core ist die Annahme, die Code-Lizenz regle
die Daten. Tut sie nicht:

| | Code | Daten (Definitionspakete, DTC-Wissen, ODX) |
|---|---|---|
| Lizenz | Apache-2.0 (Kern) | **eigene Lizenz je Paket**, im Paket deklariert |
| Ort der Wahrheit | `LICENSE` | `provenance.license` + `provenance.sourceType` (Schema v3, `packages/definitions/src/schema.ts:357`) |
| Durchsetzung | Werkzeuge | **Validator**: `licensed` ohne `license`/`version`/`retrievedAt` ist ein **Fehler** (`validate.ts:141-151`) |
| Nutzerkommunikation | LICENSE/NOTICE | UI-Label (der Repo-Weg: `provenanceTrust(...)` + Scope-Anzeige) |

Was daraus folgt:

- `LICENSE`/`README` müssen ausdrücklich sagen: **die Lizenz gilt dem Code, nicht
  den Datenpaketen.**
- Der Weg zu OEM-Daten ist im Repo bereits beschrieben und **rechtmäßig**: über
  Art. 61 VO (EU) 2018/858 (verpflichtender Zugang) und Art. 63 (gebührenpflichtig)
  sowie über die **eigene Messung** am eigenen/beauftragten Fahrzeug (ADR 0058,
  `tools/harvest`, `sourceType: "observed"`). Das ist kein Umweg, das ist der
  Business Plan: **lizenzierte Daten sind ein Produkt, keine Beschaffungsfrage.**
- Ein Closed-Pack, das als `sourceType: "licensed"` deklariert wird, muss eine
  echte Lizenzkette haben. Der Validator warnt bereits, wenn `observed` mit
  `license` kombiniert wird („measured, not licensed", `validate.ts:173-179`) —
  dieselbe Ehrlichkeit gilt in die andere Richtung: ein Paket darf nicht
  `licensed` heißen, wenn niemand etwas lizenziert hat.

### 3.3 Kontamination über Abhängigkeiten verhindern

**Der entscheidende Befund: heute ist die Fläche null.** ADR 0002 hält jedes
`dependencies`-Feld auf `@vdp/*` beschränkt (verifiziert: 29 Pakete, kein
Fremdpaket in `dependencies`; nur Dev-Dependencies am Root: Biome, TypeScript,
Vitest, fast-check). Das ist ein **Wettbewerbsvorteil** und muss verteidigt werden.

| Risiko | Heute | Maßnahme |
|---|---|---|
| Laufzeit-Dependency unter Copyleft (GPL/AGPL) | strukturell unmöglich | Verbot bleibt; Erweiterung nur per ADR 0010 (Maintenance + Lizenz + Lockfile) |
| Dev-Dependency unter Copyleft | nur Build-Zeit — aber ihre **Ausgabe** kann einfließen (z.B. eingebettete Templates) | neues Gate `check:licenses` (siehe unten), das auch die **Artefakte** prüft, nicht nur die Paketnamen |
| „Ein kleines Paket mit unklarer Lizenz" | vertraglich verboten | **Sperrliste**: alles außer `MIT`, `Apache-2.0`, `BSD-2-Clause`, `BSD-3-Clause`, `ISC`, `0BSD`, `Unlicense`, `CC0-1.0` braucht einen Eintrag mit Begründung; `GPL-*`, `AGPL-*`, `SSPL`, `BUSL`, `CC-BY-NC-*`, `unknown` sind **Fehler** |
| Transitive Einschleppung | `npm audit` läuft, ein Lizenzblick fehlt | `check:licenses` liest `package-lock.json` (kein Runtime-Dep, **kein** neues Werkzeug von außen — das Repo schreibt solche Prüfer selbst: PDF, ZIP, Dependency-Checker, Manifest-Checker) |
| Fremdcode in generierten Dateien | — | „Änderung kennzeichnen" (Apache §4b) + NOTICE-Pflege bei jeder Übernahme |

**Vorschlag `tools/architecture/check-licenses.mjs`** (gleiche Bauart wie
`check-dependencies.mjs`: EXIT 2 bei unlesbarem Baum, EXIT 1 bei Verstoß,
`--json` für den Test):
Eingabe `package-lock.json` + eine Erlaubnisliste in `architecture.yaml`
(oder `licenses.yaml` mit einer Quelle), Ausgabe Verstöße + `unknown`-Liste.
Dazu **ein Biss-Test** (ADR 0029): ein Fixture mit `GPL-3.0` muss fallen.

### 3.4 Rechte-Konsolidierung: CLA statt DCO — und zwar jetzt

**Befund:** `LICENSE` sagt „Copyright (c) 2026 yes-you-CAN Contributors"; es gibt
**keine** CLA, **keinen** DCO-Hinweis, **kein** `CONTRIBUTING.md`-Kapitel dazu
(geprüft: `grep -rn "CLA\|DCO\|Developer Certificate" CONTRIBUTING.md README.md`
→ keine Treffer). `git log` zeigt im lokalen Klon **einen** Commit (Shallow-Klon,
`--depth`), der letzte gemergte PR ist #47 — die vollständige Autorenliste liegt
nur im entfernten Repository (`git shortlog -sn --all` auf vollem Klon).

**Warum das die kritischste Zeile dieses Dokuments ist:** Dual-Licensing bedeutet,
dass **der Rechteinhaber** dieselbe Software unter einer zweiten (proprietären)
Lizenz anbieten darf. Bei verstreuten Urheberrechten ohne Zustimmung ist das
nicht möglich — Apache-2.0 §5 hilft dabei **nicht** (er lizenziert eingehende
Beiträge unter Apache-2.0, er erlaubt keine Relizenzierung).

| Instrument | Was es leistet | Für Dual-Licensing ausreichend? |
|---|---|---|
| **DCO** (`Signed-off-by`) | Bestätigung: Beitrag ist rechtmäßig unter der Projektlizenz einbringbar | ❌ **Nein** — keine Relizenzierungsbefugnis |
| **CLA** mit Urheberrechts-*Lizenz*gewährung (nicht Abtretung) + Patentgrant + Relizenzierungsklausel | Der Maintainer darf das Werk auch proprietär anbieten; Beitragende behalten ihr Copyright | ✅ **Ja** — empfohlen |
| Copyright Assignment | maximale Klarheit für Investoren/Due-Diligence | ✅, aber abschreckend für Community |

**Vorgehen (billig jetzt, teuer später):**

1. Autorenliste auf vollem Klon erheben (`git shortlog -sn --all`, `git log --format='%an <%ae>'`).
2. CLA einführen (Tool: CLA-Assistant o.ä. als GitHub-App; Text juristisch prüfen
   lassen) + `CONTRIBUTING.md`-Kapitel „Beiträge und Rechte".
3. **Rückwirkende Bestätigung** der vorhandenen Beitragenden einholen — solange
   es wenige sind, ist das ein Nachmittag.
4. Zusätzlich DCO verlangen (Signalwirkung: Herkunft ist bekannt) — schließt
   KI-generierte Beiträge und Fremdcode-Fehler nicht aus, aber macht sie sichtbar.
5. **KI-Beiträge ausdrücklich adressieren.** Dieses Repository ist AI-nativ
   (Commits `arena-ai-coding-agent[bot]`, AGENTS 0.0 als „AI Engineering
   Contract"). Der CLA muss klarstellen, dass eingebrachter KI-generierter Code
   unter denselben Bedingungen eingeht, und der Beitragende erklären muss, dass
   er zu der Verwertung berechtigt ist. (Rechtslage zu Urheberrecht an
   KI-Ausgaben ist uneinheitlich — das ist eine der Fragen für die Juristin,
   siehe Kapitel 5.)

### 3.5 Marke und Vertrieb — der Hebel, der bei Open-Core wirklich zieht

Der Code darf kopiert werden; der **Name** nicht. Apache-2.0 §6 stellt klar, dass
die Lizenz keine Markenrechte gewährt. Daraus folgt der praktische Aufbau:

- `TRADEMARK.md` mit Nutzungsregeln: „Powered by yes-you-CAN" (Drittprodukte
  gegen den offenen Kern) ✅ · „yes-you-CAN Enterprise" für Drittangebote ❌.
- Signatur-/Zertifikatszeichen („verified build", „signed session") nur mit
  ausgestellter Signatur — und die kommt aus §2.3.
- Der Vertrieb verkauft **Aktualität, Support, Daten und Nachweis** — nicht
  „Zugang zu Code, den es offen gibt". Diese Positionierung folgt zwingend aus
  §2.1 („nichts ist unknackbar") und ist die einzige, die dauerhaft hält.

### 3.6 Compliance-Artefakte, die jetzt nachziehen müssen

Das Repo hat bereits eine Konformanz-Ebene; sie ist die richtige Stelle, die neue
Grenze zu dokumentieren (Regel 34.24: im selben PR):

| Artefakt | Was sich ändert |
|---|---|
| `docs/standards/iso-21434-cybersecurity.md` | §1 bekommt die vierte Vertrauensgrenze **„Open ↔ Closed"**; §2 (Angriffsfläche) bekommt Lizenz-/Entitlement-Endpunkte; die TARA-Tabelle erbt die neuen Gefährdungen aus §2.6 (T8/T9 gehören in ein CSMS, nicht in ein Konzeptpapier) |
| `docs/standards/csms.md` | „Supply Chain" erweitert um Lizenzprüfung (`check:licenses`) + Registry-Zugriff + Secret-Scanning; Rollen für Lizenz-/Rechtefragen |
| `SECURITY.md` | Meldeweg für Lizenz-/Crack-Fälle (nicht nur Code-Schwachstellen) |
| `CONTRIBUTING.md` | CLA/DCO + „keine Wettbewerberdaten" + Closed-Scope-Regeln |
| `docs/standards/conformance.md` | neue Zeilen: License-Gate, API-Gate, Registry-Herkunft |
| `AGENTS.md` | neue Regeln (Anhang A) — u.a. das Importverbot und „Closed-Module erhalten keine neue Autorität" |

---

## 4. Konkreter Migrationsplan

Der Plan folgt der Repo-Ordnung: **ein Thema je PR** (AGENTS 0.C.1), ADR im
Template 0043, und — weil er Architektur berührt — YAML + `ARCHITECTURE.md` +
betroffene `README.md` **im selben PR** (Regel 34.24). Jede Phase nennt Aufgabe,
Artefakt und **Gate** (den Nachweis, dass sie fertig ist).

### Phase 0 — Vorbedingung: Recht und Messung (Woche 1, kein Code)

| # | Aufgabe | Artefakt | Gate |
|---|---|---|---|
| 0.1 | Autorenliste + Rechtekette erheben (voller Klon) | `docs/architecture/authorship-audit.md` (intern oder privat) | Liste vollständig, Lücken benannt |
| 0.2 | CLA/DCO-Entscheidung + Text (juristisch geprüft) | `CONTRIBUTING.md`, CLA-Assistent aktiv | Neue PRs verlangen Signatur |
| 0.3 | Lizenzwahl bestätigen (Apache-2.0 Kern / proprietär Module / AGPL Dienst) | `LICENSE`, `NOTICE`, `TRADEMARK.md`, alle 29 `package.json` | `check:manifests` grün; `grep -c '"license": "MIT"'` → 0 im Kern |
| 0.4 | Registry-Zugang einrichten (Scopes, OIDC, 2FA-Pflicht) | Runbook `docs/operations/registry.md` | Trockenlauf: `npm pack` eines Pakets, Publish in ein Test-Scope |
| 0.5 | **Ist-Baseline messen** (Regel 34.21) | `npm run ci` + Coverage-Ausgabe als Referenz im PR | EXIT 0, Zahlen im PR-Body |

> Ohne 0.1–0.3 ist jede weitere Phase eine Investition in eine Struktur, die
> juristisch nicht trägt. Diese Phase ist die einzige, die **vor** dem ersten
> Code-PR abgeschlossen sein muss.

### Phase 1 — Verträge einfrieren (Woche 2–3, 2–3 PRs)

| # | Aufgabe | Artefakt | Gate |
|---|---|---|---|
| **1.1 ✅** | Contract-Pakete markieren (IR, domain-Ports, definitions-Schema, protocols-oem, `AnalysisProvider`, `IntegrityPort`, `SeedKeyAlgorithm`) | `architecture/architecture.yaml` (`contracts`, jeder Vertrag mit `why`; `entry` nur für Modul-Verträge), Zeilen in `ARCHITECTURE.md` („die harten Verträge") | `check:deps` grün; Schemafehler (fehlendes `why`, unbekannter Schlüssel, nicht platziertes Paket) = EXIT 2 |
| **1.2 ✅** | Öffentliche API einfrieren und messen | `tools/architecture/check-api.mjs` + `architecture/public-api.json` | Gate fällt bei Änderung ohne Versionssprung (absichtlich provoziert) |
| 1.3 | Vertragsdokumentation vollständig | `docs/api/*` (ein Eintrag je Naht), `docs/flows/open-core-boundary.md` | Link-Check im Testlauf |
| **1.4 🟡** | Versionierungspolitik | `CONTRIBUTING.md` + ADR-Eintrag | Review |

### Phase 2 — Closed-Kandidaten benennen (Woche 4–5, 1–2 PRs)

| # | Aufgabe | Artefakt | Gate |
|---|---|---|---|
| 2.1 | Kandidaten verschieben: `packages/enterprise/{entitlement,oem-routines,analysis-premium,knowledge-premium,native-core}` als `@vdp/enterprise-*`, weiter `private: true`, **nichts veröffentlichen** | YAML (Layer `enterprise`), Package-READMEs (Purpose / Does NOT do) | `check:deps`: 34+ Pakete platziert, 0 Verstöße |
| 2.2 | Kantenregel: nur `@vdp/runtime` + `@vdp/web` dürfen Enterprise importieren; `layerRules`-Verbot für alle anderen | `architecture.yaml` | **Biss-Test**: temporärer Import in `@vdp/core` → Test rot |
| **2.3 ✅** | Verteilungsregel: öffentlich (`private:false`) darf nicht von privat abhängen | `check-package-manifests.mjs` (neue Regel + Ausgabe), Test | Fixture fällt |
| 2.4 | Autoritäts-Invariante testen: Enterprise-Provider bekommt keinen Schreibpfad (ADR 0038 gilt mit) | `tests/architecture/dependencies.test.ts` erweitert | Test grün, Biss nachgewiesen |
| **2.5 ✅** | `check:licenses` einführen (Sperrliste, Lockfile-basiert) | `tools/architecture/check-licenses.mjs` + `architecture.yaml`-Erlaubnisliste | Fixture mit `GPL-3.0` fällt; realer Baum grün |

### Phase 3 — Auszug in das private Repository (Woche 6–7)

| # | Aufgabe | Artefakt | Gate |
|---|---|---|---|
| 3.1 | Privates Repo anlegen, Historie **neu** beginnen (kein `filter-repo`-Risiko, kein Alt-Historie-Leak); Werkzeuge übernehmen (Biome, `tsc -b`, Vitest), **Contract-Abhängigkeit gepinnt** auf die veröffentlichte Version | Repo + CI-Datei | Build gegen Registry grün |
| 3.2 | Closed-Pakete als **Build-Artefakte** veröffentlichen (`dist` + `.d.ts` + `.node`), Scope `@vdp-enterprise` | `files`-Feld, `publishConfig`, `--provenance` | `npm pack` zeigt **nur** `dist/**`, kein `src`; Gegenprobe: `tar -tf` |
| 3.3 | Öffentlicher Kern veröffentlicht die Contract-Pakete (Version `1.0.0` der Verträge) | Registry-Versionen | `npm view` |
| 3.4 | Öffentlicher Baum: Enterprise-Verzeichnis **entfernt**, Grenze bleibt als Test + Doku | PR | `check:deps`, `npm run ci` EXIT 0; Grep nach `@vdp/enterprise` im öffentlichen Baum → nur Doku/Tests |
| 3.5 | Kombinierter Lauf: Workbench mit installiertem Enterprise-Modul | `docs/operations/local-enterprise-install.md` | `npm run demo` + Panel sichtbar; Log zeigt geladene Lizenz (ohne Schlüssel) |

### Phase 4 — Lizenzierung und Rechte (Woche 8–10)

| # | Aufgabe | Artefakt | Gate |
|---|---|---|---|
| 4.1 | `EntitlementPort` im Core (Vertrag), Implementierung im privaten Modul | Core-PR + privates Repo | Offline-Verifikation im Test: gültig/abgelaufen/gefälscht/andere Maschine |
| 4.2 | Lizenzausstellung (Aussteller-Schlüssel im HSM, `keyId`-Fingerprint wie `manifestKeyId`) | privater Dienst + Runbook | Testvektoren: Signatur, Rotation, Widerruf |
| 4.3 | Entitlement → `DiagnosticCapability` → UI-Aktionen | `@vdp/web` + Runtime | UI zeigt ohne Lizenz keine Premium-Aktion; **Schreibpfad unverändert** (Test) |
| 4.4 | Uhr-/Kopiermanipulation | monotoner Zähler, Lease, Grace Period | Test: Uhr zurücksetzen verlängert nicht; zweite Maschine abgelehnt |
| 4.5 | Nutzungs-/Missbrauchs-Sichtbarkeit (opt-in, DSGVO-konform) | `SECURITY.md`-Ergänzung + Datenschutzhinweis | Opt-out getestet |

### Phase 5 — Serverseite Schutzschicht (Woche 10–14)

| # | Aufgabe | Artefakt | Gate |
|---|---|---|---|
| 5.1 | Cloud-Instanz des Workbench-Servers als Dienst (gleiche Baseline: Token, TLS, Rate-Limit — ADR 0009/0051/0054) | Deployment + Runbook | Lasttest + Sicherheitsreview |
| 5.2 | Entitlement-Prüfung serverseitig, Mandanten-Scope, kurzlebige Tokens | Dienst | Test: Anfrage ohne Recht → 403, **ohne** Feature-Enumeration |
| 5.3 | Datenpakete: Auslieferung verschlüsselt, Schlüssel je Kunde, Rotation, Wasserzeichen | Dienst + Vertrag | Extraktionstest dokumentiert **Restrisiko** (§2.6 T7) |
| 5.4 | Signatur/Attestierung für Premium-Artefakte (Basis: vorhandene ed25519-Mechanik) | Dienst + Verifizierer im Core | Golden-Test: manipulierter Report fällt durch |

### Phase 6 — Betrieb und Härtung (fortlaufend)

| # | Aufgabe | Gate |
|---|---|---|
| 6.1 | Natives Modul härten: `strip`, Symbolschutz, keine Debug-Symbole, Crash-Symbolik dokumentiert | `readelf`/`nm`-Beleg im PR |
| 6.2 | Rust-Kern aus 0.E E25 abarbeiten, **bevor** er Closed-Logik trägt (Permit-Fix, Tests, Vektor-Kopplung) | `cargo test` + Vektorlauf — **braucht eine Toolchain-Umgebung** (heute fehlt `cargo`, ADR 0053 §4) |
| 6.3 | Registry-Härtung: OIDC, 2FA, Secret-Scanning, Publish-Allowlist | Trockenlauf + Review |
| 6.4 | TARA/CSMS nachziehen (T8/T9), Rollen benennen | Review mit dem/der Sicherheitsverantwortlichen |
| 6.5 | Jährlicher Rechte-Audit (CLA-Status, NOTICE, Datenlizenzen) | Bericht |

### 4.7 Risiken und Abbruchbedingungen (was den Plan kippt)

| Risiko | Frühwarnzeichen | Gegenmaßnahme / Abbruch |
|---|---|---|
| **CI-Workflow-Rechte fehlen** (0.E E10: `.github/workflows/*` nicht pushbar, „refusing to allow a GitHub App to create or update workflow") | Der gehärtete Workflow landet nicht | **Der öffentliche Baum muss ohne Secrets auskommen**: `npm run ci` ist das Tor (AGENTS 35). Alle Registry-/Publish-Schritte gehören in eine **eigene** Pipeline, nicht in `ci.yml`. |
| Contract-Drift zwischen den Repos | Closed-Build bricht ohne Erklärung | API-Gate (§1.3) + gepinnte Verträge + „Closed kompiliert gegen veröffentlicht, nicht gegen lokal" |
| Lizenzwechsel kostet mehr als gedacht (fehlende Zusagen) | Autoren antworten nicht | Phase 0 nicht überspringen; notfalls betroffene Dateien neu schreiben (Clean Room), statt zu hoffen |
| Schutzaufwand frisst Produktbudget | Wochen ohne Feature-Fortschritt | Leiter §2.4 nach Nutzen: Server > nativ+`strip` > Lizenz > TPM > Dongle/Anti-Debug |
| Closed-Modul wird zum Sicherheitsrisiko (ungetesteter Rust-Crate, Obfuskation ohne Crash-Symbolik) | Support kann Fehler nicht deuten | 0.E E25 abarbeiten; Closed-Module brauchen **dieselben** Teststandards wie der Kern (Definition of Done, AGENTS 35) |
| Die Community nimmt die Grenze als Verrat wahr | Diskussionen „das war mal offen" | Grenze offen dokumentieren (dieses Dokument), Begründung je Baustein (§1.1), **nichts zurücknehmen, was schon veröffentlicht war** — Rücknahme ist der einzige unverzeihliche Schritt |

### 4.8 Definition of Done je Phase (Kurzform)

```text
Phase 0: Rechte geklärt · Lizenzen entschieden · Registry trockenprojekt
Phase 1: Verträge markiert und gemessen · API-Gate fällt bei Drift
Phase 2: Enterprise-Pakete im Baum · Kanten- und Verteilungsregel mit Biss-Test
Phase 3: Closed-Quelle im privaten Repo · öffentlicher Baum ohne sie · Kombilauf grün
Phase 4: Lizenz offline verifizierbar · Capabilities gekoppelt · Safety unverändert
Phase 5: Dienst-autoritative Entscheidung · Daten verschlüsselt ausgeliefert
Phase 6: Native Härtung belegt · TARA/CSMS nachgezogen · Audit-Termin
Jede Phase zusätzlich: ADR (Template 0043) · YAML + ARCHITECTURE.md + README je
betroffenes Paket im selben PR (Regel 34.24) · npm run ci EXIT 0 ·
Verifikationsbeleg im PR-Body (Regel 34.21) · ein Thema je PR (AGENTS 0.C.1)
```

---

## 5. Offene Entscheidungen (mit Empfehlung)

| # | Entscheidung | Optionen | Empfehlung | Wer | Frist |
|---|---|---|---|---|---|
| E1 | **Lizenz des Kerns** | MIT behalten · Apache-2.0 · AGPL-3.0 | **Apache-2.0** (§3.1) — **vor** der ersten Veröffentlichung | Inhaber + Juristin | Phase 0 |
| E2 | **Rechte-Instrument** | DCO · CLA (Lizenzgewährung) · Assignment | **CLA** + DCO als Signal | Inhaber + Juristin | Phase 0 |
| E3 | **Repo-Topologie** | A/B/C/D (§1.4) | **C** mit Übergang **C1** | Technik | Phase 2/3 |
| E4 | **Registry** | GitHub Packages · Verdaccio | GitHub Packages zuerst, Verdaccio ab Offline-Kunde | Technik | Phase 3 |
| E5 | **Umfang „closed"** | nur Daten · Daten+Provider · Daten+Provider+native | **Daten + Premium-Provider + OEM-Routinen**; Sicherheits- und Schreibpfad bleiben offen (§0.3) | Inhaber | Phase 2 |
| E6 | **Offline-Anforderung an Lizenzen** | Lease 30/90 Tage · ewige Lizenz · online-pflichtig | **Lease + Grace**, online-pflichtig nur für Cloud-Features | Vertrieb + Technik | Phase 4 |
| E7 | **Obfuskation/Dongle** | voll · teilweise · keins | **keins im JS**, optional in nativen Modulen, Dongle nur mit OEM-Volumen | Technik | Phase 6 |
| E8 | **Telemetrie** | aus · opt-in · opt-out | **opt-in**, ausschließlich Lizenz-/Fehlerdaten (§2.7) | Inhaber + Datenschutz | Phase 4/5 |

---

## Anhang A — Was dieses Konzept an Regeln hinzufügt

Vorschlag für die neuen Regeln (Aufnahme in AGENTS 34 + `AGENTS.md`-Abschnitt 0.0
nach Abnahme; Formulierungen im Repo-Stil):

1. **`@vdp/enterprise-*` ist geschlossen.** Kein öffentliches Paket importiert es.
   Ausnahme: `@vdp/runtime` und `@vdp/web` als Composition Roots.
2. **Ein Closed-Modul implementiert einen offenen Vertrag und bekommt keine neue
   Autorität.** Kein `WritePort`, kein Bus, kein Steuergerät, keine
   Schreibfähigkeit für die Analyse (fortgesetzt aus ADR 0038).
3. **Kein Enterprise-Code in `apps/web/public/**`.** Was im Browser läuft, ist
   veröffentlicht.
4. **Ein veröffentlichtes Paket darf nicht von einem privaten abhängen.**
5. **Neue Fremdabhängigkeit nur mit Lizenzprüfung** (`check:licenses`), Sperrliste
   für Copyleft/source-available; Ausnahmen mit Begründung und Ablaufdatum.
6. **Lizenz ist kein Safety-Override.** `SafetyManager` bleibt die Instanz;
   Capabilities steuern die UI, nicht die Zulässigkeit (ADR 0032/0033).
7. **Kein Umgehen von Hersteller-Schutzmechanismen — auch nicht in bezahlten
   Modulen** (AGENTS 26/34.12, verschärft statt gelockert).
8. **Daten haben ihre eigene Lizenz.** `LICENSE` gilt dem Code;
   Datenpakete tragen ihre Lizenz im `provenance`-Feld (Validator erzwingt sie
   bereits für `licensed`).
9. **Obfuskation und Anti-Debugging dürfen die Diagnostizierbarkeit nicht
   zerstören** (Regel 34.25, AGENTS 33): laut statt still, mit Crash-Symbolik,
   nie im Schreib-/Sicherheitspfad.

## Anhang B — ADR-Entwurf (Nummer bei Abnahme: **0059**, die nächste freie nach 0058/`0044`-Lücke)

```markdown
# ADR 59 — Open-Core und Dual-Licensing: Vertrag offen, Implementierung getrennt

- Status: vorgeschlagen (2026-09-23)
- Kontext: ADR 0002 (keine Laufzeit-Abhängigkeiten), ADR 0009 (Security-Baseline),
  ADR 0029 (Guardrails, die beißen), ADR 0031/0042/0043 (eine Quelle, Werkzeug
  statt Regel-Kopie), ADR 0032 (Schreibpfad), ADR 0038 (Analyse liest Belege),
  ADR 0047/0057 (Integrität/Signatur), AGENTS 24, 26, 34.12, 34.24, 35
- Betrifft: `architecture/architecture.yaml`, `ARCHITECTURE.md`, `LICENSE`,
  `NOTICE`, `TRADEMARK.md`, `CONTRIBUTING.md`, alle `package.json` (Feld
  `license`), neue Pakete `@vdp/enterprise-*`, `tools/architecture/*`
  (`check-api.mjs`, `check-licenses.mjs`, Erweiterung `check-package-manifests.mjs`),
  `tests/architecture/*`, `docs/architecture/open-core-dual-licensing.md`,
  `docs/standards/*`, `AGENTS.md`

## Problem
Der Kern ist vollständig MIT und vollständig privat — es gibt weder eine
Veröffentlichung noch eine Grenze zwischen dem, was geteilt werden soll, und dem,
was den Wert trägt. Ein nachträglicher Split ohne eingefrorene Verträge erzeugt
zwei driftende Wahrheiten; ohne Rechte-Konsolidierung ist Dual-Licensing
rechtlich nicht möglich.

## Entscheidung
1. Der **Vertrag ist offen** (IR, Ports, Definitions-Schema, SPIs), die
   **Implementierung** kann geschlossen sein und wird ausschließlich am
   Composition Root injiziert.
2. **Zwei Veröffentlichungsdomänen** (`@vdp/*` offen, `@vdp-enterprise-*` privat
   über Build-Artefakte in einer privaten Registry).
3. **Schutz durch Wertverteilung**: Server für Entitlement/Daten/Modell,
   native Module mit Lizenzbindung für lokal notwendige Logik, Obfuskation nur
   als Zusatz.
4. **Apache-2.0** für den offenen Kern, proprietär für Module und Daten.
5. Die Grenze wird **erzwungen**: YAML-Kantenregel, Verteilungsregel im
   Manifest-Gate, API-Gate, Lizenz-Gate — jedes mit Biss-Test.

## Forbidden implementations
- Closed-Logik in `apps/web/public/**` oder in einem offenen Paket.
- Ein öffentliches Paket, das von einem privaten abhängt.
- Ein Closed-Modul mit Schreib-/Sicherheitsautorität oder als Ersatz für
  `WritePort`/`SafetyManager`.
- Copyleft-Abhängigkeit ohne Eintrag; „nur ein kleines Paket".
- Umgehung von SFD/Security Access in einem bezahlten Modul (AGENTS 26/34.12).
- Anti-Debugging, das Fehler verschluckt (Regel 34.25).

## Migration
Phasen 0–6 (siehe `docs/architecture/open-core-dual-licensing.md` §4):
Rechte → Verträge → Kandidaten → Auszug → Lizenzierung → Server → Betrieb.

## Tests
Kantenregel + Biss · Verteilungsregel + Fixture · API-Gate (Drift rot) ·
Lizenz-Gate (GPL-Fixture rot) · Autoritätsinvariante (Enterprise-Provider ohne
Schreibpfad) · Offline-Lizenzvektoren (gültig/abgelaufen/gefälscht/fremde
Maschine) · UI zeigt ohne Entitlement keine Premium-Aktion, Schreibpfad
unverändert.

## AI implementation notes
- Vor jeder Änderung an der Grenze: `architecture.yaml` lesen, dann die
  betroffene Package-README („Does NOT do").
- Ein neues Enterprise-Paket ist **kein** neuer Layer ohne ADR; die Layer-Liste
  ist Teil der Regel, nicht des Geschmacks.
- Nie einen Vertrag ändern, um ein Closed-Modul passend zu machen — der Vertrag
  wird versioniert und das Closed-Modul zieht nach.
```

## Anhang C — Belege im Repository (Stand 2026-09-23)

| Aussage | Beleg |
|---|---|
| 29 Pakete, 92 Kanten, 6 Regeln, 0 Verstöße | `node tools/architecture/check-dependencies.mjs` (Ausgabe: `dependency rule: 29 packages placed, 92 edges, 6 rules` / `no violations.`, EXIT 0, Node v22.22.3) |
| Alle Pakete `private: true`, MIT, 0.1.0 | Schleife über `packages/**/package.json`, `tools/*`, `apps/*` |
| Keine Fremd-Laufzeitabhängigkeit | ADR 0002; jedes `dependencies`-Feld enthält nur `@vdp/*` (z.B. `packages/core/package.json`) |
| Seed&Key-Verweigerung als Default | `packages/protocols/uds/src/security.ts:38` (`refuseAllSecurityAccess`), `xorSeedKeyAlgorithm` nur „test/simulator only" (`:54`) |
| OEM-Hooks als Erweiterungspunkt | `packages/protocols/oem/src/index.ts`, `README.md`; Injektion `createDiagnosticRuntime({ oemProtocols })` |
| Definierte Nähte (Ports) | `packages/domain/src/ports/*`, `packages/ai/src/types.ts`, `packages/core/src/logging/integrity.ts` |
| Provider-Injektion + VIN-Redaktion + pinnbarer HTTP-Client | `packages/ai/src/service.ts`, `packages/ai/src/http.ts` |
| AI ohne Schreibfähigkeit | ADR 0038; Kopfdoku `packages/ai/src/types.ts` |
| ed25519-Signatur, prozessflüchtig | `packages/storage/src/manifest-signer.ts` (ADR 0057) |
| Integritäts-Seam | `packages/core/src/logging/integrity.ts` (`IntegrityPort`), `packages/storage/src/integrity.ts` |
| Rust-Crate mit Release-Härtung | `crates/yes_you_can_core/Cargo.toml`; Befunde: AGENTS 0.E E25 |
| Provenance erzwingt Lizenzangaben | `packages/definitions/src/schema.ts:357`, `validate.ts:141-179` |
| Bestehende Vertrauensgrenzen/TARA | `docs/standards/iso-21434-cybersecurity.md` §1–§4 |
| Werkzeuge und ihre Bauart (EXIT 2 bei unlesbarem Baum, `--json`) | `tools/architecture/check-dependencies.mjs`, `check-package-manifests.mjs` |
| ADR-Pflichtstruktur ab 0043 | `docs/adr/README.md` |
| Workflow-Rechte als bekannte Grenze | AGENTS 0.E E10/E20 |
| Rechtlicher Rahmen OEM-Daten (Art. 61/63 VO (EU) 2018/858, EuGH C-319/22, OLG Köln 6 U 58/24) | AGENTS 1.46 (Changelog-Eintrag zu ADR 0058), `tools/harvest/README.md` |
