# ADR 47 — Der Raw-Trace-Digest kommt durch einen Port: `@vdp/core` definiert, *was* gehasht wird, `@vdp/storage` liefert *wie*

- Status: akzeptiert (2026-09-19)
- Kontext: ADR 0002 (keine Laufzeit-Abhängigkeiten), ADR 0015 (der Abhängigkeitsgraph
  ist ein Test), ADR 0033 (fehlende Evidenz ist ein Fehlschlag), ADR 0036 (goldene
  Sitzungen), ADR 0042 (`package.json` ist eine Behauptung über Importe), ADR 0045
  (Konformanz-Vektoren als cross-language Anker), `architecture/architecture.yaml`
  → `rules.nodeBuiltins`
- Betrifft: `packages/core/src/logging/integrity.ts` (Seam + kanonischer Strom),
  `packages/core/src/logging/session-logger.ts` (`integrity`-Option, Verweigerung),
  `packages/storage/src/integrity.ts` (neu, `nodeIntegrityPort`),
  `packages/storage/src/index.ts`, `apps/web/src/backend.ts` (Port-Injektion,
  Export-Zeuge), `tests/architecture/hygiene.test.ts` (Größen-Ausnahme nachgemessen)

## Problem

1.40 hat die Integrität des Roh-Traces auf den Rekord gestellt — und dabei eine
Regel der eigenen Architektur übergangen: `packages/core/src/logging/integrity.ts`
importierte `node:crypto`. `@vdp/core` ist eine portable Schicht; `rules.nodeBuiltins`
erlaubt Node-Builtins nur in storage, adapter-host, web und den Tools. Die Folge war
Basis-Rot: `check:deps` meldete `@vdp/core → node:crypto`, `npm run ci` fiel auf
Schritt 4, und jeder weitere Zweig trug das Rot mit sich (AGENTS 1.40).

Der Defekt war nicht nur formal. Er steckte in der Entscheidung selbst:

1. **Die Hash-Entscheidung war unsichtbar.** Eine Funktion, die still ihr
   Plattform-Default benutzt, hinterlässt keinen Namen dessen, was sie tat. Ein
   Manifest, das behauptet „sha256", ohne dass irgendwo ein SHA-256 ausgewählt
   wurde, ist eine Behauptung ohne Zeugen.
2. **Die Eingabe war nicht kanonisch.** Über `JSON.stringify` von Objekten mit
   `Uint8Array` gehasht, hängt der Digest von Schlüsselreihenfolge und
   Array-Serialisierung des Wirts ab — dieselbe Aufzeichnung hätte in Node, in
   einem Replay-Worker und in einem Export-Pfad unterschiedlich lesen können.
3. **Eine portable Schicht, die nur unter Node baut**, ist für Browser-, WASM- und
   Hardware-Hosts wertlos — genau die Hosts, für die der Port-Gedanke existiert.

## Entscheidung

1. **`@vdp/core` besitzt den Byte-Vertrag, nicht die Hash-Funktion.**
   `canonicalRawTraceChunks` ist der exportierte Generator, der jede Trace-Zeile
   kanonisch und längenpräfixiert schreibt: `index|t|canId|direction|dlc|payloadHex|channel|extended|fd`,
   Payload kleingeschrieben, Präsentationsfelder
   (ISO-Zeitstempel, Hex-Ids) ausgeschlossen, weil sie abgeleitet sind und Exporte
   sie unterschiedlich formatieren dürfen. Das Längenpräfix macht ein Trennzeichen
   im Wert harmlos: Zwei verschiedene Traces können nicht denselben Strom lesen.
   Dass der Generator exportiert ist, ist Absicht — eine Änderung ändert jeden je
   gespeicherten Digest und muss im Review sichtbar sein, nicht in `hashRawTrace`
   verschwinden.
