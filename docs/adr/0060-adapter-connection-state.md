# ADR 0060 — Der Adapter hat einen Zustand, nicht nur ein Boolean

Status: accepted · Datum: 2026-09-24 · Bezug: ADR 0001 (Schichten), ADR 0033
(fehlende Evidenz ist ein Fehlschlag), Backlog E31/E32/E34, Master-Prompt P1

## Problem

Die Frame-Schicht kannte genau eine Aussage über den Draht: `isOpen(): boolean`.
Gemessen am Code vor dieser Änderung:

| Situation | `isOpen()` | Was der Techniker liest |
|---|---|---|
| nie geöffnet | `false` | „offline“ |
| ELM327, Handshake nie beantwortet (falsche Baudrate, toter Klon) | `true` — `open()` setzte `opened = true` **vor** der Init-Sequenz und ließ es bei einem Fehler stehen | „verbunden, Fahrzeug schweigt“ |
| Bluetooth-Abbruch mitten in der Sitzung | `false` | „offline“ |
| Supervisor versucht gerade, das Gerät wiederzubeleben (E34) | `false` | „offline“ |
| Wiederbelebungs-Budget aufgebraucht | `false` | „offline“ |
| Adapter antwortet, verweigert aber Frames (`BUS BUSY`, `BUFFER FULL`) | `true` | „verbunden“ |

Fünf verschiedene Lagen, zwei Werte — und die gefährlichste Verwechslung ist
die zwischen „das Gerät ist weg“ und „das Fahrzeug antwortet nicht“. Genau diese
Verwechslung kostet am Hardware-Tag eine Stunde (AGENTS 34.21: eine ungemessene
Aussage ist ein Fehlschlag, nicht ein neutraler Wert).

Zusätzlich: `ConnectionStatus` existierte bereits für die **Byte**-Transporte
(`VehicleTransport.getStatus()`, DoIP), aber mit vier Werten und ohne Bezug zur
`CanBus`-Seite. Zwei Vokabulare für dieselbe Frage sind zwei Wahrheiten.

## Entscheidung

**Ein Vokabular, eine Zustandsmaschine, für beide Seiten der ISO-TP-Naht.**

```ts
type AdapterConnectionState =
  | "disconnected"  // kein Link; nie geöffnet oder bewusst geschlossen
  | "connecting"    // Handshake läuft
  | "connected"     // Link trägt; sagt nichts über das Fahrzeug
  | "degraded"      // Link steht, das Gerät hat einen Frame verweigert — nutzbar, nicht vertrauenswürdig
  | "recovering"    // eine begrenzte Reconnect-Policy gibt ihr Budget aus
  | "error";        // Link unbrauchbar, bis jemand handelt — mit Grund
```

1. **`degraded` und `recovering` sind keine Fehler.** `degraded` trägt weiter
   Frames (ein ELM327, der einmal `BUS BUSY` gesagt hat), `recovering` ist eine
   Policy, die noch Budget hat. Beide zu `error` zu machen wäre Alarmismus,
   beide zu `connected` zu machen wäre genau der stille Zustand, den es zu
   beseitigen gilt. `USABLE_CONNECTION_STATES` listet die nutzbaren Zustände
   **einmal** auf; ein Test hält die Liste gegen die Maschine.
2. **`ConnectionTracker` ist die einzige Zustandsmaschine**
   (`packages/transport/can/src/connection.ts`): Zustand, Grund, Zeitpunkt,
   begrenzte Historie, Listener. Adapter melden, was sie beobachten — sie
   erfinden keine eigene Maschine. Wiederholung ist **kein** Übergang; ein
   Listener darf nur bei echten Wechseln geweckt werden.
3. **`CanBus.getStatus(): ConnectionStatus` ist Pflicht**, nicht optional. Ein
   Adapter, der keinen Link hat (Replay, virtuelle Leitung, Passthrough), sagt
   trotzdem, in welchem Zustand er ist — und benennt es im `detail`.
4. **`ConnectionState` bleibt der Name** und ist jetzt die Obermenge; DoIP und
   die Frame-Schicht antworten mit denselben Worten. `ConnectionStatus` trägt
   zusätzlich `stateReason` und `since`.
5. **Der Zustand ist sichtbar**: `AppState.connection` liefert ihn in den
   Arbeitsplatz, das Adapter-Panel zeigt `<state> · <Grund>`.

Zustandsübergänge, wie sie die Adapter tatsächlich fahren:

| Auslöser | Übergang |
|---|---|
| `open()` | `connecting` → `connected` |
| Handshake scheitert (still, BEL, Bitrate verweigert) | `connecting` → `error` (+ Grund), `isOpen()` bleibt `false` |
| ELM/slcan verweigert einen Frame bzw. antwortet BEL | `connected` → `degraded` |
| nächstes beantwortetes Kommando / nächster empfangener Frame | `degraded` → `connected` |
| Stream meldet seinen Tod | `*` → `error` (`byte stream failed: …`) |
| Supervisor entdeckt den Verlust mit Budget | → `recovering` |
| Wiederbelebung erfolgreich / Budget aufgebraucht | → `connected` / → `error` |
| `close()` durch den Aufrufer | → `disconnected` |

