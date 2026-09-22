# ADR 53 — Abhängigkeiten, Hardware-Grenze und Werkzeug-Ausnahme als Teil von Industriestandard

- Status: akzeptiert (2026-09-22)
- Kontext: ADR 0050 (Konformanz-Register), ADR 0052 (goldene Sitzungen),
  AGENTS 0.E (offene Befunde), `npm outdated`, `npm audit`, `tests/hardware/`,
  `biome.json`
- Betrifft: `package.json`, `package-lock.json`, `docs/standards/conformance.md`,
  `docs/standards/README.md`, `docs/adr/README.md`,
  `architecture/architecture.yaml` (Topic `formal`)

## Problem

„Alles auf Industriestandard" enthält neben Normen auch Betriebshärtung, die sich
messen lässt:

- **5 veraltete Pakete** (`npm outdated`): `@biomejs/biome` 1.9.4 → 2.5.14 (Major),
  `@types/node` 26.5.1 → 26.6.2, `vitest` 5.0.0 → 5.0.1,
  `@vitest/coverage-v8` 5.0.0 → 5.0.1, `fast-check` 4.9.0 → 4.10.2.
  `npm audit` meldete 0 Schwachstellen — das ist gut, aber ein Major-Sprung ohne
  Migration ist kein „Update", sondern ein Projekt.
- **Hardware-Tests** (`tests/hardware/vcan.test.ts`,
  `socketcan-conformance.test.ts`) brauchen `vcan0` und `socketcan`. Ohne das
  Interface skippen sie deterministisch. Das war in ADR 0016/0017 dokumentiert, aber
  im Konformanz-Register fehlte die Zeile — wer nur das Register liest, sieht eine
  Lücke, wo eine Grenze ist.
- **Goldene Sitzungen** waren bis ADR 0052 nicht reproduzierbar (44 Wertzeilen
  Drift). Das ist seit 0052 behoben, aber im Register stand noch der alte Befund
  nicht als erledigt.

## Entscheidung

**1. Sichere Updates sofort, Major mit Begründung zurückstellen.**
`@types/node` 26.5.1 → 26.6.2, `vitest` 5.0.0 → 5.0.1,
`@vitest/coverage-v8` 5.0.0 → 5.0.1, `fast-check` 4.9.0 → 4.10.2 wurden aktualisiert
(`npm install --save-dev`, gemessen: `npm ci` EXIT 0, `biome check .` 482 Dateien
grün, `vitest --project unit` 114 passed). `@biomejs/biome` 1.9.4 bleibt — 2.x
verlangt eine Config-Migration (`$schema` 1.9.4 → 2.x, neue Regel-Namen, neue
`overrides`-Form), und ein Major-Sprung im Linter mitten in einem
Sicherheits-PR wäre genau die Verwechslung von „aktuell" und „stabil", die
Industriestandard vermeiden will. Die Ausnahme steht im Register mit Begründung
und Aufwand.

**2. Hardware-Grenze ins Register, nicht nur in ADRs.**
`tests/hardware/` ist die Grenze zwischen „läuft auf diesem Rechner" und „läuft
nur mit vcan". Der Test-Skip ist kein Fehler, sondern die Aussage „ohne vcan0
keine Aussage über SocketCAN". Das steht jetzt in `conformance.md` unter
„Betrieb und Werkzeuge".

**3. Goldene Sitzungen als erledigt markieren.**
Seit ADR 0052: 0 Wertzeilen Drift zwischen zwei Läufen auf demselben Baum,
vorher 44. Die Zeile im Register bewegt sich von „Lücke" nach „implementiert".

**4. Kein neues Tool ohne Begründung.**
`cargo`, `ghc`, `stack`, `rustc` fehlen in der Umgebung — gemessen mit
`command -v`. Das ist keine Lücke, die man mit einem PR schließt, sondern eine
Umgebungsgrenze. Sie steht im Register als „nicht verifiziert", nicht als „fehlt".

## Why

- **Ein Major-Update ohne Migration ist kein Fortschritt.** Biome 2.x ändert das
  Schema, die Regel-Namen und die Fix-Semantik. Wer das in einem PR mitzieht, der
  gleichzeitig Authentifizierung und Clock-Injection einführt, produziert einen
  Diff, den niemand reviewen kann — und bricht die Regel „ein Thema je PR"
  (AGENTS 0.C.1).
- **Eine Grenze, die nur in einer ADR steht, ist für den nächsten Leser
  unsichtbar.** Das Konformanz-Register ist die Datei, die jemand öffnet, wenn er
  „ist das Industriestandard?" fragt. Wenn die Hardware-Grenze dort fehlt, sieht er
  eine Lücke und meldet sie — wieder.
- **Reproduzierbarkeit ist Betriebshärtung.** Eine goldene Sitzung, die bei jedem
  Lauf anders wird, ist kein Referenzartefakt, sondern Rauschen, das `git diff`
  unlesbar macht.

## Alternatives

1. **Biome sofort auf 2.5.14.** Verworfen: Config-Migration + Regel-Anpassungen +
   482 Dateien neu formatiert = eigener PR, eigene Messung, eigenes Risiko. In
   diesem PR wäre es ein Nebenschauplatz mit Hauptwirkung.
2. **Hardware-Tests aus dem Register streichen.** Verworfen: dann fehlt die Aussage,
   wo die Grenze liegt.
3. **Goldene Sitzungen weiter als „nicht byte-stabil" führen.** Verworfen — seit
   0052 ist die Aussage falsch.

## Affected packages

Kein Produktionscode. `package.json` / `package-lock.json` (4 Dev-Dependencies),
`docs/standards/*`, `docs/adr/*`, `architecture/architecture.yaml`.

## Forbidden implementations

- **Ein Major-Update ohne Config-Migration committen.**
- **Hardware-Tests als Fehler werten, wenn sie skippen.** Sie skippen, weil die
  Umgebung fehlt — das ist die Aussage.
- **Goldene Sitzungen als nicht reproduzierbar dokumentieren**, nachdem 0052
  gemessen 0 Wert-Drift liefert.

## Tests

Kein Produktionscode. Messungen:

- `npm outdated` vorher: 5 Pakete, nachher: **1** (`@biomejs/biome` 1.9.4 → 2.5.14,
  bewusst offen).
- `npm audit`: **0** Schwachstellen vorher und nachher.
- `npm ci` EXIT 0, `biome check .` 482 Dateien grün, `vitest --project unit`
  114 passed, `CI=true npm run ci` EXIT 0 — 2330 Tests / 161 Dateien,
  Coverage-Gate 94,13 / 86,39 / 95,94 / 95,52.
- `npm run golden:record` zweimal hintereinander: **0** Wertzeilen Drift
  (vorher 44), 3472 Zeilen nur Zeitstempel.
- `command -v cargo ghc stack rustc` → keines vorhanden — im Register als
  „nicht verifiziert".

## AI implementation notes

- Wer Biome auf 2.x hebt, macht das in einem eigenen PR mit `biome migrate`
  und einem `biome check .` über 482 Dateien vorher/nachher.
- Wer eine neue Hardware-Abhängigkeit einführt, trägt sie in `conformance.md`
  unter „Betrieb und Werkzeuge" ein — mit Beleg (Datei/Zeile) und Skip-Grund.
- Goldene Sitzungen: nach einem `golden:record` gehört `git diff` gelesen; ein
  Diff aus Zeitstempeln ist keiner gegen den Code.
