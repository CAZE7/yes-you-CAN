# AGENTS.md — Vehicle Diagnostics Platform

> **Version:** 2.0 · **Letzte Änderung:** 2026-09-22
> **Einstieg, nicht Archiv:** fünf Themen, die ein Change nicht brechen darf, und der
> Weg zu den Volltexten. Alles Übrige aus Fassung 1.44 (239 KB) liegt **wortgleich
> verschoben** in [`docs/agents/`](docs/agents/README.md) — nichts gelöscht.
> Nummern bleiben gültig: `AGENTS 34.12` = [`docs/agents/rules.md`](docs/agents/rules.md) §34.12,
> `AGENTS 0.E E15` = [`docs/agents/backlog.md`](docs/agents/backlog.md) E15,
> `AGENTS 11.1` = [`docs/agents/specification-diagnosis.md`](docs/agents/specification-diagnosis.md) §11.1.
> Fassungen 1.0–1.44: [`docs/agents/changelog.md`](docs/agents/changelog.md).
> **Bei Widerspruch zwischen Doku und Repository gilt das Repository** — die Differenz
> wird im selben PR dokumentiert (Regel 34.24).

## 0. Lesereihenfolge

| Frage | Antwort |
|---|---|
| Wie ist das System aufgebaut? | [`ARCHITECTURE.md`](ARCHITECTURE.md) — Schichten, Verträge, Datenflüsse |
| Welche Importe sind erlaubt? | [`architecture/architecture.yaml`](architecture/architecture.yaml) — die **eine** Regel, geprüft von `npm run check:deps` |
| Wo ändere ich für Aufgabe X? | [`docs/code-map.md`](docs/code-map.md) |
| Was heißt dieser Begriff? | [`docs/glossary.md`](docs/glossary.md) — ein Begriff = eine Bedeutung |
| Warum ist es so gebaut? | [`docs/adr/`](docs/adr/README.md) — ADRs, nie gelöscht, nur `superseded` |
| Was existiert wirklich / was ist offen? | [`docs/agents/implementation-status.md`](docs/agents/implementation-status.md) (0.A) · [`docs/agents/backlog.md`](docs/agents/backlog.md) (0.E) |
| Welche Befehle funktionieren? | [`docs/agents/operations.md`](docs/agents/operations.md) (0.B) |
| Volltext der Spezifikation §0–§36 | [`docs/agents/README.md`](docs/agents/README.md) — thematisch in fünf Dateien |
| Norm-Konformanz (ISO 14229/15765/13400/21434/26262) | [`docs/standards/`](docs/standards/README.md) · Branch-Regel: [`docs/maintenance/branch-hygiene.md`](docs/maintenance/branch-hygiene.md) |

## 1. Architekturprinzipien — Layer-Regeln für `packages/*`

Abhängigkeiten zeigen **nur nach unten**; jede Kante ist ein Test
(`tests/architecture/dependencies.test.ts`, ADR 0015/0031). Die Kanten stehen genau
einmal in [`architecture/architecture.yaml`](architecture/architecture.yaml) — diese
Datei ist ein Zeiger, keine zweite Regel. Was ein Paket dort nicht in `mayImport`
nennt, ist verboten.

```text
UI (apps/web) → runtime → application → core → protocols / transport → adapters → Vehicle
                              ↑ domain · diagnostic-ir · definitions (Verträge, keine I/O)
```

- **UI interpretiert keine CAN-Frames** und enthält keine UDS-Logik (Regel 34.4);
  OEM-Logik liegt in `packages/definitions`, nie in der CAN-Schicht.
- **Protokolle sprechen durch eine Link-Seam** (`UdsLink`), nie durch eine `CanBus`
  (ADR 0031). Grund ist die Norm, nicht Geschmack: ISO 14229-2 definiert die
  Sessiondienste transportunabhängig, also muss dieselbe UDS-Logik über CAN
  (ISO 15765-2) und DoIP (ISO 13400) laufen (§2).
- **Lesen und Schreiben sind getrennt.** Alles Lesende (UI, Reports, AI) bekommt
  Beobachtungen mit Beleg aus dem Diagnostic IR (ADR 0034/0037); alles Schreibende läuft
  über `WritePort` + `SafetyManager` (ADR 0032, §26). Fehlende Evidenz ist ein Fehlschlag,
  keine Warnung (ADR 0033). `@vdp/ai` darf `@vdp/core` nicht transitiv erreichen.
