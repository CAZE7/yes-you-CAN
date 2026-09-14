# ADR 38 — Evidenz statt Bauchgefühl: die Evidence Engine ist der einzige Input der Analyse

- Status: akzeptiert (2026-09-14)
- Kontext: ADR 0034/0037 (Diagnostic IR), AGENTS 22 (KI ohne Scheinsicherheit), AGENTS 24 (Herkunft), AGENTS 25/26 (Schreibkette), Master-Backlog P0 #39/#40/#41/#42, Roadmap-Schritt 16 (Geführte Diagnose)
- Betrifft: `packages/diagnostic-ir/src/{evidence,window,index}.ts`, `packages/core/src/evidence/{collect,hypotheses}.ts`, `packages/core/src/dtc/scanner.ts`, `packages/core/src/session/observation.ts`, `packages/runtime/{src/evidence-service.ts,src/runtime.ts,src/index.ts,src/version.ts}`, `packages/ai/{src/types.ts,src/prompt.ts,src/provenance.ts,src/heuristic.ts,src/http.ts}`, `apps/web/{src/analysis-input.ts,src/backend.ts,public/app.js}`, `tools/architecture/dependency-rules.json`, `tests/architecture/{guardrails,manifests,dependencies}.test.ts`

## Problem

Die Analyse-Kette war: `backend.analyze()` baut aus Views und Statistik ein
`AnalysisInput`, ein Provider antwortet, die UI zeigt Befunde. Vier Fragen bleiben
offen:

1. **Worauf eine Antwort sich stützt.** `AnalysisFinding` hatte `relatedDtcs` und
   `relatedSignals` (Namen), aber keine Belege. Die Frage „warum das?" war nicht
   beantwortbar, und ein Bericht konnte die Antwort nicht abnehmen, ohne die Sitzung
   selbst durchzulesen.
2. **Welche Fassung geantwortet hat.** Das Ergebnis nannte `provider`, `model`,
   `source`, `generatedAt` — aber nicht Prompt-Fassung, Plattform-Version oder
   Definitionspaket. Dieselbe Sitzung, zwei Wochen später analysiert, konnte anders
   antworten, und niemand konnte sagen, warum.
3. **Ein Parallelmodell.** `apps/web/src/analysis-input.ts` deklarierte
   `AnalysisDtcSource` als strukturelle Kopie von `DtcView` (Zyklus-vermeidend, aber
   eine zweite Form), und der Provider-Vertrag kannte weder ECU-Beobachtung noch
   Anreicherung — nur die Sicht, die jemand für den Bildschirm gebaut hatte.
4. **Muster, die niemand prüft.** Seit ADR 0025 dokumentieren die Pakete `patterns[]`
   mit `checks[]` (`min`/`max`/`windowMs`) — Roadmap-Schritt 16 nennt das „messen →
   Fenster bewerten → Ergebnis je Muster". Bewertet wurde nichts: die Zahlen standen
   als Text in der Workbench.

## Entscheidung

1. **Vokabular in die IR, Assembly in `core`.** `diagnostic-ir/src/evidence.ts`
   definiert `EvidenceItem`, `EvidenceSet`, `EvidenceConflict`, `Hypothesis`,
   `HypothesisCheck` — reine Daten mit den Vokabeln von ADR 0034 (`Evidence`,
   `MeasurementWindow`). `core/src/evidence/collect.ts` füllt sie aus der Sitzung
   (Scan, Statistik, Anomalien, Bestimmung, `sessionGapsOf`) und erfindet nichts:
   **jedes Item ist eine Aussage, die die Sitzung schon getätigt hat.** Eine offene
   Frage ist ein Item (`gap`, unproven), kein fehlender Eintrag.

2. **Belege sind Adressen.** `evidenceItemId(kind, subject, ecuId?)` erzeugt stabile
   Schlüssel (`dtc:P0420@engine`); ein Befund zitiert sie in `basedOn`, das Ergebnis
   listet die Menge in `provenance.evidence`. Eine Zitat-Id, die das Set nicht
   enthält, wird verworfen — auch wenn ein externes Gateway sie liefert
   (`knownCitations`): **ein Zitat ist ein Nachschlagebefehl, kein Schmuck.**

3. **Widersprüche bleiben stehen.** `conflictsOf` meldet den Fall, dass ein Code im
   Fehlerspeicher undokumentiert ist, die Variante aber ein Muster dafür beschreibt —
   mit beiden Item-Ids. Eine Seite verlieren wäre der Wissensverlust, den ADR 0033
   verbietet.

4. **Ein Feld, das Raten ersetzt.** `EnrichedDtc` trägt neben der Textzeile `evidence`
   jetzt `enrichmentEvidence?: Evidence` — das IR-Objekt selbst; der Collector hängt es
   an das `dtc`-Item, die UI bleibt bei der Zeile. Ohne dieses Feld hätte der Collector
   entscheiden müssen, ob eine Beschreibung belegt ist, indem er den **Wortlaut der
   Zeile liest** — eine zweite Deutung derselben Aussage, genau das, was P0 #1
   ausschließt. Ein Record ohne Beleg-Objekt ist damit *unproven mit Grund*, nicht
   „vermutlich in Ordnung". (Gefunden beim Nachmessen des eigenen Collector-Zweigs:
   der erste Entwurf markierte jedes Record mit Textzeile als proven — also auch jedes
   undokumentierte.)

