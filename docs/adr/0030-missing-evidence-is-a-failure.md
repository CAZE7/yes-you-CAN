# ADR 0030 — Fehlende Evidenz ist ein Fehlschlag, keine Warnung

- Status: akzeptiert (2026-09-14)
- Kontext: AGENTS 26 („Safety Layer"), AGENTS 24 (Datenherkunft/Ehrlichkeit), Master-Backlog P0 #5
- Betrifft: `packages/core/src/safety/safety-manager.ts`, `packages/core/src/writes/port.ts`, `packages/domain/src/model.ts`, `packages/runtime/src/services.ts`, `apps/web/{src/views.ts,src/backend.ts,public/app.js,public/styles.css}`

## Problem

Die Safety-Kette unterschied zwei Zustände: **erfüllt** und **verletzt**. Was sie nicht
unterschied, war **nicht belegt** — und das war die gefährlichste der drei Möglichkeiten, weil sie
sich als „erfüllt" verhielt:

```ts
if (state.batteryVoltage === undefined)
  warnings.push("battery voltage unknown — precondition not verifiable");
```

Wer keine Batteriespannung angab, bekam eine Warnung und einen Permit. Dieselbe Lücke bei
`ignitionOn`, beim ECU-Typ und bei der Softwarevariante: `expectedEcuType && actualEcuType && …`
prüfte nur, wenn **beide** Seiten bekannt waren — ein Definitionseintrag mit erwartetem Typ und ein
Adapter, der den Typ nie gelesen hatte, ergaben schlicht keinen Treffer. Und für DoIP-Netzvoraussetzungen
galt: was nicht gefragt wurde, wurde nicht geprüft.

Drei Folgen: (1) Der Aufrufer konnte eine Verweigerung nicht deuten — „Spannung unbekannt" sah aus
wie „Spannung zu niedrig". (2) Ein Schreibvorgang **ohne** Messung war erlaubt, ein Schreibvorgang
**mit schlechter** Messung nicht; die belohnte Handlung war, nicht zu messen. (3) Ein Audit-Log, das
„permit-issued" ohne geprüfte Spannung enthält, ist kein Nachweis.

## Entscheidung

1. **Drei Ausgänge statt zwei.** Jede Vorbedingung endet als *proven*, *violated* oder *unproven*.
   `unproven` **blockiert** wie eine Verletzung und ist zusätzlich in `SafetyCheckResult.unproven`
   benannt (`ok = failed.length === 0`, `unproven ⊆ failed`). `warnings` bleibt echten Hinweisen
   vorbehalten — „hohes Risiko, Werkstattnetzteil empfohlen" ist eine Warnung, „niemand hat gemessen"
   ist keine.

2. **Die Begründung sagt, was fehlt.** Die Formulierungen benennen die fehlende Handlung, nicht ein
   erfundenes Ergebnis: „battery voltage unknown — cannot prove the supply is stable",
   „ECU type was never read — cannot prove it matches the definition (expected BCM)".

3. **Kein Vergleich gegen Unbekanntes.** Ist ein erwarteter Wert deklariert und der Ist-Wert nicht
   gelesen, ist das ein unerfüllter Nachweis. Ist umgekehrt nichts erwartet, wird auch nichts
   verlangt: ein gelesener Wert ohne Definition ist kein Mismatch (AGENTS 24 — keine erfundenen
   Behauptungen).

4. **Die Unterscheidung reist mit.** `WritePort.run` gibt `unproven` im Ergebnis zurück (nur wenn
   nicht leer, sonst wäre eine leere Liste eine Aussage), `WritePrecheckResult.unproven` geht über
   `DtcClearPrecheckInfo` in die Domäne, `apps/web` spiegelt es im Wire-Contract (`DtcClearPrecheck`)
   und die UI zeigt „nicht belegt" mit `?` getrennt von „verletzt" mit `✘`. Der Bediener soll messen,
   nicht reparieren.

5. **Der Audit nennt die Lücke.** Bei einer Verweigerung zählt der Audit-Eintrag zusätzlich, wie
   viele der Gründe fehlende Nachweise waren (`(n of m reasons are missing evidence)`).

## Konsequenzen

- Ein Clear ohne gemeldete Batteriespannung, ohne Ignitionszustand oder ohne Parkbremse ist jetzt
  **verweigert**, nicht erlaubt. Das Frontend reicht genau diese Werte aus dem Formular durch; fehlt
  eines, erklärt der Precheck warum, statt zu schreiben (fail-closed, P0 #5).
- Die Tests der Safety-Suite prüfen die drei Ausgänge einzeln: vollständige Eingabe → keine Gründe;
  fehlende Messwerte → `unproven` == `failed` und `warnings` leer; unbekannte Session → unproven,
  bekannte Default-Session → Verletzung; DoIP-Zustand nicht beantwortet → unproven.
- Der Integrationstest (`tests/integration/runtime.test.ts`) pinnt die Kette bis in die
  Domänen-Projektion: vollständiger Zustand ⇒ `unproven: []`, nur `{stationary: true}` ⇒ ≥ 2
  unproven-Gründe, jeder davon in `failed`, und die Spannungswarnung ist verschwunden.
