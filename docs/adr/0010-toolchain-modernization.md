# 0010 — Schrittweise Toolchain-Modernisierung

Status: accepted (2026-09-11, Schritt 1 gemergt als PR #9) · Datum: 2026-09-10 · Bezug: ADR 0002, 0006, 0008; AGENTS 34.10, 35

## Kontext

ADR 0002 schützt die Plattform vor Supply-Chain-Risiken in Offline-
Werkstattnetzen. Derselbe Grundsatz führt aber dazu, dass Commodity-Code —
PDF-Erzeugung, ZIP, Charts, Schema-Validierung — selbst geschrieben und
gepflegt wird. Für die Protokoll-Kerne ist Eigenbau der Industriestandard
(Konformität zu ISO 14229/15765-2/13400 ist nicht als Paket kaufbar); für
Infrastruktur ist er es nicht.

## Entscheidung (vorgeschlagen, schrittweise)

ADR 0002 bleibt für die Protokoll- und Diagnoseschichten in Kraft. Für
Infrastruktur werden geprüfte, etablierte Abhängigkeiten zugelassen — in
dieser Reihenfolge, jeder Schritt ein eigener Pull Request:

1. **Vitest + V8-Coverage** ersetzt die `node:test`-Orchestrierung (ersetzt
   ADR 0008): natives TS/ESM, Coverage-Schwellenwerte, Watch-Mode. Die 266
   bestehenden Tests laufen mit minimalen Import-Änderungen weiter.
2. **Zod** für Definition-Package-Validierung und API-Bodies: typsichere
   Schemas statt handgeschriebenem Validator.
3. **Fastify + @fastify/helmet + pino** ersetzen das handgerollte Routing und
   den eigenen Logger (ersetzt Teile von ADR 0006): Schema-Routing, OpenAPI
   via @fastify/swagger, bewährte Body-/Stream-Behandlung.
4. **fflate** ersetzt den eigenen ZIP-Writer, **pdf-lib** den eigenen
   PDF-Writer, **uPlot** die eigene Canvas-Chart-Klasse (uPlot ist selbst
   dependency-frei und für synchronisierte Zeitreihen gebaut).
5. **Vite + TypeScript** fürs Frontend, damit `public/*.js` erstmals
   typgeprüft wird; Framework-Entscheid (Svelte/React) erst bei Bedarf.
6. **Biome** (Lint + Format) und **Playwright** (E2E) ergänzen die Pipeline.
7. **serialport** (Node) bzw. **Web Serial API** als produktive
   ByteStream-Bindings für ELM327/CANable.

Jede neue Abhängigkeit braucht: Maintenance-Nachweis (aktive Releases),
Lizenz-Check (MIT/Apache-2.0/BSD) und — für Laufzeit-Abhängigkeiten — ein
lokal regeneriertes Lockfile per `npm install`.

## Konsequenzen

- Offline-Installierbarkeit bleibt: `npm ci` aus dem Lockfile, keine
  Build-Zeit-Downloads.
- `transport/*` und `protocols/*` bleiben dependency-frei; dort ist die
  ISO-Norm der Standard, nicht ein Paket.
- Dieser ADR wurde auf `accepted` gesetzt, nachdem Schritt 1 (Vitest) am
  2026-09-11 als PR #9 gemergt wurde.
