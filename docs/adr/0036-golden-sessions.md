# ADR 0036 — Eine goldene Sitzung ist Aufzeichnung, Erwartung und Lauf

- **Status:** akzeptiert (2026-09-14)
- **Betrifft:** `tools/golden-sessions`, `tests/fixtures/golden-sessions`, `tests/replay`,
  `packages/transport/can/src/replay.ts`, `docs/architecture/master-backlog.md` (P0 #10)
- **Kontext:** AGENTS 31.5 (Replay als Zeuge), AGENTS 24/27 (Personenbezug, Redaktion),
  Master-Backlog P0 #10; baut auf P0 #6 (`@vdp/diagnostic-ir`) und P0 #8 (Port-Verträge) auf

## Kontext

Bis hierher gab es zwei Arten von Sicherheit, und beide hatten ein Loch:

1. **Unit- und Protokolltests** prüfen Bausteine gegen erfundene Frames. Sie können nicht
   zeigen, dass eine *Sitzung* — Discovery, Identifikation, Fehlerspeicher, Live-Werte — nach
   einer Änderung noch dasselbe Ergebnis liefert.
2. **`tests/replay`** spielt eine Aufzeichnung zurück, die im Test entsteht. Damit ist der
   abgespielte Draht immer der, den der aktuelle Code erzeugt: eine Änderung am Client
   verändert Aufzeichnung und Replay gleichzeitig. Der Test kann per Konstruktion nicht rot
   werden, weil er prüft, dass die Software mit sich selbst übereinstimmt.

Der Satz „lief auf dem Prüfstand“ ist damit nicht belegbar. Was fehlte, ist eine
Aufzeichnung, die **nicht** aus dem aktuellen Lauf stammt, und eine Erwartung, die
**unabhängig** von ihr formuliert ist.

## Entscheidung

### 1. Eine goldene Sitzung ist ein Datenrecord mit drei Teilen

`vdp.golden` v1 (JSON, versioniert; unbekannte Version wird verworfen, nicht halb gelesen):

- `recording` — die Wire-Konversation beider Richtungen als `vdp.session`-Export. Roh, nicht
  dekodiert: eine Zusammenfassung würde genau die Bytes verbergen, die die Regression ausmacht.
- `expectations` — was die Plattform daraus schließen muss: ECUs mit Adresse, Identität
  (VIN-Platzhalter, Hersteller, Modell, Modelljahr), Fehlerspeicher mit Statusbyte,
  Signalwerte als Punkt (deterministisch) oder Bereich mit Mindestzahl Samples (bewegt).
- `provenance` — Adapter, Definitionspaket **und Version**, Aufzeichnungszeit, Werkzeug,
  und was redigiert wurde. Ohne die Definitionsversion ist die Erwartung nicht bewertbar.

### 2. Rezepte sind Code, Aufzeichnungen sind Daten — und beides wird erzeugt

`tools/golden-sessions/src/recipes.ts` beschreibt je Fixture das Fahrzeug (Fault Memory,
Defekt-Injektion, Seed). `npm run golden:record` fährt das Rezept gegen den Simulator, schreibt
die Datei und verifiziert sie sofort gegen sich selbst (`--verify`). Die vier eingecheckten
Fixtures — leerer Fehlerspeicher, gespeicherte Codes mit Freeze Frames, NRC 0x78 vor der
Antwort, bewegte Signale mit Seed — sind damit erzeugte Artefakte, keine Handarbeit: eine von
Hand getippte Erwartung ist ein Wunsch, eine aufgezeichnete ist ein Fakt. Der Zeitstempel steht
im Rezept, also erzeugt ein erneutes Aufzeichnen ohne Verhaltensänderung einen leeren Diff.

Der Lauf ist die **ganze** Pipeline gegen den aufgezeichneten Draht — Replay-Transport, echtes
ISO-TP, echter UDS-Client, echte Definitionen, dieselben Connect-Optionen wie bei der
Aufzeichnung. Nichts ist gestubbt, weil die Fragen genau die sind, die ein Stub falsch
beantwortet. Das Ergebnis ist eine Liste benannter Prüfungen, nie ein Boolean: ein
fehlgeschlagener goldener Lauf muss sagen, *was* verglichen wurde und was stattdessen herauskam
(`compareDtcObservations` aus P0 #6 liefert die Differenz als Text).

### 3. Redaktion ist byteweise, weil eine Textersetzung die VIN nie findet

Eine VIN ist 17 Zeichen; auf klassischem CAN passen 7 davon in einen Single Frame, also liegt
sie als First Frame plus Consecutive Frames auf dem Bus — **verteilt über mehrere Frames**.
Eine Textersetzung (auch die über Hex-Strings) findet sie deshalb nicht, und ein
zeichenweiser Durchlauf über die rohen Frames ebenso wenig: die Bytes stehen in drei Frames.
`isobytes.ts` setzt deshalb ISO-TP-Nachrichten zusammen (First + Consecutive, PCI-Offset bei
Extended Addressing), sucht die Sequenz im *zusammengesetzten* Nutzinhalt und schreibt die
Ersatzbytes in genau die Frames zurück, aus denen sie stammen.

Der VIN-Platzhalter ist 17 Zeichen lang (Länge und damit der Nachrichtenaufbau bleiben
identisch) und enthält nur Zeichen, die die VIN-Prüfung nicht akzeptiert
(`REDACTED-VIN-0000`) — er ist als Platzhalter erkennbar. `assertGoldenRedacted()` prüft nach
dem Schreiben beides: die serialisierte Datei enthält die VIN nicht mehr, und die
zusammengesetzten Nachrichten enthalten sie nicht mehr. Der Recorder gibt eine Datei nur
heraus, wenn diese Prüfung besteht; eine Redaktion, die nur ein Leser kontrolliert, kann ein
Schreiber vergessen.

### 4. Erwartungen tragen stabile ECU-Identitäten

`EcuSession.id` wird pro Lauf erzeugt (`ecu_…`). Eine Erwartung, die darauf zeigt, fällt beim
zweiten Lauf um — aus einem Grund, der nichts mit dem Fahrzeug zu tun hat, und genau solche
Fälle lassen eine Regressionssuite ihre Autorität verlieren. Erwartet wird deshalb die
stabile Identität: die Definitions-ECU-Id (`engine`, `abs`), sonst der Anzeigename
(`ecu-identity.ts`).

### 5. Was eine redigierte Aufzeichnung nicht reproduzieren kann, wird als übersprungen gemeldet

Hersteller, Modell und Modelljahr liest die VIN-Analyse aus der Nummer selbst; der Platzhalter
trägt keine WMI. Diese Felder stehen trotzdem in den Erwartungen — sie sind Teil dessen, was
die Sitzung festgestellt hat — und das Rezept vermerkt in `identity.vinDerived`, welche Felder
aus der VIN stammen. Der Lauf meldet diese Prüfungen als **übersprungen mit Grund**, nicht als
Fehlschlag: eine Datenschutzentscheidung ist kein Regressionsbefund, aber stilles Weglassen
wäre eine grüne Lüge.

### 6. Der Replay-Transport muss den Draht nachbilden, nicht eine Tabelle

Zwei Befunde aus dem ersten echten goldenen Lauf, beide im Replay und beide in der
Aufzeichnung angelegt:

1. **Flow Control ist keine Anfrage.** Antwortet der Tester auf einen First Frame mit
   `30 00 00` (PCI-Nibble `0x3n`), sah der Replay darin eine neue Anfrage. Damit hingen die
   Consecutive Frames der echten Antwort am falschen Austausch und jede folgende Anfrage traf
   den nächsten Record — Symptom: 25 `payload-differs` und 26 gerissene Erwartungen, was wie
   ein kaputter Record aussieht und ein Zuordnungsfehler ist. Ein Flow-Control-Frame gehört zur
   laufenden Antwort: er öffnet keinen Austausch und schließt keinen.
2. **Zeitlichkeit ist Teil der Antwort.** Ein ECU, das „Response Pending“ (NRC 0x78) schickt
   und 30 ms später die echte Antwort, sendet *zwei* Nachrichten; der Tester wartet auf die
   zweite erst, nachdem er die erste verarbeitet hat. Werden beide in einem Rutsch zugestellt,
   ist die zweite verloren, bevor jemand zuhört. `pace: true` liefert jede Antwort zu ihrem
   aufgezeichneten Abstand und lässt `send` zurückkehren, statt den ganzen Austausch
   abzuwarten — eine aufgezeichnete Sitzung wird damit wie ein Bus abgespielt und nicht wie
   eine Tabelle. Voreinstellung bleibt `false`: ein Unit-Test will, dass `await send()`
   „die Antwort ist zugestellt“ bedeutet.

### 7. Das Werkzeug ist keine Schicht

`@vdp/golden-sessions` wird von nichts importiert; es ist Werkzeug plus Fixture-Erzeugung. Die
Bibliotheksteile bleiben frei von I/O, nur die CLI liest und schreibt Dateien — deshalb steht
`@vdp/golden-sessions` in `dependency-rules.json` als Ausnahme für Node-Builtins, und zwar
mit Begründung: eine Ausnahme ohne Grund ist eine Hintertür.

## Konsequenzen

- **Was das kostet:** vier Fixtures à 74–112 KB, ein Werkzeug mit 42 Unit-Tests und sechs
  Replay-Tests, und die Pflicht, bei beabsichtigten Verhaltensänderungen neu aufzuzeichnen
  (`npm run golden:record --verify`). Die Fixtures werden formatterrein geschrieben (der
  Writer druckt die Form, die `biome check .` erwartet), damit die Dateien im Gate bleiben
  und nicht durch eine Ignore-Regel herausfallen.
- **Was das trägt:** eine Protokoll-, Definitions- oder Decoder-Änderung, die eine echte
  Sitzung anders auswertet, ist ab jetzt ein roter Test mit Namen und Ist-Wert — nicht ein
  Fund auf dem Prüfstand. Der Lauf kostet ~0,2 s pro Fixture, die Suite bleibt unter 30 s.
- **Offen:** die Fixtures stammen vom Simulator (`provenance.source: "simulator"`). Echte
  Fahrzeugaufzeichnungen laufen durch dieselbe Pipeline, sobald Adapteraufzeichnungen
  vorliegen (P1 #11 ff.); das Format unterscheidet `simulator`, `bench` und `vehicle`, damit
  eine echte Aufzeichnung nicht als „auf dem Prüfstand entstanden“ gelesen wird.
- **Nicht Teil dieser Entscheidung:** eine Fixture-Bibliothek pro Fahrzeugvariante und das
  Einbinden in die Evidence Engine (P2). Heute geht es um die Reproduzierbarkeit einer
  Sitzung, nicht um Diagnosewissen.
