# ADR 44 — Der Roh-Trace-Digest ist ein Primitiv in `@vdp/shared`: eine portable Schicht kennt kein `node:crypto`

- Status: akzeptiert (2026-09-18)
- Kontext: AGENTS 18 (Raw CAN Trace), AGENTS 28 (Schichten und ihre Erlaubnisse),
  ADR 0002 (keine Laufzeit-Abhängigkeiten), ADR 0021 (derselbe Konflikt, damals auf
  der Ausgabeseite: `Buffer` statt Encoder im Report), ADR 0031 (eine Regel, eine
  Quelle), Regel 34.18 (Norm-Referenz im Kommentar), 34.21, 34.24
- Betrifft: `packages/shared/src/hash.ts` (neu), `packages/shared/src/hash.spec.ts`
  (neu), `packages/shared/src/index.ts`, `packages/core/src/logging/integrity.ts`,
  `packages/core/src/logging/integrity.spec.ts`, `packages/core/src/logging/session-logger.ts`
  (nur Importordnung), `scenarios/alternator_failure.json` (nur Format),
  `packages/shared/README.md`, `packages/core/README.md`, `ARCHITECTURE.md`,
  `docs/code-map.md`, `docs/adr/README.md`, `AGENTS.md` (changelog 1.40, 0.A, neuer
  Backlog-Eintrag E25), `README.md`

## Problem

`packages/core/src/logging/integrity.ts` liegt in diesem Baum: ein Roh-Trace-Manifest
(`format`, `version`, `algorithm`, `entries`, `sha256`), aus dem Core öffentlich
exportiert, von `SessionLogger.rawTraceManifest()` erzeugt, mit zwei eigenen Tests.
Der Baum war deshalb **rot**, und zwar zweifach (gemessen 2026-09-18 am Stand
`fabc0aa`, nach `npm ci && npm run build`):

| Befund | Messung |
|---|---|
| Schichtregel verletzt | `npm run check:deps` → `✗ [node-builtin] @vdp/core imports node:crypto, but is a portable layer`, Exit 1 |
| Architektur-Suite fällt, **und** 10 ihrer Tests verschwinden still aus der Zählung | `npm test` → `140 passed \| 2 failed \| 1 skipped (143)` Dateien, `2027 passed \| 1 failed \| 1 skipped (2029)` Tests; `dependencies.test.ts` scheitert auf Modulebene, `tests/architecture/guardrails.test.ts` mit dem Quality-Gate |
| Format findings im selben Modul | `npx biome check .` → 3 Fundstellen: `integrity.spec.ts` (Format), `session-logger.ts` (Importordnung), `scenarios/alternator_failure.json` (Format) |
| Behauptung im Dateikopf, die die Implementierung widerlegt | der Kopf verspricht „the same digest in Node, a replay worker, and an export pipeline" — mit `node:crypto` gibt es den Digest im Browser-Worker nicht; portabel genannt, an eine Laufzeit gekettet |
| nirgends dokumentiert | kein ADR, keine Zeile in `AGENTS §18`/0.A, `packages/core/README.md` kannte nur `SessionLogger` in `logging/`, Glossar leer (Regel 34.24) |

Der Kern des Befunds ist nicht das Manifest — es ist die **Stelle des Digests**. Ein
`createHash`-Import in einer Schicht, die per Definition keine Laufzeitbindung kennen
darf, ist keine Kleinigkeit am Rand: die Schicht ist genau die, die in einem Worker
oder Browser weiterlaufen muss (Replay, Export, Analyse). Und eine zweite Lösung für
dasselbe Problem (ein Loader, der `crypto` je Umgebung wählt) wäre genau die doppelte
Vokabel, die ADR 0031/0042 zu entfernen da sind.

## Entscheidung

