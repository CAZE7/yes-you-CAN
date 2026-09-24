# ISO 21434 / UNECE R155 — Cybersecurity (TARA)

> **Status: Bewertet (Entwurf, 2026-09-22).** Angriffsfläche gemessen, Gegenmaßnahmen
> belegt, Bewertung nach Angriffsvektor/Angriffsressource (ISO 21434 Anhang E) als
> **Entwurf** ausgefüllt — begründet, aber nicht abgenommen. CSO-Entscheidung steht
> aus, aber der Entwurf ist die Vorlage für das Review.
>
> Zugehörig: [`conformance.md`](conformance.md), [`hara-template.md`](hara-template.md)
> (HARA-05), [ADR 0050](../adr/0050-standards-conformance-register.md),
> [ADR 0051](../adr/0051-workbench-api-knows-its-caller.md),
> [ADR 0054](../adr/0054-tls-rate-limit-and-csms.md).

## 1. Item und Vertrauensgrenzen

| Grenze | Was sie trennt | Stand |
|---|---|---|
| Browser ↔ Workbench-Server | Bedienperson ↔ HTTP-API | **Token-Tor seit ADR 0051**: `Authorization: Bearer` oder `httpOnly`-Cookie aus dem `?token=`-Tausch; ohne konfiguriertes Token offen (Prüfstand) und in der Startwarnung benannt. **TLS-Option seit ADR 0054**: `--cert`/`--key` oder `VDP_TLS_CERT`/`VDP_TLS_KEY`, `https://` statt `http://` |
| Workbench ↔ Fahrzeug-Bus | Werkzeug ↔ Steuergeräte | Adapter-Seam (`linkFactory`); CAN/DoIP ohne eigene Authentifizierung (fahrzeugseitig: Security Access 0x27, `protocols/uds/src/security.ts`); Rate-Limit schützt Bus vor Überflutung |
| Datei ↔ Sitzung | Export/Import von Sitzungen | `rawTraceManifest` mit SHA-256 über den kanonischen Trace (ADR 0047) — Manipulation fällt auf |

## 2. Angriffsfläche (gemessen)

| Fläche | Wert | Quelle |
|---|---|---|
| API-Routen | **37** Pfade unter `/api/` (36 literale + `/api/session/:id/package`; gemessen 2026-09-24) | `apps/web/src/server.ts`, `apps/web/src/adapter-routes.ts` |
| Body-Limit | **1 000 000 Byte**, beim Einlesen geprüft, `413` darüber | `server.ts:79`, `:520-521` |
| Pfad-Eindämmung | Segment-Vergleich statt Präfix-Test, `..` und NUL abgewiesen | `apps/web/src/paths.ts`, `static-assets.ts` |
| Rate-Limiting | **100 Req/60s/IP** für API, **10 SSE/IP** concurrent, **429** mit Retry-After | `apps/web/src/rate-limit.ts`, `server.ts:handle()` + `streamEvents()` |
| TLS | **Option vorhanden**: `--cert`/`--key`, liest PEM, `https.createServer`, loggt `tls:true`; `strict-transport-security` gesetzt | `server.ts` `certPath`/`keyPath`, `static-assets.ts:58` |
| Authentifizierung | **Token-Tor** vor jedem `/api/`-Pfad inkl. SSE; konstanter Vergleich über SHA-256-Digest | `apps/web/src/auth.ts`, `server.ts` `handle()` |
| Bindung | `--host=0.0.0.0` möglich; der Server warnt beim Start mit Zustand (`authenticated`, `tls`) | `server.ts` (`WARN listening on all interfaces`) |
| Offene SSE-Verbindungen | werden in einem `Set` geführt und beim Stopp geschlossen, plus Rate-Limit-Zähler | `server.ts` (`streams`, `rateLimiter`) |

## 3. Was bereits geschützt ist

| Schutz | Beleg |
|---|---|
| CSP ohne Inline-Script, `object-src 'none'`, `frame-ancestors 'none'`, `form-action 'none'` | `apps/web/src/static-assets.ts:49-50` |
| `x-content-type-options: nosniff`, `x-frame-options: DENY`, `referrer-policy: no-referrer`, `cross-origin-resource-policy: same-origin`, `strict-transport-security` | dito `:58` |
| Verzeichnis-Eindämmung in Pfad-Segmenten (kein `startsWith`) | `apps/web/src/paths.ts` |
| Body-Größe begrenzt, bevor gepuffert wird | `server.ts:520` |
| JSON-Fehler sind Sätze, keine Stack-Traces | `statusFor(error)`, `messageOf(error)` |
| Sitzungs-Integrität | `rawTraceManifest` (ADR 0047), golden verifiziert |
| Struktur-Tore | `biome check .` 486 Dateien (Biome 2.5.14), `hygiene.test.ts` |
| Rate-Limit | `RateLimiter` 100/60s + 10 SSE/IP, 429, getestet |
| TLS | Option mit PEM, `https://`, getestet mit self-signed |

