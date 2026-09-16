# ADR 40 — Das Fahrzeugmodell erzeugt die Fehler, die Szenario-Engine schreibt sie vor

- Status: akzeptiert (2026-09-15)
- Kontext: AGENTS 32 (Simulator), AGENTS 20 (DTC-System), ADR 0037 (Fehlerspeicher läuft durch die IR), ADR 0038 (Evidence Engine), ADR 0039 (Fault-Injection am Seam), Master-Backlog P0 #16/#17
- Betrifft: `tools/simulators/src/vehicle-model.ts`, `vehicle-state.ts`, `vehicle-monitors.ts`, `vehicle-signals.ts`, `vehicle-wiring.ts`, `scenarios.ts`, `scenario-catalog.ts`, `high-fidelity-vehicle.ts`, `virtual-can.ts`, `tests/integration/scenario-chain.test.ts`, `apps/web/src/scenario-view.ts`

## Problem

Der Simulator konnte Zustände setzen. `setEcuOnline("abs", false)` hieß: Fehlerspeicher
des Gateways `U0121` schreiben, `server.stop()`, fertig — und die Tests des High-Fidelity-
Fahrzeugs haben genau das geprüft: Zustand gesetzt, Zustand zurückgelesen. Damit war der
Simulator eine Fixture mit CAN-Adressen, kein Fahrzeug:

- Ein Fehler hatte keine Ursache, also konnte auch kein Test zeigen, dass die Plattform
  eine Ursache **findet**. Die Kette `Unterspannung → ECU reagiert → DTC → UDS-Lesung →
  IR → Beleg` war nirgends gemessen; sie bestand aus zwei independenten Behauptungen
  („das Modell hat den Status gesetzt" und „der Client kann lesen").
- Cross-Modul-Effekte waren `switch`-Fälle pro ECU-Paar. DieABS-offline-Regel kannte
  `U0121` und stampfte sie Engine **und** Gateway ins Gedächtnis — die Engine dokumentiert
  den Code in keinem Paket, also meldete ein Scan eine Zahl ohne Erklärung.
- „Intermittierend" gab es nicht: ein `Math.random`-Drag pro Aufruf ist kein Wackelkontakt,
  sondern Rauschen, und ein Test darauf wäre flaky.

Dazu kam die Frage, wo Szenarien leben. Als Testkörper geschrieben treiben sie weder die
Workbench noch eine Aufzeichnung; als Demo-Code verifiziert sie niemand. Beides war
dasselbe Objekt nötig: Daten, die ein Test abarbeitet und ein Simulator ausführt.

## Entscheidung

1. **Ein Verhaltensmodell ist die einzige Quelle für Fahrzeugzustand.**
   `VehicleBehaviourModel` hält Stromversorgung (Ruhespannung, Anlasserstrom,
   Innenwiderstand als `voltsPerAmpere`, Lichtmaschine, Verbraucher), Antriebsstrang
   (Drehzahl gegen die gelernte Leerlaufadaption, Zünden nur ab `crankingStartV`,
   Motortemperatur, Mischlauf/Trims), Räder und Sensorfehler. Alles daran ist **Ursache
   oder Integration**: es gibt keinen Setter für einen DTC, keinen für „online", keinen für
   einen Status. Die Physik wird in festen Schritten von 20 ms Modellzeit integriert;
   `advance(ms)` in Scheiben zerlegt dasselbe Ergebnis liefert wie ein Aufruf (gemessen:
   `slicing the advance changes nothing`).

