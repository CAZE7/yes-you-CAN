# Lese-Paket: Vokabel

**Zweck:** Den richtigen Namen finden — bevor ein neuer (falscher) Name
entsteht.

## Lese-Liste

1. [`../docs/glossary.md`](../docs/glossary.md) — die verbindliche Vokabel:
   der diagnostische Pfad (Frame → Bus → Link → UDS-Message → Raw/Decoded),
   das Diagnostic-IR-Wort (Observation, Evidence, Provenance, Enrichment,
   DtcState, SignalReading, Session), der analytische Teil (EvidenceItem,
   EvidenceSet, Hypothesis, DiscriminatingTest) und das Schreib-Universum
   (WriteOperation, WritePort, SafetyManager, NRC).
2. Die Sektion **„Verbotene Doppelnamen“** desselben Dokuments — die
   Fallstricke, die ein Agent am häufigsten trifft (`DiagnosticData`,
   „Session“ für UDS-Diagnosesession, `Measurement` für alles).

## Die drei goldenen Regeln

1. **Ein Begriff = eine Bedeutung.** Ein neuer Name für ein bestehendes
   Ding ist ein Defekt.
2. **Roh heißt `raw`, dekodiert heißt `value`** — nie umgekehrt, nie
   „value“ für die Rohebene (ADR 0004).
3. **Evidenz-Wörter kommen aus dem IR** (`evidence`, `proven`, `unproven`,
   `conflict`) — eine UI/Report/Analyse, die eigene Evidenz-Vokabeln
   erfindet, erzeugt eine zweite Kopie (ADR 0038).
