# 0002 — Keine Laufzeit-Abhängigkeiten

Status: accepted · Datum: 2026-09-10 · Bezug: AGENTS 34.10, 35

## Kontext

Ein Diagnose-Werkzeug läuft in Werkstattnetzen, die offline sind und bleiben.
Jede Abhängigkeit ist dort ein Installations- und ein Sicherheitsrisiko.

## Entscheidung

`dependencies` bleiben in jedem Paket leer; nur `devDependencies` (TypeScript,
`@types/node`) existieren, und die nur am Root.

Daraus folgt, dass zwei Dinge selbst geschrieben wurden:

- **PDF-Writer** (`packages/reports/src/pdf.ts`): unkomprimiertes PDF 1.4 mit
  Helvetica-Text und Rechtecken. Rund 200 Zeilen, prüfbar.
- **ZIP-Writer** (`packages/storage/src/zip.ts`): Store-Methode mit CRC32 für
  Session-Pakete.

Ebenso: `node:test` statt Jest/Vitest (ADR 0008) und Vanilla ESM statt React
(ADR 0006).

## Konsequenzen

- `npm ci` installiert nichts außer TypeScript; kein Supply-Chain-Vektor.
- PDF/ZIP beherrschen nur das, was ein Report braucht — keine Bilder, keine
  Kompression. Das ist bewusst.
- Text außerhalb von Latin-1 wird im PDF ersetzt (`sanitize`), damit die
  Byte-Offsets der xref-Tabelle gültig bleiben.
