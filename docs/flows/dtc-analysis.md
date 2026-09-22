# Flow: DTC-Analyse (Fehlerspeicher → Variantenwissen → Beleg)

> Pipeline: `CAN-Frame → DtcRecord (Roh) → DtcObservation (IR) →
> DtcEnrichment (Wissen) → DtcState → EvidenceItem`.

```text
Scan über alle Module (DtcAccess.scanAll, ADR 0049)
  ├─ antwortet  → ScannedEcu { ecuId, dtcs[] }   ─┐
  └─ antwortet nicht → UnreadEcu { ecuId, ecuName, rxId, reason }
                                                   │  DtcScanReport { scanned, unread }
ECU meldet Fehlerspeicher (0x19 READ_DTC_INFORMATION)
  ▼
@vdp/transport-can          CanFrame (Roh)
  ▼
@vdp/transport-iso-tp       Reassembly → Response-Bytes
  ▼
@vdp/protocols-uds          UdsClient.readDtcByStatusMask() → DtcRecord[] (Rohform:
                             code, raw, status, statusBits, snapshot)
  ▼
@vdp/core (dtc/)            DtcScanner: Decode + Varianten-Kontext
  ├─ DtcTracker: firstSeen/lastSeen, firstSeenInThisScan
  ├─ Freeze Frame: 0x19 SubFn 0x01/0x02 → recordNumber + Bytes
  └─ dtcObservationOf(record)  → DtcObservation (IR) + provenance(serviceId 0x19)
  ▼
@vdp/definitions            Variantenwissen (Schema v3, ADR 0024): Auflösung nach
                             Spezifität (OEM → Modell → Variante), Provenance-Gates
                             (ADR 0025) → DtcEnrichment (mit eigener evidence)
  ▼
@vdp/diagnostic-ir          DtcState { observation, enrichment?, firstSeen?, lastSeen? }
                             — „die ECU meldete P0420“ getrennt von „unser Wissen sagt X“
  ▼
@vdp/core (evidence/collect.ts)  collectEvidence() → EvidenceSet:
                             dtc:P0420@ecu-engine        (Aussage + Beleg der Enrichment-Quelle)
                             freeze-frame:P0420@ecu-engine
                             pattern:P0420@ecu-engine    (dokumentierte Checks als Items)
  ▼
@vdp/runtime (EvidenceService) / @vdp/reports / @vdp/web (Fehlerspeicher-View)
```

**Wichtige Kanten:**

- **Zwei Hälften, eine Wahrheit:** Observation (Fahrzeug) und Enrichment
  (unser Wissen) tragen *eigene* Evidence. Ein unbekannter Code ist eine
  `unproven`-Enrichment — „niemand kennt ihn“ ist ein Befund, kein Fallback
  (ADR 0024/0033).
- **Severity zweimal:** der Reader klassifiziert aus dem Status-Byte, das
  Paket dokumentiert seine eigene — eine Projektion löst
  `enrichment.severity ?? observation.severity` auf; ohne Klassifikation
  bleibt das Feld *abwesend*, nicht `info` (IR-Kontrakt).
- **Variantenwissen ist Daten:** `packages/definitions/src/<oem>/`, validiert
  durch `validate.ts` (ADR 0025). Kein DTC-Wissen im Code.
- **Status-Byte-Dekodierung existiert genau einmal:** `decodeDtcStatus` aus
  `@vdp/protocols-uds` (Core, Simulator, Workbench-View alle benutzen sie).
- **Zwei Scans ergeben Historie:** `firstSeen` erscheint erst ab dem zweiten
  Scan, in dem der Code sichtbar ist (AGENTS 20).
- **Ein Scan hat zwei Hälften (ADR 0049):** `scanned` sind die Codes, `unread` sind
  die Module, die nicht geantwortet haben — mit `ecuId`, `ecuName`, `rxId` und Grund.
  Ein Bus, an dem niemand antwortet, liefert `scanned: []` **und** ein volles
  `unread`; nur die erste Hälfte zu zeigen ist der Defekt, den das ADR behebt
  (nachgemessen: 200 `{"dtcs":[]}` bei 8,01 V Batteriespannung). Die Lücke reist als
  `QueryKinds.GetDtcScanGaps` und als Pflichtfeld `DtcsReadPayload.unreadCount`, und
  sie altert bei der nächsten Antwort des Moduls.

**Verboten:** `EnrichedDtc` aus `@vdp/core` direkt in Report/UI weiterreichen
(das ist die alte Einheitsform — die IR-Hälften sind der Kontrakt, ADR 0037);
DTC-Texte ohne Quelle zitieren; Status-Byte-Logik neu schreiben; `unread` aus einem
`DtcScanReport` verwerfen und nur `.scanned` weiterreichen (ADR 0049 — wer die erste
Hälfte will, schreibt es hin).

**Zugehörig:** [`docs/flows/ai-analysis.md`](ai-analysis.md) (was aus den
Items wird), [`tests/examples/dtc-analysis.example.ts`](../../tests/examples/dtc-analysis.example.ts).