5. **Hypothesen werden gerechnet.** `core/src/evidence/hypotheses.ts` bewertet jeden
   dokumentierten Check gegen die Messwerte im dokumentierten Fenster — mit
   `summariseWindow`, der **einen** Fensterrechnung der IR, die `measurementWindow`
   jetzt trägt (statt sie zu duplizieren). Urteil je Check, das Musterurteil ist der
   schlechteste Fall, eine leere Check-Liste ist `untested` (nicht: `every` auf leer
   = confirmed). `confidenceOf` steht offen im Code (`prior ± Beleglast`, Deckel 0,9),
   denn eine Zahl, die niemand nachrechnen kann, ist eine Blackbox mit Dialogfeld
   (AGENTS 22/36).

6. **Die Analyse liest nur die IR.** `@vdp/ai` darf `@vdp/diagnostic-ir` importieren
   und sonst nichts Neues: kein `core`, kein `runtime`, keine Transporte — die
   maschinelle Form von „eine KI ruft nie `CAN.write()`/`UDS.send()`". Ein neuer
   Guardrail-Test rechnet die Transitivhülle **aus `dependency-rules.json`** und fällt,
   sobald ein Lese-Layer Schreibfähigkeit erreicht; abgeleitet aus der einen
   Regelquelle statt als zweite Liste nachgeschrieben (ADR 0031). `@vdp/web` darf die
   IR lesen, um Belege an den Provider zu übergeben, statt sie nachzubauen.

7. **Die Fassung der Antwort ist Teil der Antwort.** `ANALYSIS_PROMPT_VERSION` lebt in
   `packages/ai/src/prompt.ts` **und steht im Prompttext selbst**
   (`analysisInstruction()`), damit eine gespeicherte Antwort und der Text, der sie
   erzeugte, nicht unbemerkt auseinanderlaufen. `PLATFORM_VERSION` (`@vdp/runtime`)
   wird von `tests/architecture/manifests.test.ts` gegen die Workspace-Version geprüft —
   kein Build-Stempel im Haus, also die ehrliche Untergrenze. `definitionVersion` und
   `packageVersions` kommen aus der Sitzung. **Versionen stammen aus der Anfrage, nie
   aus der Antwort:** Ein Gateway, das seine eigene Prompt-Fassung meldet, macht eine
   Aussage, keine Tatsache.

8. **Geführte Diagnose fängt unten an.** `nextTest` ist der erste noch *nicht
   entschiedene* Check — ein widerlegter ist beantwortet und wird nicht nochmal
   angemeldet. Die Workbench zeigt „next test for …" als Empfehlung; der interaktive
   Ablauf (Messen → Fenster schließen → nächster Schritt) bleibt Backlog #40.

## Konsequenzen

- `apps/web/src/analysis-input.ts` hat jetzt die eine Assemblage (`buildAnalysisInput`);
  `backend.analyze()` schrumpft von 35 auf 30 Zeilen und enthält keine Mapping-Logik
  mehr. Die Datei bleibt auf der E15-Ausnahmeliste, wächst aber nicht weiter.
- Der Demo-Pfad antwortet anders: Confidence **0,4 → 0,3**, weil das
  Simulationsfahrzeug ein undokumentiertes C1234 enthält und eine Aussage ohne Quelle
  jetzt deckelt. Der gepinnte Test in `apps/web/test/server.spec.ts` ist angepasst und
  begründet; der Wert ist niedriger, weil die Antwort ehrlicher ist, nicht weil das
  Auto ein anderes ist.
- Offene Fragen und unbelegte Aussagen sind zwei verschiedene Dinge: Ersteres wird
  gewarnt, **zweitens deckelt** — sonst deckelt jede Sitzung sich selbst, weil jede
  mindestens eine offene Frage hat. Das ist ADR 0033 in der Analyseschicht.
- Drei neue erlaubte Kanten auf die IR (`reports`, `web`, `ai`), 79 Kanten, keine
  Verletzung; der Struktur-Snapshot in `dependencies.test.ts` ist mitgezogen (er
  zwingt genau hier zum Hinsehen).
- Kein Schema-Bump, keine Migration: `enrichmentEvidence` ist additiv optional auf
  einem `Partial<…>`-Record; eine Analyse ignoriert ein fehlendes Feld sichtbar.

## Messung

- `npm run ci` grün; `npm test` **114 Dateien / 1717 Tests**; Coverage global
  **94,64 / 87,58 / 96,51 / 95,92** (vorher 94,49 / 87,22 / 96,31 / 95,83).
- Per File (Statements / Zweige): `evidence/collect.ts` 97,18 / 85,52 ·
  `evidence/hypotheses.ts` 95,23 / 84,31 · IR `evidence.ts` 100 / 100 · IR
  `window.ts` 100 / 100 · `ai/provenance.ts` 100 / 100 · `ai/prompt.ts` 100 / 100 ·
  `ai/heuristic.ts` 100 / 88,02 · `runtime/evidence-service.ts` 100 / 100.
- Tests: +44 gegenüber Schritt 1 — `core/src/evidence/evidence.spec.ts` 22 (neu),
  `packages/ai/src/ai.spec.ts` 36 → 43, `apps/web/test/analysis-input.spec.ts` 10 → 15,
  `runtime/src/evidence-service.spec.ts` 2 (neu), `diagnostic-ir.spec.ts` 22 → 26,
  `tests/integration/full-stack.test.ts` 20 → 21, `guardrails.test.ts` 7 → 8,
  `manifests.test.ts` 6 → 8. Ein bestehender Test (`server.spec.ts`, Demo-Analyse) ist
  bewusst angepasst, nicht umgeschrieben: andere Zahl, gleiche Aussage.
- Ende-zu-Ende im Demo: `analysis.provenance` = `prompt 2026-09-14.1 · 0.1.0 ·
  simulator@1.0.0 · n Belege`, Befunde mit `basedOn: ["dtc:P0420@…"]`, Empfehlungen
  mit „next test for …" — gemessen an der laufenden Demo-Sitzung, nicht am Fixture.
