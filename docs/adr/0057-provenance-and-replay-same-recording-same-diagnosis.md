# ADR 57 — Provenance und Replay: dieselbe Aufnahme, dieselbe Diagnose

- Status: akzeptiert (2026-09-22) — Entscheidung getroffen, Implementierung läuft
  (siehe Migration)
- Kontext: ADR 0005 (Simulator und Replay statt Real-Fahrzeug), ADR 0007
  (versionierte Sessions mit Migration), ADR 0047 (Integrity-Port: Core sagt *was*,
  Storage sagt *wie*), ADR 0048 (Szenario-Dateien sind der Katalog, der Seed läuft
  durch), AGENTS 22 (maschinell prüfbar statt behauptet), AGENTS 34.21 (Messung vor
  Behauptung)
- Betrifft (geplant): `packages/core/src/session/session.ts`,
  `packages/core/src/logging/` (`session-logger.ts`, `integrity.ts`),
  `packages/core/src/diagnostics/session-opener.ts`, `packages/storage/src/integrity.ts`
  (+ neuer Signer), `packages/runtime` (Engine-Options), `apps/web/src/backend.ts`,
  `tests/replay/scenario-replay.test.ts` (neu)

## Problem

Eine Diagnose war nicht vollständig nachvollziehbar. Die Session trug `SessionId` und
den Raw-Trace-Digest, aber nicht, *unter welchen Bedingungen* die Aufnahme stand:

- **Kein `TraceId`, das zur Aufnahme gehört.** Der Digest `8600983e…` bewahrt die
  Integrität des Rohmaterials, aber zwei Aufnahmen desselben Inhalts hatten keinen
  gemeinsamen, prüfbaren Namen — und eine Session, die eine `traceId` behauptet,
  konnte nicht gegen ihr eigenes Manifest verifiziert werden.
- **Kein Provenance-Block.** Welches Szenario lief, mit welchem Seed, welche
  Plattformversion, welche Definitionen, welche AI (Provider, Prompt, Runtime) —
  alles stand in unterschiedlichen Feldern oder gar nicht. „Gleiche Aufnahme,
  gleiche Diagnose" ließ sich nicht aus den gespeicherten Daten ableiten.
- **Das Replay war nicht Teil der Kette.** `tests/replay/` spielte gespeicherte
  Sessions ab, aber ein Lauf aus der *Szenario-Datei* (die Quelle aller Verbraucher,
  ADR 0048) über Live-Simulator → Raw-Trace → Manifest → Replay → gleicher DTC-Output
  war nicht als ein zusammenhängender, signierter Befund vorhanden.

Zusammen: „Reproduzierbar und auditierbar" war ein Versprechen, das die gespeicherten
Daten nicht stützten.

## Entscheidung

1. **Provenance ist additive, optionale Top-Level-Felder auf
   `VehicleSessionData` — kein Schema-Bump.** Neue Felder:
   - `platformVersion?` — kommt über `CreateSessionOptions` in den
     Session-Opener (L76), der sie von den Engine-Options ← der Runtime
     (`PLATFORM_VERSION`) bekommt. Jede Session, die neu geöffnet wird, trägt
     die Version der Plattform, die sie geöffnet hat.
   - `scenario? { id, title, seed }` — setzt das Backend nach `runScenario`,
     die ID aus dem Katalog (ADR 0048) und der Seed, der durch den Lauf ging.
   - `ai? { provider, promptVersion, runtimeVersion }` — setzt das Backend nach
     `analyze`, aus der Provenance der Antwort (ADR 0043: Versionen kommen aus
     der Anfrage, nie aus der Antwort).
   - `traceId?` — **content-addressed**: `t-` + `sha256(Manifest)`.slice(0, 16).
     Dieselbe Aufnahme → dieselbe ID, ohne Gegenstand, ohne Zähler; eine Session,
     deren Manifest nicht zu ihrer `traceId` passt, ist *prüfbar* falsch.
   Alle vier bleiben optional: eine alte Session, die sie nicht trägt, liest sich
   exakt wie bisher (SessionStorage-Migrationsvertrag, ADR 0007) — Provenance ist
   eine Erweiterung, keine Strukturänderung.
2. **Das Manifest bekommt Version 2 — Version 1 bleibt gültig.**
   `SUPPORTED_VERSIONS = [1, 2]` in der Verifikation (heute: strikt `1`). V2 trägt
   das optionale Feld

   ```
   signature: { keyId: string; algorithm: "ed25519"; value: string /* base64 */ }
   ```

   über die **kanonische Zeichenkette**
   `format|version|algorithm|entries|sha256` — exakt die Felder, die den Inhalt
   bestimmen, in fester Reihenfolge. V1 bleibt unverändert lesbar, und der
   goldene Digest `8600983e…` bleibt gepinnt: ein Version-Bump, der alte Manifeste
   umbrochen hätte, wäre eine Migration, die niemand braucht.