## 4. TARA — Gefährdungen und Bewertung (Entwurf)

Bewertung nach ISO 21434 Anhang G: Angriffsvektor, Angriffskomplexität, Privilegien,
Benutzerinteraktion → Angriffspotential → Risikowert. Skalen als Entwurf.

| ID | Gefährdung | Angriffsvektor | Angriffskomplexität | Privilegien | Benutzerinteraktion | Gegenmaßnahme | Risiko (Entwurf) |
|---|---|---|---|---|---|---|---|
| CY-01 | Unautorisierter Lesezugriff auf Fahrzeugdaten (VIN, DIDs, DTCs) | Netz (gleiches L2) | Niedrig (kein Exploit, nur Port erreichen) | Keine | Keine | Token-Tor (401 mit Satz), TLS-Option, HSTS, Rate-Limit | **Mittel** — ohne Token offen (Prüfstand benannt), mit Token + TLS niedrig |
| CY-02 | Unautorisierte Schreiboperation (Codierung, Adaptation, DTC löschen) | Netz → HTTP-POST `/api/coding/write`, `/api/dtc/clear` | Niedrig (HTTP) | Keine (ohne Token) / Token-Besitz (mit) | Keine | Token-Tor (gemessen 401 ohne), `WritePort` Permit+Precheck+Stufenfolge, 44 Vektoren, Rate-Limit, TLS | **Hoch ohne Token, Niedrig mit Token+TLS** — deshalb Token-Pflicht bei `0.0.0.0` empfohlen |
| CY-03 | Manipulation einer gespeicherten Sitzung | Lokal (Datei) | Mittel (SHA-256 fälschen + Manifest) | Dateizugriff | Keine | `rawTraceManifest` SHA-256, golden verifiziert | **Niedrig** — Manipulation fällt auf |
| CY-04 | Denial of Service über SSE-Streams oder Dauer-Polling | Netz | Niedrig (Loop) | Keine | Keine | **Rate-Limit** 100/60s + 10 SSE/IP → 429, Streams in Set, close-Handler | **Niedrig** — seit ADR 0054 umgesetzt |
| CY-05 | Abhören der Übertragung | Netz (MitM) | Mittel (ARP-Spoof etc.) | Netz-Position | Keine | **TLS-Option** `--cert`/`--key`, HSTS `max-age=31536000`, loggt `tls:true` | **Mittel ohne TLS, Niedrig mit TLS** |
| CY-06 | Pfad-Durchgriff auf das Dateisystem | Netz → GET `/../…` | Niedrig | Keine | Keine | Segment-Vergleich, NUL/absolute Abweisung, getestet `static-assets.spec.ts` | **Niedrig** — Umsetzung + Tests vorhanden |

**Begründung für „Entwurf":** Die Risikowerte sind ohne CSO-Abnahme. Sie sind aber
begründet und mit Beleg — das Review kann sie prüfen, statt sie zu raten.

## 5. Maßnahmen — Stand nach ADR 0054

1. ~~**Token-Authentifizierung**~~ — **erledigt** (ADR 0051): 16 Tests, 100% Coverage.
2. ~~**`strict-transport-security`**~~ — **erledigt** (`static-assets.ts:58`).
3. ~~**Rate-Limit**~~ — **erledigt** (ADR 0054): `rate-limit.ts` (100/60s, 10 SSE/IP, 429), `defaultLimiter`, Tests.
4. ~~**TLS als Option**~~ — **erledigt** (ADR 0054): `--cert`/`--key`, `VDP_TLS_CERT`/`VDP_TLS_KEY`, `https.createServer`, Fehlermeldung bei fehlender Datei, loggt `tls:true/false`.
5. **CSMS-Prozess** — **Gerüst vorhanden** (`docs/standards/csms.md`), aber Organisation (Meldewege, Reaktionszeiten) nicht abgenommen.

**Was in diesem Repository erledigbar war, ist erledigt.** Punkt 5 (CSMS als
Organisation) bleibt Prozess.

## 6. Verifikation

- **Token-Tor:** `auth.spec.ts` 16 Tests, live 401/200 gemessen.
- **Rate-Limit:** `rate-limit.spec.ts` neu (10 Tests, siehe ADR 0054), live 429 gemessen.
- **TLS:** `tls.spec.ts` neu (3 Tests, self-signed Zertifikat, `https://` URL), manuell mit `openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 1 -subj /CN=localhost` getestet.
- **HSTS:** Header `strict-transport-security: max-age=31536000; includeSubDomains` in jedem Response, auch ohne TLS (Browser ignoriert ihn auf HTTP, aber er ist da).
