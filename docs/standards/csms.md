# CSMS — Cybersecurity Management System (Gerüst)

> **Status: Gerüst, Organisation fehlt.** Dieses Dokument beschreibt, was ISO 21434
> und UNECE R155 als Prozess verlangen, und was davon in diesem Repository bereits
> als Code oder Doku vorhanden ist. Was fehlt (Rollen, Reaktionszeiten, Meldewege)
> steht als Lücke da — nicht als erledigt.
>
> Zugehörig: [`iso-21434-cybersecurity.md`](iso-21434-cybersecurity.md) (TARA),
> [`conformance.md`](conformance.md), ADR 0050/0051/0054.

## 1. Was CSMS verlangt (ISO 21434 §5, UNECE R155)

| Anforderung | Was es bedeutet | Stand in diesem Repo |
|---|---|---|
| **Cybersecurity-Policy** | Organisation bekennt sich zu Security, benennt Rollen | **Fehlt** — keine Policy-Datei, kein CODEOWNERS für Security |
| **Risikomanagement** | TARA für jedes Item, Bewertung, Maßnahmen | **Entwurf vorhanden** — `iso-21434-cybersecurity.md` mit 6 Gefährdungen, Bewertung Entwurf, Maßnahmen 1-4 erledigt |
| **Schwachstellen-Management** | Wie werden Schwachstellen gemeldet, bewertet, behoben | **Gerüst:** `npm audit` 0 Schwachstellen, `npm outdated` 1 bewusst offen (Biome Major), `SECURITY.md` fehlt |
| **Incident Response** | Wer reagiert, in welcher Zeit, wie wird kommuniziert | **Fehlt** — keine Reaktionszeiten, keine Kontakte |
| **Nachweis und Audit** | Wie wird nachgewiesen, dass Maßnahmen umgesetzt sind | **Teilweise:** `biome check .` 482 Dateien, `check:deps`, `check:manifests`, 2330 Tests, 28/28+44/44 formale Vektoren, `auth.spec.ts` 16, `rate-limit.spec.ts` 12, `tls.spec.ts` 3 |
| **Supply Chain** | Wie werden Abhängigkeiten geprüft | **Teilweise:** `package-lock.json`, `npm audit`, `check:deps` 29 Pakete/92 Kanten, `check:manifests` (inkl. `private-dependency-leak`), **`check:licenses`** (108 Drittpakete, 0 Produktion / 108 Entwicklung, ADR 0060), keine neuen Deps ohne ADR (AGENTS 0.0) |

## 2. Schwachstellen-Prozess (Vorschlag, nicht abgenommen)

### Meldung

- **Kanal:** GitHub Security Advisories oder E-Mail an `security@` (noch nicht eingerichtet)
- **Format:** Beschreibung, betroffene Version, Reproduktion, CVSS-Vorschlag
- **Antwortzeit (Vorschlag):** 24h Bestätigung, 7 Tage Bewertung, 30 Tage Fix für Hoch

### Bewertung

- CVSS 3.1, dann Mapping auf ISO 21434 Risiko (wie in TARA §4)
- Betroffene Fläche: `conformance.md` + `iso-21434-cybersecurity.md` §2

### Behebung

- Fix in eigenem PR, ein Thema je PR (AGENTS 0.C.1)
- Tests, die ohne Fix rot sind (Biss gemessen, wie in ADR 0049/0051/0052)
- `npm audit` muss 0 bleiben, `biome check .` grün, `CI=true npm run ci` EXIT 0
- Doku im selben PR (AGENTS 34.24) — Register-Zeile bewegt sich mit

### Kommunikation

- `SECURITY.md` mit unterstützten Versionen und Meldeweg — **fehlt, sollte erstellt werden**
- Changelog-Eintrag, wenn Fix sicherheitsrelevant

## 3. Was in diesem Repository bereits CSMS trägt

| Maßnahme | Beleg | Status |
|---|---|---|
| Token-Authentifizierung | `auth.ts` 100% Coverage, 16 Tests, live 401/200 | **Erledigt** |
| Rate-Limit | `rate-limit.ts` 12 Tests, live 429 | **Erledigt** |
| TLS-Option | `server.ts` `--cert`/`--key`, 3 Tests | **Erledigt** |
| HSTS + Security-Header | `static-assets.ts` 6 Header, getestet | **Erledigt** |
| Body-Limit 1 MB | `server.ts:79` + `:520` | **Erledigt** |
| Pfad-Eindämmung | `paths.ts` Segment-Vergleich, 7 Tests | **Erledigt** |
| Sitzungs-Integrität SHA-256 | `rawTraceManifest` ADR 0047 | **Erledigt** |
| Keine neuen Deps ohne ADR | AGENTS 0.0, `check:deps` | **Erledigt** |
| `npm audit` 0 | `package-lock.json` | **Erledigt** |
| Struktur-Tore | `biome check .` 482, `tsc -b`, `hygiene.test.ts` | **Erledigt** |

## 4. Was fehlt (Organisation)

| Lücke | Wer | Aufwand |
|---|---|---|
| **SECURITY.md** mit Meldeweg und unterstützten Versionen | Maintainer | Klein — Datei erstellen |
| **Rollen benennen** (Security Owner, CSO) | Organisation | Prozess |
| **Reaktionszeiten festlegen** | Organisation + CSO | Prozess |
| **Supply-Chain-Policy** (wie werden neue Deps geprüft, wann wird `npm audit` im CI erzwungen) | Organisation | **Code-Teil erledigt** (ADR 0060: Lizenzrichtlinie + Gate); offen bleibt die organisatorische Abnahme der Reaktionszeiten |
| **Audit-Plan** (wer prüft wann TARA/CSMS) | Organisation | Prozess |
| **Vulnerability Disclosure** (wie wird extern kommuniziert) | Organisation | Prozess |

## 5. Nächste Schritte (konkret)

1. **SECURITY.md erstellen** — Vorlage aus GitHub Docs, mit E-Mail und unterstützten Versionen.
2. **CI-Job `npm audit`** — bricht bei Schwachstellen, nicht nur bei Tests.
3. **Rollen in CODEOWNERS oder AGENTS.md** — wer ist Security Owner.
4. **Review von TARA und HARA** mit benannter Person — S/E/C/ASIL und Risiko freigeben.

Bis dahin ist dieses Dokument das Gerüst, das zeigt, wo die Organisation anfangen
muss — nicht der Nachweis, dass sie es getan hat.