2. **Die Naht ist `IntegrityPort`.** `{ algorithm, createDigest(): IntegrityDigest }`
   mit einem Streaming-Digest (`update(chunk)` / `hex()`), damit eine 200 000-Zeilen-
   Trace nicht als ein Buffer im Speicher landen muss (das Limit, das `SessionLogger`
   durchsetzt). Implementierungen müssen deterministisch sein und die Algorithmus-
   Konstante aus dem Core lesen — Port, Manifest und Verifizierer können nicht
   auseinanderlaufen. `verifyRawTraceManifest` weist ein Manifest ab, dessen
   `algorithm` nicht der des Ports ist: Ein Nach-Haken mit einer anderen Funktion
   kann einen alten Zeugen nie bestätigen.
3. **Das Wie liegt in `@vdp/storage`.** `nodeIntegrityPort` ist SHA-256 über
   `node:crypto` — absichtlich sechs Zeilen Verhalten. Storage ist die Schicht, die
   den Session-Export schreibt, dem das Manifest beiliegt — und damit genau der Ort,
   an dem `rules.nodeBuiltins` den Datei- und Plattformzugriff dieser Art erlaubt.
4. **Kein Digest wird erfunden.** `SessionLogger` nimmt `integrity` als Option;
   `rawTraceManifest()` ohne Port wirft eine `SessionError`, die den fehlenden Port
   beim Namen nennt (`nodeIntegrityPort` aus `@vdp/storage`) — ein Export, der
   Provenanz behauptet, die er nie berechnet hat, ist schlechter als einer, der
   sagt: kein Zeuge (ADR 0033). `toJson` trägt das optionale `rawTraceManifest`
   neben dem `trace`-Block; Reader, die das Feld nicht kennen (Replay-, Golden-
   Parser), behalten unbekannte Schlüssel und lesen die Sitzung weiter.
5. **Das Manifest ist selbst daten.** `format: "vdp.raw-trace-manifest"`, Version 1,
   der Algorithmus, die abgedeckte Eintragszahl, der Digest in Kleinbuchstaben-Hex.
   Der goldene Digest `8600983efbd90138bc603449abf03aa606f571272451cd2c9df8dd38af748172`
   ist in `packages/storage/src/integrity.spec.ts` gepinnt — derselbe Anker, gegen
   den die Haskell-Seite (ADR 0045) den Diff führen kann.

## Why

- **Abhängigkeitsrichtung schlägt Bequemlichkeit.** Die Regel (`nodeBuiltins`) ist
  älter als der Verstoß; der saubere Zustand ist der, in dem `check:deps` wieder
  „no violations" sagt und der Graph als Test grün ist (ADR 0015).
- **Ein Zeuge, der beim Namen genannt wird.** Der Aufrufer wählt den Hasher, das
  Manifest trägt den Algorithmus — nichts an dieser Kette ist ein stiller Default
  (AGENTS 0.E: Entscheidungen auf dem Rekord, ADR 0029).
- **Ein Digest, überall derselbe.** Der kanonische Strom ist hostunabhängig;
  Node, Replay-Worker und Export-Pfad erzeugen für dieselbe Aufzeichnung denselben
  Wert — Voraussetzung dafür, dass ein goldenes Manifest über Zeit und Hosts hinweg
  Bestand hat (ADR 0036).

## Alternatives

- **Status quo** (`node:crypto` im Core): portable Schicht an Node gebunden,
  Gate dauerhaft rot, keine Manifeste in Browser-/WASM-Hosts. Verworfen.
- **Ein sechstes Paket** (`@vdp/integrity-node`): sechs Zeilen Verhalten an einem
  eigenen Ort mit eigenem Manifest-Eintrag. Verworfen — Storage ist die Schicht,
  die den Export schreibt, dem das Manifest beiliegt; dort gehört der Port hin.
- **Hash-Funktion als Parameter** statt Port: verliert die Algorithmus-Identität,
  die das Manifest tragen muss; ein freier Funktionsparameter macht jeden Aufruf
  zu einer neuen Entscheidung ohne Aufzeichnung. Verworfen.
- **Über `JSON.stringify` hashen:** wirtsabhängig (Schlüsselreihenfolge,
  `Uint8Array`-Serialisierung), kein Byte-Vertrag. Verworfen.

## Affected packages

