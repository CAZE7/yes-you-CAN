# 0019 — Das Zeitbudget der ECU-Discovery ist explizit, injizierbar und gehört zum Command-Vokabular

Status: accepted · Datum: 2026-09-12 · Bezug: AGENTS 12, 31, 34.21; ADR 0005, 0014, 0017

## Kontext

Die ECU-Discovery (`packages/core/src/diagnostics/discovery.ts`) hört nach einem
Funktionalprobe eine Weile mit (`windowMs`, Default 1200 ms) und tastet
zusätzlich jeden Kandidaten einzeln ab — mit einer hart verdrahteten Pause von
15 ms zwischen zwei Probes.

Damit war `windowMs` nicht das, was der Name verspricht. Gemessen am 2026-09-12:

- `engine.connect({ windowMs: 30 })` gegen das Generik-Paket (11 Kandidaten)
  dauerte **200 ms** — 30 ms Fenster plus 11 × 15 ms Probepause.
- Ein Connect ohne Optionen dauerte **~1,37 s**, und zwar in *jedem* Test, der
  ein Fahrzeug verbindet: Replay-Suite 11,74 s, Integrations-Suite 36,67 s,
  Gesamtlauf 71,69 s bei 971 Tests.
- Der Workbench-Start gegen den Simulator wartete dieselben ~1,37 s, bevor die
  erste ECU sichtbar wurde — obwohl `VirtualCanNetwork` ohne `latencyMs`
  synchron und verzögerungsfrei antwortet (ADR 0005).
- Auf der Command-Ebene ließ sich nur `windowMs` übergeben; die Probepause war
  von außen nicht erreichbar, obwohl `DiscoveryOptions.sleep` als Injektion
  bereits existierte.

Gleichzeitig warteten vier Tests der Workbench mit festen `setTimeout`-Werten
(300–400 ms) auf Live-Samples, die der 60-ms-Poll-Loop normalerweise nach
~70 ms liefert: auf einer schnellen Maschine verschenkte Zeit, auf einem
beladenen CI-Runner ein Rennen — genau die Klasse von Instabilität, die
AGENTS 0.E (E9) mit „explizite Waits statt Sleeps“ adressiert.

## Entscheidung

1. **`probeDelayMs` wird Teil der Discovery-Optionen** und ist über
   `DiagnosticEngine.connect()`, `VehicleService.connect()` und das Kommando
   `connectVehicle({ windowMs, probeDelayMs })` erreichbar. Der Default bleibt
   `DEFAULT_PROBE_DELAY_MS = 15` — reale Busse werden weiterhin nicht geflutet.
   Die tatsächlich verbrauchte Zeit ist damit
   `windowMs + Kandidaten × probeDelayMs` und im Start-Log sichtbar
   (`windowMs`, `probeDelayMs`, `candidates`).
2. **Tests fahren ein explizites Budget** (`windowMs` klein, `probeDelayMs: 0`)
   statt des versteckten Defaults. Determinismus bleibt Vorrang (AGENTS 31);
   gemessen wird weiterhin gegen Simulator und Replay, nie gegen Echtzeit.
3. **Die Workbench wählt das Budget pro Transportquelle.** `DemoBackend`
   übergibt im Simulator-Modus `{ windowMs: 40, probeDelayMs: 0 }`; Replay und
   Hardware behalten den Core-Default, weil dort das Fenster überhaupt erst
   spät antwortende Steuergeräte sichtbar macht. Ein explizites
   `BackendOptions.discovery` überschreibt beide.
4. **Feste Sleeps in Tests werden durch Bedingungs-Waits ersetzt**
   (`waitFor`/`waitForSamples` in `apps/web/test/server.spec.ts`): gewartet wird
   auf das Ereignis (Sample in der Aufnahme), nicht auf eine Zeitspanne.
5. **DoIP-Discovery bekommt dieselbe Injektion** (`sleep`, Default
   `DEFAULT_DISCOVERY_WINDOW_MS = 1000`), damit auch das UDP-Fenster testbar
   ist, ohne Echtzeit zu verbrauchen — konsistent zur CAN-Discovery.

## Konsequenzen

- Gemessen nach der Umstellung (Node 22, 2026-09-12): **Gesamtlauf 71,69 s →
  23,83 s**, Replay 11,74 s → 1,41 s, Integration 36,67 s → 7,71 s,
  Regression 3,97 s → 1,57 s. 991 Tests grün. In der CI desselben PRs
  fiel die Job-Laufzeit von 39 s auf 18 s.
- Der Operator spült denselben Gewinn: ein Kaltstart der Workbench gegen den
  Simulator (`DemoBackend.start()`, gemessen über den kompilierten Build)
  dauerte **1413,5 ms** mit dem alten Default und **69,1 ms** mit dem
  Simulator-Budget — Faktor 20,5 bei identischem Ergebnis (`connected: true`,
  3 ECUs). Über HTTP nachgemessen: `POST /api/start` 83 ms, danach
  `dtc/scan` (8 DTCs über 3 ECUs), `live/start` → 10 Samples/8 Marker nach
  einer Sekunde, CSV- und PDF-Export jeweils HTTP 200.
- Kürzere, deterministischere Läufe senken die Wahrscheinlichkeit, dass die CI
  Retries braucht; sie sind die Voraussetzung, um `retry: 2` in
  `vitest.config.ts` irgendwann zu senken (AGENTS 0.E, E9).
- `windowMs` allein begrenzt die Discovery weiterhin nicht — wer ein hartes
  Zeitbudget braucht, setzt beide Werte. Das ist jetzt dokumentiert statt
  überraschend.
- Ein Produktionsanschluss mit sehr langsamen Steuergeräten kann über
  `probeDelayMs` *hoch*gedreht werden, nicht nur herunter: die Option ist kein
  Test-Schlupfloch, sondern ein Bus-Parameter.

## Alternativen

- **Den Default senken** (z. B. 1200 → 200 ms): hätte reale Adapter schlechter
  gemacht, um Tests zu beschleunigen — falsche Richtung.
- **`sleep` global in Tests fake'n** (`vi.useFakeTimers`): bricht die
  Integrations- und Replay-Suiten, die bewusst über echte Sockets und echte
  HTTP-Server laufen (AGENTS 31, Ebene Integration).
- **Eine Aufnahme pro Replay-Suite teilen** (`beforeAll`): wäre schneller
  gewesen, hätte aber acht Tests an einen gemeinsamen Zustand gekoppelt. Das
  explizite Zeitbudget entfernt dieselbe Wartezeit ohne diese Kopplung.