- **`raw` und `decoded` bleiben getrennt** (ADR 0004, Regel 34.7): ein Feld trägt
  entweder Bytes oder einen dekodierten Wert, nie beides vermischt.
- **Keine monolithische Diagnoseklasse** (Regel 34.3): neue Funktionalität landet als
  Command/Query/Aktion im `application`-Layer, nicht als Methode der Engine (ADR 0014).
- **Portabilität:** `shared`, `domain`, `application`, `diagnostic-ir`, `definitions`,
  `transport/*`, `protocols/*` kennen keine `node:`-Builtins und keine Laufzeit-Dependencies
  (ADR 0002); Hardware- und Dateizugriff sitzen in `adapters/*` bzw. `storage`.
- **Oberstes Ziel (§36):** Das MVP darf klein sein — die Architektur darf nicht klein
  gedacht sein. Keine CAN-Logger-App, sondern eine erweiterbare Diagnoseplattform.

## 2. Naming-Conventions

- **Pakete** `@vdp/<name>`, Verzeichnisse kebab-case, geschachtelt nach Layer:
  `packages/transport/iso-tp`, `packages/protocols/uds`, `packages/adapters/elm327`.
  Jedes Paket hat eine `README.md` mit *Purpose / Does NOT do / Public API / Invariants*.
- **Dateien** kebab-case, ein Begriff pro Datei: Unit-Tests co-lokatiert
  `src/<name>.spec.ts`, Ebenen-Tests `tests/<ebene>/<thema>.test.ts`, ausführbare Doku
  `tests/examples/*.example.ts` (ADR 0043).
- **Bezeichner**: Typen `PascalCase`, Variablen/Funktionen `camelCase`, Norm-Tabellen
  `SCREAMING_SNAKE_CASE` (`SID`, `NRC`, `DID`, `SESSION`, `FRAME_TYPE`), Boolean-Getter
  `is*`/`has*`. Kein `any`, kein `@ts-ignore`, keine Nicht-Null-Assertion in
  Produktionscode (Hygiene-Gate).
- **Ein Begriff = eine Bedeutung** ([`docs/glossary.md`](docs/glossary.md)): Wer
  `Reading`, `Measurement`, `DiagnosticData` oder `Observation` neu benutzt, ergänzt dort
  den Eintrag — sonst ist es ein zweiter Name für dasselbe.
- **Commits/Branches**: `<scope>: <was>` als Betreff (Begründung und Messung in den
  Body), Branch `<typ>/<kurzthema>` mit `typ ∈ {feat, fix, chore, test, refactor, docs}`.
- **ADRs**: `docs/adr/NNNN-kebab-titel.md`, vierstellig, aufsteigend; eine Nummer wird
  nie wiederverwendet.

## 3. Testpflicht

- **Jede neue Funktion kommt mit Tests** auf der passenden Ebene (§31: unit, integration,
  protocol, simulator, replay, regression). Ungetestet ist nicht fertig (§35).
- **Simulator und Replay statt echtem Fahrzeug** (Regel 34.9, ADR 0005): Hardware-
  Tests liegen ausschließlich in `tests/hardware` (Vitest-Projekt `hardware`, läuft
  in keinem Default-Skript).
- **Jeder gefundene Fehler wird ein Regressionstest mit Symptombeschreibung**
  (`tests/regression/regression.test.ts`) — Symptom, Ursache, Gegenprobe.
- **Determinismus:** keine fixen Sleeps, sondern Bedingungen warten
  (`tests/helpers/wait.ts`, ADR 0019); kein `.only`/`.skip` ohne Grund; `Math.random` nur
  als injizierbarer Default (Hygiene-Gate).
- **Coverage ist ein Gate, kein Bericht:** global 90 % lines / 80 % branches plus
  per-file-Gates, maßgeblich in [`vitest.config.ts`](vitest.config.ts). Erst die Tests,
  dann das Gate anheben (ADR 0017) — nie senken, um rot zu reparieren.
