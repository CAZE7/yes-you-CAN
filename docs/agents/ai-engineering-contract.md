# Teil 0 · 0.0 AI Engineering Contract (verbindlich, ADR 0043)

> **Aus `AGENTS.md` verschoben** (2026-09-22, AGENTS 2.0 — die Wurzel-Datei ist der
> Einstieg, die Volltexte liegen hier). Lesereihenfolge, vorbereitete Kontext-Pakete und die Pflicht, Doku und Stand zusammen zu ändern.
> Dieser Kasten ist neu; alles darunter ist **wortgleich** der Stand aus
> `AGENTS.md` 1.44. Abschnitts- und Regelnummern bleiben gültig: `AGENTS 34.12`
> ist §34.12 in [`rules.md`](rules.md), `AGENTS 0.E E15` ist E15 in
> [`backlog.md`](backlog.md).

## 0.0 AI Engineering Contract (verbindlich, ADR 0043)

Dieses Repository ist ein **AI-natives Repository** gebaut: die Architektur
steht einmal, maschinenlesbar, in [`architecture/architecture.yaml`](../../architecture/architecture.yaml)
(Layer, `mayImport`-Kanten, AI-Context-Topics), und die Doku-Ebene
([`ARCHITECTURE.md`](../../ARCHITECTURE.md), Package-READMEs, `docs/code-map.md`,
`docs/glossary.md`, `docs/api/*`, `docs/flows/*`, [`.ai/`](../../.ai/README.md))
verweist darauf — keine zweite Regel-Kopie existiert, eine zweite Kopie ist
ein Defekt (ADR 0031/0042/0043).

**Vor jeder Codeänderung — in dieser Reihenfolge:**

1. Lies `architecture/architecture.yaml` → Layer + `mayImport` deines Pakets.
2. Lies die Package-`README.md` des Ziel-Pakets (v. a. „Does NOT do“).
3. Identifiziere die architektonische Grenze, die du berührst (siehe
   [`ARCHITECTURE.md` → „Die harten Verträge“](../../ARCHITECTURE.md)).
4. Finde die **bestehende** Abstraktion (Code-Map-Zeile, dann `docs/api/*`).
5. Erstelle **keine** doppelte Abstraktion — eine zweite Kopie einer
   Vokabel/Regel/Logik ist ein Review-Defekt.
6. Führe die relevanten Tests aus (`npm run test:unit` als Mindestschleife,
   dazu die Projekt-Suite der betroffenen Ebene).
7. Führe `npm run check:deps` **und** `npm run check:manifests` aus — beides
   ist Teil von `npm run ci` und fällt bei einer Regelverletzung.
8. Bei Architektur-/Toolchain-Änderung: ADR im neuen Template (ADR 0043,
   inkl. *Affected packages* / *Forbidden implementations* / *AI
   implementation notes*) — und im selben PR: YAML + ARCHITECTURE.md +
   betroffene READMEs (Regel 34.24).

**Verboten (jeder Punkt bricht ein Review):**

- WritePort umgehen: ein Write nur als `WriteOperation` hinter
  `WritePort`/`SafetyManager` (ADR 0032, AGENTS 26).
- Direkter Transport-/Bus-Zugriff aus der UI (Regel 34.4) — die UI spricht
  über Runtime + Command Bus.
- Private Implementation-Casts: z. B. in interne `UdsServer`-Maps
  (ADR 0041), in `DiagnosticEngine`-Innereien aus dem Runtime heraus
  (ADR 0014), in Simulator-Felder aus Tests (ADR 0040).
- Neue Dependency ohne Begründung und ADR-Notiz (ADR 0002/0010, Regel
  34.20) — gilt auch für Dev-Dependencies und Parser-Bibliotheken.
- Duplicierte Protokoll-Logik: eine UDS-/DTC-Status-/Dekodierungs-Stelle
  (Glossar „Verbotene Doppelnamen“; `decodeDtcStatus` ist *die* Stelle).
- Evidenz neu bauen außerhalb `collectEvidence`/`EvidenceService`
  (ADR 0038) — UI/Report/AI *zitieren* Item-Ids, sie sammeln nicht.
- `mayImport` erweitern, um „eine kleine Abhängigkeit“ zu erlauben: das ist
  eine Architekturentscheidung — ADR + YAML, nicht nur YAML (Regel 34.15).

**Für Themen statt Baumsuchen:** `npm run ai:context uds|transport|
diagnostic-ir|dtc|simulator|ai` erzeugt das passende Kontext-Bundle
(Architektur-Regeln, Pakete, Public APIs, ADRs, Flows, Beispiele) — oder
lies das kuratierte Paket unter [`.ai/`](../../.ai/README.md).

