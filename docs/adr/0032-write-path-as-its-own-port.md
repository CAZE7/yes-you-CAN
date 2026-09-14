# ADR 29 — Der Schreibpfad ist ein eigener Port, keine Methode am Lesepfad

- Status: akzeptiert (2026-09-14)
- Kontext: AGENTS 20 („Clear DTCs mit expliziter Bestätigung"), AGENTS 25/26 (Safety-Kette, „jede Stufe ein Ergebnis mit Gründen"), Master-Backlog P0 #3, #4, #5, #7
- Betrifft: `packages/core/src/writes/` (`port.ts`, `transaction.ts`, `dtc-clear.ts`, `standard-operations.ts`), `packages/core/src/dtc/clear.ts`, `packages/core/src/diagnostics/{engine,dtc-access,engine-context}.ts`, `packages/runtime/src/{runtime,services,mappers}.ts`

## Problem

Lesen und Schreiben waren zwei Zweige derselben Klasse. `DiagnosticEngine` hatte
`scanDtcs()` **und** `clearDtcs()`, `DtcAccess` hatte `scanEcu()` **und** `clear()`, und die
Safety-Kette war eine Methode, die man *aufrufen musste* — `evaluateDtcClear()` für die
Vorprüfung, dieselbe Auswertung nochmal innerhalb von `clearDtcs()`. Drei Folgen:

1. **Der Lesepfad konnte das Fahrzeug ändern.** Wer eine Engine zum Scannen hatte, hatte
   automatisch die Möglichkeit zu löschen. Ein Port, der beides anbietet, ist kein Lesepfad.
2. **Ablehnungen waren Ausnahmen.** `DtcClearService.clear()` warf. Ein Aufrufer erfuhr damit
   „nein" und „mittendrin kaputt" nur am Typ der Ausnahme, und die Begründung steckte in einer
   Zeichenkette. Die HTTP-Schicht übersetzte das zurück in Daten (ADR 0018) — der Fehler war
   damit zweimal modelliert, einmal als Wurf und einmal als Antwort.
3. **Es gab keinen Ort für „was ist bisher passiert".** Ein abgebrochener Schreibvorgang hinterließ
   eine Ausnahme, kein Ergebnis. Für Backup, Audit und spätere Wiederaufnahme war das zu wenig.

## Entscheidung

1. **Zwei Objekte, ein Weg.** Der Lesepfad (`DiagnosticEngine`, `DtcAccess`) hat **keine
   Schreibmethode** mehr; `engine.clearDtcs`/`evaluateDtcClear` und `DtcAccess.clear/evaluate`
   existieren nicht. Schreiben geht ausschließlich über `WritePort` (`writes/port.ts`), der die
   Operationen unter ihrem `kind` führt (`register`, `run`, `precheck`, `kinds`, `history`).

2. **Eine Operation ist Daten, kein Skript.** `WriteOperation<Input, Prepared, Value>` deklariert
   `kind`, `title`, `risk` und die Stufen `prepare → confirm → execute → verify` (+ optional
   `rollback`). Der Port kennt keine Operationsnamen; das Vokabular (`clear-dtc`) lebt in der
   Operation. `createWritePort()` (`writes/standard-operations.ts`) ist der eine Ort, an dem
   festgelegt wird, was die Plattform heute schreiben darf — heute genau ein Eintrag.

3. **Jede Stufe ist ein Ergebnis mit Gründen.** `DiagnosticTransaction.stage(name, body)` fängt
   jeden Wurf und macht daraus einen `StageReport { stage, state, reasons, warnings, at, detail? }`.
   `run()` wirft nur noch bei einem unbekannten `kind` (Programmierfehler); jede Ablehnung des
   *Schreibvorgangs* kommt als `WriteOperationResult` mit `ok: false`, `reasons`, `stages` und der
   Transaktion zurück.

4. **Fail-closed an der Stufengrenze.** Scheitert `prepare` (kein Backup oder verweigerter
   Sitzungswechsel), wird die Transaktion abgebrochen, **ohne** dass `confirm` läuft: Für einen
   Schreibvorgang, der nicht starten kann, wird kein Permit angefragt und kein irreführender
   Audit-Eintrag erzeugt (AGENTS 26). Ohne Permit läuft `execute` nie.

5. **Der Audit-Ausgang ist explizit.** Der Port journaliert den Permit-Ausgang
   (`SafetyManager.recordResult`, `write-success`/`write-failed`) — auch wenn die Ausführung nach
   erteiltem Permit scheitert. Ob das Ziel erreicht wurde, beurteilt die Operation selbst über den
   optionalen Hook `outcomeOf(value)`: Ein Clear, dessen Re-Read den Fehler weiterhin zeigt, ist
   *ausgeführt*, aber nicht bestätigt und steht als `write-failed` im Audit-Log.

6. **Kein Rollback, der nicht existiert.** ISO 14229-1 kennt keinen Dienst, der gelöschten
   Fehlerspeicher wiederherstellt. Deshalb hat `clear-dtc` kein `rollback`, sondern
   `rollbackUnavailable` mit Begründung; der Port protokolliert die übersprungene Stufe **mit
   dieser Begründung**, statt eine Rücknahme zu erfinden.

7. **Die Transaktion ist ein Zustand, kein Aufrufstapel.** `DiagnosticTransaction` führt
   `open → prepared → confirmed → executed → verified | suspended | aborted | rolled-back`, prüft
   die Stufenreihenfolge (eine `verify`-Stufe ohne Schreibstufe bricht ab) und hält ein
   Journal (`snapshot.stages`, `snapshot.journal`). `suspend`/`resume` beschreiben eine
   unterbrochene Handlung als Zustand — die Voraussetzung für „Wiederaufnahme" und für eine
   spätere Session-Persistenz (P0 #6/#7).

## Konsequenzen

- Die Write-Port-Suite (`writes/writes.spec.ts`) prüft die Szenarien der alten
  `DtcClearService`-Tests erneut — mit dem Unterschied, dass Ablehnungen jetzt als Daten geprüft
  werden (`ok: false`, Stufe, Grund) statt als Ausnahmen; die Tests der Kollaborateure pinnen
  zusätzlich, dass der Lesepfad **keine** Schreibmethode besitzt.
- Die HTTP-/Runtime-Schicht übersetzt nur noch: `DtcService.precheckClear`/`clear` rufen
  `precheckDtcClear`/`runDtcClear` und mappen `WriteOperationResult` auf `ClearDtcOutcome`
  (inklusive `stages` und `transactionId`, damit die Ablehnung im UI erklärbar bleibt).
- Jede weitere Schreiboperation (Coding, Adaptation, Routine — Master-Backlog P2) ist ein
  `WriteOperation`-Objekt und eine Zeile in `createWritePort()`; sie kann die Stages nicht
  umgehen und nicht ohne Permit schreiben.
- Die `definitionVersion`, gegen die ein Schreibvorgang validiert wird, kommt aus dem
  `WriteBinding` — eine Quelle statt zweier (Input und Bindung), damit Permit und Transaktion nie
  verschiedene Versionen nennen.
