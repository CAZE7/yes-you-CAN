# ADR 0061 — DoIP endet nicht am Handle: Verbindung, Lebenszyklus und Sitzung

Status: accepted · Datum: 2026-09-24 · Bezug: ADR 0005 (Simulator/Replay),
ADR 0032 (Lesen/Schreiben getrennt), ADR 0040 (Verhaltensmodell), ADR 0060
(Adapter-Zustand), Master-Prompt P2

## Problem

DoIP war im Baum vorhanden, aber nicht *benutzbar*. Gemessen am Code vor dieser
Änderung:

| Baustein | Zustand |
|---|---|
| Codec (ISO 13400-2 §7, §9) | ✅ `message.ts`, mit Konformanz-Vektoren |
| Routing Activation + Timeout | ✅ `transport.ts`; ein verweigerter Aufruf gibt den Socket frei |
| UDP-Discovery | ✅ `discovery.ts` (injizierter Datagram-Socket) |
| Transport-Seam in der Engine | ✅ `DoipEcuLinkFactory` (Runtime) |
| **Reale Sockets** | ❌ niemand im Produkt erzeugt einen TCP-Socket; nur Test-Doubles |
| **Verbindungsverlust** | ❌ `DoipSocket` hatte kein `onClose`/`onError`: ein schlafendes Fahrzeug las sich wie ein schweigendes Steuergerät (Timeout) |
| **Reconnect** | ❌ keine Policy; ein toter Socket blieb tot |
| **Adressierung aus der Discovery** | ❌ die Antwort der Discovery wurde nirgends zu einem ECU-Ziel |
| **Sitzung** | ❌ ein per `attach()` angebundenes ECU erzeugte ein Handle **ohne** Sitzungsdatensatz — `engine.vehicleSession` blieb `null`, also gab es keine IR-Sicht, keine Evidence-Menge und keinen Bericht für die DoIP-Strecke |
| **Reproduzierbare Gegenstelle** | ❌ nur Fake-Sockets in Tests, keine virtuelle DoIP-Entity |

Der Kern des Problems ist der letzte Punkt: Die Diagnose-Plattform hängt am
Sitzungsdatensatz. Ein Transport, der ECUs anbinden kann, aber keine Sitzung
erzeugt, endet genau am Handle — unabhängig davon, wie gut der Codec ist.

## Entscheidung

**Alle sieben Lücken schließen, keine neue Abstraktion einführen.**

1. **Reale Sockets sind Host-Bindings** (`@vdp/adapter-host/src/doip-socket.ts`):
   `createDoipTcpSocket` (TCP, mit `onClose`/`onError`, begrenztem
   Connect-Timeout und `isSecure()` = false für den Klartext-Kanal) und
   `createDoipUdpSocket` (Broadcast + Empfangsfenster). Die Architektur bekommt
   dafür **eine** neue Kante: `@vdp/adapter-host` → `@vdp/transport-doip`, mit
   derselben Begründung wie `→ @vdp/transport-can` (die Schnittstelle muss dort
   importierbar sein, wo die Implementierung liegt). `node:net`/`node:dgram`
   bleiben in der Host-Schicht.
2. **Der Tod der Verbindung ist ein Zustand, kein Timeout** (`transport.ts`):
   `DoipSocket.onClose?/onError?` sind Teil des Vertrags; stirbt die Verbindung,
   geht der Transport nach `error` mit dem Grund, alle wartenden `receive()`
   scheitern **mit diesem Grund**, und `send()`/`receive()` auf einem toten Link
   nennen ihn in der Meldung. Die Basis-Meldung bleibt unverändert („DoIP
   transport is not connected“), damit bestehende Zusicherungen gelten.
   Ein **NACK bleibt Daten**, kein Link-Fehler — die bestehende Suite pinnt das.
3. **Die Sitzung entsteht beim expliziten Anbinden.** `EcuLinkFactory` bekommt
   ein optionales `describe(): { adapter, transport }`. Beschreibt die Fabrik
   sich (DoIP tut das), legt `DiagnosticEngine.attach()` den
   `VehicleSession`-Datensatz an — mit Adapter, Transport, Paket- und
   Plattformversion — und trägt das ECU ein. Beschreibt sie sich nicht (ein
   Test-Double, ein geskripteter Link), bleibt es beim bisherigen Verhalten:
   kein Datensatz ist besser als ein erfundener. Danach funktionieren
   `sessionObservationOf`, `collectEvidence`, Bericht und Aufzeichnung für eine
   DoIP-Sitzung genau wie für eine CAN-Sitzung.
4. **Die Reconnect-Policy ist eine Regel, zwei Aufrufstellen.** `ReconnectPolicy`,
   die Grenzen und `reconnectPolicyOf` ziehen nach `@vdp/shared`
   (`packages/shared/src/reconnect.ts`); `@vdp/adapter-host` re-exportiert sie
   unverändert (öffentliche API stabil), die DoIP-Link-Fabrik nutzt dieselbe.
   Die Verletzung der Regel ist damit nicht eine zweite Policy, sondern eine
   zweite Naht: ein Supervisor um einen Bus, ein Supervisor um eine
   TCP-Verbindung.
