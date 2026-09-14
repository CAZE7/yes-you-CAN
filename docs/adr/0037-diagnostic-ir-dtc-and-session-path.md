# ADR 37 — Diagnostic IR, zweite Etappe: der Fehlerspeicher- und Sitzungspfad läuft durch sie

- Status: akzeptiert (2026-09-14)
- Kontext: ADR 0034 (erste Etappe, Messpfad), AGENTS 20 (DTC-Zustand), AGENTS 10/12 (Sitzung), AGENTS 13 (Definitionsversion), AGENTS 24 (keine erfundenen Daten), Master-Backlog P0 #6
- Betrifft: `packages/diagnostic-ir/src/{dtc,session,index}.ts`, `packages/core/src/dtc/scanner.ts`, `packages/core/src/dtc/clear.ts`, `packages/core/src/session/{observation.ts,index.ts}` (neu: observation), `packages/domain/src/model.ts`, `packages/runtime/src/mappers.ts`, `packages/reports/src/report.ts`, `apps/web/src/dtc-view.ts`, `apps/web/public/app.js`, `tools/architecture/dependency-rules.json`

## Problem

ADR 0034 hat die Zwischenstufe eingeführt und den **Messpfad** durchgezogen. Für den
Fehlerspeicher und die Sitzung blieb der offene Halbsatz im Backlog („DTC- und
Session-Observations als Datenfluss … und die Sicht ‚Lücken' in Reports/UI“).
Nachgemessen am Baum waren das vier getrennte Übel, die dasselbe Thema haben:

1. **Drei Vergleiche, drei Identitätsregeln.** `DtcScanner.compare` (Schreibpfad),
   `compareDtcObservations` (IR, Replay-Werkzeug) und `DtcTracker.key` (Historie)
   beantworteten „ist das derselbe Fehler?“ verschieden: der eine keyte
   `ecuId:code` roh, der andere `code`, der dritte `ecuId:CODE` normalisiert.
   Genau dieselbe Scans Folge konnte also „unverändert“ (Historie: gleicher Code)
   und „entfernt + neu“ (Vergleich: andere Schreibweise) heißen.
2. **Das Projektionsfeld ohne Projektion.** `DtcView.provenance` war im
   Wire-Contract deklariert („Provenance of the description — never present
   invented knowledge“) und wurde **nie** gesetzt — die Workbench hatte
   einen Platz für die Frage „woher stammt diese Beschreibung?“ und keine Antwort.
3. **Rohdaten, die die Projektion nicht erreichten.** `DtcRecord.snapshot` und
   `extendedData` landeten im `EnrichedDtc` nur, weil `{ ...record }` sie
   mitnahm. Wer die Beobachtung baute, kannte sie nicht; wer sie brauchte, kam an
   der Beobachtung vorbei.
4. **Die Sitzung konnte ihre Lücken nicht benennen.** Ein Steuergerät, das nie
   antwortete, und ein Code, den kein Paket dokumentiert, sind zwei Aussagen mit
   Beleg — sie existierten nur als `reachable: false` und als fehlende
   Beschreibung, also als Abwesenheit.

## Entscheidung

1. **Eine Identitätsregel: `dtcKey = ecuId + normalisierter Code`.**
   `dtcKey()` lebt in der IR und ist die einzige Stelle, die „derselbe Fehler?“
   beantwortet. Historie (`DtcTracker.key`), Vergleich (`compareDtcObservations`)
   und jede Projektion benutzen sie. **Das kippt eine gepinnte Entscheidung:**
   `dtc-scanner.spec.ts` forderte bisher, dass `P0420` und `p0420` verschieden
   sein müssen (lauter Alarm statt stiller Gleichsetzung). Das ist falsch herum
   laut: ein DTC ist ein 3-Byte-Wert, die Buchstabenform ist eine Darstellung, und
   die Historie hat längst normalisiert. Der neue Test pinnt beide Hälften —
   Identität ist normalisiert, die **gemeldete Schreibweise** überlebt im Record.

2. **`observe()` → `DtcState`, `enrich()` ist die Projektion.** Genau das Muster,
   das `SignalDecoder.observe()/decode()` vorlebt: ein Rechenweg, zwei Sichten.
   `DtcScanner.observe()` liefert `DtcScan { state, knowledge? }`;
   `toEnrichedDtc(scan)` ist eine verlustfreie Projektion nach außen, deshalb
   musste kein Konsument (Engine, Runtime, Workbench, Berichte, Speichering)
   geändert werden. `DtcVariantKnowledge` bleibt dabei **neben** dem IR-State und
   wird nicht in ihn hineingezogen: `patterns[]`/`checks[]` mit Min/Max/Fenster
   sind Vokabular der Definitionspakete mit eigener Schema-Version (ADR 0025);
   die IR kennt kein Protokoll und keine Paketstruktur. Wo sie zusammenkommen,
   ist die Projektion — und nur dort.

3. **Die Beobachtung trägt die Rohdaten, die Projektion herstellt, was sie sieht.**
   `DtcObservation` kennt jetzt `severity`, `snapshot` und `extendedData`;
   `dtcEnrichment()` zählt eine deklarierte Schwere als Dokumentation und nennt
   im unproven-Fall alle vier Felder, die gefehlt haben. Die Schwere wird nie neu
   erfunden: ohne Beleg wiederholt die Projektion `dtcSeverity(statusBits)` —
   dieselbe Funktion, die auch das Protokoll auf diese Bytes losgelassen hat
   (Eigenschaftstest über alle 256 Statusbytes).

4. **Die Sitzung wird projizierbar: `sessionObservationOf` / `dtcObservationsOf` /
   `sessionGapsOf`** (`packages/core/src/session/observation.ts`). Eine Projektion
   **auf** dem Datensatz, nicht ein vierter Ablageort: `session.data` bleibt die
   eine Wahrheit, die Beobachtung wird bei Bedarf abgeleitet. `SessionGap` ist die
   einzige Stelle, die „was bleibt offen?“ beantwortet (nicht erreichbares
   Steuergerät mit Grund, undokumentierter Code mit IR-Evidenz, fehlende
   Scan-Historie, keine Messung) — Bericht und UI lesen dieselbe Liste.

5. **Ein Bericht braucht eine Lücken-Sektion.** `Observations & gaps` steht in der
   AGENTS-21-Reihenfolge direkt nach den Anomalien und vor dem Audit-Log, weil ein
   Handout mit „0 Anomalien“ für ein Auto, dessen ABS nie geantwortet hat, den
   Mechaniker an das falsche Bauteil schickt. `Open questions: none` heißt *nicht*
   „nichts ist kaputt“, sondern „jede Aussage in diesem Bericht hat eine Quelle“ —
   der Satz steht so im Text, damit die Sektion nicht als Freispruch gelesen wird.

6. **Das freie Feld wird gefüllt statt neu erfunden.** `DtcInfo.evidence` (Domain)
   trägt die eine IR-Zeile (`describeEvidence`), `toDtcView` schiebt sie
   unverändert auf `DtcView.provenance`, `app.js` beschriftet sie („Belegt durch:
   …“). Die Workbench formuliert keine eigene Provenanz-Vokabular und prüft auch
   nicht den Wortlaut auf `not proven` — der Satz sagt das selbst.

7. **Ein Werkzeug, eine Regel: `@vdp/reports` darf `@vdp/diagnostic-ir` importieren.**
   Nicht, damit Berichte Protokoll lernen, sondern damit ein Bericht, der eine
   unbewiesene Aussage zeigt, die Wörter der Beobachtung benutzt statt sie
   nachzuerzählen. Die Regeländerung liegt, wie von ADR 0031 verlangt, allein in
   `dependency-rules.json` — `reports` hatte bisher nur `core` freigegeben.

8. **JSON kann keine Byte-Felder.** Beim Projizieren einer **gespeicherten**
   Sitzung wird `Uint8Array([0x0c,0x30])` zu `{"0":12,"1":48}`, und der Typ des
   Records lügt weiter. `storedBytes()` repariert das an der einzigen Stelle, die
   gespeicherte Records in eine Beobachtung überführt, und **verweigert** alles,
   was keine indizierte Byteliste ist — ein Objekt mit Benannten Schlüsseln wird
   nicht zu einem Freeze-Frame umgedeutet. Der Test „ein Neustart der Datei ändert
   die Beobachtung nicht“ (deepEqual live vs. reload) ist der Grund, warum diese
   halbe Zeile Code hierher gehört und nicht in die `repository`.

## Konsequenzen

- Der Schreibpfad bleibt unangetastet: `dtc-clear.ts` ruft weiter `enrich()`/
  `compare()` und bekommt dieselben Werte. **Die 1646 bestehenden Tests laufen
  unverändert** — außer zwei, deren gepinnte Entscheidung bewusst ersetzt wurde:
  die Identitätsregel (siehe 1.) und der Wortlaut des unproven-Grunds, seit eine
  deklarierte Schwere ebenfalls Dokumentation ist.
- Sessions speichern ab jetzt `evidence` pro Record (additiv, optional).
  **Kein Schema-Bump**: `SESSION_SCHEMA_VERSION` bleibt 1, `defaultMigrations`
  bleibt leer — ein Bump ohne registrierten Schritt macht jede gespeicherte
  Sitzung unlesbar, additive optionale Felder brauchen ihn nicht.
- Reports haben eine Sektion mehr. Wer die Reihenfolge der AGENTS-21-Punkte
  prüft (`reports.spec.ts`), prüft weiterhin nur die Pflichtsektionen; die neue
  ist zusätzlich und damit prüfbar, ohne eine Spezifikation umzuschreiben.
- Eine zweite Zeile für „Belegt durch“ in den DTC-Details ist kein neues Panel:
  die Information war im Vertrag, es fehlte der Sender.

## Messung

- `npm run ci` grün: Build, beide `--noEmit`-Pässe, `biome check .`,
  `check:deps`, `npm test`.
- Suite 111 → **112 Dateien / 1646 → 1673 Tests**, Coverage global
  **94,49 / 87,22 / 96,31 / 95,83** (vorher 94,45 / 87,18 / 96,27 / 95,79 — die
  Fläche ist gewachsen, nicht geschrumpft).
- `session-observation.spec.ts` 14 Tests (neu), `dtc-scanner.spec.ts` +6 (davon
  einer Property-Test über alle 256 Statusbytes), `diagnostic-ir.spec.ts` +3,
  `reports.spec.ts` +2, `views.spec.ts` +2 — zusammen 27 Tests.
- Coverage der Beteiligten (Statements / Zweige / Funktionen / Zeilen):
  `session/observation.ts` 97,61 / 89,65 / 100 / 100 · `dtc/scanner.ts`
  100 / 84,67 / 100 / 100 · IR `dtc.ts` 100 / 97,43 / 100 / 100 ·
  `reports/report.ts` 99,5 / 84,61 / 100 / 100 · `apps/web/src/dtc-view.ts`
  100 / 100 / 100 / 100 (beide Zweige des neuen Feldes gemessen).
