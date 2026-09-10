# 0009 — CI/CD-Baseline und HTTP-Härtung

Status: accepted · Datum: 2026-09-10 · Bezug: AGENTS 27, 31, 34.8, 35

## Kontext

Die Plattform hatte 266 Tests, aber keine Automatisierung: „build green“ war
eine manuell geprüfte Behauptung. Der Workbench-Server band standardmäßig an
`0.0.0.0`, sendete keine Security-Header und akzeptierte unbegrenzt große
Request-Bodies — für ein Diagnose-Tool ohne Authentifizierung kein tragbarer
Auslieferungszustand.

## Entscheidung

- **GitHub Actions** (`.github/workflows/ci.yml`): Matrix-Build auf den
  Node-LTS-Versionen 22 und 24, `npm ci` (Lockfile erzwungen), `npm run build`,
  `npm test`. Minimale Token-Rechte (`contents: read`), Abbruch veralteter
  Läufe per Concurrency-Gruppe.
- **Dependabot** (`.github/dependabot.yml`): wöchentliche Updates für
  npm-Abhängigkeiten und GitHub Actions.
- **HTTP-Härtung** (`apps/web/src/server.ts`):
  - Bind an `127.0.0.1` als Standard; Freigabe ins Netz nur explizit über
    `--host`/`VDP_HOST`, mit Warn-Log bei `0.0.0.0`.
  - Einheitliche Security-Header auf jeder Antwort: strikte CSP
    (`default-src 'self'`, kein Inline-JavaScript), `nosniff`,
    `frame-ancestors 'none'`, `referrer-policy: no-referrer`.
  - Request-Bodies auf 1 MB begrenzt (413); ungültiges JSON wird als 400
    beantwortet statt still als `{}` weiterzulaufen.
  - `/api/stream` und statische Pfade sind GET-only (405).

## Konsequenzen

- „Green“ ist ab jetzt pro Push und Pull Request belegt, nicht behauptet.
- Container-Deployments müssen `VDP_HOST=0.0.0.0` setzen — bewusster
  Trade-off: Exposition ist eine Entscheidung, kein Versehen (AGENTS 27).
- CodeQL, Dependency-Review und Secret-Scanning erfordern auf privaten
  Repositories GitHub Advanced Security und werden aktiviert, sobald das Repo
  public ist oder GHAS vorliegt.
