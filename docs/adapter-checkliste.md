# Adapter-Checkliste für Tag X (Hardware-Day)

> Stand **2026-09-24**, verifiziert gegen den Branch-Stand dieses PRs
> (`npm run adapter:doctor` selbst gebaut, PTY-Rehearsal-Suite
> `tests/integration/adapter-rehearsal.spec.ts` 6/6 grün, Full-Suite
> `npm test` grün). Diese Datei ist die operative Brücke zwischen dem Audit
> (Backlog E31) und dem Tag, an dem die Adapter am Fahrzeug laufen müssen.

## 0. Vorab (auf dem Rechner, 2 Minuten)

```bash
npm ci
npm run build
npm run adapter:doctor -- --list-adapters     # Übersicht, was der Rechner kann
node apps/web/dist/src/server.js --doctor --adapter <id> --device <pfad>
```

Der **Adapter-Doctor** ist der Vorab-Check: er läuft die Checkliste des
jeweiligen Adapters in der Reihenfolge ab, in der ein Techniker sie abarbeiten
würde — Einstellungen → Gerät → Handshake/Identität → Fahrzeugseite —
und der **erste** Punkt, der klemmt, nennt Ursache und Hinweise. Exit-Codes:
`0` bereit · `2` Einstellungsfehler · `3` Adapter braucht Aufmerksamkeit.

Dasselbe gibt es **im Arbeitsplatz** (E33): das Adapter-Panel hat einen
„Adapter prüfen“-Knopf, der die im Formular stehende Auswahl prüft, ohne sie
anzuwenden (erst prüfen, dann übernehmen). Die Route
`POST /api/adapter/doctor` antwortet immer mit dem Bericht —
ready / „braucht Aufmerksamkeit“ / blockiert ist ein Befund, kein Fehler; nur
die laufende Sitzung auf genau diesem Adapter wird abgewiesen (409, „erst
stoppen, dann prüfen“). Am Fahrzeug heißt das: der Browser reicht, die Console
ist nur noch für den Fall da, dass gar kein Browser läuft.

**Verlorene Verbindung (E34):** stirbt eine Seriell-Verbindung (Bluetooth
abgebrochen, USB gezogen), versucht die Workbench sie **einmal nach 2 s**
wieder aufzunehmen — Gerät neu öffnen, Adapter-Init erneut, Sitzung läuft
weiter, jede Wiederbelebung steht als Log-Eintrag mit Grund da. Klemmt es
bleibend, bleibt der Endzustand wie vorher: Status zeigt den Fehler, die
Sitzung wird von Hand neu gestartet. Abschaltbar für Messfahrten:
`--reconnect-attempts=0` bzw. `reconnectAttempts: 0` im Body.

## 1. Schnellstart je Adapter

### ELM327 / OBDLink (seriell) — der normale Adapter

```bash
npm run adapter:doctor -- --adapter elm327 --device /dev/ttyUSB0
# grün? dann Workbench:
npm run build && node apps/web/dist/src/server.js \
  --adapter elm327 --device /dev/ttyUSB0 --sessions ./sessions-local
```

- Baudrate-Default **38400** (OBDLink STN: `--baud=115200`).
- Die Leitung wird nur gesetzt, wenn `--configure-port` mitgegeben wird
  (`stty` — absichtlich, ADR 0010; erst versuchen, sonst setzen).
- 29-Bit- oder 250-kBaud-Bus: `--protocol=7|8|9` (Default 6 = 11-Bit/500k).
- Der Doctor meldet Firmware (`ELM327 v…`), Fahrzeugspannung (`ATRV`) und die
  am Bus antwortenden ECUs (funktionales TesterPresent, read-only).

### CANable / CANtact / USBtin (slcan, seriell)

```bash
npm run adapter:doctor -- --adapter slcan --device /dev/ttyACM0
```

- Baudrate-Default **115200**, CAN-Bitrate-Default **500k**
  (`--bitrate=250k|125k|…`).
- `open()` beweist das Gerät (V-Handshake: erwartete slcan-Firmware eindeutig)
  — Schweigen dort heißt fast immer: falscher Port, falsche Baudrate oder ein
  ELM327 als slcan gewählt (die beiden „verstehen sich nicht”).
