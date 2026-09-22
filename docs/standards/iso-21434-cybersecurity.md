# ISO 21434 / UNECE R155 — Cybersecurity (TARA-Gerüst)

> **Status: Gerüst mit messbarer Angriffsfläche.** Die Gefährdungen und ihre
> Gegenmaßnahmen sind belegt; die Bewertung nach Angriffsvektor/Angriffsressource
> (ISO 21434 Anhang E) ist **offen**, weil sie eine CSO-Entscheidung ist.
>
> Zugehörig: [`conformance.md`](conformance.md), [`hara-template.md`](hara-template.md)
> (HARA-05), [ADR 0050](../adr/0050-standards-conformance-register.md).

## 1. Item und Vertrauensgrenzen

| Grenze | Was sie trennt | Stand |
|---|---|---|
| Browser ↔ Workbench-Server | Bedienperson ↔ HTTP-API | **Token-Tor seit ADR 0051**: `Authorization: Bearer` oder `httpOnly`-Cookie aus dem `?token=`-Tausch; ohne konfiguriertes Token offen (Prüfstand) und in der Startwarnung benannt |
| Workbench ↔ Fahrzeug-Bus | Werkzeug ↔ Steuergeräte | Adapter-Seam (`linkFactory`); CAN/DoIP ohne eigene Authentifizierung (fahrzeugseitig: Security Access 0x27, `protocols/uds/src/security.ts`) |
| Datei ↔ Sitzung | Export/Import von Sitzungen | `rawTraceManifest` mit SHA-256 über den kanonischen Trace (ADR 0047) — Manipulation fällt auf |

## 2. Angriffsfläche (gemessen)

| Fläche | Wert | Quelle |
|---|---|---|
| API-Routen | **37** Pfade unter `/api/` | `apps/web/src/server.ts` |
| Body-Limit | **1 000 000 Byte**, beim Einlesen geprüft, `413` darüber | `server.ts:79`, `:520-521` |
| Pfad-Eindämmung | Segment-Vergleich statt Präfix-Test, `..` und NUL abgewiesen | `apps/web/src/paths.ts`, `static-assets.ts` |
| Rate-Limiting / Request-Timeout | **fehlt** — `grep -c "rate.?limit\|request.setTimeout" apps/web/src/server.ts` → **0** | — |
| TLS | **fehlt** — kein `createSecureServer`; `strict-transport-security` ist gesetzt und wirkt ab dem Tag, an dem TLS kommt | `static-assets.ts:58` |
| Authentifizierung | **Token-Tor** vor jedem `/api/`-Pfad inkl. SSE; konstanter Vergleich über SHA-256-Digest | `apps/web/src/auth.ts`, `server.ts` `handle()` |
| Bindung | `--host=0.0.0.0` möglich; der Server warnt beim Start | `server.ts` (`WARN listening on all interfaces`) |
| Offene SSE-Verbindungen | werden in einem `Set` geführt und beim Stopp geschlossen | `server.ts` (`streams`) |

## 3. Was bereits geschützt ist

| Schutz | Beleg |
|---|---|
| CSP ohne Inline-Script, `object-src 'none'`, `frame-ancestors 'none'`, `form-action 'none'` | `apps/web/src/static-assets.ts:49-50` |
| `x-content-type-options: nosniff`, `x-frame-options: DENY`, `referrer-policy: no-referrer`, `cross-origin-resource-policy: same-origin` | dito |
| Verzeichnis-Eindämmung in Pfad-Segmenten (kein `startsWith`) | `apps/web/src/paths.ts` — ein Sibling-Verzeichnis, dessen Name mit dem Wurzelnamen beginnt, wird abgewiesen |
| Body-Größe begrenzt, bevor gepuffert wird | `server.ts:520` |
| JSON-Fehler sind Sätze, keine Stack-Traces | `statusFor(error)`, `messageOf(error)` |
| Sitzungs-Integrität | `rawTraceManifest` (ADR 0047), golden verifiziert in `tests/protocol/*` |
| Struktur-Tore | `biome check .` (kein `any`, kein `@ts-ignore`), `hygiene.test.ts` |

## 4. TARA — Gefährdungen und Bewertung

| ID | Gefährdung | Angriffsvektor | Gegenmaßnahme heute | Bewertung |
|---|---|---|---|---|
| CY-01 | Unautorisierter Lesezugriff auf Fahrzeugdaten (VIN, DIDs, DTCs) | Netz, gleicher Broadcast-Domain | Token-Tor (ADR 0051): 401 mit Satz statt Daten; Zustand in der Startwarnung | **offen** — Umsetzung vorhanden, Bewertung ausstehend |
| CY-02 | Unautorisierte Schreiboperation (Codierung, Adaptation, DTC löschen) | HTTP-POST an `/api/coding/write`, `/api/dtc/clear` | Token-Tor (ADR 0051, gemessen: `POST /api/dtc/clear` ohne Token → 401) **und** `WritePort` mit Permit und Stufenfolge, `SafetyManager`-Policy, 44 formale Vektoren | **offen** — beide Hälften vorhanden, Bewertung ausstehend |
| CY-03 | Manipulation einer gespeicherten Sitzung | Datei | `rawTraceManifest` (SHA-256) macht sie sichtbar | **offen** |
| CY-04 | Denial of Service über offene SSE-Streams oder Dauer-Polling | Netz | Streams werden geführt und geschlossen; **kein** Rate-Limit | **offen** |
| CY-05 | Abhören der Übertragung | Netz | **keine TLS**; `strict-transport-security` ist gesetzt (`static-assets.ts:58`) | **offen** |
| CY-06 | Pfad-Durchgriff auf das Dateisystem | HTTP-GET `/../…` | Segment-Vergleich, NUL- und Absolut-Pfad-Abweisung, getestet in `static-assets.spec.ts` | **offen** — Umsetzung vorhanden, Bewertung ausstehend |

## 5. Maßnahmen in Reihenfolge ihres Nutzens

1. ~~**Token-Authentifizierung** für alle `/api/`-Routen (CY-01, CY-02)~~ —
   **erledigt** (ADR 0051): Bearer oder `httpOnly`-Cookie aus dem `?token=`-Tausch,
   konstanter Vergleich, `401` mit Satz. 16 Tests, `auth.ts` 100/100/100/100.
2. ~~**`strict-transport-security`** in die Header-Tabelle~~ — **erledigt**
   (`static-assets.ts:58`).
3. **Rate-Limit** je Verbindung für die SSE-Registrierung und die Polling-Routen
   (CY-04) — **offen**.
4. **TLS** als Option (`--cert`/`--key`) — **offen**; Betrieb, kein Code-Kern.
5. **CSMS-Prozess** (Schwachstellenannahme, Reaktionszeit, Meldewege) —
   **offen**, Organisation und nicht Repository.

**Was davon in diesem Repository erledigbar war:** 1–4. Punkt 5 nicht.
