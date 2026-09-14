# ADR 39 — Fault-Injection auf dem Draht, und eine abgeschnittene Antwort ist kein leerer Fehlerspeicher

- Status: akzeptiert (2026-09-14)
- Kontext: AGENTS 9 (Timing/Fehlerbehandlung), AGENTS 29 (MVP: was ein Bus kann), ADR 0033 (fehlende Evidenz ist ein Fehlschlag), Master-Backlog P0 #16 (Fault Injection)
- Betrifft: `tools/simulators/src/faulty-link.ts` (neu), `tests/protocol/fault-injection.test.ts` (neu), `packages/protocols/uds/src/client.ts`

## Problem

Jeder Protokolltest dieses Repositories beantwortet dieselbe Frage positiv: was
passiert, wenn ein Steuergerät antwortet. Was passiert, wenn es **nicht** antwortet,
falsch antwortet oder zu spät, stand bisher nur als Einzelfall in `client-engine.spec.ts`
(geskriptete Antworten) — nicht als System.

Beim Ansetzen fiel sofort ein echtes Loch auf: `isPositiveResponse(sid, response)`
prüft **nur das erste Byte**. Ein `0x49`-Antwortrahmen, der auf dem Bus abgeschnitten
wurde, ist damit formal eine positive Antwort; `parseDtcList` lief über die verbliebenen
zwei Bytes, fand kein 4-Byte-Record und gab **`[]`** zurück. Der Kunde sieht: „kein
Fehler gespeichert." Genau die Verwechslung, die ADR 0033 für Messwerte verbietet, war
im Fehlerspeicher noch da — und kein Test der Welt hätte sie gefunden, weil alle einen
gesunden ECU hatten.

## Entscheidung

1. **Ein Fault-Injector am bestehenden Seam, kein zweiter Test-Stack.** `FaultyLink`
   implementiert `UdsLink` (für den Client) **und** `UdsServerLink` (für das `UdsServer`):
   Client und Server hängen an demselben Objekt, der gesunde Pfad bleibt echte
   ECU-Implementierung — only the wire lies. Ein Mock-ECU hätte den Harness getestet.

2. **Nur Faults, die ein Bus erzeugen kann:** Antwort schlucken, Request nicht
   durchlassen, Antwort für eine andere Service-ID, gekürzter Rahmen, Müll hinter
   korrektem SID, hängender Endrahmen nach NRC 0x78, 0x78-Schleife ohne Ende,
   ungeordertes Frame vor der Antwort, Antwort nach dem Timeout. Kein Fault „wirft
   einfach eine Exception", weil kein Kanal das kann.

3. **Der Injector richtet nichts gerade.** `unanswered` parkt Frames, deren
   Transaktion schon vorbei ist (statt sie dem nächsten Request unterzuschieben) —
   dieselbe Regel, die `IsoTpConnection.awaitResponse` über eine Slot-ID durchsetzt.
   `wire` ist ein Protokollsatz: Richtung, Bytes, Schicksal (`sent`/`swallowed`/
   `not-forwarded`/`cut`/`replaced`/`parked`/`injected`). Damit ist auch der Fall testbar,
   in dem der Client **nichts merken kann** (unterdrückte Positive Response über eine
   verlorene Leitung): der Draht erzählt es trotzdem.

4. **Zeit ist injiziert** (`sleep`), damit Timeout-Fälle in Mikrosekunden laufen —
   dieselbe Naht, die das Protokollteam für NRC-0x78-Schleifen benutzt (AGENTS 34.7).
   Der Hygiene-Guard („keine festen Sleeps") hat beim ersten Anlauf zugebissen und den
   Blick auf `waitFor(...)` erzwungen; die Regel funktioniert also.

5. **Der Collector-Fix gehört ins Protokoll, nicht in die Doku:** `parseDtcList` wirft
   jetzt `ProtocolError`, wenn der Rumpf nicht in 4-Byte-Records aufgeht
   (`malformed DTC list: N byte(s); expected 3 header byte(s) plus whole 4-byte records`).
   Eine leere Liste bleibt eine leere Liste (`0x49 0x02 <mask>` = 3 Bytes, Rest 0) —
   „kein Fehler" ist ein Ergebnis, „abgeschnitten" ist ein Fehler.

## Konsequenzen

- Der Fehlerspeicher-Lesepfad (`readDtcByStatusMask`, `readSupportedDtc`) kann jetzt
  mit einem Fehler enden, wo er vorher `[]` lieferte. Genau das ist der Zweck; alle
  1.730 Tests bleiben grün, kein bestehender Test fütterte einen unvollständigen Rahmen —
  das Loch war, wie erwartet, ungetestet.
- Bewusst **nicht** geändert: `stats.timeouts` zählt den Overlauf des
  Pending-Budgets weiter **nicht** (`client-engine.spec.ts` pinnt den Grund: „the
  overflow is a protocol abort, not a transport timeout"). Mein erster Entwurf hatte
  die Zeile hochgezählt — der gepinnte Test hat recht, die Unterscheidung trägt
  (Transport vs. Protokoll), also wurde der eigene Test angepasst, nicht der Pin.
- `tools/simulators` wächst um ein Modul, das nur in Tests atmet; es bleibt ein Tool
  unter `@vdp/simulators` (niemand importiert es in Produktionsschichten), 92,2 %
  Zeilen / 77,6 % Zweige eigenem Harness.
- Fuzzing (Backlog #19: CAN/ISO-TP/UDS/Import-Parser) ist damit **nicht** erledigt — die
  Fault-Injection ist der planbare Teil (eine Liste bekannter Fehlerklassen), das Fuzzing
  der Suchteil; es folgt auf dieser Linie.

## Messung

- `npm run ci` grün; `npm test` **115 Dateien / 1731 Tests** (37,5 s); Coverage global
  94,62 / 87,52 / 96,44 / 95,90 — die globalen Werte sinken um Hundertstel, weil das neue
  Harness-Modul mitgemessen wird (92,2/77,6), nicht weil weniger Code getestet wäre.
- Neu: 14 Fault-Injection-Fälle (Stille, verlorener Request, falsche SID, NRC,
  Busy-Retry genau einmal, Kürzung auf 1 Byte, halber Record, Müll, hängender
  Endrahmen, Pending-Limit, ungeordnetes Frame, Antwort nach Timeout, toter Link,
  unterdrückter Request).
- Die Busy-Wiederholung war dabei eine Überraschung: `retryTransientNrc` retryt
  **genau einmal** und liefert dann die gesunde Antwort — pinnt jetzt beides
  (`link.requests.length === 2`).