- **Listen-only**: `--listen-only` öffnet wirklich mit `L` — kein Frame wird
  bestätigt und kein Ping gesendet (Doctor-Schritt „Fahrzeug-Ping” = dann
  bewusst übersprungen).

### SocketCAN (nur Linux)

Reihenfolge der Verbindung: **natives Modul** (`npm i socketcan`, braucht
node-gyp) → **can-utils-Fallback** (`sudo apt install can-utils`, kein
nativer Build, ein Prozess pro gesendetem Frame) → klare Absage mit beiden
Installationswegen.

```bash
sudo ip -details link show can0            # existiert? up? Bitrate?
sudo ip link set dev can0 up               # nötig, wenn „down”
npm run adapter:doctor -- --adapter socketcan --channel can0
# Trockenübung ohne Hardware:
sudo modprobe vcan && sudo ip link add dev vcan0 type vcan && sudo ip link set up vcan0
```

**CAN-FD** (z. B. `ip link set can0 type can bitrate 500000 dbitrate 2000000
fd on`): `--can-fd` schaltet den Adapter auf FD — erst dann wirbt er mit der
Fähigkeit und ISO-TP segmentiert in 64-Byte-Frames. Ohne das Flag bleibt der
Adapter klassisch, auch wenn die Hardware mehr könnte: eine Fähigkeit, die
nicht verhandelt wurde, wird nicht angenommen (AGENTS 4). Die Flags (`fd`,
`brs`) reisen seit 2026-09-24 durch Bindung und can-utils-Fallback in beide
Richtungen — davor wurde jedes FD-Frame auf dem RX-Weg zu einem klassischen
flachgedrückt.

Probe und Öffnen lesen `/sys/class/net` (Existenz, ARPHRD_CAN, operstate) —
**„Interface down” ist der häufigste echte SocketCAN-Fehler** und wird jetzt
mit dem Aufruf-Kommando benannt, nicht mit einem I/O-Error aus der Tiefe.

### Simulator / Replay

Braucht keine Hardware und wird vom Doctor als `managedBy: application`
erkannt (kein Hardware-Check). Start: `npm run demo`.

## 2. „Geht nicht” → Tabelle der Ursachen

| Symptom | Wahrscheinlichste Ursache | Was der Doctor sagt | Was tun |
|---|---|---|---|
| exit 2, Schritt „Einstellungen” ✗ | fehlendes `--device`/`--channel` (pflicht je Adapter) | `adapter "elm327" needs --device=<serial device>` | Pflichtwert ergänzen |
| exit 3, „Verfügbarkeit” ✗ `ENOENT` | falscher Pfad, Adapter nicht eingesteckt | `… is not usable: ENOENT …` + Kandidatenliste | `ls -l /dev/ttyUSB* /dev/ttyACM*`, `dialout`-Gruppe |
| exit 3, „Adapter öffnen” ✗ Timeout | **Baudrate falsch** oder Typ-Verwechslung (elm327 vs. slcan) | `no answer to … within N ms on …` + Hinweise (Baudrate, Port, Adaptertyp) | `--baud=` korrigieren, `--configure-port`, Adaptertyp prüfen |
| exit 3, „Adapter öffnen” ✗ BEL (slcan) | Gerät verweigert Bitrate/Kanal | `slcan refused the slcan bitrate command "S6" (500k) (BEL) — …` | `--bitrate=` wie Fahrzeugbus, kein anderes Programm auf dem Kanal |
| ✗ beim SocketCAN-Binding | weder natives Modul noch can-utils | `no SocketCAN transport available` + beide Install-Wege | `sudo apt install can-utils` (oder `npm i socketcan`) |
| „Verfügbarkeit” ✗ `… is not a CAN interface` | `--channel=eth0` statt CAN | CAN-Interfaces des Hosts als Hinweis | richtiges can0/vcan0 wählen |
| „Verfügbarkeit” ✗ `… is down (down)` | Interface existiert, aber down | `sudo ip link set dev can0 up` als Hinweis | Interface hochnehmen (+ Bitrate vorher) |
| ⚠ „Fahrzeugspannung” | OBD-Stecker nicht am Fahrzeug / keine Fahrzeugspannung (ELM327, ~< 11 V oder keine Antwort) | Spannung + Hinweis | Stecker prüfen, Zündung an |
| ⚠ „Fahrzeug-Ping” keine Antwort | Zündung aus, falsches Protokoll, falscher Bus — **oder leerer vcan0 (dann korrekt)** | `NO DATA` / kein Responder + Hinweise | Zündung an; `--protocol=`; Bus-Stecker-Seite prüfen |
| Multi-Frame-Lesung (VIN, DTC) hängt/schlägt früher mit `STOPPED` fehl | halbduplexe ELM327-Klone (PIC18F25K80): Eingabe im Empfangsfenster bricht es ab | **behoben** (Befehls-Serialisierung, E31; PTY-Rehearsal fährt beide Geräte-Varianten grün) | aktuellen Stand einsetzen |
| Fehlerliste leer, aber keine Antworten je nach Gerät | Fahrzeug antwortet nicht auf 11-Bit/500k | Doctor-Ping ⚠ mit `--protocol=` Hinweis | `--protocol=7` (29-Bit), `8/9` (250k) |