1. **`sha256Hex(input: string | Uint8Array): string` in `@vdp/shared`** — die
   Foundation-Schicht, die per Schichtregel *alle* anderen erreichen dürfen
   (`docs/code-map.md`: „Neue Konstante / Enum, die zwei Schichten brauchen? →
   `@vdp/shared` (Primitiv)"). SHA-256 nach FIPS 180-4 §4.2.2/§5.3.3/§6.2 (identisch
   zu ISO/IEC 10118-3:2004), Konstanten im Kommentar mit Normstelle (Regel 34.18).
   Ein String wird als UTF-8 gehasht — dieselben Bytes, die
   `createHash("sha256").update(text, "utf8")` sieht.
2. **`integrity.ts` behält seinen Vertrag.** Kanonische Datensätze, längenpräfixiert,
   Manifest-Felder, `algorithm: "sha256"`, `RAW_TRACE_MANIFEST_VERSION = 1`. Kein
   neues Feld, kein Formatwechsel, kein Session-Schema-Bump — **derselbe Digest wie
   zuvor**, weil SHA-256 über derselben Bytefolge definiert ist und die Verkettung der
   kanonischen Sätze unverändert bleibt (Concatenation → ein Hash = sequenzielles
   `update` → ein Hash).
3. **Die Allowlist bleibt, wie sie ist.** `architecture/architecture.yaml` →
   `rules.nodeBuiltins.allowedIn` nennt weiterhin `adapter-host`, `storage`, `web`,
   `golden-sessions`. `@vdp/core` wird nicht eingetragen: eine Regel zu erweitern,
   damit ein Verstoß durchgeht, ist keine Reparatur, sondern eine stillschweigende
   Architekturentscheidung (0.D, Regel 34.15). Die Abhängigkeit ging, die Regel blieb.
4. **Der Digest ist gepinnt, nicht nur verglichen.** `integrity.spec.ts` trägt
   `REFERENCE_DIGEST` als Konstante — gemessen mit `node:crypto` über den kanonischen
   Satzstrom der beiden Fixture-Einträge, also von einer Implementierung, die hier
   *nicht* läuft. Ein Wert aus demselben Code wäre keine Behauptung, sondern ein
   Echo. Damit fällt die Suite, sobald jemand die Kanonisierung anfasst — und damit
   auch jede gespeicherte Sitzung unlesbar würde.
5. **Das ungenutzte Anhängsel ist weg.** `withRawTraceManifest(payload)` war ein
   Export ohne einzigen Aufrufer — und einer, der am echten Export-Pfad vorbeitypiert:
   `SessionLogger.toJson` schreibt den Trace mit `payload: entry.payloadHex` (ein
   String), die Signatur verlangt `RawTraceEntry[]` (Bytes im Feld `payload`). Wer das
   Manifest je anhängen will, tut es in der Schicht, in der die Datei entsteht
   (`apps/web/src/server.ts`, `@vdp/storage`) — ein Helfer, den seine eigene
   Datenform nicht annimmt, ist eine Behauptung über einen Pfad, den es nicht gibt
   (dieselbe Kategorie wie das gestrichene `summarizeAvailability`, 0.E E17).
   `createRawTraceManifest`, `verifyRawTraceManifest` und `hashRawTrace` bleiben
   öffentlich: sie *sind* der Vertrag, der jetzt gemessen wird.
