# ADR 27 — Das Browser-Frontend wird gegen den Wire-Contract typgeprüft

**Status:** accepted · **Datum:** 2026-09-14 · **Betrifft:** `apps/web`, `tsconfig.frontend.json`,
`tests/architecture/guardrails.test.ts` · **Löst ein:** E19 (AGENTS 0.E)

## Kontext

`apps/web/public/*.js` ist geprüftes JavaScript (`checkJs`) ohne Bundler, und es war der letzte
Ort im Baum, an dem `noImplicitAny` abgeschaltet war. Gemessen am 2026-09-14 mit
`noImplicitAny: true`: **110 Fehler in 4 Dateien**, davon 104 × TS7006 (implizite
Parametertypen) und 6 × TS2339.

Der Messwert war zu optimistisch, und zwar aus einem Grund, der die Entscheidung bestimmt: Die
110 Fehler waren die *Oberfläche* eines untypisierten DOM-Helfers. Sobald `$` ehrlich als
`HTMLElement | null` typisiert war, wurde aus einem Teil der TS7006 eine **Nullability-Frage**
(TS18047 „possibly null", TS2531) — der Zähler stieg auf **221**. Ein Teil davon war kein
fehlendes JSDoc, sondern eine fehlende Antwort auf die Frage, ob ein Panel existiert.

Die zweite Beobachtung: Das Frontend rendert JSON, das der Server baut (`backend.ts`), und beide
Seiten stimmten nur per Konvention überein. Ein umbenanntes Feld brach die Oberfläche zur
Laufzeit — und der Typecheck konnte es nicht sehen, weil er die Server-Typen nicht kannte. Der
naheliegende Weg (`@types/node` + JSDoc-Import aus `backend.ts`) wurde verworfen: dann müsste das
Browser-Projekt den Node-Backend-Zweig mitprüfen (`node:fs/promises`, Storage, Transporte) und
verlöre genau die Grenze, die es sichern soll.

## Entscheidung

1. **Der Wire-Contract ist ein eigenes, node-freies Modul.** `apps/web/src/views.ts` enthält die
   View-Typen (`EcuView` … `AppState`, `AdaptersView`, `AnalysisView`, `DtcClearView`, …) und
   importiert ausschließlich Typen. `backend.ts` importiert und re-exportiert sie, sodass alle
   bestehenden Importe unverändert bleiben. Ein neuer Guardrail-Test hält beide Invarianten fest:
   `views.ts` enthält kein `node:` und kein `backend.js`, und **jeder** absolute Import der
   Frontend-Module (`/dom.js`, `/api.js`, `/graphs.js`, …) hat ein `paths`-Mapping in
   `tsconfig.frontend.json` — ohne Mapping tippt TypeScript den Import still als `any`.
2. **Ein typisierter API-Client statt verstreuter `fetch`-Aufrufe.** `apps/web/public/api.js`
   bildet jede Route auf ihren Antworttyp ab (`fetchState(): Promise<AppState>`). Der Rumpf ist
   `unknown` — die JSON-Antwort ist eine Vertrauensgrenze —, jede exportierte Funktion benennt
   die Form, die sie erwartet. Eine Route, eine Aussage, an einer Stelle.
3. **DOM-Helfer in `dom.js`, einmal statt dreimal.** `$` bleibt nullbar (optionale Panels),
   `must`/`input`/`select`/`button`/`child` verlangen einen existierenden Knoten und werfen mit
   dem Selektor im Text. Das ist verhaltensgleich zu vorher (`$("#x").textContent = …` warf bei
   fehlendem Knoten ohnehin), nur mit einer Fehlermeldung, die den Grund nennt.
4. **`noImplicitAny: true` in `tsconfig.frontend.json`**, ohne Eintrag in `RELAXED_FLAGS`. Der
   Guardrail-Test fordert `checkJs` **und** `noImplicitAny` positiv — eine gelöschte Zeile wäre
   sonst ein stiller Rückschritt.

## Konsequenzen

- Was der Server nicht mehr sendet, bricht den Frontend-Typecheck statt der Oberfläche. Der
  typisierte Durchgang hat sofort einen echten Fehler gefunden: `btn-live-start` rief
  `renderConnection({ connected, live, vehicle })` — ein Objekt ohne `adapter`, das die Funktion
  für `data.adapter.name` liest. Jeder Klick auf „Live starten" endete bisher im Fehlerbanner.
  Der Handler holt den Zustand jetzt beim Backend (`fetchState()`), das ihn besitzt.
- `backend.ts` sinkt durch die Auslagerung von 1326 auf 1117 Zeilen (E15); der Contract liegt
  sichtbar neben dem Backend statt in ihm.
- Zwei neue Dateien (`views.ts` 350, `api.js` 142 Zeilen) und vier getippte Module ersetzen keine
  Logik — die Schicht bleibt Rendering über View-Projektionen (Roadmap-Schritt 9).
- Kosten: `tsconfig.frontend.json` prüft 8 Dateien in ~0,3 s und läuft im Architekturtest mit
  (ADR 26 §4).
- Grenze: Das Frontend bleibt ohne Browser-Tests ungetestet (E15) — der Typecheck ist die
  Untergrenze, keine Alternative zu einem DOM-Test.
