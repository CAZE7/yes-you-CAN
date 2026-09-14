# ADR 31 — Diagnostische Zwischenstufe: Beobachtungen mit Beleg

- Status: akzeptiert (2026-09-14)
- Kontext: AGENTS 14/17 (Roh und dekodiert bleiben getrennt), AGENTS 20 (DTC-Zustand), AGENTS 24 (Datenherkunft), AGENTS 26/ADR 30 (fehlende Evidenz ist ein Fehlschlag), Master-Backlog P0 #6
- Betrifft: `packages/diagnostic-ir/` (neu), `packages/core/src/measurements/{decoder,live}.ts`, `packages/core/src/diagnostics/measurement-access.ts`, `tools/architecture/dependency-rules.json`, `vitest.config.ts`

## Problem

Zwischen Rohform und Projektion lag genau **ein** Schritt: Protokollbytes rein,
Domain-DTO raus. Diese eine Naht verlor zwei Dinge, die jede spätere Auswertung
braucht:

1. **Herkunft.** Ein dekodierter Wert trug weder das DID noch die
   Definitionsversion noch den Zeitpunkt, an dem er *beobachtet* wurde — nur das
   Ergebnis. Berichte, Evidence Engine (#41) und KI-Schicht (§22) hätten die
   Herkunft jeweils neu erraten müssen.
2. **Den Unterschied zwischen „kein Wert“ und „nicht beobachtet“.** `decode()`
   antwortet `null`, wenn eine DID-Antwort nicht passt, und die Live-Engine zählte
   das als Fehler auf DID-Ebene. Auf Signal-Ebene passierte das Gegenteil: das
   Signal fehlte einfach. Ein ausgefallener Sensor und ein ausgefallenes Kabel
   sahen damit gleich aus — nämlich nach nichts.

Regel 2 ist im Kern dieselbe Aussage, die ADR 30 für die Safety-Kette
festgehalten hat: *fehlende Evidenz ist ein Fehlschlag, kein Schweigen.* Auf der
Datenebene fehlte sie.

## Entscheidung

1. **Ein eigenes Paket.** `@vdp/diagnostic-ir` sitzt zwischen Rohform und
   Projektion und kennt weder Transport noch Protokoll (die Architekturregeln in
   `dependency-rules.json` erzwingen `mayImport: ["@vdp/shared"]`). Es führt keine
   I/O aus. Ein 26. Paket ist gerechtfertigt, weil die Alternative ein weiterer
   Satz Typen in `core` wäre — und `core` **darf** Protokolle kennen, die IR nicht.

2. **Beobachtungen tragen Belege.** `Provenance` (Herkunft, Zeitpunkt, ECU, DID,
   Definitionsversion, Rohbytes) und `Evidence = Proven | Unproven` sind
   Bestandteil jeder Beobachtung. `describeEvidence()` liefert eine Zeile für Log,
   Bericht und Audit. Ein Beleg ist damit kein Optionals-Feld, das man vergessen
   kann: Wer einen Wert braucht, muss `isProven()` vorher bestehen.

3. **Eine verpasste Messung ist ein Datensatz.** `SignalObservation` ist
   `SignalReading | SignalGap`; der Gap trägt den Grund („no data returned for DID
   0xC“, „the payload did not match the declared layout“). `readings()`/`gaps()`
   trennen die beiden Sichten, ohne dass eine Seite stillschweigend verschwindet.

4. **Beobachtung und Wissen bleiben getrennt.** `DtcObservation` (was das
   Fahrzeug gesagt hat, mit Service-ID 0x19) und `DtcEnrichment` (was die
   Definition dazu weiß) haben je einen eigenen Beleg. Ein Code ohne
   Dokumentation ist damit sichtbar *undokumentiert* statt nur unerklärt.
   `compareDtcObservations()` vergleicht Zustände (added/removed/changed/unchanged)
   — die Aussage, die nach einem Löschen zählt (AGENTS 25).

5. **Ein Fenster ohne Belege ist kein Urteil.** `MeasurementWindow` liefert
   `samples`, `min`/`max`/`mean` **und** die Lücken im Fenster; `conclusive` ist nur
   wahr, wenn mindestens ein Wert vorliegt und keine Lücke gemeldet wurde. Eine
   Fensterauswertung, die nur Zahlen kennt, kann eine Diagnose darauf stützen, dass
   *nichts* gemessen wurde.

6. **Verdrahtung schrittweise, mit Verbraucher.** Der Messpfad läuft schon durch
   die IR: `SignalDecoder.observe()` erzeugt die Beobachtung, `SignalDecoder.decode()`
   ist die Projektion davon (ein Rechenweg, zwei Sichten), `LiveDataEngine` sammelt
   `gaps` pro Runde und zählt `stats.gaps`, `MeasurementAccess` führt Live-Daten über
   `observe()`. DTC- und Session-Observations sind bewusst **noch nicht** angebunden:
   sie sind das Vokabular für #7 (Transaktions-Persistenz), #10 (Golden Sessions)
   und #41 (Evidence Engine). Kein Umbau ohne Verbraucher — der nächste Schritt
   steht im Master-Backlog.

> **Nachtrag (2026-09-14, ADR 0038):** die hier angekündigten Fortsetzungen sind
> erledigt — Backlog-Zeilen **#39 (Evidence Engine)** und **#40 (Hypothesis Engine)**;
> die Nummern in diesem Text (#41/#42) stammen aus dem Stand des Backlogs an dem Tag,
> an dem die ADR geschrieben wurde. Widersprüche *zwischen* zwei Belegen sind damit
> **nicht** gemeint: `conflictsOf` meldet nur den Fall „undokumentierter Code bei
> dokumentiertem Muster", ein allgemeiner Beleg-Widerspruch bleibt offen.

## Konsequenzen

- Eine Live-Session kann jetzt sagen, **welche** Werte warum fehlen: `PollRoundResult.gaps`
  (pro Signal) neben `errors` (pro DID) und `stats.gaps`. `errors` bleibt, weil es die
  DID-Ebene beschreibt; `gaps` ist die Signal-Ebene derselben Störung, keine Kopie.
- `decode()` behält seinen Vertrag (`null` statt Wurf, `strict` wirft weiterhin)
  — 1300+ bestehende Tests bleiben gültig, ohne dass Verhalten umgedreht wurde.
- Ein neues Paket heißt: Manifest, `tsconfig`-Referenz, Architekturregeln,
  Coverage-Gate (95/85, gemessen 97,8/93,9/100/100) und eigene Tests in einem Zug.
  `npm test` zählt 94 Dateien / 1369 Tests, die Kantenzahl steigt auf 68.
- Die IR ist der Ort, an dem #41 (Evidence Engine) und #42 (Widersprüche) ansetzen:
  `Evidence` und `MeasurementWindow` liegen dort schon in der Form, die ein Bericht
  braucht; Widersprüche zwischen zwei Belegen gibt es noch nicht als Typ — sie
  gehören in #42.
