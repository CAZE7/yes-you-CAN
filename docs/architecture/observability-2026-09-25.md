# Observability-Ausbau 2026-09-25

Aufbau auf dem [Bug-Review](bug-review-2026-09-25.md): Fehler sollen **schneller
auffallen** und die Ursache **ohne Raw-Logging nachvollziehbar** sein.

## 1. Timeouts tragen jetzt Evidenz mit sich

Früher sagte ein Timeout nur „ISO-TP response timeout after 500 ms" — weder
welche Request das war, noch was der Bus in der Zeit gemacht hat.

### ISO-TP: der Frame-Witness (`transport/iso-tp/src/connection.ts`)

Die Verbindung führt jetzt einen kleinen Ring-Puffer (32 Frames) über **jeden**
Frame, den die ECU an unsere `rxId` adressiert — aufgenommen **vor** dem Filter,
also auch Frames, die die Verbindung verwirft (ungültige Länge, falsche
Extended-Source). Jeder Timeout-Error trägt jetzt dazu bei:

- `request` — die Bytes der gesendeten Request (hex)
- `txId` / `rxId` — welche Verbindung
- `frames` — alles, was die ECU während des Wartens gesendet hat
- `silent: true` — wenn **nichts** kam (das ist selbst eine Diagnose:
  ECU tot / Leitung offen — statt „vielleicht Timeout, wer weiß")

Gilt für alle vier Timeout-Arten: Response, N_Bs (Flow Control), N_Cr
(Sender stoppte mid-message) und WFTmax. Der Warn-Log-Zeile fehlt nichts
gegenüber dem Error, also zeigt die Session-Log auch ohne Error-Inspecting die
Geschichte.

Die Fenster sind pro Verschnitt exakt geschnitten: Response-Timeouts zählen
von Attempt-Start, N_Cr von der First Frame („was kam danach?"), N_Bs vom
Multi-Frame-Start.

### UDS-Client: Request-Fingerprint (`protocols/uds/src/client.ts`)

Jeder aus `transmit` entweichende Fehler (Timeout, NRC, unerwartete Antwort)
trägt jetzt zusätzlich:

- `sid` — die UDS-Service-ID (`0x22`, `0x19`, …)
- `request` — die exakten Request-Bytes
- `ecu` — der Name der ECU

Bestehende `details` gewinnen über den Fingerprint (Transport-Evidenz geht
nicht verloren). Dazu je eine Log-Zeile:

- **Link-Fehler (Timeout/Disconnect) → `warn`** auf Scope `uds`: die
  Kommunikation ist fehlgeschlagen, das ist ein echtes Problem.
- **NRC / unerwartete Antwort → `debug`**: eine NRC ist die ECU, die
  *antwortet* — Ablehnung ist Daten (AGENTS 34.25). Der Probe-Pfad erwartet
  NRC 0x11 als Normalergebnis; ein Warn pro NRC würde jedes Attach unter
  Rauschen begraben. Bei DEBUG ist die volle Evidenz im Log.

### DoIP / Replay: `protocols/uds/src/link-adapter.ts`

Der Request-Response-Adapter (der DoIP-Pfad) hängt seinem Timeout jetzt
`request` (hex) an — ein DoIP-Stillstand sagt, welches Read wartete.

## 2. `test:fast` — die schnelle Feedback-Lane

```
npm run test:fast   # ≈ 55 s statt ≈ 110 s für die volle Suite
```

Läuft die Projekte `unit` + `protocol` (die regressions sensitivsten
Schichten, kein Socket, kein Build). Für „habe ich etwas kaputt gemacht?"
während des Arbeitens; die volle Suite (inkl. Regression, Replay,
Integration, Architecture) bleibt der definitive Gate via `npm test` / `ci`.

## 3. Verankerung

Neue Tests (7):

- `connection.spec.ts` (4): Timeout mit `silent` + Request-Bytes; Timeout mit
  verwerfenem Frame im Witness (der Frame taucht auf, obwohl die Verbindung
  ihn droppt); N_Cr mit leerem Witness; N_Bs mit txId/rxId + `silent`.
- `client.spec.ts` (2): Link-Timeout trägt `sid`/`request`/`ecu` und behält
  die Transport-Details; NRC trägt den Fingerprint, eigene Felder bleiben
  Autorität.
- `link.spec.ts` (1, erweitert): DoIP-Timeout trägt `request` + `timeoutMs`.

Architektur-Gate: die Size-Exemption von `connection.ts` führt den
Witness-Anteil im Audit-Trail (893 → 1007).

Stand: Build ✅ · Typecheck ✅ · Biome ✅ · **2718 Tests / 0 Fehlschläge** ✅

## Beispiel: wie sich ein Fehler jetzt liest

```
2026-09-25T09:31:04Z WARN  [isotp] ISO-TP response timeout
  {"timeoutMs":500,"timeout":"response","request":"22 F1 90",
   "txId":"0x7E0","rxId":"0x7E8","frames":[],"silent":true}
```

→ „VIN-Lese-Request (22 F1 90) auf 0x7E0/0x7E8; die ECU hat in 500 ms
nichts gesendet — Modul stromlos oder Leitung offen." Ohne den Witness wäre
aus derselben Zeile „timeout" gewesen.

```
2026-09-25T09:31:04Z WARN  [isotp] ISO-TP response timeout
  {"timeoutMs":500,"timeout":"response","request":"22 F1 90",
   "txId":"0x7E0","rxId":"0x7E8",
   "frames":[{"seq":41,"at":1758802264012,"id":2024,"data":"7E 80 11 22"}]}
```

→ „Die ECU hat geantwortet — aber mit einem verwerfen Frame (7E 80 11 22:
Single Frame mit deklariertem Byte, das sie nicht trägt) — Adressierungs-
oder Firmware-Problem an der ECU, nicht Timeout."
