# 0022 — Coverage-Gates für Export-Pfad und Analyse, storage nachgezogen

Status: accepted · Datum: 2026-09-12 · Bezug: ADR 0016 §2, 0017, 0020, 0021; AGENTS 0.E (E13), 34.21

## Kontext

ADR 0017 legt fest: maßgeblich für Coverage-Gates ist `vitest.config.ts`, und
Gates bewegen sich nur nach oben — erst hebt gezieltes Nachtesten die Coverage,
dann darf der Wert steigen. Die Nachmessung am 2026-09-12 hat drei Lücken
gezeigt, die alle dieselbe Ursache haben: **wo kein per-file-Gate stand, ist
Qualität stehengeblieben.**

1. **`packages/reports/**` und `packages/ai/**` hatten überhaupt kein Gate.**
   Im Export-Pfad saß dadurch ein echter Ausgabefehler: `pdf.ts` schrieb
   UTF-8-Bytes in ein Dokument, dessen Schriften WinAnsi deklarieren — jeder
   Bericht mit Umlaut oder Gradzeichen war Mojibake (ADR 0021). In der Analyse
   lag `http.ts` bei **63,6 % Funktionen**, weil der eingebaute
   `defaultHttpClient` nie ausgeführt wurde, und `service.ts`' Fehlerpfad samt
   `messageOf` war nie gelaufen. Ungetestet war dort auch die Annahme, eine
   Gateway-Antwort sei wohlgeformt: `JSON.parse` wurde blind auf
   `Partial<AnalysisResult>` gecastet.
2. **Das storage-Gate stand auf 90/55, obwohl E13 die Dateien weit darüber
   gehoben hatte** (`zip.ts` 58,1 → 83,9 % Zweige, `migrations.ts` 61,5 → 92,3).
   Die in E13 beabsichtigte Anhebung auf 95/80 war **nie committet** — geprüft am
   2026-09-12: `db5d525` enthält ausschließlich `migrations.ts` und
   `storage.spec.ts`, in `vitest.config.ts` stand weiter 90/55. Ein Gate, das 25
   Punkte unter dem Ist-Wert liegt, erlaubt unbemerkten Abbau.
3. Dieselbe Zeile `error instanceof Error ? error.message : String(error)` stand
   **45 mal in 25 Dateien** (sieben private Funktionen plus 38 inline), keine
   davon getestet — `packages/shared/src/errors.ts` hatte bis dahin keine eigene
   Spec.

## Entscheidung

| Gate (per file) | vorher | neu | schwächste Datei (gemessen) |
|---|---|---|---|
| `packages/reports/**/src/**` | — | **95 / 75** | `report.ts` 100 Zeilen / 78,2 % Zweige, `pdf.ts` 100 / 88,9 |
| `packages/ai/**/src/**` | — | **90 / 75** | `heuristic.ts` 94,9 / 79,5, `http.ts` 100 / 87,7, `service.ts` 100 / 100 |
| `packages/storage/**/src/**` | 90 / 55 | **95 / 80** | `zip.ts` 100 / 83,9, `repository.ts` 100 / 86,1, `migrations.ts` 100 / 92,3 |

Erst die Tests, dann das Gate — die Reihenfolge aus ADR 0017 ist eingehalten:

- `reports.spec.ts` 9 → **12 Tests**: Latin-1-Bytes ohne UTF-8-Sequenzen,
  `/Length` gleich der echten Stromlänge, `startxref` und jeder `n`-Eintrag auf
  dem richtigen Objekt, die Abbildungen `→ • ≥ ≤ €`.
- `ai.spec.ts` 13 → **21 Tests**: der eingebaute Client über `globalThis.fetch`
  samt Abort-Signal und Bearer-Header, die Timeout-Wache, `safeHost`s Fallback
  „invalid endpoint", die Normalisierung einer Junk-Antwort, die clamp-Grenzen,
  die Protokollpfade eines scheiternden Providers und der Default-Logger.
- `errors.spec.ts` **neu, 10 Tests**: die Fehler-Hierarchie (jede Klasse trägt
  ihren eigenen Code, die Codes sind eindeutig, `new.target` liefert den Namen,
  `details` überleben) und der Vertrag von `messageOf`/`asError`.

Zwei Änderungen am Produktcode waren Voraussetzung, nicht Nebenprodukt:
`normalise`/`clamp` in `ai/http.ts` prüfen jetzt Feld für Feld (`Number.isNaN`
koerziert nicht, deshalb wurde aus `"confidence": "high"` früher `NaN`, aus dem
`JSON.stringify` ein `null` machte), und `messageOf`/`asError` liegen als **ein**
Vertrag in `@vdp/shared/errors.ts` — 40 Stellen rufen sie jetzt auf.

## Konsequenzen

- **Dass die Gates beißen, ist gemessen, nicht angenommen.** Mit absichtlich
  unmöglichen 99 % Zweigen für `reports` lief `npm run test:coverage` mit
  `EXIT=1` und benannte die Dateien einzeln (`pdf.ts` 88,88 %, `report.ts`
  79,48 %). Zurück auf 75: `EXIT=0`, **1050 Tests in 77 Dateien, 22,82 s**,
  `typecheck` und `biome ci` (235 Dateien) grün.
- Global stiegen die Zweige von 86,39 auf **87,33 %**, weil 37 der inline
  geschriebenen Ternäre vorher nie ausgeführte Zweige waren.
- **80 % Zweige sind für `zip.ts` die ehrliche Obergrenze**, kein Kompromiss: die
  verbleibenden `?? 0`-Arme existieren nur, weil `noUncheckedIndexedAccess` nicht
  sehen kann, dass `offset + 4 <= archive.length` den Index bereits bewiesen hat.
  Der Grund steht als Kommentar an der Gate-Zeile.
- **Prozess-Lehre aus Punkt 2:** eine beabsichtigte Gate-Änderung ist keine
  Gate-Änderung. Regel 34.21 gilt auch für Leitplanken selbst — belegt wird mit
  einem Lauf (`EXIT=1` mit den benannten Dateien), nicht mit einer Notiz.
- E13 ist damit vollständig abgeschlossen und aus dem Backlog entfernt; ebenso
  E12, dessen Befund (`catalog.ts` 68,0/48,6) seit der SocketCAN-Naht überholt
  ist — gemessen 100 Zeilen / 95,2 % Zweige.

## Alternativen

- **`perFile` global einschalten:** bestraft weiterhin Hardware-Glue und steht
  schon in ADR 0016 §2 als bewusste Ausnahme (`serial.ts`,
  `socketcan/binding.ts` sind ausgenommen).
- **Reports und AI ungated lassen:** der Mojibake-Fehler zeigt den Preis — ein
  Ausgabepfad ohne Gate und ohne Byte-Test liefert strukturell gültige Dateien
  mit falschem Inhalt.
- **Gates auf den Ist-Wert setzen (100/88,9 usw.):** ein Gate ohne Puffer macht
  jede kleine Änderung rot und wird dann umgangen; ADR 0017 nennt das
  „Aspirationswert statt Leitplanke". Die gewählten Werte liegen 5–10 Punkte
  unter dem Gemessenen und über dem, was vorher erlaubt war.
