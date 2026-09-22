# ADR 54 — TLS-Option, Rate-Limit und CSMS-Gerüst schließen die ISO-21434-Lücken

- Status: akzeptiert (2026-09-22)
- Kontext: ADR 0050 (Konformanz-Register), ADR 0051 (Token-Tor), `docs/standards/iso-21434-cybersecurity.md`
  (CY-04/CY-05), `docs/standards/hara-template.md` (HARA-05), ADR 0053 (Deps/Hardware)
- Betrifft: `apps/web/src/server.ts` (TLS-Option `--cert`/`--key`, `VDP_TLS_CERT`/`VDP_TLS_KEY`,
  Rate-Limit in `handle()` + `streamEvents()`), `apps/web/src/rate-limit.ts` (neu),
  `apps/web/test/rate-limit.spec.ts` (neu, 10 Tests), `apps/web/test/tls.spec.ts` (neu, 3 Tests),
  `biome.json` (Migration 1.9.4→2.5.14, 482 Dateien), `docs/standards/*` (TARA-Bewertung Entwurf,
  CSMS-Gerüst, Traceability, HARA-ASIL-Entwurf), `SECURITY.md` (neu), `package.json`

## Problem

Nach ADR 0051 blieben in `iso-21434-cybersecurity.md` zwei Zeilen offen, die sich
messen ließen:

- **CY-04** — kein Rate-Limit: `grep -c "rate.?limit" server.ts` → **0**. Ein Client
  konnte unbegrenzt SSE-Streams öffnen oder die API hämmern.
- **CY-05** — keine TLS: `grep -c "createSecureServer|cert.*key" server.ts` → **0**.
  HSTS war gesetzt, wirkte aber nicht ohne HTTPS.

Dazu:

- **Biome 1.9.4** war der letzte veraltete Dep nach ADR 0053 (`npm outdated` → 1 Paket).
  2.x verlangt Config-Migration und 237 neue Diagnosen — als eigener Schritt machbar,
  aber nicht mehr „bewusst offen".
- **HARA/TARA** trugen S/E/C/ASIL leer — korrekt nach ISO 26262-3 §6 (benannte Person
  erforderlich), aber ohne Entwurf ist das Review eine Ratesitzung statt einer Prüfung.
- **CSMS** fehlte als Datei — `SECURITY.md` fehlte, `npm audit` lief nicht im CI als
  Pflicht, Rollen unbenannt.

## Entscheidung

**1. Rate-Limit (CY-04).**
`apps/web/src/rate-limit.ts`: in-memory sliding window pro IP, keine externen
Abhängigkeiten, keine Timer — Fenster resetten lazy beim nächsten Request.

- API: **100 Req/60s/IP** (Default, großzügig für UI-Polling), `429` mit `retry-after`
  und Satz (ADR 0018).
- SSE: **10 concurrent/IP** (Browser öffnet 1, zweiter Tab 2), `429` mit Satz
  „too many streams".
- Pro Server-Instanz ein eigener Limiter — ein globaler würde Tests, die einen
  Server hämmern, den nächsten auf 127.0.0.1 blockieren.
- Option `rateLimit` in `ServerOptions` für Tests (kleine Limits, schnelle Tests).

**2. TLS-Option (CY-05).**
`server.ts`:

- `--cert=`/`--key=` + `VDP_TLS_CERT`/`VDP_TLS_KEY` (Umgebung).
- Wenn beide gesetzt: `readFileSync` + `https.createServer`, sonst `http`.
- Fehler beim Lesen → `400` mit Satz, nicht Crash.
- Loggt `tls:true/false` + `certPath` beim Start, URL sagt `https://` statt `http://`.
- HSTS war bereits gesetzt (`static-assets.ts:58`) und wirkt ab dem Tag, an dem TLS
  kommt — jetzt ist der Tag da.

**3. Biome 2.5.14 Migration.**
`biome migrate --write` + `biome check --write` (4 Durchläufe bis grün):

- 46 Buttons in `index.html` → `type="button"` (a11y `useButtonType` ist
  Industriestandard, nicht Dekoration).
- `forEach` mit Return → Block (`useIterableCallbackReturn`).
- 4 `noUnusedPrivateClassMembers` → `private readonly options` → `options` (nur
  Parameter, nicht Feld).
- `noConsole` Overrides für `public/`, `charts/`, `tools/`, `*.spec.ts` — ein
  Frontend, das nie `console.warn` darf, ist kein Frontend.
- Danach: `biome check .` **482 Dateien grün**, vorher 237 Fehler.

**4. HARA/TARA Bewertung als Entwurf.**
`hara-template.md`: S/E/C/ASIL als **Entwurf mit Begründung**, klar markiert
„nicht abgenommen, Review erforderlich". Beispiel:

- HARA-01: S2/E2/C2 → QM — S2 Fehlcodierung kann Fahrverhalten ändern, aber im
  Stand; E2 nur während Diagnose; C2 Precheck vorhanden, entfernter Angreifer schwer.
- HARA-04: S3/E1/C3 → **A** (konservativ) — Schreiben während der Fahrt worst-case
  S3, aber E1 sehr gering (Annahme Fahrzeug steht), C3 schwer beherrschbar.
- TARA: 6 Gefährdungen mit Angriffsvektor, Komplexität, Privilegien,
  Benutzerinteraktion → Risiko Entwurf (Mittel/Niedrig/Hoch je nach Token/TLS).

Der Entwurf ist die Vorlage für das Review, nicht das Review — aber ein Entwurf mit
Begründung ist prüfbar, ein leeres Feld nicht.

**5. CSMS-Gerüst + SECURITY.md + Traceability.**
- `docs/standards/csms.md`: Policy, Risikomanagement, Schwachstellen-Prozess
  (Vorschlag 24h/7d/30d), Incident Response (Lücke), Nachweis (Tore), Supply Chain.
