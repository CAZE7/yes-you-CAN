# Public API: `@vdp/ai` — der Analyse-Provider und was er sehen darf

> Paket: [`packages/ai/`](../../packages/ai/README.md) ·
> Layer: **analysis** (importiert nur `@vdp/shared` + `@vdp/diagnostic-ir`) ·
> ADRs: [0038](../adr/0038-evidence-engine-and-ai-input.md),
> [0056](../adr/0056-the-diagnosis-loop-is-a-state-machine-with-a-machine-readable-diff.md),
> [0059](../adr/0059-contracts-are-frozen-and-measured.md) ·
> Vertrag im Record: `@vdp/ai` (7 Dateien)

Diese Fläche ist der Kandidat für den geschlossenen Teil, der am wenigsten riskant ist:
Der Provider bekommt **Belege** und gibt **Vorschläge** zurück. Er bekommt keinen Bus,
kein Steuergerät, keinen `WritePort` — und das ist keine Konvention, sondern eine
Eigenschaft des Importgraphen, die ein Test nachrechnet.

## Was hier Vertrag ist

**Der Provider selbst.**

```ts
export interface AnalysisProvider {
  readonly id: string;
  readonly label: string;
  /** Providers that send data off-box must say so. */
  readonly sendsDataOffBox: boolean;
  analyze(input: AnalysisInput): Promise<AnalysisResult>;
}
```

**Die Eingabe — `AnalysisInput`.** `signals` (Statistik-Zusammenfassung, keine Rohproben),
`dtcs` (mit `scope`, `conditions`, `measure`, `evidence: { proven, line, itemId }`),
`anomalies`, `notes`, `question`, `evidence` (`EvidenceSet`), `hypotheses`,
`diagnosis` (`GuidedDiagnosisState`), `recordingId`, `scenario`, `versions`. Der
`vehicle`-Block ist **bewusst** frei von VIN und personenbezogenen Daten, außer der
Aufrufer hat zugestimmt — ein HTTP-Provider schickt dieses Objekt von der Box.

**Die Ausgabe — `AnalysisResult`.** `summary`, `findings[]` (jedes mit
`basedOn: string[]` als Evidenz-Item-Ids), `recommendations[]`, `confidence`,
`source: "heuristic" | "model" | "cache"`, `generatedAt`, `warnings[]`, `provenance`
(`promptVersion`, `runtimeVersion`, `definitionVersion?`, `provider`, `model?`,
`evidence[]`, `recordingId?`), `nextTest` (`DiscriminatingTest`) und `diagnosis`
(`GuidedDiagnosisState`).

**Die Regeln, die in den Typen stecken:**

1. **Ein Zitat auf ein Item, das es nicht gibt, wird fallengelassen** — nicht erfunden
   (`basedOn`/`evidence`; ADR 0038).
2. **Ein Provider kann keinen Test erfinden.** `nextTest` referenziert nur, was der Input
   angeboten hat; ein `hypothesisId` außerhalb des Inputs fällt weg (`diagnosis`
   eingeschlossen).
3. **Ohne Belege wird das gesagt.** Fehlt `evidence`, ist die Antwort eine Aussage über
   die Aufzeichnung als Ganzes — und muss das aushalten, nicht kaschieren.
4. **Versionen sind Teil der Antwort** (P0 #42): dieselbe Sitzung kann je nach
   Prompt-/Runtime-/Definitionsfassung anders antworten; `provenance` macht das zitierbar.
5. **Eine Analyse schlägt vor, die Write-Kette entscheidet** (AGENTS 22). Es gibt in
   dieser Fläche keinen Schreibweg — und keinen Typ, der einen beschreibt.
6. **`sendsDataOffBox` ist Verpflichtung, nicht Kosmetik.** Die UI labelt danach
   („generiert von lokaler Regel-Engine“ vs. „generiert von Modell“).

## Die Kanten (maschinell geprüft)

1. **`@vdp/ai` importiert genau `@vdp/shared` + `@vdp/diagnostic-ir`** — die
   Transitiv-Hülle wird in `tests/architecture/guardrails.test.ts` gerechnet; ein
   erreichbarer Schreibpfad lässt den Test fallen. Dieselbe Regel gilt **unverändert** für
   ein geschlossenes Provider-Modul (Konzept §1.2, Regel 4).
2. **Der Input ist die ganze Faktenlage.** Ein Provider, der mehr „weiß“ (eigene
   Session-Datei, eigener Bus), hat eine zweite Kopie der Belege — ein Defekt.
3. **Die Fläche ist eingefroren** (7 Dateien, `npm run check:api`). Der Umzug eines
   Premium-Providers in ein privates Repo erscheint damit als *sichtbare* Drift — die
   Entscheidung, nicht der Unfall.

## Häufige Fehler

- **Eine Konfidenz erfinden.** `Hypothesis.confidence` ist die veröffentlichte Heuristik
  aus `@vdp/core`; ein Gateway mit eigenen Zahlen bricht den Kontrakt.
- **Rohproben statt Zusammenfassungen schicken.** `AnalysisSignalSummary` existiert, damit
  ein Modell nicht die Messreihe bekommt, sondern die Statistik.
- **`sendsDataOffBox: false` setzen, während ein Gateway aufgerufen wird** — das Label
  lügt dann für den Nutzer (AGENTS 22/30).

**Zugehörig:** der Flow [`docs/flows/ai-analysis.md`](../flows/ai-analysis.md),
[`docs/api/evidence.md`](evidence.md), [`docs/api/hypothesis.md`](hypothesis.md),
[`docs/flows/open-core-boundary.md`](../flows/open-core-boundary.md).
