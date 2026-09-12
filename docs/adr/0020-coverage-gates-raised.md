# 0020 — Coverage-Gates nach DoIP- und Chart-Nachtest angehoben

Status: accepted · Datum: 2026-09-12 · Bezug: ADR 0011, 0016 §2, 0017; AGENTS 0.E (E4)

## Kontext

ADR 0017 legt fest: maßgeblich für alle Coverage-Gates ist `vitest.config.ts`,
und Gates bewegen sich nur nach oben — erst hebt gezieltes Nachtesten die
Coverage, dann darf der Gate-Wert steigen. Offen war seit dem Audit vom
2026-09-11 der Eintrag **E4**: `packages/transport/doip/src/transport.ts` war
mit 77,4 % lines / 68,3 % branches der dünnste sicherheitsnahe Kern
(Gate 75/50), `iso-tp/connection.ts` lag ähnlich nah an seiner Grenze.

Zwei weitere Befunde kamen bei der Nachmessung am 2026-09-12 dazu:

- `packages/charts/src/group.ts` — die Synchronisation der Graphen und damit
  Kern von AGENTS 16 — lag bei 77,0 % lines / 77,6 % branches und damit *eine
  kleine Refaktorierung* vom roten Gate (75/70) entfernt. Ein Gate, das nur
  durch Stillstand hält, ist keine Leitplanke.
- Das globale Gate (80/75) lag 15 bzw. 9 Punkte unter dem tatsächlichen
  Projekt-Durchschnitt und hätte einen spürbaren Abbau von Tests erlaubt, ohne
  rot zu werden.

## Entscheidung

Nach dem Nachtesten (alle Zahlen gemessen am 2026-09-12 mit
`npm run test:coverage`, 991 Tests grün) gelten:

| Profil | vorher | nachher | schwächste Datei danach |
|---|---|---|---|
| global (Durchschnitt) | 80/75/80/80 | **90/80/90/90** | — (Ist: 96,3 / 84,2 / 95,9 / 94,4) |
| `transport/**` (per file) | 75/50 | **85/70** | `iso-tp/connection.ts` 92,9 / 75,3 |
| `charts/**` (per file) | 75/70 | **90/75** | `viewport.ts` 92,5 / 77,1 |
| `core/**`, `protocols/**`, `adapters/**`, `storage/**` | unverändert | unverändert | s. `vitest.config.ts` |

Die nachgetesteten Dateien:

| Datei | vorher (lines/branches) | nachher |
|---|---|---|
| `transport/doip/src/transport.ts` | 78,6 / 68,3 | **98,5 / 88,7** |
| `transport/doip/src/discovery.ts` | 91,3 / 52,9 | **100 / 78,9** |
| `charts/src/group.ts` | 77,0 / 77,6 | **99,1 / 91,3** |

`core/**` (85/65) und `adapters/**` (65/45) bleiben bewusst unverändert:
`core/src/diagnostics/ecu-session.ts` liegt bei 85,6 / 65,3 und
`adapters/host/src/catalog.ts` bei 68,0 / 48,6 — beide direkt an ihrer Grenze.
Ihre Anhebung ist erst nach eigenem Nachtest zulässig und steht als offener
Punkt in AGENTS 0.E.

## Konsequenzen

- E4 ist für DoIP erledigt; der Transport-Kern ist nicht länger der dünnste
  sicherheitsnahe Bereich. ISO-TP (`connection.ts` 92,9/75,3) bleibt der
  nächste Nachtest-Kandidat, fällt aber nicht mehr durch ein zu niedriges Gate
  auf.
- Das Nachtesten hat zwei echte Fehler freigelegt, die vorher ungetestet waren
  und deshalb unsichtbar blieben:
  1. Ein fehlgeschlagener Routing-Aktivierung ließ den DoIP-Transport im Zustand
     `connecting` mit offenem Socket und abonniertem Listener zurück —
     `getStatus()` meldete danach dauerhaft einen Zustand, der nie wieder wahr
     werden konnte. `connect()` gibt den Socket jetzt frei und meldet `error`
     mit `lastError` (Test: „a missing routing activation response fails connect
     without a half-open socket“).
  2. `ChartGroup.notify()` fing Ausnahmen eines Subscribers in einem leeren
     `catch {}` — Isolation ist richtig, Schweigen verstößt gegen AGENTS 34.25.
     Die Gruppe meldet den Fehler jetzt über `onListenerError`
     (Default: Debug-Ausgabe).
- Gates bleiben Zitate, keine zweite Wahrheit: diese Tabelle dokumentiert den
  Stand vom 2026-09-12, verbindlich ist `vitest.config.ts` (ADR 0017).

## Alternativen

- **Gates unverändert lassen:** hätte bedeutet, dass 15 Punkte globaler
  Coverage-Abbau unbemerkt durchgelaufen wären.
- **`perFile` global einschalten:** bestraft weiterhin Hardware-Glue
  (`adapters/host/src/catalog.ts` probed externe Kommandos) und steht schon in
  ADR 0016 §2 als bewusste Ausnahme.