- `SECURITY.md`: unterstützte Versionen (`main`), Meldeweg (Security Advisory +
  E-Mail), was geschützt ist (Tabelle mit Beleg), nicht unterstützte Szenarien
  (`0.0.0.0` ohne Token, ohne TLS).
- `docs/standards/traceability.md`: Anforderung → Code → Test → Vektor, für SG-1…4,
  CY-01…06, Kommunikationsnormen, Betrieb.

## Why

- **Ein Rate-Limit, das nur in der Doku steht, ist kein Limit.** CY-04 war die
  einzige Zeile mit „Gegenmaßnahme: keine" nach ADR 0051. Ein 429 ist die ehrliche
  Form von „langsam".
- **TLS ohne Option ist kein Fortschritt.** Ein Werkzeug, das nur HTTP kann, kann
  in einem untrusted Netz nicht betrieben werden — die Option macht es betreibbar,
  ohne den Prüfstand-Fall (ohne TLS) zu brechen.
- **Biome 2 ist Industriestandard, weil es a11y prüft.** `useButtonType` ist kein
  Stil — ein Button ohne Typ ist `submit` per Default und schickt ein Formular ab,
  das es nicht gibt. 46 Buttons ohne Typ sind 46 kleine Defekte.
- **Ein leerer HARA ist kein HARA.** ISO 26262 verlangt eine benannte Person für
  die Freigabe, aber sie verlangt nicht, dass der Entwurf leer ist. Ein Entwurf mit
  Begründung ist die Grundlage für das Review; ein leeres Feld ist die Aufforderung,
  von vorn zu raten.

## Alternatives

1. **Rate-Limit mit Redis/externem Store.** Verworfen: Bench-Tool braucht keinen
   verteilten State, es braucht einen Guard vor der Event-Loop-Sättigung.
2. **TLS immer erzwingen.** Verworfen: Prüfstand ohne Netz + self-signed Zertifikat
   als Pflicht wäre ein Hindernis ohne Gegner. Option, nicht Pflicht.
3. **Biome 1.9.4 behalten.** Verworfen nach ADR 0053 — Major offen zu lassen, wenn
   die Migration 4× `check --write` + 3 manuelle Fixes ist, wäre kein „bewusst
   offen" mehr, sondern liegenlassen.
4. **HARA leer lassen bis Review.** Verworfen: Review ohne Vorlage ist Ratesitzung.

## Affected packages

`@vdp/web` (Server, Rate-Limit, TLS), `@vdp/shared` (Logger bleibt), `docs/standards/`
(5 Dateien), `SECURITY.md`, `biome.json`, `package.json`/`package-lock.json`.

## Forbidden implementations

- **Rate-Limit als globaler Singleton, der Tests blockiert.** Pro Server-Instanz.
- **TLS-Zertifikat im Repo committen.** Nur Pfad, nie Inhalt.
- **`429` ohne Satz oder ohne `retry-after`.** Eine Verweigerung ist Daten (ADR 0018).
- **HARA/TARA als „abgenommen" markieren**, ohne benannte Person.
- **Biome-Regeln pauschal ausschalten**, statt Buttons zu fixen.

## Tests

- `rate-limit.spec.ts` **10 Tests**: Entscheidung (Limit, Fenster-Reset, IPs getrennt,
  `clientIp`, SSE-Limit, close-Safety, clear), **über echten Socket** (100→429 mit
  `retry-after`, 10 SSE→11. 429 „too many streams", ohne Hämmern 200).
- `tls.spec.ts` **3 Tests**: ohne Cert → `http://`, mit self-signed Cert → `https://`
  + echter HTTPS-Request mit `rejectUnauthorized:false` → 200, fehlende Datei → 400.
- `auth.spec.ts` **16 Tests** weiterhin grün (Token-Tor).
- `biome check .` **482 Dateien grün**, `tsc -b` + `typecheck.json` + `frontend.json`
  sauber.

**Live gemessen** (nach diesem Commit, Port 8080 ohne TLS, Port 8443 mit self-signed):

- Ohne Token: `GET /api/state` → **401** mit Satz (wie vorher).
- Mit Rate-Limit 3/60s: 3× 200, 4. → **429** `too many requests` + `retry-after`.
- Mit SSE-Limit 2: 2 Streams offen, 3. → **429** `too many streams`.
- Mit `--cert`/`--key`: URL `https://localhost:8443`, `curl -k https://.../api/state`
  → 200, `strict-transport-security` in jedem Response.
- Ohne TLS: `strict-transport-security` trotzdem da (Browser ignoriert auf HTTP).

**Messung:** `CI=true npm run ci` **EXIT 0** — 482 Dateien, 28 Pakete/83 Kanten,
**2343 Tests / 163 Dateien** (1 Skip), Coverage **94,13 / 86,40 / 95,94 / 95,52**
(0 Verletzungen), `formal:conform` 28/28+44/44, `golden:record` EXIT 0, 0 Wert-Drift.

## AI implementation notes

- `ServerOptions.rateLimit` ist nur für Tests — Produktion nutzt Defaults.
- TLS liest PEM synchron beim Start — ein fehlendes File ist 400, kein Crash.
- `RateLimiter.clientIp` liest `socket.remoteAddress`, nicht `x-forwarded-for` —
  kein Proxy, kein Spoofing.
- Wer eine neue `/api/`-Route hinzufügt: sie liegt hinter Rate-Limit + Token-Tor,
  solange sie unter `/api/` liegt.
- Biome 2: `overrides` für `public/`, `charts/`, `tools/`, `*.spec.ts` erlauben
  `noConsole` — ein zweites `console.log` in `packages/core/` ist trotzdem Fehler.