6. **Die Doku zieht im selben Zug mit** (34.24): `packages/shared/README.md`
   (Responsibilities/Public API/Invariante), `packages/core/README.md`
   (`logging/`-Zeile, Portabilitäts-Invariante), `ARCHITECTURE.md`
   (foundation-Purpose), `docs/code-map.md` (Zeile „Aufnahme beglaubigen"),
   `AGENTS.md` 0.A/changelog/0.E, README-Testzahl, `docs/adr/README.md`.
   AGENTS **§18** bleibt unangetastet: die normativen Abschnitte 0–36 schreiben das
   *Produkt* vor, der Umsetzungsstand steht in Teil 0 — eine Implementierungszeile in
   §18 wäre eine zweite Heimat derselben Aussage.

## Why

- **Die portablen Schichten sind der Grund, warum es diese Regel gibt.** Wer einen
  Roh-Trace later beglaubigen will, muss den Digest *ohne* Node berechnen können: der
  Replay-Worker der Workbench und ein Export-Pipeline-Schritt laufen im Browser. Ein
  `node:crypto`-Import macht aus dem Versprechen im Dateikopf eine Lüge; die
  Primitive im Fundament macht sie wieder wahr.
- **Ein Hash ist ein Primitiv, keine Diagnose-Logik.** `shared` importiert
  buchstäblich nichts (die einzige solche Schicht neben `@vdp/charts`) — eine
  60-Zeilen-Implementierung ohne Abhängigkeit passt genau dahin, und der Dep-Gate
  (`npm run check:manifests`, ADR 0042) bleibt unberührt: Core erklärte `@vdp/shared`
  schon vorher.
- **Kein Schema-Bump, keine Migration** (AGENTS 10, §1.5): das Manifest-Feld ist
  additiv und unverändert; wer eine gespeicherte Sitzung nachschlägt, findet
  denselben `sha256`-Wert.

## Alternatives

- **Fertige Hash-Bibliothek (`@noble/hashes`, MIT):** schlank und sicher
  absicherungsarm, aber eine neue Laufzeit-Abhängigkeit braucht ADR-0010-Nachweise
  (Maintenance, Lizenz, Lockfile) *und* beendet die Invariante „shared importiert
  nichts". Für 60 Zeilen Standardtext, die ein Test gegen die Referenzimplementation
  prüfen, kein Gewinn (ADR 0002).
- **Hash-Funktion in `createRawTraceManifest` injizieren:** ein Seam für etwas, das
  genau einen Wert haben darf — jeder Aufrufer müsste die richtige Implementierung
  verdrahten, damit ein Manifest nachprüfbar bleibt. Eine zweite Art, dasselbe Zeugnis
  zu bauen, ist der defect, den 0.A/§23 bei Wissen und Evidenz jagen.
- **`node:crypto` in der Allowlist von `@vdp/core`:** billig grün, und die
  Portabilitätsbehauptung des Moduls wäre dauerhaft falsch. Genau die „kleine
  Abhängigkeit", die 0.D als Review-Blockade nennt.
- **Modul löschen:** grün um den Preis des Zeugnisses. Dass heute niemand das
  Manifest liest, ist ein Befund über die Export-Pfade (0.E E25), nicht über die
  Richtigkeit des Digests.

## Messprotokoll dieses Laufs

Gemessen 2026-09-18 in diesem Checkout (`npm ci` → `npm run build`), Node 22:

| Messung | Ergebnis |
|---|---|
| `npm run check:deps` nach der Umstellung | `dependency rule: 27 packages placed, 79 edges, 6 rules` — **no violations** |
| `npm run ci` (build + typecheck + biome + deps + manifests + alle 6 Ebenen) | **Exit 0**, `143 passed \| 1 skipped (144)` Dateien, `2046 passed \| 1 skipped (2047)` Tests in 55,0 s |
| Digest-Identität, altes gegen neues Verfahren | 200 000 Einträge (die Obergrenze des Recorders, `maxTraceEntries`) = 8,7 MiB kanonischer Strom: `node:crypto` Datensatz für Datensatz, `node:crypto` über den zusammengesetzten String und `sha256Hex` über denselben String — **alle drei Digestwerte gleich** |
| Laufzeit desselben Manifests | portabel (map + join + `sha256Hex`) **135 ms**, `node:crypto` über denselben String 9,9 ms, `node:crypto` Satz für Satz 69,3 ms. Der Preis der Portabilität ist gezahlt, wo er nicht stört: das Manifest entsteht pro Export, nicht pro Rahmen |
| kleine Eingaben | 10 000 kurze Digeste in 17,6 ms |
| Norm-Vektoren | `""`, `"abc"` und der 56-Byte-Beispielvektor aus FIPS 180-4 §B.1/§B.2 werden exakt reproduziert (String *und* Bytes) |
| Format | `npx biome check .` → `Checked 435 files. No fixes applied.` (vorher 3 Fundstellen) |
| Demo am lebenden Objekt | `node apps/web/dist/src/server.js --demo --port=8080`, dann `POST /api/start`, `POST /api/live/start`, `POST /api/identify`, `POST /api/dtc/scan`, `POST /api/session/save`: **931 aufgenommene Rahmen**, `GET /api/export/session.json` (362 233 Bytes), `GET /api/export/trace.csv` (932 Zeilen), `report.html` 200 / 16 811 Bytes, `report.pdf` 200 / 31 495 Bytes mit **0** Fragezeichen, `GET /` 200, `GET /lib/index.js` 200 (Regel 34.26), `HEAD /` 405 (GET-only-Baseline, ADR 0009). Über dieselbe lebende Aufnahme gerechnet: der portable Digest aus dem gebauten `dist` (`0b565a85…a0347c`), `node:crypto` über den zusammengesetzten Satzstrom und `node:crypto` Rahmen für Rahmen — **dieselben drei Werte**, 38 848 kanonische Bytes |
| Coverage der beiden Dateien | `hash.ts` 100/100/100/100, `integrity.ts` 100/100/100/100 (`npm run test:coverage`, 62,4 s, EXIT 0, global 95,19 / 87,29 / 96,52 / 96,45) |
| Der Zwilling, den die Gates erst sichtbar machten | direkt nach dem Digest-Tausch maß `integrity.ts` **88,88 / 77,77** und fiel durch das per-file-Tor `packages/core/src/**` (88/80): `ERROR: Coverage for branches (77.77%) does not meet … threshold (80%)`. Der Tausch hatte die Armsverteilung verschoben, nicht die Testqualität ersetzt — die Antwort sind die zwei zusätzlichen Fälle unten, nicht eine niedrigere Schwelle (ADR 0017: erst Tests, dann Gate) |

## Affected packages

- **`@vdp/shared`** (foundation): `hash.ts` neu, `sha256Hex` öffentlich über
  `src/index.ts`. Keine neue Abhängigkeit, `mayImport` bleibt `[]`.
- **`@vdp/core`**: `logging/integrity.ts` importiert `sha256Hex` statt
  `node:crypto`; Signatur, Felder und Digestwerte unverändert. `session-logger.ts`
  nur Importordnung (Biome).
- **`@vdp/storage`, `@vdp/reports`, `apps/web`**: nichts — sie kannten das Manifest
  nicht und kennen es weiterhin nicht (sonst wäre es eine zweite Ablage für dasselbe
  Zeugnis, §23).

## Forbidden implementations

- **Kein `node:`-Builtin in `@vdp/core`, `@vdp/domain`, `@vdp/application`,
  `@vdp/protocols/*`, `@vdp/transport/*`, `@vdp/definitions`, `@vdp/diagnostic-ir`,
  `@vdp/charts`, `@vdp/shared`.** Wer einen Digest, Zufall oder Uhr braucht, nimmt
  das Primitiv in `shared` oder macht eine Naht auf — er erweitert nicht die Allowlist.
- **Kein zweiter SHA-256.** Eine Implementierung in `core`, eine zweite in `storage`
  (das `node:crypto` *dürfte*) wäre ein zweites Zeugnis über dieselbe Aufnahme: die
  Prüfung einer Datei würde davon abhängen, welches Paket sie liest.
- **Kein Streaming-API um `sha256Hex` herum**, solange niemand es braucht: ein
  `createHash()`-Objekt durch die Schichten zu reichen wäre die Node-Form mit
  anderem Namen.
- **Kein „Verbessern" des Manifests durch ein neues Feld** (`algorithm: "sha256"`
  bleibt die einzige Fassung, `RAW_TRACE_HASH_ALGORITHM` ist die eine Stelle): ein
  zweiter Digest-Typ braucht eine Migration und einen Grund, den hier niemand hat.