## 3. Was an Tag X garantiert funktioniert — und womit wir noch ehrlich warten

**Durch Code bewiesen (PTY-Geräte-Emulatoren über der echten Seriell-Strecke,
6 Szenarien, grün — `tests/integration/adapter-rehearsal.spec.ts`):**

- ELM327: Single-Frame **und** Multi-Frame-UDS-Rundlauf mit **beiden** echten
  Prompt-Timings (sofortiger Prompt / Fenster + `STOPPED` bei Eingabe im
  Fenster — die Variante der PIC18F25K80-Klone). Bak: Der frühere STOPPED-
  Abbruch bei jeder Multi-Frame-Antwort ist durch die Befehls-Serialisierung
  behoben und rot-zu-grün dokumentiert.
- CANable: Handshake (`V`, Bitrate, `Z1` tolerant, `O`/`L`), voller
  Multi-Frame-Rundlauf, Ablehnungen (BEL) und Schweigen als benannte Fehler.
- Konsistente Scheitern-Wahrheit: kein „connected bei stillem Kabel” mehr —
  jeder Adapter schließt `open()` nur, wenn das Gerät tatsächlich konfiguriert
  wurde; fällt der Link weg (Kabel ab), meldet der Adapter `isOpen() = false`
  (elm327 und slcan gleichermaßen).
- SocketCAN: Loader akzeptiert beide Modul-Formen (`open()`-Vertrag **und**
  npm-`createChannel`), Fallback-Kette native ↔ can-utils, `/sys`-Wahrheit vor
  jedem Öffnen.

**Ehrlich offen (daran ändern wir an Tag X nichts mehr, es ist Ihnen
bekannt):**

- Verhalten gegen **echte** ELM327-Klone mit exotischen Prompt-Timings bleibt
  ein Geräts-Detail — alle Zeitpunkte abseits der beiden gemessenen Varianten
  laufen denselben Code-Pfad, aber „am echten Auto” ist der letzte Beweis.
- Der can-utils-Fallback kostet **einen Prozess pro gesendetem Frame**
  (~1–5 ms): für die Diagnose-Session fine, für einen flutenden Bus ist das
  natives Modul schneller.
- Bluetooth-ELM327-Reconnect: der Verlust wird zuverlässig gemeldet
  (`isOpen() false`, Fehler im Status), ein automatisches Wiederöffnen ist
  (Stand jetzt) bewusst nicht automatisiert.

## 4. 60-Sekunden-Tagesablauf am Fahrzeug

1. Adapter anstecken (USB). `npm run adapter:doctor -- --adapter <id> --device <pfad>` → Exit 0.
2. Zündung an → Doctor erneut: „Fahrzeugspannung” und „Fahrzeug-Ping” ✓.
3. Workbench starten (Befehl oben), im Adapter-Panel ist dieselbe Auswahl.
4. Wenn etwas klemmt: Doctor-Ausgabe lesen — die erste ✗-Zeile ist die Ursache;
   die →-Zeilen danach sind die Abhilfe. Kein Rätselraten in der Deep-Log.
5. Aufzeichnung/Testlauf: `npm run harvest:demo` (Simulator) bzw.
   `node tools/harvest/dist/src/cli.js --adapter <id> --device <pfad> --out ./harvest-x`
   (relas-Read-only Ernter der Realwelt).
