# ADR 51 — Die Workbench-API kennt ihren Aufrufer

- Status: akzeptiert (2026-09-22)
- Kontext: ADR 0050 (Konformanz-Register), `docs/standards/iso-21434-cybersecurity.md`
  (CY-01/CY-02/CY-05), ADR 0018 (eine Verweigerung ist Daten), ADR 0009
  (localhost als Default), ADR 0049 (ein Zustand wird gesagt, nicht verschwiegen)
- Betrifft: `apps/web/src/auth.ts` (neu), `apps/web/src/server.ts`
  (`ServerOptions.token`, `--token=`, `VDP_API_TOKEN`, Tor in `handle()`,
  Warnung beim Start), `apps/web/src/static-assets.ts` (`strict-transport-security`),
  `apps/web/test/auth.spec.ts` (neu), `docs/standards/*`

## Problem

Gemessen, bevor es diese Änderung gab:

- **37** Routen unter `/api/`
- `grep -c "authoriz\|bearer\|token" apps/web/src/server.ts` → **0**
- kein `strict-transport-security` in der Header-Tabelle
- `--host=0.0.0.0` bindet alle Schnittstellen; der Server warnte mit einem Satz,
  der unabhängig vom Zustand immer „has no authentication" sagte

Der `WritePort` entscheidet mit Permit, Stufenfolge und 44 formalen Vektoren,
**wann** eine Schreiboperation erlaubt ist. **Wer** fragt, entschied nichts. Jeder,
der den Port erreichen konnte, konnte das Fahrzeug lesen und `POST /api/dtc/clear`
oder `/api/coding/write` auslösen. Das ist die Gefährdung CY-02 im TARA-Gerüst, und
sie war die einzige Zeile dort, deren Gegenmaßnahme „keine" lautete, während der Rest
des Systems Freigaben prüft.

## Entscheidung

**1. Ein Token-Tor vor jedem `/api/`-Pfad, einschließlich des SSE-Stroms.**
`apps/web/src/auth.ts` liefert den `Authenticator`; `handle()` prüft vor dem Routen.
Eine Verweigerung ist **401 mit einem Satz**, der sagt, wie man sich anmeldet — nicht
403, nicht Stille (ADR 0018).

**2. Der Tausch folgt dem Muster, das ein lokales Werkzeug schon lösen muss.**
Die Bedienperson öffnet die Workbench einmal mit `?token=…` (Jupyter-Muster), der
Server tauscht das gegen einen `httpOnly; SameSite=Strict; Path=/`-Cookie und
antwortet **302** auf den Pfad ohne Token. Danach trägt jeder Aufruf den Cookie oder
`Authorization: Bearer`. **Das Token steht nicht im HTML** — wer den Server erreicht,
könnte es sonst zurücklesen, und ein Token, das man zurücklesen kann, ist keines.
Kein `Max-Age`: die Sitzung endet mit dem Browser, ein in einer URL hinterlegtes
Token bleibt nicht als stehende Berechtigung im Profil.

**3. Der Vergleich ist konstant in der Zeit.** Beide Seiten werden vor dem Vergleich
mit SHA-256 auf feste Breite gebracht, dann `timingSafeEqual`. Ein `===` auf ein
Geheimnis verrät über die Zeit seine Länge und die erste abweichende Stelle; erst der
Digest macht `timingSafeEqual` überhaupt anwendbar.

**4. Ohne Token bleibt das Verhalten unverändert — und wird gesagt.**
`enabled: false` lässt alles durch (Prüfstand ohne Netz), und die Startwarnung nennt
den tatsächlichen Zustand statt eines festen Satzes:

```
WARN [server] listening on all interfaces with NO API token — whoever reaches this
port can read the vehicle and trigger a write; set --token=… or VDP_API_TOKEN
{"host":"0.0.0.0","authenticated":false}
```

Mit Token steht dort `every /api request needs the API token` und
`authenticated: true`. Eine Warnung, die lügt, ist schlechter als keine (ADR 0049).

**5. `strict-transport-security` ist jetzt schon da.** Browser ignorieren den Header
auf unsicherem Ursprung, deshalb kann er vor der TLS-Option shipped werden: wenn
`--cert`/`--key` kommen, ist die Pinning-Regel bereits gesetzt statt nachgetragen
(CY-05).

**6. Rate-Limit bleibt offen und steht als solches da.** Ein halb eingebautes Limit,
das der Prüfstand sofort auslöst, wäre Dekoration. CY-04 im TARA-Gerüst trägt die
Lücke mit Namen.

## Why

- **Eine Freigabe ohne Aufrufer ist die Hälfte einer Regelung.** Permit und
  Stufenfolge beantworten die Frage nach dem Zeitpunkt; ohne Identität bleibt die
  nach dem Absender offen — und die Schreibpfade sind die einzigen, die am Fahrzeug
  etwas ändern.
- **Das Token im HTML wäre Selbsttäuschung.** Der Unterschied zwischen „keine
  Authentifizierung" und „ein Token, das jeder lesen kann, der den Port erreicht" ist
  keiner. Deshalb der Tausch über die URL und ein Cookie, den Skript nicht lesen kann.
