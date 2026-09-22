# ADR 52 — Die Uhr des Signalmodells ist ein Parameter, nicht die Geschwindigkeit der Maschine

- Status: akzeptiert (2026-09-22)
- Kontext: ADR 0036 (goldene Sitzung), ADR 0049 Befund 8 (die Messung, die dieses ADR
  ablöst), AGENTS 31 (Determinismus schlägt Laufzeit), ADR 0019 (warten auf
  Bedingungen, nicht auf Dauer)
- Betrifft: `tools/simulators/src/virtual-vehicle.ts` (`VirtualVehicleOptions.clock`),
  `tools/golden-sessions/src/record.ts` (Recorder-Uhr),
  `tools/simulators/src/virtual-vehicle-clock.spec.ts` (neu),
  `tests/fixtures/golden-sessions/*.golden.json` (neu aufgezeichnet),
  `tools/golden-sessions/README.md`

## Problem

ADR 0049 hielt fest: `npm run golden:record` auf **unverändertem** Baum schreibt
1804+/1804−, und nach Herausrechnen der Zeitstempel bleiben **44 Wertzeilen** Drift —
`abs.wheel_speed` 40,76 → 40,78, `engine.rpm` 831,3 → 832, `maf` 4,23 → 4,24,
Kühlmittel-Rohwert `0C FD` → `0D 00`. ADR 0049 entschied „dokumentiert statt
repariert", weil Einfrieren das Thema von ADR 0036 sei. Das war die halbe Antwort:
die Ursache war eine Zeile, und sie stand nicht im Recorder.

`tools/simulators/src/virtual-vehicle.ts:330`:

```ts
const elapsedS = (Date.now() - this.startedAt) / 1000;
```

Jedes sich entwickelnde Signal leitete sich aus der **Wanduhr** ab. Der
Pseudozufallsgenerator daneben war längst seeded — sein Kommentar sagt „so
recordings are reproducible". Die Uhr war das verbleibende Leck, und sie machte aus
einem Rezept zwei Autos, je nachdem wie schnell die Maschine gerade war.

## Entscheidung

**1. Die Uhr wird injizierbar.** `VirtualVehicleOptions.clock?: () => number`,
Default `Date.now`. `startedAt` und `elapsedS` lesen dieselbe Quelle. Kein
Verhalten ändert sich für jeden, der nichts übergibt — die Demo fährt weiter auf der
Wanduhr, denn ein Auto, das sich beim Zuschauen nicht bewegt, ist keine Demo.

**2. Der Recorder gibt eine eigene Uhr vor und schaltet sie in Phasen weiter.**
`record.ts` setzt `PHASE_MS = 50` und ruft zwischen `connect`,
`detectVehicleIdentity`, `snapshotSignals` und `scanDtcs` je einmal
`advancePhase()`. **Gestaffelt, nicht eingefroren:** eine eingefrorene Uhr würde
jedes Signal auf seinen t=0-Wert nageln, und die Fixtures würden aufhören, ein
fahrendes Auto zu zeigen. Ein Schritt je Phase hält die Werte *innerhalb* einer
Phase konstant — das ist, was aus einer `equal`-Erwartung eine `equal`-Erwartung
macht statt eines Bereichs.

**3. Die Zeitachse des Traces bleibt auf der Wanduhr, und das ist entschieden, nicht
übersehen.** Der Versuch, auch die ISO-TP-Verbindung auf die Recorder-Uhr zu legen
(`now: this.clock` — der Seam existiert, `connection.ts:105`), ist **gemessen
gescheitert**: die Aufnahme lief **359 s** und endete mit **EXIT 1** statt 3,6 s und
0, weil die ISO-TP-Timer eine echte Uhr brauchen. Zurückgenommen. Übrig bleiben
1782 `"timestamp"`- und 1690 `"t"`-Zeilen; ein Trace hält fest, *wann* etwas
geschah, und der Vergleich läuft im IR-Vokabular, nicht auf Zeitstempeln.

**4. Die Fixtures wurden neu aufgezeichnet.** Ihre Werte sind jetzt die des
Rezepts statt die des Augenblicks.

## Why

- **Ein Artefakt, das bei jedem Lauf anders wird, ist kein Referenzartefakt.** Die
  goldene Sitzung ist Aufzeichnung *und* Erwartung (ADR 0036); eine Erwartung, die
  von der Rechengeschwindigkeit abhängt, erwartet nichts.
