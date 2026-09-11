# 0013 — Transaktionssperre pro Verbindung, nicht pro Anfrage

Status: accepted · Datum: 2026-09-11 · Bezug: ADR 0001, 0005; AGENTS 15, 34.22, 34.26

## Kontext

AGENTS 15 verbietet zwei gleichzeitige UDS-Anfragen pro Sitzung. Die ISO-TP-Verbindung
hatte dafür eine `transmitLock` — aber nur `request()` nahm sie. `sendOnly()` und
`receive()` schrieben und lauschten daran vorbei. Beides ist in dieser Konstellation
kein Randfall, sondern der Normalbetrieb:

- Zwei `sendOnly()`-Aufrufe derselben Verbindung legten ihre First Frames nebeneinander
  auf den Bus, die Consecutive Frames dahinter: `1, 1, 2, 2` statt `1, 2, 1, 2`. Am
  Fahrzeug entsteht daraus keine zweite Nachricht, sondern zwei unbrauchbare.
- Der Quittierungsstrom (NRC 0x78, „response pending") läuft im Client so: `request()`
  liefert die 0x78, danach wartet `receive()` auf die finale Antwort. Mit der 0x78 gab
  die Sperre frei — der periodische TesterPresent schob sich in die Lücke, und die
  Antwort auf `22 F1 90` (`62 F1 90 11 22 33 44`) ging an den TesterPresent. Der
  Anwender sah: VIN-Read „timeout", while the answer had been delivered — to nobody.
- Ein `bus.send()`, das nie erfüllt wird (USB-Kabel halb weg, CANable mit vollem
  Sende-puffer), hielt die Sperre auf unbestimmte Zeit. `close()` gab sie nicht zurück,
  also hing auch die nächste Verbindung an derselben Kette.

Ursache ist jeweils derselbe Kategorienfehler: Die Sperre wurde als Schutz von
*Anfragen* missverstanden, obwohl sie den Besitz eines *Transaktionszeitraums* regelt.

## Entscheidung

- **Der Besitz der Verbindung ist die Einheit, nicht der Aufruf.** `request()`,
  `sendOnly()` und `receive()` laufen alle durch `enqueue()` auf derselben Kette. Da
  damit höchstens eine Transaktion offen ist, ist der einzelne `pending`-Slot für die
  Antwort-Zuordnung korrekt — er war vorher eine Datenstruktur, die nur unter
  Serialisierung stimmt, ohne dass sie sie bekam.
- **Wartende Antworten beanspruchen die Kette ab dem Aufruf.** `receive()` meldet seinen
  Lauscher synchron an (ein Frame eine Mikrosekunde später darf nicht verloren gehen),
  berechnet die Deadline beim Anruf und *nicht* beim Erhalt der Sperre, und hält die
  Kette bis die Antwort da ist oder das Budget um ist. Wer danach `request()` ruft,
  wartet hinter der ausstehenden Antwort — das ist der gewünschte Fall.
- **Die Regel sitzt in der Brücke, nicht in jedem Transport.** `RequestResponseLink`
  (DoIP, Replay, Gateway) bekommt dieselbe `enqueue()`-Semantik für `sendOnly()` und
  `receive()`; sonst müsste jeder neue Transport das Fehlerbild einzeln vermeiden.
- **Adapterzugriff ist zeitlich begrenzt.** Neu: `IsoTpTiming.sendTimeoutMs`
  (praktisches N_As, Standard 1000 ms; 0 schaltet die Begrenzung ab). Ein Schreiben, das
  nicht annimmt, wird als `TransportError` gemeldet und gibt die Kette frei. Die
  Protokoll-Timer N_Bs/N_Cr bleiben davon unberührt — sie betreffen das Gegenüber.
- **`close()` räumt auf beiden Seiten auf:** offene Anfragen, Flow-Control-Wartende und
  ein lauschendes `receive()` werden erfüllt, die Kette auf einen bereits erfüllten
  Promise gesetzt. Ein „später sowieso weg" gibt es nicht, weil das Aufräumverhalten
  genau den Fall bestimmt, in dem ein erneutes `open()` wieder benutzbar ist.
- **Ein wiedergenutzter Antwort-Slot ist ein Fehler, kein Zustand.** Wäre die
  Serialisierung jemals umgangen, wird der alte Wartende laut abgewiesen und
  `log.error` gemeldet — nicht schweigend bis zum Timeout vertröstet.

## Konsequenzen

- Der TesterPresent kann sich hinter einer langen Routine einordnen (bis zu P2*). Das
  ist bewusst: Ein Keepalive, der die Sitzungsregel verletzt, ist schlechter als einer,
  der 50 ms zu spät kommt. Wer das nicht will, verkürzt P2*/S3 — nicht die Sperre.
- `IsoTpConnection.receive()` ist nicht mehr „ein Listener, der jederzeit reinplatzt",
  sondern ein Transaktionsbesitz. Ein Aufrufer, der dauerhaft lauschen will, nimmt
  `onUnsolicited()` — die Aufteilung ist jetzt explizit.
- `sendTimeoutMs` ist eine neue Stellschraube für Embedder langsamer Strecken (seriell
  über Bluetooth, gateway-seitige Puffer). Der Default liegt deutlich über realistischer
  USB-Seriell-Latenz; ein Wert `< 1` deaktiviert die Begrenzung, statt sie zu halbieren.
- Die Regressionstests sitzen in `packages/transport/iso-tp/src/connection.spec.ts`
  (Rahmenreihenfolge, 0x78-Schwanz, blockiertes Senden, `close()`) und
  `packages/protocols/uds/src/link.spec.ts` (Brücke). Alle vier sind
  Mikrosekunden-deterministisch über das virtuelle Bussystem, ohne echte Zeit und ohne
  Socket (AGENTS 31).
- Nicht Teil dieser Entscheidung: die Konformitätskorrekturen an STmin, slcan und
  DoIP-Routing-Aktivierung, die im selben Stand enthalten sind. Sie ändern keine
  ownership-Regel, nur Byte-Layout und Timings.
