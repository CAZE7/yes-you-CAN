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
   gebaut: `app.js` steht mit 1097 Zeilen schon außerhalb des Größenbudgets (0.E E15),
   und eine View, die niemand abdecken kann, ist Schulden statt Funktion. Der Endpoint ist
   die nach oben offene Fläche; das Panel ist ein eigener, kleiner Schritt.

## Gemessen beim Bauen (das hier steht, weil es sonst eine Anekdote bleibt)

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