3. **Signieren ist ein Port, nicht ein Feature.** `ManifestSigner`
   (`sign(manifest): { keyId, algorithm, value }`) gehört in Core neben
   `IntegrityPort` (ADR 0047: Core sagt *was* signiert wird, Storage sagt *wie*):
   `nodeManifestSigner` in `@vdp/storage` über `node:crypto` (ed25519),
   `keyId = "ed25519:" + sha256(pubkey).slice(0, 16)` — die ID ist der
   Fingerabdruck des Schlüssels, nicht sein Name. Die Workbench führt **einen
   Process-Signer** (Prozessstart erzeugt das Schlüsselpaar; es verlässt den
   Prozess nicht, der PublicKey geht ins Manifest neben die Signatur). Ein Export
   trägt das signierte Manifest; die Signatur wird dort verifiziert, wo sie
   erzeugt wurde, nicht wo sie günstig ist.
4. **Der Replay ist ein Test über den Live-Lauf.** Neu
   `tests/replay/scenario-replay.test.ts` (Projekt `replay`), je Szenario-Datei:
   `HighFidelityVehicle` mit dem **Seed aus der Datei** (Muster
   `tests/integration/scenario-file.test.ts`) → `DiagnosticEngine` → UDS-0x19-Scan →
   DTC-Output des Live-Laufs; parallel wird der **Raw-Trace** gesammelt und in ein
   signiertes V2-Manifest verpackt; der Test verifiziert **Digest und Signatur**
   und spielt den Trace über `ReplayTransport` ab — und behauptet: **gleicher
   DTC-Output**. Der Replay ist damit die zweite Hälfte derselben Messung, nicht
   ein zweites Feature.
5. **Der Befund trägt die Kette.** Export-Meta (`exportJson`) und gespeicherte
   Session (`saveSession`) tragen den vollen Provenance-Block
   (`platformVersion`, `scenario`, `ai`, `traceId`); der Report bekommt eine
   Provenance-Sektion. Wer den Befund liest, liest die Bedingungen, unter denen er
   stand.

## Why

- **Content-addressed statt zuweisend.** Ein Zähler- oder UUID-`TraceId` ist ein
  Name ohne Inhalt: er bindet die Session an nichts, und zwei identische
  Aufnahmen tragen zwei Namen. `t-` + SHA-256 des Manifests ist der stärkste
  Name, den die Aufnahme haben kann — sie *ist* ihr Name. Und die Prüfung
  (Session → `traceId` → Manifest → Digest) braucht keine Datenbank, nur die
  Kryptografie, die schon da ist.
- **Additive statt Breaking.** Provenance beschreibt die Bedingungen einer
  Aufnahme; sie ändert nicht, was eine Aufnahme *ist*. Ein Schema-Bump für vier
  optionale Felder wäre eine Migration, die nichts migriert — und sie würde die
  goldene Kette (Digest `8600983e…`, gespeicherte Sessions) brechen, um nichts
  zu gewinnen.
- **V2 als neue Version, nicht als Erweiterung von V1.** Was signiert wird, hängt
  davon ab, welche Felder existieren. V1 zu erweitern, würde die kanonische
  Zeichenkette ändern und damit alte Manifeste ungültig machen, die sich heute
  noch verifizieren lassen — genau die, die der goldene Digest schützt.
- **Ein Signer, ein Prozess.** Wer die Signatur erzeugt, muss sie auch
  verantworten können: der Prozess, der exportiert, kennt den privaten Schlüssel;
  ein Export, der auf einer anderen Maschine signiert wurde, ist ein Export, der
  jemand anderem gehört. Der `keyId` als PublicKey-Fingerabdruck macht das
  prüfbar, ohne dass das System Schlüsselverwaltung wird.

## Alternatives

- **UUID-`traceId` mit Manifest-Index in der Session:** abgelehnt — ein Name, der
  nicht aus dem Inhalt folgt, ist eine Behauptung; der Content-Address ist die
  Aussage, die man gegen das Manifest prüfen kann, ohne eine zweite Quelle.
- **Schema-Bump `SESSION_SCHEMA_VERSION 2` für die Provenance-Felder:** abgelehnt —
  additive optionale Felder brauchen keine Migration, und die gespeicherten
  Sessions bleiben lesbar (ADR 0007); ein Bump wäre eine Regel, die nichts regelt.
