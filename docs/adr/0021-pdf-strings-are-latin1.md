# 0021 — PDF-Strings sind Latin-1: ein Encoder für Text, Länge und Offsets

Status: accepted · Datum: 2026-09-12 · Bezug: AGENTS 14, 28, 34.21; ADR 0022; `packages/reports/src/pdf.ts`

## Kontext

`@vdp/reports` erzeugt das Dokument, das eine Werkstatt an den Kunden weitergibt
— der sichtbare Beweis der ganzen Kette. Die beiden Schriften darin deklarieren
`/Encoding /WinAnsiEncoding`, ein PDF-Leser macht also aus **einem Byte eine
Glyphe**.

Geschrieben wurde mit `new TextEncoder()`, und `TextEncoder` erzeugt UTF-8. Für
die Zeile `Kühlmittel 90 °C` gemessen am 2026-09-12 (`PdfDocument.toBytes()`,
Hexdump der fertigen Datei):

| Zeichen | geschrieben (UTF-8) | korrekt (WinAnsi/Latin-1) |
|---|---|---|
| `ü` | `c3 bc` | `fc` |
| `°` | `c2 b0` | `b0` |
| Binärkommentar `%âãÏÓ` | `c3a2 c3a3 c38f c393` (8 Bytes) | `e2 e3 cf d3` (4 Bytes) |

Jeder exportierte Bericht mit Umlaut oder Gradzeichen kam damit als
`KÃ¼hlmittel 90 Â°C` an — und zwar auf dem realen Pfad
`apps/web/src/server.ts → renderPdf`. Bei einer deutschen Werkstatt-Software sind
Umlaute und `°C` der Normalfall, nicht die Ausnahme.

Warum das kein Test gemerkt hat: die Datei blieb **strukturell** gültig.
`/Length` und die xref-Offsets zählten dieselben UTF-8-Bytes, die auch
geschrieben wurden, `startxref` zeigte auf die Tabelle, alle Offsets stimmten.
Nur der Inhalt war falsch. Strukturelle Prüfungen allein können eine falsche
Kodierung nicht finden — sie müssen die Bytes selbst ansehen.

`sanitize()` war bereits vorhanden und korrekt: es hält jeden Text im
Latin-1-Bereich (alles darüber wird auf ASCII abgebildet). Genau dadurch wird
„ein Byte pro Code-Einheit" exakt — genutzt hat es nur nichts, solange der
Encoder UTF-8 schrieb.

## Entscheidung

1. **Ein Latin-1-Encoder** (`latin1Encoder` in `pdf.ts`) schreibt ein Byte pro
   Code-Einheit und wird **konsequent** für alles verwendet, was Bytes zählt oder
   erzeugt: den Header samt vierbytes Binärkommentar, jeden Objektkörper,
   `/Length` der Inhaltsströme und die xref-Offsets. Länge und Inhalt dürfen nie
   aus zwei verschiedenen Kodierungen stammen.
2. **`sanitize()` bleibt die Voraussetzung**, die das exakt macht: nichts über
   `0xFF` überlebt, also ist die Byte-Zahl gleich der Zeichen-Zahl.
3. **Bewusst nicht `Buffer.from(text, "latin1")`.** `@vdp/reports` ist ein
   portabler Layer und bleibt frei von Node-Builtins (AGENTS 28). Die
   §29-Allowlist erlaubt dem Paket außerdem kein `@vdp/shared`, der Encoder kann
   also auch nicht von dort kommen — er gehört in die Datei, die PDF schreibt.
4. **Der tote `case 0x00b0` in `mapUnicode` ist entfernt.** `sanitize` ruft die
   Funktion nur für Codepunkte über `0xff` auf; das Gradzeichen ist darstellbar
   und kommt dort nie an. Ein Arm, der nicht erreichbar ist, ist keine
   Verteidigung, sondern eine falsche Behauptung über den Code.

## Konsequenzen

- Gemessen an derselben Beispieldatei: **778 → 772 Bytes**, `ü` = `fc`,
  `°` = `b0`, keine UTF-8-Sequenz `c3bc`/`c2b0` mehr, Header
  `25 e2 e3 cf d3 0a` — exakt die Konvention aus ISO 32000-1.
- Drei neue Tests in `reports.spec.ts` (12 statt 9) sichern das ab und würden
  einen Rücktausch des Encoders benennen:
  1. die Latin-1-Bytes samt Ausschluss der UTF-8-Sequenzen und der
     Binärkommentar als vier Bytes über 127,
  2. `/Length` gleich der echten Bytes zwischen `stream` und `endstream`,
     `startxref` zeigt auf `xref`, und jeder `n`-Eintrag zeigt auf sein Objekt,
  3. die Abbildungen `→ • ≥ ≤ €` und die Invariante „kein Codepoint über `0xff`".
- `pdf.ts`: 93,9 % statements / 71,4 % branches → **100 / 88,9**. Für den
  Export-Pfad gilt seither ein per-file-Gate (ADR 0022) — vorher hatte er
  überhaupt keins, was der Grund ist, warum dieser Fehler bis hierher überlebt
  hat.
- Die Lehre steht in Test 2: eine Datei kann gültige Offsets haben und trotzdem
  falschen Inhalt. Wer nur Struktur prüft, prüft die Hälfte.

## Alternativen

- **UTF-8 behalten und `/Encoding /Identity-H` mit eingebetteter Schrift:** echtes
  Unicode, aber Schriften-Einbettung und CID-Abbildung — ein neues Feature. Der
  Backlog 0.E ist bewusst auf Bestehendes beschränkt, und WinAnsi deckt den
  lateinischen Schriftraum einer Werkstatt ab.
- **Nicht-ASCII transliterieren (`ü` → `ue`):** verfälscht Beschriftungen und
  Messwerte; `sanitize` bildet bereits die wenigen Symbole ab, die in Befunden
  vorkommen, und lässt Umlaute als das, was sie sind.
- **Dokumentieren statt beheben:** der Fehler ist im ausgedruckten Dokument
  sichtbar. Eine falsche Bytefolge zu dokumentieren ist keine Option.