## Migration

1. `packages/shared/src/hash.ts` + Spec, Export in `src/index.ts`.
2. `integrity.ts`: Import getauscht, `hashRawTrace` bildet den kanonischen Satzstrom
   und übergibt ihn einmal — kein Verhalten, kein Format.
3. `integrity.spec.ts`: `REFERENCE_DIGEST` von außen gemessen, dazu die beiden
   bestehenden Tests; `session-logger.ts` und das Szenario-JSON neu formatiert.
4. Doku-Punkte aus Entscheidung 5. Kein Commit-Zwischenschritt nötig: niemand ruft
   `rawTraceManifest()` in Produktion, die gespeicherten Sitzungen enthalten kein
   Manifest (gemessen mit grep über `packages apps tools`: ein Export ohne Aufrufer,
   0.E E25). Ein Zurück wäre damit ebenso folgenlos wie der Wechsel.

## Tests

- `packages/shared/src/hash.spec.ts` (6): die drei veröffentlichten FIPS-Vektoren;
  Übereinstimmung mit `node:crypto` für **jede Länge 0…200** (die beide Padding-Formen
  und drei volle Blöcke berühren); ein 100-KiB-Strom über 1600 Blöcke, zweimal
  hintereinander (beweist, dass der wiederverwendete Scratch-Puffer nichts über
  Blöcke hinweg trägt); UTF-8-Strings mit `ü`, `°`, `…`, `—` und einem Emoji als
  Surrogat-Paar; String gegen Bytes desselben Textes; `"ab"` gegen `"ab\0"` (ohne das
  Längenfeld identisch — §5.1.1).