## Konsequenzen

- **Der Typ erzwingt Ehrlichkeit.** `getStatus()` ist Teil des Ports, also
  scheitert ein neuer Adapter ohne Zustand im Typecheck — nicht erst am Fahrzeug.
  Die Vertrags-Suite (`tests/protocol/contracts/can-bus.contract.test.ts`) prüft
  zusätzlich auf jedem Subjekt: frisch `disconnected`, geöffnet `connected`,
  geschlossen `disconnected`, nie ein Wert außerhalb des Vokabulars, und
  `getStatus()` darf `isOpen()` nicht widersprechen.
- **Ein Fehler, der vorher unsichtbar war, ist jetzt benannt:** ein
  fehlgeschlagener `open()` läuft nicht mehr als offener Adapter weiter
  (ELM327: `opened = false` + `haltedReason`). Das war der Pfad „falsche
  Baudrate liest sich wie ein schweigendes Fahrzeug“.
- **Zähler haben eine Heimat.** `counters` liest jetzt aus dem Tracker; die
  privaten `txCount`/`rxCount`-Felder der Adapter sind weg (eine Regel, eine
  Quelle).
- **Kein Tracker, wo es keinen Link gibt:** GenericCan, Chaos-Proxy und der
  Reconnect-Supervisor delegieren bzw. melden ihren eigenen Zustand; sie
  erfinden keinen. `connectionStatusOf(open, id)` ist die ehrliche Antwort für
  einen Fixture, der wirklich nur an/aus kennt.
- **Nebenwirkung, beabsichtigt:** Die Test-Doubles mussten `getStatus()`
  implementieren (~12 Dateien). Das ist der Preis eines Pflichtfeldes im Port
  und der Grund, warum es nicht optional ist (ADR 0031: eine Regel, die nicht
  greift, ist keine).

## Belege

- `packages/transport/can/src/connection.spec.ts` — 12 Unit-Tests: alle sechs
  Zustände erreichbar, `degraded`/`recovering`-Semantik, Fehler wird beim
  Verbinden gelöscht, Übergänge mit `from`/`to`/`at`/Grund, begrenzte Historie,
  Listener, Listener-Fehler werden **gezählt statt geschluckt**, Zähler.
- `packages/adapters/elm327/src/elm327.spec.ts` — verweigerter Frame →
  `degraded` → nächstes Kommando → `connected`; unvollständige Frame-Zeile wird
  verworfen und der Zähler zählt Frames, nicht Zeilen.
- `packages/adapters/host/src/reconnect.spec.ts` — `recovering` während der
  Wiederbelebung, `error` mit Grund, wenn das Budget aufgebraucht ist.
- `tests/integration/adapter-rehearsal.spec.ts` (echte PTYs, `socat`) — drei
  neue Szenarien: stilles Gerät → `error` mit Ursache statt „offen“; slcan, das
  die Bitrate-Befehlsfolge mit BEL verweigert → `error` mit dem Befehlsnamen;
  verlorene Leitung → `recovering` → `connected` → Budget aufgebraucht →
  `error`.
- `tests/protocol/contracts/can-bus.contract.test.ts` — der Vertrag, auf allen
  sieben Subjekten.

## Ehrlich offen

- **Am echten Fahrzeug ist nichts davon gemessen.** Alle Belege stammen aus
  PTY-Rehearsals und Fixtures; der Zustandsautomat selbst ist unabhängig von der
  Hardware, seine *Auslöser* (welcher ELM-Klon wann `degraded` sagt) bleiben eine
  Tag-X-Frage.
- **`degraded` ist heute konservativ:** ein verweigerter Frame degradiert den
  Link, obwohl ein `?` (unbekanntes Kommando) auch eine Fehlkonfiguration sein
  kann. Beides ist „Link steht, Diagnose geht gerade nicht“ — die Ursache steht
  im `stateReason`, nicht in einer zweiten Zustandsvariablen.
- **SocketCAN meldet `degraded`, nicht `error`, wenn der Kernel einen Send
  ablehnt.** Ein Bus-Off wäre ein `error`; ohne Auswertung der `errno` wird
  nicht geraten, welcher Fall vorliegt — der nächste erfolgreiche Frame heilt
  den Zustand, und der Grund bleibt lesbar.
- **Der Bericht zeigt den Zustand (noch) nicht.** Heute reist er in den
  Arbeitsplatz; eine Report-Sektion „Verbindung“ braucht eine
  Session-Momentaufnahme des Zustands und nicht des Live-Werts.
