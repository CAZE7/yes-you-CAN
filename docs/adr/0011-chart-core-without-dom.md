# 0011 — Chart-Kern als DOM-freies, getestetes Paket

Status: accepted · Datum: 2026-09-10 · Bezug: ADR 0002, 0006, 0010; AGENTS 16, 34.8, 35

## Kontext

AGENTS 16 nennt das Graph-System die „zentrale Funktion" der Plattform und
fordert Zoom, Pan, Cursor, Marker, Zeitraumwahl, Min/Max/Ø/Delta,
Ein-/Ausblenden, automatische Skalierung und synchronisierte Zeitachsen.

Die erste Fassung (`apps/web/public/chart.js`) war eine einzige Canvas-Klasse:
Zoomen, Skalieren, Trimmen und Statistik lagen zwischen `ctx.beginPath()`-Aufrufen.
Damit war keiner dieser Teile testbar — genau die Regeln, an denen sich ein
Diagnosewerkzeug von einer Bastel-App unterscheidet (etwa: „Decimierung darf
keine Spitze verstecken" oder „Zoom stoppt an der Aufnahmegrenze").

ADR 0010 schlägt in Schritt 4 vor, die eigene Canvas-Klasse durch `uPlot` zu
ersetzen. Das bleibt eine Option — sie beantwortet aber nicht die Frage, wo die
*Regeln* leben.

## Entscheidung

Die Mathematik der Graphen liegt in **`packages/charts` (`@vdp/charts`)**:

- **DOM-frei.** Kein `canvas`, kein `window`, kein `document`. Das Paket kennt
  nur Zeitpunkte, Werte, Fenster und Marker.
- **In sich getestet.** 41 Unit-Tests (Vitest, ADR 0010 Schritt 1) decken Viewport-Klemmung,
  Zoom-Anker, Pan-Richtung, Follow-Verhalten, Decimierung (Min/Max und LTTB),
  Statistik über Fenster, Cursor-Snapping, Marker-Filterung und die
  Synchronisation über `ChartGroup` ab.
- **Im Browser dieselbe Datei.** Der Server liefert das kompilierte Paket unter
  `/lib/` aus (gleiche Regeln wie `public/`: same-origin, GET-only, kein
  Path-Traversal). Die Canvas-Klasse importiert `/lib/index.js` und *zeichnet
  nur noch*.

`ChartGroup` hält den gemeinsamen Zustand: ein Viewport, ein Cursor, eine
Auswahl, beliebig viele Serien. Einzelne Graphen lesen diesen Zustand — deshalb
sind sie synchron, ohne sich gegenseitig Nachrichten zu schicken, und deshalb
lässt sich die Synchronisation als Zustand testen statt als Pixel.

Die Decimierung ist bewusst doppelt vorhanden: `minmax` (spiketreu, Standard)
und `lttb` (formtreu). Min/Max ist der Standard, weil ein Diagnosewerkzeug eine
ausgelassene Spitze teurer bezahlt als eine etwas zackigere Linie.

## Konsequenzen

- Regelfehler in Zoom, Cursor und Statistik sind ab jetzt Testfehler, nicht
  „sieht komisch aus".
- Der Renderer bleibt austauschbar: Ein späterer Umstieg auf `uPlot` (ADR 0010
  Schritt 4) ersetzt `chart.js`, nicht `@vdp/charts`.
- Keine Laufzeit-Abhängigkeit (ADR 0002) — das Frontend lädt weiterhin nur
  eigenen, selbst gebauten Code.
- `/lib/` ist ein weiteres statisches Verzeichnis und damit Teil der
  Angriffsfläche: es wird beim Serverstart aus dem Paketnamen aufgelöst und wie
  `public/` gegen Traversal und fremde Methoden gesichert.