- **Rückwärtskompatibilität ist hier kein Zugeständnis.** Ohne Netz am Prüfstand ist
  ein Token ein Hindernis ohne Gegner. Der Zustand steht in der Warnung, und die
  Tests decken beide Fälle — den offenen und den geschützten.

## Alternatives

1. **Token in die ausgelieferte Seite einbetten.** Verworfen — siehe Why.
2. **Authentifizierung immer erzwingen.** Verworfen: der Prüfstand ohne Netz ist der
   Normalfall, und ein erzwungenes Token dort schützt niemanden, kostet aber jeden
   Test und jede Doku ihren direkten Weg.
3. **Basic Auth.** Verworfen: der Browser merkt sich die Antwort, die Abmeldung ist
   unsauber, und das Token stünde in jedem Request-Log im Klartext.
4. **Grundlegend TLS statt Token.** Nicht entweder/oder: TLS schützt den Weg, nicht
   den Absender. Die TLS-Option steht als Punkt 4 in
   `docs/standards/iso-21434-cybersecurity.md` §5.
5. **Rate-Limit im selben Zug.** Verworfen — eigenes Thema, eigene Tests, eigene
   Grenze, die der Prüfstand nicht auslösen darf.

## Affected packages

`@vdp/web` allein. `node:crypto` ist in `apps/web` erlaubt
(`architecture/architecture.yaml`, `nodeBuiltins.allowedIn`). Keine neue
Abhängigkeit, keine geweitete Kante.

## Forbidden implementations

- **Ein Geheimnis mit `===` vergleichen.** Auch nicht „vorübergehend".
- **Das Token in HTML, JS oder einen SSE-Kommentar schreiben.**
- **`403` statt `401`** für einen nicht authentifizierten Aufrufer — 403 sagt
  „authentifiziert, aber nicht erlaubt", und das ist eine andere Aussage.
- **Eine neue `/api/`-Route vor dem Tor anmelden.** Das Tor sitzt in `handle()` vor
  dem Routen; wer eine Route davor einhängt, öffnet sie.
- **Die Startwarnung auf einen festen Satz zurückbauen.** Sie nennt den Zustand.
- **`enabled: false` als Fehler behandeln.** Es ist der Prüfstand-Fall und getestet.

## Tests

`apps/web/test/auth.spec.ts` (neu, **16 Tests**), beide Ebenen:

- Entscheidung: konstanter Vergleich (gleich/ungleich/ungleiche Länge — kein Crash),
  Cookie-Parsen (unter anderen, fehlend, kodiert), `enabled: false` lässt durch,
  Bearer groß/kleinschreibungsunabhängig, `Basic` wird abgewiesen, Cookie-Attribute
  (`HttpOnly`, `SameSite=Strict`, `Path=/`, kein `Max-Age`), falscher Tausch ergibt
  keinen Cookie.
- **Über einen echten Socket:** `/api/state` ohne Anmeldedaten → 401 mit Satz, der
  `Bearer` nennt; `POST /api/dtc/clear` ohne Anmeldedaten → **401** (der Schreibpfad
  ist ebenfalls gated); mit Bearer → 200 mit echtem Zustand; mit falschem Bearer →
  401; `?token=` → 302 + genau ein `Set-Cookie` + `location` ohne Token, und mit dem
  Cookie danach 200; falsches URL-Token → 401 und **kein** Cookie; ohne
  konfiguriertes Token → 200 wie vorher.

**Biss gemessen:** das Tor in `handle()` ausgeschaltet (`if (false && …)`) → 2 Tests
rot mit `200 !== 401`. `auth.ts` selbst: **100 / 100 / 100 / 100**.

**Live nachgemessen** (`--token=bench-s3cret`, Port 8081):
`GET /api/state` ohne Token → **401** mit dem Satz; mit falschem Token → 401; mit
Token → **200**; `POST /api/dtc/clear` ohne Token → **401**;
`GET /?token=bench-s3cret` → **302** mit
`set-cookie: vdp_session=…; HttpOnly; SameSite=Strict; Path=/`;
`GET /` → `strict-transport-security: max-age=31536000; includeSubDomains`.

**Messung am Stand:** `npm run test:coverage` **EXIT 0** — **2326 passed / 2 skipped**
(160 Dateien), global **94,12 / 86,40 / 95,94 / 95,52**, `auth.ts` **100/100/100/100**,
keine Gate-Verletzung; `biome check .` **481 Dateien** grün; `tsc -b`,
`tsconfig.typecheck.json` und `tsconfig.frontend.json` sauber.

## AI implementation notes

- Das Token kommt aus `--token=` oder `VDP_API_TOKEN`; `ServerOptions.token` gewinnt.
- Der Tausch gilt für **jeden** Pfad mit `?token=`, nicht nur `/` — ein Link auf
  `/graphs.html?token=…` funktioniert damit auch.
- `EventSource` trägt den Cookie automatisch (same-origin), der SSE-Strom braucht
  deshalb keine eigene Behandlung.
- Wer eine Route hinzufügt: sie liegt hinter dem Tor, solange sie unter `/api/` liegt
  und nicht vor `handle()`s Prüfung eingehängt wird.
- `secretsEqual` ist exportiert und getestet — ein zweiter Vergleich mit `===` ist ein
  Defekt, kein Stil.