- **V1 zu erweitern, statt V2 einzuführen:** abgelehnt — die kanonische
  Zeichenkette der Signatur hängt von den Feldern ab; V1 zu ändern bricht
  bestehende Manifeste, V2 lässt sie gelten.
- **Den Replay als eigenes Feature neben dem Live-Lauf:** abgelehnt — dann ist er
  eine zweite Definition desselben Laufs (derselbe Fehler wie der zweite
  Haskell-Treiber, ADR 0055); als Test über dem Live-Lauf ist er die
  zweite Hälfte derselben Messung.

## Affected packages

- `@vdp/core`: `session.ts` (vier optionale Felder), `session-opener.ts`
  (`platformVersion` in `CreateSessionOptions`), `logging/integrity.ts`
  (V2 + Signatur-Verifikation, `SUPPORTED_VERSIONS`), neuer `ManifestSigner`-Port.
- `@vdp/storage`: `nodeManifestSigner` (ed25519, `node:crypto`).
- `@vdp/runtime`: Engine-Options tragen `platformVersion` (von
  `PLATFORM_VERSION`).
- `apps/web`: `backend.ts` (`saveSession`, `exportJson`, `runScenario`, `analyze`
  setzen die Felder; Provenance-Block im Export), Report: Provenance-Sektion.
- `tests/replay`: `scenario-replay.test.ts` (neu).

## Forbidden implementations

- **Kein Hash über einer anderen Darstellung.** Die Signatur läuft über die
  kanonische Zeichenkette `format|version|algorithm|entries|sha256` — wer ein
  anderes Feld oder eine andere Reihenfolge einbindet, signiert etwas anderes
  und verifiziert etwas Drittes.
- **Kein Schlüssel pro Export.** Der Signer ist pro Prozess; ein Export, der
  seinen eigenen privaten Schlüssel erzeugt, ist ein Export, den niemand
  prüfen kann (der Schlüssel ist weg, die Signatur bleibt).
- **Kein Schema-Bump für Provenance.** Optionale additive Felder; wer
  `SESSION_SCHEMA_VERSION` erhöht, um sie unterzubringen, hat sie zu etwas
  gemacht, was sie nicht sind.
- **Kein Replay ohne Verifikation.** Der Replay-Test muss Digest **und** Signatur
  prüfen, *bevor* er den gleichen Output behauptet; ein Replay, der den
  Manifest-Sprung überspringt, ist ein Replay, der nichts bewahrt.

## Migration

Die Entscheidung ist getroffen; die Implementierung läuft in diesem Stand:

1. `VehicleSessionData` + vier optionale Felder (additive, kein Bump).
2. `CreateSessionOptions` + `platformVersion` durch den Session-Opener in die
   Engine-Options.
3. `integrity.ts`: `SUPPORTED_VERSIONS = [1, 2]`, V2-Form, Signatur-Feld und
   Verifikation (Digest und Signatur), goldener Digest bleibt gepinnt.
4. `ManifestSigner`-Port in Core, `nodeManifestSigner` in Storage, Process-Signer
   in der Workbench.
5. `backend.ts`: `saveSession`/`exportJson`/`runScenario`/`analyze` setzen die
   Felder; Report-Provenance-Sektion.
6. `tests/replay/scenario-replay.test.ts`: Live-Lauf → signiertes Manifest →
   Verifikation → `ReplayTransport` → gleicher DTC-Output, je Szenario-Datei.

## Tests

- (bestehend, bleibt grün) `packages/core/src/logging/`-Specs: goldener Digest
  `8600983e…`, V1-Verifikation strikt — V2 ergänzt, ohne V1 zu brechen.
- (neu) `integrity`-Spec für V2: Signatur über kanonischer Zeichenkette,
  Falsifikation bei abweichendem Feld, `keyId`-Form.
- (neu) `tests/replay/scenario-replay.test.ts`: je Szenario-Datei der Live-Lauf,
  die Verifikation und der Replay — drei Behauptungen, eine Messung.

## AI implementation notes

- Die kanonische Zeichenkette ist die *einzige* Stelle, die „was signiert wird"
  definiert; `ManifestSigner` (Core) und `nodeManifestSigner` (Storage) teilen
  sie, eine zweite Kodierung wäre der alte Defekt (ADR 0047).
- `traceId` wird *aus* dem Manifest berechnet, nie *für* das Manifest gewählt;
  eine Session mit `traceId` trägt sie, weil das Manifest sie ergibt, nicht umgekehrt.
- Die vier Felder sind optional, weil sie Provenance sind; wer sie zu Pflicht
  macht, um „sauber" zu sein, hat sie zu Struktur gemacht und bricht die
  gespeicherten Sessions.