2. **Fehler entstehen aus Monitorregeln, nicht aus Aufrufen.** Eine Regel
   (`vehicle-monitors.ts`) ist ein Messwert gegen ein dokumentiertes Code-Paar:
   `bcm-supply-voltage → B1001`, `engine-misfire → P0300`, `engine-mixture-lean → P0171`,
   `engine-catalyst-efficiency → P0420`, `abs-front-left-circuit → C0035`,
   `transmission-requested-lamp → P0700` (die Gangsteuerung meldet, dass der Motor die MIL
   angefordert hat — abgeleitet aus dem Zustand eines Nachbarn, nicht nebenbei gesetzt),
   plus **generiert** ein `gateway-lost-<peer> → U010x` pro überwachtem Knoten. Vier Regeln
   halten das zusammen: Debounce (eine Bedingung muss `debounceMs` halten), Hysterese
   (`clear()` ist ein zweites Fenster, nicht die Negation), **nur dokumentierte Codes**
   (Regel 3) und **Silence nach Speech** (Regel 4: wer nie antwortete, ist nicht „lost",
   sondern „absent" — das ist Discovery, kein U-Code).

3. **Die Signalkette hat einen Ausgang.** `vehicle-signals.ts` ist die *einzige* Abbildung
   Modellzustand → Signal-Id. `VirtualVehicle.signalValue` wurde `protected`,
   `buildPayload` `protected`, `buildFreezeFrame` bekam eine Value-Funktion: Live-DID,
   Freeze Frame und Szenario-Messwert lesen dieselbe Tabelle. Ein Freeze Frame wird damit
   **beim Latch** mit den Werten des Moments kodiert, nicht mit dem dokumentierten
   Beispielwert — und für einen Code ohne deklariertes Layout bleibt er leer, weil das
   Paket kein Layout dokumentiert (AGENTS 20.1).

4. **Leitungsausfall ist ein Draht, keine Flagge.** `VirtualCanNetwork.impair()` schluckt
   Rahmen nach Prädikat (beide Richtungen, `lossRate` oder `silent`) und zählt
   `matched`/`dropped`. Das Fahrzeug sendet pro online-Modul einen Broadcast auf
   `HEARTBEAT_IDS`; das Gateway lauscht auf seinem eigenen Bus und meldet
   `model.heardFrom(peer)`. „Lost communication" ist damit eine **Messung eines Nachbarn**,
   und derselbe Ausfall ist für den Tester ein Timeout — zwei unabhängige Belege, ein
   Ereignis.

5. **Ein Szenario ist Daten.** `VehicleScenario` = `steps` (Ursache + Modellzeit +
   `holdMs`), `conditions` (physikalische Bedingung am Zustand), `expectations`
   (`active|stored|absent|intermittent` je Modul und Code, jeweils mit `because`).
   `runScenario(target, …)` arbeitet gegen ein `ScenarioTarget`: das nackte Modell
   (`modelTarget`) **und** das fahrende Fahrzeug (das `bus`-Ursachen auf den Draht legt)
   erfüllen dasselbe Interface. `closedWorld` macht jeden vom Szenario nicht
   vorhergesagten Latch zu einem Fehlschlag — eine Szene, in der „irgendwas auftritt", ist
   kein Test. `intermittent` prüft die **Historie** (`raised ≥ minRaises`), weil ein
   Statusbyte zu einem Zeitpunkt über einen Wackelkontakt nichts aussagt.
   Der Katalog hält die sechs Fälle: Unterspannung beim Start, ABS intermittierend offline,
   CAN-Bus-Aussetzer, Sensorwerte außerhalb plausibler Grenzen, Load Dump,
   Lichtmaschinenausfall.

6. **Die Kette wird oben gemessen, nicht unten.** `tests/integration/scenario-chain.test.ts`
   fährt pro Szenario `onMoment`-Scans über echte ISO-TP/UDS-Stapel und prüft jede
   Erwartung **in dem Moment, den das Szenario nennt** — nicht erst nach dem Lauf.
   Ergänzt um den Positiv-/Negativpair: Cause → `0x19`-Lesung → `DtcScanner.observe` →
   `EvidenceService`-Item mit `proven`-Beleg und stabilem Item-Id, und dasselbe Fahrzeug
   ohne Ursachen mit leerem Speicher.

7. **Das Modell gehört dem Takt, den es selbst setzt.** `HighFidelityVehicle.runScenario()`
   pausiert den Realtime-Loop des Demofahrzeugs für die Dauer des Laufs (Resume im
   `finally`). Zwei Taktgeber, ein Fahrzeug: jede Erwartung wäre ein Rennen (AGENTS 31).

8. **Die Workbench spricht dasselbe Vokabular.** `apps/web/src/scenario-view.ts` projiziert
   Katalog und Lauf (`ScenarioSummary`, `ScenarioRunView`), `GET /api/simulator/scenarios`
   und `POST /api/simulator/scenario` liefern sie; die Typen hängen an `views.ts`, weil das
   Frontend dagegen typgeprüft wird (ADR 0030). Bewusst **kein** Panel in `public/app.js`
   gebaut: `app.js` steht mit 1642 Zeilen schon außerhalb des Größenbudgets
   (Ausnahmeeintrag in `tests/architecture/hygiene.test.ts`, Zahl nachgemessen
   2026-09-16 — das Tor vergleicht neuerdings die Zahl im Ausnahmetext mit der
   gemessenen, weil beide dort als Prosa standen und um 545 Zeilen verfault waren), und
   eine View, die niemand abdecken kann, ist Schulden statt Funktion. Der Endpoint ist
die nach oben offene Fläche; das Panel ist ein eigener, kleiner Schritt — er kam
(2026-09-16, 0.E E21 geschlossen) und war dann genau das: ein Schritt, kein Umzug.
`apps/web/public/scenario.js` (194 Zeilen) montiert Katalog, Lauf und Ergebnis an die
View, `apps/web/src/scenario-view.ts` (407 Zeilen) baut jede Zeile auf der Server-Seite
der Grenze, damit das Markup keine zweite Zuordnungstabelle bekommt; `app.js` wuchs nur
um Mount und Refresh (1648 Zeilen, dieselbe Messung, die den Ausnahmegrund in
`tests/architecture/hygiene.test.ts` auf den Stand des Commits gebracht hat).

9. **Die Messwert-Tabelle und die Signale des Fahrzeugs sind eine geprüfte Beziehung.**
   `MODEL_SIGNAL_READERS` (`vehicle-signals.ts`) ist die eine Tabelle — eine Tabelle und
   kein `switch`, weil die Liste der Ids *selbst* die Behauptung ist, die verglichen wird;
   eine sich aus Quelltext lesende Liste hätte ihre Regel im Test statt im Modul.
   `tools/simulators/src/vehicle-definition.spec.ts` prüft beide Richtungen gegen
   `highFidelityPackage`: jede gemappte Id braucht ein deklariertes Signal, und jedes
   deklarierte Signal mit numerischem Encoding braucht einen Leser — sonst antwortet die
   Basis-Simulation eine Zahl, die niemand gemessen hat. Ausgenommen sind
   ASCII-Identifikationen und die Register, die das Fahrzeug selbst führt
   (`bcm.coding_block`); die Ausnahme ist an `encoding === "bitmask"` gebunden, damit sich
   keine Messgröße dort eintragen kann. Gefunden hat der erste Lauf die eine Hälfte: der
   ABS-Modul meldete zwei Räder, während das Modell vier fährt und `breakSensor()` an
   jedem der vier etwas kaputt machen kann — eine Ursache, die niemand ablesen kann. Das
   Paket deklariert die beiden Hinterräder seither auf dem DID, das das Modul schon
   antwortet (`0xF40D`, vier Werte, Provenance `own`, keine erfundene Nummer). Und weil
   eine Mode-Union eine Zusage ist, hat `faultedWheelSpeed` keinen `default`-Zweig: ein
   neuer Modus muss beantwortet sein, bevor der Baum baut.
## Gemessen beim Bauen (das hier steht, weil es sonst eine Anekdote bleibt)

- **Die Cause-API war schmaler als ihr eigenes Vokabular**: `breakSensor()` nahm drei der
  sechs `SensorFaultMode`-Arten an, das Szenario-Format alle sechs — `short-to-ground` war
  vom Fahrzeug aus unerreichbar, obwohl das Modell es seitlich auf null zieht. Typ jetzt auf
  die Union; der Fehler war unsichtbar, weil jede Teststelle eine der drei zuließ.
- **Rundung frisst Akkumulation.** `batteryVoltage` pro Schritt auf 0,01 V gerundet, bei
  0,0037 V pro Schritt: die Spannung bewegte sich 40 s Modellzeit nicht — ein
  Lade-system-Ausfall ohne Effekt. Integration akkumuliert jetzt ungerundet; kodiert wird
  über die DID-Skala.
- `holdMs` **liftete nicht**: der Runner hob Aufhebe-Ereignisse aus dem Zeitplan, rief aber
  kein `undo()`. Zwei Szenarien liefen deshalb „für immer weiter".
- `attach()` prime `lastHeard`. Damit galt jeder Peer als gehört, und Regel 4 (Silence nach
  Speech) war unwirksamer Code. Priming ist raus; `reset()` leert die Liste.
- **Lichtmaschine maskiert die Batterie**: „Batterie auf 10 V ziehen" bei laufendem Motor
  ändert die Schiene nicht. Das ist korrekt, war aber die still Voraussetzung von drei
  Tests — sie stating jetzt `alternator: 0` oder `ignition: off`. Die Gegenrichtung
  (Load Dump) wirkt nur, weil der Regler `max(chargeTargetV, batteryVoltage)` ist: eine
  Regulierung hält eine Schiene auf Ziel, sie saugt keinen Spannungsstoß weg.
- **Anlasser-Rampe**: 900 rpm/s ließ den Motor nach 230 ms fangen — die Unterspannungs-
  lücke war kürzer als der Debounce, B1001 latchte nie. Rampe 250 rpm/s (≈ 1 s) macht den
  Unterschied zwischen „Orgeldrehzahl zu niedrig" und „Kurbeln ohne Start" messbar.
- **Fangen ist ein Sprung**: ohne `rpm = max(rpm, 480)` beim Zünden landet die erste
  Verbrennung unter der Abwürgschwelle, und jeder Start dieses Modells ist ein Stillstand.
- Ein `contact`-Fenster, das aus `lastFlap` indexiert wird, ist immer „1" — der Wackel-
  kontakt blieb für immer offen. Gezählt wird seit `flapOrigin` (Anwendung des Fehlers).
- Per-Satz-Ziehen am Kontakt ist Rauschen, kein Wackelkontakt: `flapMs` (Fenster) plus
  `pattern: "alternate"` (periodisch, rng-frei) macht ein intermittierendes Szenario
  reproduzierbar, **unabhängig von der Zufallsquelle des Aufrufers**.
- Der Runner wertete Erwartungen nur an Cause-Momenten aus — eine Erwartung `atMs: 1500`
  ohne Cause an der Stelle wurde **nie geprüft** und war damit grün. Momente sind jetzt
  Cause- **und** Prüfzeitpunkte.
- Der 5-ECU-Simulator startet mit leerem Fehlerspeicher (`startWithStoredFaults: false`);

- **Ein Tablett mit vierzehn Zeilen, dreizehn davon falsch beschriftet.** Das erste Panel
  zeigte den Fehlerspeicher als 14 Zeilen, 13 mit Status `0x00`, und die Zeilen sagten
  „gespeichert“. Sie kamen aus dem dokumentierten Vokabular des Modells (`dtcMemory`: Codes,
  die die Monitore melden *könnten*), gemeldet war einer. Eine Tabelle ohne Nenner ist eine
  Aussage, die sich der Leser selbst basteln muss. Seither dekodiert `toMemoryRows` den
  Statusbyte mit demselben `decodeDtcStatus` aus `@vdp/protocols-uds`, das auch die UDS-Lesung
  benutzt, und `toMemoryNote` nennt die Hälfte, die zählt: „1 von 14 dokumentierten Codes sind
  im Fehlerspeicher gemeldet“. Kein neuer Rand: `apps/web` hatte das Paket schon als Dependency.
- **Die Frontends waren die letzte Schicht ohne Prüfer — und ihre Fehlerklasse war nicht die
  der Typen.** Ein `checkJs`-Pass deckt Seitentypen ab, aber eine ID, die kein Markup hat,
  wirft zur Laufzeit und reißt die Module mit, die nach ihr geladen werden. Der naheliegende
  Prüfer war ein enger Kreis „nur die Workbench“; geworden ist `apps/web/test/markup.spec.ts`,
  das alle `public/*.js` gegen `index.html` scannt (94 Selektoren gegen 140 IDs, gemessen am
  Commit von 1.35) und zusätzlich die Hosts des neuen Panels einzeln pinnt — der Biss ist durch
  Umbenennen einer Host-ID bewiesen, nicht durch Behaupten.
  die Paket-Codes sind sonst Einträge, die kein Monitor gelatcht hat.

## Konsequenzen

- `setEcuOnline(ecuId, boolean)` ist als Setter verschwunden; `isEcuOnline()` bleibt als
  **abgelesene** Tatsache (`powered && onBus`). Ursachen heißen `cutPower`,
  `restorePower`, `loosenConnector`, `openBus`, `breakSensor`, `setBatteryVoltage`,
  `setElectricalLoad`, `setAlternator`, `drive`.
- Ein Szenario, das einen neuen Code erzeugen soll, muss ihn im Definitions-Paket
  dokumentieren (Regel 3). Das ist Absicht: Wissen entsteht im Datenpaket, nicht im
  Simulator.
- `@vdp/simulators` bleibt werkzeug-seitig; die Schichtregeln (ADR 0031) sind unverändert —
  `virtual-can`, `vehicle-*` und `scenarios` importieren nur shared/core/definitions/
  protocols-uds/transport-*.
- Coverage: `tools/**` hat bewusst kein Per-File-Gate (0.E E20/E16-Kontext); die neuen
  Module liegen bei 88–98 % Zeilen im Suite-Schnitt. Wer sie steigen lassen will, hebt das
  globale Gate — nicht per Ausnahme.
