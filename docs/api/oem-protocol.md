# Public API: `@vdp/protocols-oem` — die Vorlage für ein Herstellermodul

> Paket: [`packages/protocols/oem/`](../../packages/protocols/oem/README.md) ·
> Layer: **protocol** (importiert **nichts** — nicht einmal `@vdp/shared`) ·
> ADRs: [0003](../adr/0003-definition-packages.md), [0059](../adr/0059-contracts-are-frozen-and-measured.md) ·
> Vertrag im Record: `@vdp/protocols-oem` (**eine** Datei — der kleinste Vertrag des
> Repos, und das ist die Aussage)

Dieses Paket ist der Ort, an dem sich ein OEM-Modul einklinkt, ohne unsere Innereien zu
kennen. Es hat **keine Importe**: Wer einen Hook implementiert, braucht nur diese Typen —
kein `@vdp/core`, keinen Bus, keinen Port. Das macht es zum saubersten Kandidaten für die
Open/Closed-Grenze: Ein geschlossenes Modul kann gegen *genau diese* Datei kompilieren.

## Was hier Vertrag ist

| Export | Bedeutung |
|---|---|
| `OemProtocol` | Der Hook selbst: Kennung, Identifikations-Hinweise, DTC-Interpretation, optionale Hinweise — **nur lesend** |
| `OemIdentificationHint` | Ein Merkmal, an dem sich ein Steuergerät dieser Marke erkennen lässt (Label + erwartete Form) |
| `OemDtcInterpretation` | Was ein Code bei dieser Marke bedeutet — Wording und Provenance, **keine** Handlung |
| `OemProtocolRegistry` | Die Registrierung: Ein Modul meldet sich an, die Plattform fragt ab |
| `vagExampleProtocol` | Das mitgelieferte Beispiel — Referenz, kein Bestandteil des Vertrags |

**Ein Hook schlägt vor, er schreibt nicht.** Es gibt in dieser Fläche keinen
`WriteOperation`-Bezug, keine Service-Id zum Senden, keinen Transport. Ein OEM-Modul, das
etwas am Fahrzeug ändern will, muss durch dieselbe Kette wie alles andere
(`WritePort` + `SafetyManager`, AGENTS 26) — die Kette ist offen und bleibt offen, gerade
weil das Modul sie nicht umgehen kann.

## Die Kanten (maschinell geprüft)

1. **Das Paket importiert nichts** — `mayImport: []`. Wächst hier ein Import hinein, ist
   der Vertrag keine Vorlage mehr, sondern eine Abhängigkeit (`npm run check:deps`).
2. **Die Fläche ist eine Datei** (`dist/src/index.d.ts`, `entry` im Record sichtbar).
   Die kleinste Vertragsfläche des Repos ist Absicht: Je weniger ein Closed-Modul kennen
   muss, desto weniger bricht bei uns.
3. **Nichts importiert dieses Paket außer der Registry-Nutzung** — die
   Layer-Regeln halten Protokolle von Adaptern und Transporten getrennt.

## Häufige Fehler

- **Einen Schreibpfad in den Hook legen** („das Modul weiß doch, wie es geht“) — dann ist
  die Write-Kette optional, und die Safety-Zusage (AGENTS 26) wird zur Behauptung.
- **Die Interpretation mit Handlungsanweisungen füllen.** `OemDtcInterpretation` erklärt,
  was ein Code heißt; was zu tun ist, entscheidet der Diagnose-Loop auf Basis von Belegen
  (`docs/api/hypothesis.md`).
- **Markenspezifische Zahlen ohne Provenance liefern** — ein Hook ohne Herkunft ist ein
  Gerücht mit Typen.

**Zugehörig:** [`docs/api/definitions-schema.md`](definitions-schema.md) (wo dieselbe
Information als *Daten* liegt), [`docs/flows/open-core-boundary.md`](../flows/open-core-boundary.md)
(was ein Closed-Modul bekommen darf und was nicht).