- `@vdp/core` — `logging/integrity.ts` (Seam, kanonischer Strom, Manifest-Erzeugung
  und -Prüfung), `logging/session-logger.ts` (`integrity`-Option, Verweigerung,
  `toJson`-Feld). Kein `node:*`-Import mehr.
- `@vdp/storage` — `integrity.ts` neu (`nodeIntegrityPort`), `index.ts` re-exportiert
  Port und Verifizierer.
- `@vdp/web` — `apps/web/src/backend.ts` injiziert den Node-Port; jeder Workbench-
  Export trägt den Zeugen neben dem Trace.
- Tests — `integrity.spec.ts` (Core, 11), `storage/integrity.spec.ts` (6),
  `session-logger.spec.ts` (+2), `backend-paths.spec.ts` (+1).

## Forbidden implementations

- **Kein `node:*` im Core-Logging.** Der alte Defekt mit neuem Datum ist immer
  noch der Defekt; die portable Schicht definiert Verträge, keine Plattform-Aufrufe.
- **Kein Digest ohne benannten Port.** Kein verstecktes Plattform-Default, kein
  Fallback-Hasher, kein „best effort"-Digest — eine Port-Implementierung, die
  Politik hinzufügt (Fallback-Algorithmus, Cache), verschiebt eine Entscheidung in
  einen Ort, den kein Export je aufzeichnet.
- **Kein Verifizierer, der über den Algorithmus hinwegsieht.** `verify` mit einem
  Port anderer `algorithm` muss `false` liefern, nie „trotzdem ok".
- **Keine stille Änderung an `canonicalRawTraceChunks`.** Sie ändert jeden je
  gespeicherten Digest; das ist ein versionierter, reviewter Akt (Manifest-Version
  ist der Hebel), kein Refactoring-Nebeneffekt.
- **Kein Manifest, das einen Algorithmus behauptet, den der Port nicht gefahren
  ist.** Die Konstante wird gelesen, nicht nachgeschrieben.

## Migration

Alte Exporte ohne `rawTraceManifest` bleiben lesbar — die Parser behalten
unbekannte Schlüssel, und ein Export ohne Manifest sagt seinen Zustand durch
Abwesenheit, ehrlich. Neue Exporte aus dem Workbench tragen den Zeugen ab sofort.
Der Graph-Verstoß `@vdp/core → node:crypto` ist mit diesem ADR aus der Welt;
`check:deps` meldet wieder „no violations".

## Tests

- `packages/core/src/logging/integrity.spec.ts` (11 Tests): alles über einen
  Digest-Double — der Beweis, dass der Kern keine Plattform-Krypto braucht.
- `packages/storage/src/integrity.spec.ts` (6 Tests): FIPS 180-4-Vektoren gegen
  `node:crypto`, der goldene Manifest-Digest `8600983e…` über eine gepinnte Trace,
  Verifizierer-Negative (veränderte Trace, verkürzte Trace → `false`).
- `packages/core/src/logging/session-logger.spec.ts` (+2 Blöcke): die Verweigerung
  ohne Port als `SessionError` mit Grund und Details; `toJson` trägt das Manifest.
- `apps/web/test/backend-paths.spec.ts` (+1): der Export-Zeuge verifiziert gegen
  den exportierten Trace, Manipulation fällt auf.
- Coverage: beide `integrity.ts` **100/100/100/100**; `check:deps` „no
  violations"; `npm run ci` EXIT 0 (2289 Tests / 155 Dateien, 2 skips).

## AI implementation notes

- Node-Host? `nodeIntegrityPort` aus `@vdp/storage` injizieren — fertig. Browser-,
  WASM- oder HSM-Host? Eigene `IntegrityPort`-Implementierung derselben Naht, kein
  Polyfill im Core.
- Niemals außerhalb von `canonicalRawTraceChunks` hashen — ein zweiter kanonischer
  Strom ist der alte Zwei-Wahrheiten-Defekt (ADR 0031) in neuem Gewand.
- Ein zweiter Algorithmus wäre: Port-Implementierung + Konstante + Manifest-Version
  angehoben, in einem Review — nie ein String-Swap in `nodeIntegrityPort`.
