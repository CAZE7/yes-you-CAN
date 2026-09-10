# 0003 — OEM-Wissen in Definition-Paketen mit Pflicht-Provenance

Status: accepted · Datum: 2026-09-10 · Bezug: AGENTS 3, 13, 24, 34.6

## Kontext

Hersteller-DIDs und Fehlercodes sind der Teil mit dem größten Haftungsrisiko:
Wer erfundene Werte als Fahrzeugwahrheit ausgibt, erzeugt Fehldiagnosen.

## Entscheidung

OEM-Daten leben ausschließlich in `DefinitionPackage`-Strukturen, nie in
Diagnose- oder UI-Code. Jedes Paket trägt eine verpflichtende `provenance`:

```ts
provenance: { sourceType: 'own' | 'standard' | 'licensed' | 'community'
                        | 'reverse-engineered' | 'example-placeholder',
              source: string, license?: string }
```

Der Validator (`validateDefinitionPackage`) erzeugt Warnungen für
`reverse-engineered` und `example-placeholder`. Die mitgelieferten VAG- und
Mercedes-Pakete sind ausdrücklich `example-placeholder` — sie enthalten
erfundene Werte und sind als solche gekennzeichnet.

Zusätzlich gibt es `OemProtocol`-Hooks (`protocols/oem`) für die drei Stellen,
an denen Herstellerwissen Verhalten ändert: Adress→Rolle, Identifikations-DIDs,
DTC-Interpretation. Die Engine konsultiert sie **nur**, wenn die
Definition-Pakete nichts sagen — dokumentierte Daten gewinnen immer.

## Konsequenzen

- Importierte DBC-/CSV-Dateien werden validiert, nicht blind übernommen.
  Broadcast-Meldungen werden *nicht* zu ECUs, weil sonst Request-Kennungen
  erfunden würden, die kein Fahrzeug beantwortet.
- Signale über 32 Bit Länge werden mit Grund übersprungen statt stillschweigend
  gekürzt.
- Die UI kann Provenance anzeigen; eine Analyse ist nie „einfach wahr".
