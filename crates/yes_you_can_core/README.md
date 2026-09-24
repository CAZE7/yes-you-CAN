# `crates/yes_you_can_core` — Referenz / experimentell

**Dieser Crate ist nicht Teil der Plattform.** Er wird **nicht gebaut**,
**nicht getestet** und **nicht importiert** — drei Sätze, die
`tests/architecture/reference-crate.test.ts` als Tor festhält, statt sie in
Prosa zu behaupten und rosten zu lassen.

| Frage | Antwort |
|---|---|
| Wird er gebaut? | Nein. Kein `cargo`-Schritt in `package.json`, keiner in `.github/workflows/`. |
| Wird er getestet? | Nein. Kein CI-Lauf ruft `cargo test` auf. |
| Importiert ihn die Plattform? | Nein. Nichts unter `packages/`, `apps/`, `tools/` verweist auf `crates/`. |
| Warum liegt er dann im Tree? | Als zweite, maschinenlesbare Aussage zu zwei Verträgen, für die es schon eine Referenz gibt: `formal/` (Haskell, ADR 0045). |

## Was bereits geprüft ist

| Befund (AGENTS 0.E E25, 2026-09-19) | Stand 2026-09-24 |
|---|---|
| (1) `isotp.rs` behauptete „SF up to 62 bytes (CAN-FD)" und „4 GB with 32-bit DL", implementiert ist Classic CAN | **geschlossen.** Der Modulkopf sagt heute „up to 7 bytes (Classic CAN)" und „up to 4095 bytes (12-bit DL)". |
| (3) `safety.rs::execute` nahm das Permit-Ablaufdatum vom Aufrufer entgegen | **geschlossen.** Die Signatur ist `execute(self, current_time_ms: u64)` und prüft gegen `permit.expires_at_epoch_ms`; `test_expired_permit_rejected` pinnt es. |
| (2) „zero-copy"/„zero-allocation" war unbelegt | **geschlossen als Claim.** `signal.rs` alloziert (`to_vec()`, zweimal `vec![0.0; n]`), `Cargo.toml` und `lib.rs` sagen das jetzt. Ein Benchmark fehlt weiter — er ist nicht nötig, solange niemand die Behauptung braucht. |

## Was offen ist — und warum es hier bleibt

| Befund | Warum offen |
|---|---|
| (4) `signal.rs` (252 Zeilen Statistik) hat keinen Test | Ein `#[cfg(test)]`-Block, den niemand übersetzt, ist ein Test, der nicht läuft — genau die Krankheit, gegen die `NOT RUN ≠ bestanden` steht. Der Block entsteht in einer Umgebung mit `cargo`, nicht hier. |
| (5) Der Crate hängt an keinem Tor | Bewusste Entscheidung (AGENTS 0.E E25): Integration nur bei messbarem Hotspot. Der Crate bleibt Referenz/Experimentell. |

## Zwei Befunde aus dem Lesen am 2026-09-24, ohne Toolchain nicht behebbar

Beide sind an Datei und Zeile gebunden und gehören in einen Lauf mit `cargo`:

1. **`src/isotp.rs:57` — `parse_frame` bricht bei einer Single Frame mit `SF_DL = 0`.**
   Der Zweig prüft `if len > data.len() - 1` und schneidet dann `&data[1..=len]`.
   Für `len == 0` ist das `&data[1..=0]` — ein Bereich, dessen Anfang hinter
   seinem Ende liegt, und `panic!` statt `Err(IsoTpError)`. Ein Frame `[0x00]`
   oder `[0x00, 0x00]` panikt damit. Ein Dekodierer, der auf unvollständiger
   Eingabe panikt, ist ein Dekodierer, den man nicht an einen Bus hängen darf.
   Der Fix ist eine Zeile (`len == 0` mit abweisen oder als leere Nutzlast
   zulassen — die TypedScript-Referenz in `packages/transport/iso-tp/src/`
   entscheidet, was normgerecht ist); **ohne Compiler ist er hier nicht
   belegbar**, deshalb steht er hier und nicht im Code.
2. **`compute_fft` setzt `values.len() >= 4` voraus, prüft aber nicht, dass
   `timestamps` dieselbe Länge hat.** `timestamps.last()`/`first()` lesen über
   `unwrap_or`, ein kürzeres `timestamps` ergibt eine stillschweigend andere
   Abtastrate statt eines Fehlers. Gleiche Begründung: ein Verhalten, das man
   ohne Lauf nicht beweisen kann.

## Wie es weitergeht

Der Weg steht in AGENTS 0.E E25 und ist vorab entschieden: **Integration nur bei
messbarem Hotspot** (Benchmark → nachweisen → Binding), sonst bleibt der Crate
Referenz. Soll er Referenz *mit* Pflichten werden, sind die Schritte:

1. `cargo test` in einem Job (braucht die Toolchain),
2. ein Rust-Runner über **dieselben** Vektordateien wie TypeScript und Haskell
   (`tools/formal-conformance/vectors/`, ADR 0045 — das Differential-Gate mit
   einem dritten Subjekt),
3. erst dann ein `cargo`-Schritt in `package.json`.
