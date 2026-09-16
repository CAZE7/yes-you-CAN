# 0017 — Coverage-Gates neu kalibriert: Ist-Zustand statt Aspirationswerte

Status: accepted · Datum: 2026-09-11 · Bezug: ADR 0010, ADR 0016 (korrigiert §2); AGENTS 0.A, 0.E

## Kontext

ADR 0016 §2 dokumentierte Coverage-Gates, die nach der ersten Kalibrierung in
`vitest.config.ts` nochmals angepasst wurden, ohne dass die Dokumentation
nachgezogen wurde. Gemessen am 2026-09-11 galt:

- Die Konfiguration trug niedrigere Werte als ADR 0016 nennt (`core` 85/65
  statt 85/75, `adapters` 65/45 statt 70/60, `transport` 75/50 statt 75/65,
  `storage` 70/45 statt 70/50, `charts` 75/70 statt 80/70) — der
  Branches-Wert für `core` war von 75 auf 65 gelockert worden („war 95/90,
  causing 87 red thresholds“), ohne dass ein ADR die Lockerung trug.
- ADR 0016 behauptete, die Hardware-Module (`serial.ts`, `binding.ts`) seien
  aus `coverage.exclude` *genommen* worden; tatsächlich stehen sie dort als
  bewusste Ausnahme weiter (sie hängen an `node:serialport`/`socketcan` und
  werden über `tests/hardware` geprüft).
- AGENTS.md, README und ADR nannten dadurch jeweils andere Werte — ein
  Verstoß gegen Regel 34.24 (Dokumentation, die vom Stand abweicht, ist ein
  Defekt).

## Entscheidung

- **Maßgebliche Quelle für alle Coverage-Gates ist `vitest.config.ts`.**
  Dokumentation zitiert die Werte, sie dupliziert sie nicht als eigene
  Wahrheit. Stand 2026-09-11: global 80/75/80/80 (lines/branches/
  functions/statements) als Projekt-Durchschnitt; per-file `core` 85/65,
  `protocols` 90/75, `adapters` 65/45, `transport` 75/50, `storage` 90/55
  (nach Nachtesten am selben Tag von 70/45 angehoben), `charts` 75/70.
- **Gates werden nur in eine Richtung bewegt:** Erst hebt gezieltes Nachtesten
  die Coverage (AGENTS 0.E, E4), dann darf der Gate-Wert steigen. Gates
  senken, um rote Coverage durchzuwinken, ist unzulässig — eine Lockerung
  braucht wie hier einen eigenen ADR mit Begründung.
- ADR 0016 §2 gilt damit in seinen Zahlen als korrigiert; die dortige
  Absicht (realistische, aber verbindliche Gates) bleibt gültig.

## Konsequenzen

- `npm run test:coverage` ist lokal wie in der CI der einzige Beleg für
  Coverage-Behauptungen (Regel 34.21).
- `storage/src/repository.ts` wurde am 2026-09-11 von 70 %/46 % auf
  97 %/84 % nachgetestet (Crash-Toleranz der Streams, Migrations-Persistenz,
  Listen-Resilienz); das storage-Gate stieg entsprechend auf 90/55.
  `transport/doip/src/transport.ts` bleibt ein Nachtest-Kandidat (AGENTS 0.E).
- Dasselbe Muster ein drittes Mal angewandt (2026-09-16, AGENTS 0.E E17): die
  Bodenschwelle `apps/web/src/**` stand auf 69/54, während `server.ts` 69,63/65,53
  und `adapters.ts` 73,68/54,54 meldeten. Erst die Tests (`server-paths.spec.ts` für
  Freeze-Frame-Lesung bis aufs Rohbyte, die Absagen, das Body-Limit und die Marker;
  Adapter-Pins für die drei `create()`-Verweigerungen), dann die Schwelle auf 75/66.
  Der Biss ist gezeigt, nicht behauptet: mit `branches: 78` benennt der Coverage-Lauf
  genau `backend.ts` 67,87 und `server.ts` 77,28 und bricht mit EXIT 1. Was die Zahl
  ausdrücklich *nicht* vortäuscht: der CLI-Block am Fuß von `server.ts` bleibt
  ungeprüft, weil die v8-Deckung eines Kindprozesses nicht in die Zählung des Vaters
  fällt — ihn zu spawnen bringt Verhalten, keine Coverage.
- Noch einmal dasselbe Muster, einen Tag später (AGENTS 0.E E17, zweiter
  Schnitt): `backend.ts` meldete 67,87 Zweige, und die Zeile in 0.E nannte die
  Export- und Session-Zweige, die denselben Nachlauf verdienten. Getan:
  `apps/web/test/backend-paths.spec.ts` (8 Tests) geht Replay-Quellen,
  Abbruch bei Session ohne Roh-Trace, Managed-Absage, werfenden Event-Listener,
  Marker vor der Verbindung, Statistik-/Spektrum-Arme und die drei
  Chaos-Schalter durch. `backend.ts` 92,81/67,87 → 95,56/73,89, Schwelle
  75/66 → **76/72**; gemessener Biss mit `branches: 74`:
  `ERROR: Coverage for branches (73.89%) does not meet "apps/web/src/**"
  threshold (74%) for apps/web/src/backend.ts`. Der Puffer ist in Einheiten des
  Einzelnen ausgerechnet, nicht gefühlt: 249 Zweige, einer sind 0,4 Punkte,
  also 1,89 Punkte ≈ vier Zweige; bei den Zeilen sind es 3,67 Punkte unter
  `server.ts` 79,67. Was die Zahl weiterhin nicht vorspielt: die drei
  Aufräum-Fänge in `stop()`, die Zuordnungen für Guide, Anomalie und
  Actions-Zeile, der abgelehnte Marker und der CLI-Block — alles Arme, die eine
  Injektion oder einen Kindprozess brauchen, und ein Test, der eine Zahl hoben,
  indem er einen unbenannten Rest zurücklässt, wäre kein Test. Mit dem
  letzten toten Export (`get canBus()`, kein Aufrufer im Baum) ist die Datei
  1427 → 1419 Zeilen; die Größen-Ausnahme in `hygiene.test.ts` musste auf den
  neuen Wert, und der Lauf hat sie erwischt, bevor irgendetwas grün war —
  Ausnahmen mit Zahl sind Kontrollen, keine Kommentare.