5. **Der DoIP-Link ist ein Objekt, das die Sitzung überlebt.** `SupervisedDoipLink`
   (Runtime) hält die jeweils aktuelle `DoipTransport`-Instanz, meldet Zustände
   über den `ConnectionTracker` aus ADR 0060 (`connected`, `degraded`,
   `recovering`, `error`) und gibt sein Budget in genau einer Wiederbelebung pro
   Vorfall aus. Eine Wiederbelebung ist **Socket öffnen *und* Routing Activation**
   — eine TCP-Verbindung ohne Aktivierung ist kein Diagnose-Link. Eine Anfrage,
   die den Tod trifft, scheitert mit dem Grund; die nächste findet den
   wiederbelebten Link. Kein versteckter Retry über einem Timeout: ein Timeout
   des Steuergeräts ist keine Verbindungsstörung und wird nicht hier wiederholt.
6. **Die Gegenstelle ist ein Simulator, kein Mock**
   (`tools/simulators/src/doip-entity.ts`): `startVirtualDoipEntity` bindet
   echtes UDP + TCP auf Loopback, dekodiert mit dem Produktions-Codec und
   beantwortet Diagnosemeldungen aus einem UDS-Handler. Es kann gezielt falsch
   sein: Routing-Aktivierung mit wählbarem Antwortcode, schweigende Aktivierung,
   verzögerte Antworten, fehlende Positive-Acks, nicht routbare Zieladressen,
   Generic-NACKs für gewählte Payload-Typen und `killConnections()` für ein
   Fahrzeug, das einschläft. Damit ist die DoIP-Strecke ohne Hardware und ohne
   erfundene Bytes reproduzierbar.

## Konsequenzen

- **Der Weg ist durchgehend und getestet:**
  Discovery (echtes UDP) → logische Adresse → Routing Activation → DoIP-Frame →
  UDS → Engine → `sessionObservationOf` (Diagnostic IR) → `collectEvidence`.
  `tests/integration/doip-pipeline.test.ts` fährt ihn über echte Sockets.
- **Fehlerpfade sind Daten:** verweigerte Aktivierung (Antwortcode), schweigende
  Aktivierung (Timeout), nicht routbares Ziel (Negative Ack im `lastError`),
  toter Socket (`error` + Grund), aufgebrauchtes Budget (`error` + Grund),
  TLS-Pflicht gegen Klartext (`error`), nicht erreichbarer Endpunkt
  (Adresse im Grund).
- **Der Architektur-Gate hat mitgezogen:** zwei neue Kanten
  (`@vdp/adapter-host` → `@vdp/transport-doip`, `@vdp/simulators` →
  `@vdp/transport-doip`), und `@vdp/simulators` steht jetzt in der
  Node-Builtin-Ausnahme — ein Netz-Simulator ohne Socket wäre eine Attrappe
  seiner selbst, und das Paket ist ein Werkzeug, das nichts importiert.
- **Was ausdrücklich *nicht* dazukam:** TLS. `requireTls` lehnt einen
  Klartext-Socket ab (fail closed), aber es gibt keine `tls.connect`-Bindung.
  Das ist derselbe Vertrag mit einem anderen Socket und bleibt offen (siehe
  Status).

## Belege

- `tests/integration/doip-pipeline.test.ts` — 9 Szenarien über echte Sockets:
  Discovery → Zieladresse; vollständige Pipeline bis zur Evidence-Menge (mit dem
  ehrlichen „unproven“-Ergebnis für einen Code, den keine Definition erklärt);
  verweigerte Aktivierung; schweigende Aktivierung; nicht routbares Ziel;
  wiederbelebte Verbindung; aufgebrauchtes Budget; TLS-Pflicht; toter Endpunkt.
- `tests/integration/doip-engine.test.ts` — unverändert grün: der Seam-Test
  bleibt gültig (Fake-Socket, keine Netzwerkabhängigkeit).
- `packages/transport/doip/src/doip.spec.ts` / `message.spec.ts` — unverändert
  grün, inklusive der Zusicherung „ein NACK ist Daten, kein kaputter Link“.
- `packages/adapters/host/src/reconnect.spec.ts` und
  `tests/integration/adapter-rehearsal.spec.ts` — unverändert grün: die
  verschobene Policy ist dieselbe.
- Gates: `npm run check:deps` (29 Pakete, 94 Kanten, keine Verstöße),
  `npm run check:manifests` (Importe und `package.json` stimmen überein).

## Ehrlich offen

- **Kein echtes Steuergerät, kein echter Gateway.** Alle Belege stammen aus der
  virtuellen Entity auf Loopback; ein Fahrzeug mit DoIP-Gateway bleibt Tag X.
- **TLS ist nicht implementiert** (nur erzwungen), also auch die Ports 3496 nicht
  erreichbar.
- **Die Workbench startet noch keine DoIP-Sitzung.** Der Weg ist über Runtime
  und Tests fahrbar, nicht über einen Schalter im Arbeitsplatz; das braucht eine
  Auswahl „Transport: DoIP“ plus Endpunkt-Eingabe und ist der nächste Schritt
  (Backlog E36).
- **Mehrfach-Verbindungen und Alive-Checks im Dauerbetrieb** sind nicht
  gemessen: die Entity antwortet auf Alive-Checks (der Codec-Pfad existiert),
  aber ein Stabilitätslauf über Stunden gehört zum Hardware-/Integrations-Tag.
- **`mtu: 65535`** ist die Obergrenze des DoIP-Diagnosemessagings, nicht die
  einer Segmentierung — ISO 14229-5 verlangt keine ISO-TP-Schicht über DoIP, und
  der Wert sagt „keine Segmentierung nötig“, nicht „65535 ist gemessen“.