- **`npm test` und `npm run test:coverage` bauen selbst** (Regel 34.26): Die Workbench-
  Tests beziehen den Chart-Kern aus `dist` über `/lib`. Ein Lauf ohne `dist` ist kein Beleg.
- **Messung vor Behauptung** (Regel 34.21): „alle Tests grün“ steht nur mit Ausgabe eines
  tatsächlichen Laufs im Commit oder PR. Lokal ein Tor: `npm run ci` (Build + Typecheck +
  Biome + Architektur-Gates + Suite).

## 4. Security-Regel für Seed&Key

**Keine Umgehung von Hersteller-Schutzmechanismen — niemals** (Regel 34.12, §25):
kein SFD/SFD2, kein Seed&Key-Algorithmus eines Herstellers, kein Zertifikats- oder
Security-Gateway-Bypass. Das gilt fürs Implementieren, fürs Hinzufügen fremder
Algorithmen und fürs Konfigurieren.

- Die **einzige** Stelle dafür ist [`packages/protocols/uds/src/security.ts`](packages/protocols/uds/src/security.ts):
  Default ist `refuseAllSecurityAccess` — verweigert lokal, mit `SecurityAccessRefusedError`,
  und jeder Versuch wird audit-geloggt (Regel 34.10).
- Ein Workshop kann einen Algorithmus **explizit registrieren**, für den er eine
  Berechtigung hat; `SeedKeyAlgorithm` verlangt dafür `id` **und** `provenance` —
  ohne Herkunft kein Algorithmus.
- `xorSeedKeyAlgorithm` ist **Simulator-Material** und bleibt eindeutig markiert
  (`id: "xor-test"`, Provenance „test/simulator only — XOR pattern, not a real manufacturer
  algorithm“). Die Markierung abzuschwächen, ihn umzubenennen oder außerhalb von
  Tests/Simulator zu verwenden, ist dieselbe Regelverletzung wie ein echter Algorithmus.
- SecurityAccess (0x27) ist ein Write-Service: Die Default-Session bietet ihn nicht an
  (NRC 0x7F), und der Client arbeitet daran nicht vorbei (§26, ADR 0018 — Ablehnungen sind
  Daten mit Grund, keine Exceptions).
- Eine Freischaltung gilt **nur in der Session, in der sie stattfand**: Session-Wechsel
  und S3-Rückfall setzen sie zurück (ISO 14229-1 §9.2/§10.2, ISO 14229-2 §7.4).
- Daneben unverändert: **Security-Baseline ADR 0009 nicht absenken** (Regel 34.22 —
  localhost-Default, Security-Header, Body-Limit, GET-only-Stream, API-Token ADR 0051),
  keine Secrets im Code (34.16), keine ungeklärten Konkurrenzdaten (34.17).

## 5. PR-Prozess

1. Kleiner, thematisch reiner Branch von `main` — **ein PR = ein Thema** (Regel 34.23,
   [`CONTRIBUTING.md`](CONTRIBUTING.md)). Nie direkt auf `main` pushen.
2. [`PR-Template`](.github/pull_request_template.md) ausfüllen — es kodiert die
   Definition of Done (§35) und die Leitplanken.
3. CI **muss auf Node 22 und 24 grün sein** — kein Merge auf Rot, kein Umgehen der
   Checks (Regel 34.19, ADR 0009).
4. Doku im **selben** PR nachziehen (Regel 34.24): 0.A-Stand, package-README,
   `ARCHITECTURE.md`, `docs/code-map.md`, Glossar — was der Change berührt.
   Architektur- und Toolchain-Entscheidungen bekommen einen ADR (Regel 34.15).
5. Dependencies: **keine neuen Laufzeit-Dependencies** (ADR 0002); Infrastruktur nur nach
   ADR 0010 mit Maintenance-Nachweis, Lizenz-Check (MIT/Apache-2.0/BSD) und im selben PR
   regeneriertem Lockfile (Regel 34.20).
6. Definition of Done (§35): Implementation + Error Handling + Tests + Logging +
   UI-Anbindung (falls relevant) + Doku + CI grün + Verifikationsbeleg — nicht nur
   „läuft bei mir“.
7. Danach: gemergte Branch löschen, unmerged als `archive/*`-Tag pinnen
   ([`docs/maintenance/branch-hygiene.md`](docs/maintenance/branch-hygiene.md)).
