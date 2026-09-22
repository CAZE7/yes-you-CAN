# Standards — was dieses Repository erfüllt, und was nicht

Dieser Ordner ist die ehrliche Antwort auf „ist das Industriestandard?". Er besteht
aus einem Register mit Belegen und drei Gerüsten für Normen, die sich nicht durch
Code erfüllen lassen.

| Datei | Was sie ist |
|---|---|
| [`conformance.md`](conformance.md) | **Das Register.** Jede Norm → Status → Beleg (Datei/Zeile) → Lücke → wer → Aufwand. Seit ADR 0052/0053 auch Betrieb: goldene Sitzungen 0 Wert-Drift, Deps gepflegt, Hardware-Grenze dokumentiert |
| [`iso-26262-safety-concept.md`](iso-26262-safety-concept.md) | Sicherheitskonzept als Gerüst: Item-Definition, Sicherheitsziele im Entwurf, was maschinell schon gepinnt ist |
| [`hara-template.md`](hara-template.md) | HARA-Arbeitsblatt mit fünf Gefährdungen — S/E/C/ASIL **leer**, weil sie eine benannte Person setzen muss |
| [`iso-21434-cybersecurity.md`](iso-21434-cybersecurity.md) | TARA-Gerüst mit der gemessenen Angriffsfläche der Workbench — seit ADR 0051 mit Token-Tor, HSTS, Zustand in der Warnung |

## Die Kurzantwort

**Kommunikations- und Diagnosenormen: implementiert und getestet.** ISO 14229-1/-2,
ISO 15765-2/-4, ISO 13400-2, ISO 11898-1, ISO 14230, SAE J1979 / ISO 15031-5,
SAE J2012 — je mit Anker im Register. Dazu **28 ISO-TP- und 44 Write-Safety-Vektoren**
(`npm run formal:conform` → 28/28 und 44/44).

**Prozess- und Sicherheitsnormen: fehlen.** ISO 26262, ASPICE, ISO 21434 / UNECE
R155 — keine ist implementiert, und keine lässt sich durch Code allein erfüllen.
MISRA ist nicht anwendbar (C/C++; dieses Repository ist TypeScript — das Äquivalent
ist maschinell getornt, `tests/architecture/hygiene.test.ts`), AUTOSAR ebenso.

**Formale Referenzseite: nicht verifiziert.** `npm run formal:conform` meldet
wörtlich `haskell NOT RUN`, wenn keine GHC-Toolchain da ist; die Rust-Crate ist aus
demselben Grund unverifiziert (AGENTS 0.E E25, fünf offene Befunde).

## Warum diese Dateien existieren

Ein Werkzeug, das an einem echten Fahrzeug schreibt, wird irgendwann danach gefragt,
welche Normen es erfüllt. Die zwei möglichen Antworten sind „alle" und eine Tabelle.
Diese Dateien sind die Tabelle — mit der Zusage, dass jede Zeile einen Anker hat oder
als Lücke dasteht, und dass eine Lücke einen Namen und einen Aufwand trägt.

Die Regel dahinter ist dieselbe wie im Rest des Repositories: **Messung vor
Behauptung** (AGENTS 34.21). Eine Norm, die im Code wächst, ohne dass ihre Zeile hier
wächst, ist eine Lücke, die niemand sieht.

## Pflege

- Eine Änderung, die einen Norm-Status bewegt, ändert ihre Zeile **im selben PR**
  (AGENTS 34.24).
- S/E/C/ASIL bleiben leer, bis eine benannte Person sie setzt. Sie hier „vorläufig"
  zu füllen wäre eine Zahl ohne Geltung.
- Belege altern: eine Zeile, deren Datei verschoben wurde, ist ein falscher Beleg.
  Lieber die Zeile löschen als einen Anker stehen lassen, der nicht trägt.

**Zugehörig:** [ADR 0050](../adr/0050-standards-conformance-register.md),
[`../code-map.md`](../code-map.md), [`../../AGENTS.md`](../../AGENTS.md) §0.A.
