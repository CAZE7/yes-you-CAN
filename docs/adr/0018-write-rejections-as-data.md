# 0018 — Abgelehnte Write-Operationen sind Antworten, keine Fehler

Status: accepted · Datum: 2026-09-12 · Bezug: AGENTS 15, 26; ADR 0014

## Kontext

Die einzige Write-Operation der Plattform — das Löschen eines Fehlerspeichers —
läuft durch die komplette Safety-Kette: Backup-Snapshot → explizite Bestätigung
→ Freigabe (Permit) → Schreibzugriff → Verifikation per Rücklesen → Audit-Trail
(AGENTS 20, 25, 26).

Vor der Engine-Zerlegung (Roadmap-Schritte 8/9) rief das Web-Backend die Engine
direkt auf. Eine Ablehnung durch die Safety-Kette (fehlende Bestätigung,
Fahrzeugzustand nicht sicher) warf dort eine Exception, die der HTTP-Server als
`500 Internal Server Error` beantwortete. Damit war eine *normale, erwartbare*
Antwort der Safety-Kette von einem echten Serverfehler nicht zu unterscheiden;
der Operator sah einen technischen Fehler statt der fehlenden Voraussetzung.

Der Runtime-Vertrag hatte die Gegenposition bereits implementiert:
`DtcService.clear` liefert bei Ablehnung ein `deniedClearOutcome`
(`ok: false` + Gründe) und publiziert `safety-approval-denied` — die Ablehnung
ist ein Ergebnis.

## Entscheidung

Die Runtime-Semantik wird zur einzigen: **Eine abgelehnte Write-Operation ist
eine fachliche Antwort mit Gründen, kein Fehlerzustand.**

- `dtc.clear` liefert bei Ablehnung `ok: false`, `reasons` (die fehlenden
  Voraussetzungen) und die Audit-Ereignisse `safety-approval-requested` /
  `safety-approval-denied`. Es wird kein Permit ausgestellt und nichts
  geschrieben.
- Der HTTP-Layer antwortet darauf mit `200` und dem Ergebnis im Body
  (`cleared: false`, `reasons: […]`). Ein `4xx`/`5xx` bleibt echten Fehlern
  vorbehalten (unbekannte ECU, Transportbruch, Engine-Absturz).
- `dtc.clear-precheck` wertet exakt dieselbe Kette mit `userConfirmed: false`
  aus, damit Vorab-Anzeige und Schreibzugriff nie auseinanderlaufen können
  (AGENTS 26). Die Gründe des Prechecks und der Ablehnung sind dieselben.
- Ein Fehler der Write-*Ausführung* (ECU antwortet nicht, Transport bricht ab)
  bleibt eine Exception bzw. ein `diagnostic-error`-Ereignis — geschrieben
  werden sollte, aber konnte nicht. Das ist etwas anderes als „die Kette hat
  geprüft und Nein gesagt".

## Konsequenzen

- Clients müssen `cleared: false` auswerten; der HTTP-Status allein trägt die
  Information nicht. Das Frontend zeigt die Gründe aus `reasons` an.
- Die Änderung ist sichtbar: Wer den alten `500`-Pfad erwartete, bekommt jetzt
  `200` mit `cleared: false`. Abgedeckt durch
  `server.spec.ts` („a refused clear is an answer with reasons“) und die
  Runtime-Integration („dtc.clear runs the safety chain“).
- Das Muster gilt für künftige Write-Operationen (z. B. DID-Write): Ablehnung
  durch Policy/Safety ist immer Ergebnis mit Gründen, nie HTTP-Fehler.
