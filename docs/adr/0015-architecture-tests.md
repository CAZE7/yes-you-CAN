# 0015 — Architekturtests: der Abhängigkeitsgraph ist ein Test

Status: accepted · Datum: 2026-09-11 · Bezug: ADR 0001, 0014; Zielarchitektur §28/§29

## Kontext

Die Schichtungsregeln der Plattform (AGENTS 2, ADR 0001) wurden bisher durch
Reviews und Disziplin verteidigt. Mit wachsender Paketzahl und mehreren Paketen,
die bewusst *keine* Technik kennen dürfen (`@vdp/domain`, `@vdp/application`),
reicht das nicht: Eine Regel, die niemand durchsetzt, ist nach zwei Jahren eine
Empfehlung.

Typische Erosion, die verhindert werden soll:

- `domain` importiert „nur für einen Typ" etwas aus `@vdp/protocols-uds`.
- Ein Adapter ruft zur Bequemlichkeit direkt `DiagnosticEngine` auf.
- Ein neues Paket entsteht und hängt sich irgendwohin, ohne dass jemand die
  Schichtung bewusst entscheidet.
- `node:fs` sickert in einen Kern, der später auch im Browser laufen soll.

## Entscheidung

- **Der Importgraph ist ein Test.** `tests/architecture/dependencies.test.ts`
  scannt alle Workspace-Pakete (Produktivquellen, ohne `*.spec.ts`), baut den
  realen `@vdp/*`-Importgraphen und prüft ihn gegen eine explizite
  Allowlist (`ALLOWED_VDP_DEPS`). Jede nicht erlaubte Kante lässt die Suite failen.
- **Neue Pakete müssen sich bewusst einordnen.** Ein Paket ohne Eintrag in der
  Allowlist ist ein Testfehler — die Architektur wird beim Anlegen entschieden,
  nicht nachträglich repariert.
- **Zusätzliche harte Regeln als eigene Tests:**
  - kein Paket importiert die UI (`@vdp/web`);
  - portable Schichten (`shared`, `domain`, `application`, `charts`,
    `definitions`, `protocols-*`, `transport-*`, `adapter-*` außer `host`,
    `core`, `runtime`, `ai`, `reports`) importieren keine `node:*`-Builtins —
    Dateisystem und Sockets gehören zu `storage`, `adapter-host` und den Apps;
  - `domain`/`application` sind protokoll- und transportfrei;
  - Protokolle importieren keine Adapter, Transporte keine Protokolle, Adapter
    weder Protokolle noch Core.
- **Ein Graph-Snapshot** dokumentiert den aktuellen Zustand und macht jede
  Kantenänderung im Diff sichtbar — Architekturänderung wird zum Review-Ereignis.
- Die Tests laufen als eigenes Vitest-Projekt `architecture` in jedem normalen
  `npm test`-Lauf (und damit in CI) mit.

## Konsequenzen

- Wer eine Abhängigkeit braucht, die die Allowlist nicht hergibt, ändert zuerst
  die Architektur (oder begründet die neue Kante im PR und im Snapshot).
- Bestehende, bewusst zugelassene Ausnahmen (z. B. `adapter-canable` nutzt die
  ELM327-Implementierung mit) sind in der Allowlist sichtbar und damit diskutierbar.
- Die Tests sind statisch (kein Build nötig) und laufen in Millisekunden.
