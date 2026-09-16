# Lese-Paket: „Where should I change this?“

**Zweck:** Die Aufgabe→Stelle-Karte, damit ein Agent nicht raten muss.

## Lese-Liste

1. [`../docs/code-map.md`](../docs/code-map.md) — **die** Tabelle
   (Aufgabe → primäre Stelle → Sekundärstellen) + die Regelmuster für
   wiederkehrende Fragen („neue Hardware?“, „neuer Hersteller?“,
   „etwas schnell in die UI/KI?“).
2. [`../ARCHITECTURE.md`](../ARCHITECTURE.md) §2 — falls die Aufgabe eine
   ganze Schicht berührt (dann: Layer + Verträge der Schicht).
3. Package-`README.md` des Ziel-Pakets — v. a. „Does NOT do“: es sagt,
   dass die Änderung *nicht* dort hingehört, bevor du sie schiebst.

## Checkliste „die Änderung sitzt an der richtigen Stelle“

- [ ] Die Code-Map-Zeile für die Aufgabe existiert — wenn nicht: erst die
      Zeile ergänzen (oder die Aufgabe in zwei Zerlegen), dann ändern.
- [ ] Das Ziel-Paket darf die benötigten Pakete importieren
      (`architecture/architecture.yaml` → `mayImport`).
- [ ] „Does NOT do“ der README ist nach der Änderung noch wahr.
- [ ] Es gibt keine zweite Kopie der betroffenen Vokabel/Logik
      ([`../docs/glossary.md`](../docs/glossary.md)).
- [ ] `npm run check:deps && npm run check:manifests` grün.