- **`git diff` ist das Interface des Aufzeichnens.** Wer nach einem `golden:record`
  1804 geänderte Zeilen sieht, kann nicht unterscheiden, was Absicht ist und was
  Rauschen — und committet beides oder nichts.
- **AGENTS 31 gilt auch hier.** Überall sonst ist die Zeit injizierbar
  (`SessionLogger({ clock })`, `IsoTpConnection({ now })`, `modelTickMs: 0`); das
  Signalmodell war die Ausnahme, und Ausnahmen von einer Regel, die das Repository
  sonst durchhält, sind der Ort, an dem Determinismus verloren geht.

## Alternatives

1. **Bei ADR 0049 bleiben (dokumentieren statt reparieren).** Verworfen, nachdem die
   Ursache eine Zeile war: ein Befund, dessen Behebung eine Option mit Default ist,
   ist kein Architekturthema.
2. **Die Uhr einfrieren.** Verworfen — die Fixtures würden ihre Dynamik verlieren und
   `equal`-Erwartungen würden zu Bereichen.
3. **Pro Aufruf weiterschalten statt pro Phase.** Verworfen: zwei Lesungen desselben
   Signals in einer Antwort würden sich unterscheiden, und aus jeder `equal`-Erwartung
   würde ein `min`/`max`-Paar — ein ungenaueres Artefakt.
4. **Auch die Trace-Zeit deterministisch machen.** **Versucht und verworfen** —
   gemessen 359 s und EXIT 1.

## Affected packages

`@vdp/simulators` (Option + eine Zeile), `@vdp/golden-sessions` (Recorder-Uhr),
Fixtures. Kein Produktionstopf, keine Architekturkante, keine neue Abhängigkeit.

## Forbidden implementations

- **Im Signalmodell `Date.now()` direkt lesen.** Der Default steht im Konstruktor.
- **Die Recorder-Uhr einfrieren** oder pro Aufruf weiterschalten.
- **Der ISO-TP-Verbindung eine gestaffelte Uhr geben.** Die Timer brauchen eine echte
  Uhr — gemessen.
- **Fixtures committen, ohne `git diff` gelesen zu haben.** Ein Diff aus lauter
  Zeitstempeln ist keiner gegen den Code; ein Diff mit Werten ist einer.

## Tests

`tools/simulators/src/virtual-vehicle-clock.spec.ts` (neu, 3) — über den Draht
(`0x22` auf DID `0xF405`), nicht gegen ein Feld des Simulators:

- zwei Fahrzeuge, gleicher Seed, gleiche Uhr → gleicher Wert, **und** unter 100 °C
  (die Decke, die eine Wanduhr von 2026 gegen eine Epoche von 2023 liefert — ohne
  diese zweite Hälfte hielte die Gleichheit aus dem falschen Grund);
- die Uhr weiterschalten bewegt das Signal — **der Biss**;
- ohne Option läuft das Fahrzeug weiter auf der Wanduhr (der Demo-Fall).

**Biss gemessen:** `this.clock()` zurück auf `Date.now()` → **2 von 3 Tests rot**
(`105 °C — 105 is the ceiling…` und `cold 105 °C, warm 105 °C`).

**Reproduzierbarkeit gemessen:** zwei `npm run golden:record`-Läufe auf demselben
Baum → Diff von 3472 Zeilen, davon **0** Wertzeilen; Feldverteilung
1782 × `"timestamp"`, 1690 × `"t"`. Vorher: 44 Wertzeilen.
`npm run golden:record` **EXIT 0** in 3,6 s, `--project replay` **17 Tests grün**,
`tools/golden-sessions` **42 Tests grün**.

## AI implementation notes

- `VirtualVehicleOptions.clock` ist die einzige Zeitquelle des Signalmodells; wer ein
  neues sich entwickelndes Signal schreibt, liest `elapsedS` und nicht die Uhr.
- Der Recorder schaltet die Uhr in `advancePhase()` weiter — ein neuer
  Aufzeichnungsschritt gehört zwischen zwei Phasen, nicht innerhalb.
- `IsoTpConnection({ now })` existiert und bleibt für Tests mit virtueller Zeit; der
  golden-Recorder benutzt ihn **nicht** (siehe Entscheidung 3).