- `packages/core/src/logging/integrity.spec.ts` (5): der bestehende
  Präsentationsgleichheits-Test, der bestehende Tamper-/Reorder-/Truncation-Test,
  neu der Known-Answer-Pin gegen den von außen gemessenen Wert, ein Fall für
  `extended`/`fd`/`channel`/`dlc` (die Bits, die ein Decoder nicht aus dem Payload
  zurückgewinnt) und einer gegen ein Manifest, das nicht dieses Format, diese Fassung,
  diesen Algorithmus oder diese Zahl nennt — gebildet mit `Object.assign`, weil ein
  Manifest aus einer Datei kommt und die deklarierte Literaltype dort nichts gilt.
- `packages/shared` hält sein per-file-Gate (100 % Linien, ≥95 % Zweige —
  `vitest.config.ts`); die Zahlen dieses Laufs stehen in 0.A.
- Die Suite zählt nicht runter, sie zählt wieder richtig: der rote Lauf meldete
  `2027 passed | 1 failed | 1 skipped`, weil `dependencies.test.ts` mit seinen 11
  Tests auf Modulebene aus der Zählung fiel — ein Ausfall, der die Zahl still
  verkürzt, statt sie zu berichtigen. Grün gemessen: `npm run ci` **Exit 0**,
  `143 passed | 1 skipped (144)` Dateien, `2048 passed | 1 skipped (2049)` Tests in
  55,0 s (zweiter Lauf: 56,5 s); die 9 Tests dieser Runde (6 + 3) stecken darin, `npm run test:coverage`
  ebenso Exit 0.

## AI implementation notes

- **Ein Digest, ein Ort:** `sha256Hex` aus `@vdp/shared`. Ein `node:crypto`-Import in
  einer portablen Schicht ist ein Build-Fehler (`npm run check:deps`), kein
  TODO-Kommentar. Die Liste erlaubter Schichten steht *nur* in
  `architecture/architecture.yaml`.
- **Strings sind UTF-8** in diesem Primitiv — wer einen Digest über Bytes will, übergibt
  `Uint8Array`, und beide Formen müssen dasselbe Ergebnis liefern (getestet).
- **Wer das Manifest speichern will, ändert den Export-Pfad, nicht das Zeugnis:**
  `apps/web/src/server.ts` (`/api/export/*`) und `@vdp/storage` sind die Stellen, an
  denen eine Datei entsteht; der Core liefert nur den Wert (0.E E25). Ein Manifest
  neben `session.json` abzulegen, ohne den Export anzufassen, wäre ein zweiter
  Ablageort für dasselbe Wissen (§23).
- **Known-Answer-Tests mit außen gemessenen Werten** sind hier der Maßstab: Ein
  Digest-Test, der den Erwartungswert aus demselben Code berechnet, prüft nichts.
