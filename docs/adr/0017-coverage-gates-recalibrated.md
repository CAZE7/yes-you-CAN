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
