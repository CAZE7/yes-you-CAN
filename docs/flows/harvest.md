# Flow: Ernte — ein Fahrzeug read-only auslesen und als Beobachtung behalten

> Pipeline: `CanBus → Discovery → UDS-Leseantworten → HarvestReport →
> { harvest.json · ODX-D/PDX · Definitions-Kandidat }` (ADR 0058)

```text
Plan (tools/harvest/src/plan.ts — Daten, vor dem Lauf druckbar)
  ├─ Bereiche: F180–F1FF (Identifikation), F400–F4FF (OBD), Paket-DIDs
  ├─ Dienste: sichere Sonden aus @vdp/core + „never sent" mit Grund
  └─ Budgets: requestGapMs, budgetPerEcuMs, maxDidsPerEcu, Doppellesung
  ▼
Discovery (EcuDiscovery, @vdp/core)
  ├─ antwortet → DiscoveredEcu { rxId, txId, extended, definitionEcuId }
  └─ deklariert, aber stumm → HarvestUnread { rxId, txId, reason }   ← zweite Hälfte
  ▼
je ECU: IsoTpConnection → UdsClient (tools/harvest/src/harvest.ts)
  ├─ Dienste      probeSupportedServices-Sonden (0x10/0x11/0x19/0x22/0x31/0x3E)
  │               0x14/0x27/0x28/0x2F/0x34/0x85 → outcome "not-probed" + Grund
  ├─ Identifikation F190/F187/F181/F18C … → HarvestedIdentification (roh + ASCII-Hinweis)
  ├─ DID-Sweep    readDid je DID, Doppellesung für `stable`
  │               ├─ beantwortet → HarvestedDid { rawHex, byteLength, asciiHint, origin }
  │               ├─ verweigert  → DidRefusalGroup { origin, nrc, count, firstDid, lastDid }
  │               └─ stumm       → Lücke (kein DID mit 0 Byte!)
  └─ Fehlerspeicher (tools/harvest/src/fault-memory.ts)
        0x19 0x01 → dtcCount + Verfügbarkeitsmaske (ISO 14229-1 §11.3.4.2)
        0x19 0x03 → je Code: snapshotRecordCount (§11.3.4.4)
        0x19 0x02 → HarvestedDtc { code, status, statusBits, severity, availabilityMask }
        0x19 0x04/0x06 → snapshots[] / extendedRecords[] (roh, Layout undokumentiert)
  ▼
HarvestReport { identity, bus, plan, ecus, unread, counts, notes }
  ├─ harvest.json          Datensatz: Plan + Zähler + Lücken + Notes (VIN maskiert)
  ├─ <container>.odx-d     ODX-Projektion (odx/diag-layer.ts)
  │     DIAG-LAYER-CONTAINER → BASE-VARIANT je ECU
  │       ├─ DIAG-SERVICE je beobachtetem Austausch (REQUEST/POS-RESPONSE als Byte-Rezept)
  │       ├─ DTC-DOP → DTC je Code (TROUBLE-CODE, DISPLAY-TROUBLE-CODE, TEXT, SDGs)
  │       ├─ ENV-DATA-DESC/ENV-DATA je Freeze Frame (roh)
  │       └─ SDGS: Adresse, Timing, Dienste, Verweigerungen, Lücken, Provenance
  ├─ <container>.pdx       ZIP mit index.xml (ODX-CATALOG) + dem Dokument (odx/pdx.ts)
  └─ <oem>-definition.json Definitions-Kandidat (definition.ts) + skipped[] mit Grund
  ▼
Gegenprüfung (odx/verify.ts, optional): odxtools parst das Dokument,
  encodiert jede beobachtete Anfrage und decodiert jede beobachtete Antwort
  → "verified" | "failed" | "not-run" (nie stillschweigend grün)
```

**Wichtige Kanten:**

- **Beobachtung ≠ Wissen.** Ein `asciiHint` ist ein Hinweis („17 druckbare Bytes"),
  kein Signalname. Ein DTC-Text sagt „gemeldet", nie „bedeutet". Eine Länge ohne
  dokumentierte Kodierung wird **kein** Signal, sondern ein `skipped`-Eintrag mit
  Grund — sonst entsteht eine Wissensbasis aus Vermutungen, die wie Dokumentation
  aussieht (AGENTS 13, ADR 0033).
- **Read-only ist eine Eigenschaft, keine Absicht.** `FORBIDDEN_HARVEST_SERVICES`
  nennt jeden Schreibdienst mit Grund, `findWriteRequests()` prüft einen Plan, und
  `harvest.spec.ts` scannt die eigenen Quellen nach Schreibaufrufen. `0x2E` wird nur
  mit `--probe-writes` sondiert — ohne das Flag gilt wörtlich „kein Schreibdienst".
- **Verweigerung, Lücke und Wert sind drei verschiedene Dinge.**
  `requestOutOfRange` → `didRefusals` (gruppiert, mit NRC und Bereich), Timeout →
  `gaps` (mit Grund), Antwort → `dids`. Ein „DID mit 0 Byte" existiert nicht.
- **Beide Hälften reisen mit:** `ecus` und `unread`, `dids` und `didRefusals`,
  `dtcs` und `gaps`, dazu `notes` für alles, was der Lauf *nicht* getan hat
  (Sitzung, VIN-Maskierung, abgeschaltete Stufen).
- **Die Verfügbarkeitsmaske reist mit dem Code.** `DtcRecord.availabilityMask` →
  `HarvestedDtc.availabilityMask` → SDG im ODX → `notes` im Kandidaten. Ohne sie ist
  „Bit nicht gesetzt" von „Bit wird nicht gemeldet" nicht zu unterscheiden.
- **Provenance auf jeder Ebene:** Paket, ECU, DTC und Signal tragen `observed` mit
  Datum und eigener Quelle (`… ECU 0x7e8, DID 0xf40c`), plus die Bytes in der Notiz.
- **Ein Artefakt, drei Projektionen.** `HarvestReport` ist die Wahrheit; ODX, PDX und
  Kandidat sind Abbilder derselben Beobachtung — kein zweiter Datenspeicher.

**Verboten:** Bedeutungen, Namen, Einheiten oder Skalierungen in die Ernte
hineinraten · einen Schreibdienst senden (auch nicht „nur als Sonde") · eine
Verweigerung als leeren Wert speichern · `odxtools NOT RUN` als bestandene Prüfung
zählen · die VIN im Klartext schreiben, ohne dass `--keep-vin` es verlangt und der
Datensatz es vermerkt · eine zweite ECU-Id-Regel oder einen zweiten Frageplan bauen.

**Zugehörig:** [`docs/flows/diagnostic-read.md`](diagnostic-read.md) (der Lese-Pfad,
den die Ernte benutzt), [`docs/flows/dtc-analysis.md`](dtc-analysis.md) (was aus
Codes wird, sobald Wissen existiert), [`tools/harvest/README.md`](../../tools/harvest/README.md),
ADR 0058.
