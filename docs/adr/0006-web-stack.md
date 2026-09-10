# 0006 — Node HTTP + SSE + Vanilla ESM für die Oberfläche

Status: accepted · Datum: 2026-09-10 · Bezug: AGENTS 16, 34.10

## Kontext

Die UI soll in einer Werkstatt ohne Build-Pipeline laufen und Live-Werte
anzeigen, ohne einen WebSocket-Server zu betreiben.

## Entscheidung

- Server: `node:http` mit Server-Sent Events (`/api/stream`). Kein WS, kein
  Socket.io.
- Client: Vanilla ES-Module, ein `EventSource`, ein Canvas-Chart in ~200 Zeilen.
  Kein Framework, kein Bundler — `public/` wird unverändert ausgeliefert.
- Alle Graphen teilen sich die Zeitachse über die monotone Millisekunden-Achse
  `t` der Samples (AGENTS 16: „synchronisierte Graphen").

## Konsequenzen

- Kein Build-Schritt für das Frontend; `node dist/src/server.js` genügt.
- SSE ist unidirektional — für Diagnose-Datenströme passend, für bidirektionale
  Steuerung nicht. Steuerbefehle laufen als normale POSTs.
- Die UI enthält bewusst keine CAN-/UDS-Logik (ADR 0004).
