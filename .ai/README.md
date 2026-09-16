# `.ai/` — AI-Kontextschicht

Kuratierte Lesepakete für Coding-Agenten (ADR 0043). Diese Schicht ist
**Navigation, keine Quelle**: sie verweist auf die verbindlichen Stellen,
sie kopiert keine Regeln. Bei Widerspruch gilt die tiefere Ebene:

```text
architecture/architecture.yaml   (Regeln: Layer, Kanten, Topics)
  > package README.md            (Verträge pro Paket, „Does NOT do“)
  > ADRs (docs/adr/)             (Entscheidungen + Implementation Impact)
  > ARCHITECTURE.md / docs/*     (Erklärung)
  > .ai/*                        (Navigation — hier)
```

## Die fünf Minuten für ein Thema

1. **Thema identifizieren** (UDS? DTC? Transport? AI? Simulator?).
2. **Kontext-Bundle generieren**:
   `npm run ai:context uds|transport|diagnostic-ir|dtc|simulator|ai`
   → `.ai/generated/<topic>-context.md` (Regeln, Pakete, APIs, ADRs,
   Flows, Beispiele — aus `architecture/architecture.yaml`).
3. **Lese-Reihenfolge** (je nach Thema):

| Lese-Paket | Wann |
|---|---|
| [`.ai/architecture.md`](architecture.md) | immer zuerst — System in einer Sitzung |
| [`.ai/code-map.md`](code-map.md) | „wo ändere ich das?“ |
| [`.ai/glossary.md`](glossary.md) | Vokabel, bevor du Namen erfindest |
| [`.ai/invariants.md`](invariants.md) | „was darf ich nicht brechen?“ |
| [`.ai/workflows.md`](workflows.md) | „wie laufe ich das System?“ |
| [`.ai/contracts/diagnostic-ir.md`](contracts/diagnostic-ir.md) | IR-Veränderung |
| [`.ai/contracts/uds.md`](contracts/uds.md) | Protokoll/Service |
| [`.ai/contracts/transport.md`](contracts/transport.md) | Bus/Adapter/Link |
| [`.ai/packages/core.md`](packages/core.md) | Engine/DTC/Writes |
| [`.ai/packages/simulator.md`](packages/simulator.md) | Simulator/Scenarios |
| [`.ai/packages/ai.md`](packages/ai.md) | Analyse/Provider |
| [`.ai/packages/runtime.md`](packages/runtime.md) | Services/Command Bus |
| [`.ai/tasks/add-uds-service.md`](tasks/add-uds-service.md) | neuer UDS-Service |
| [`.ai/tasks/add-can-adapter.md`](tasks/add-can-adapter.md) | neue Hardware |
| [`.ai/tasks/add-diagnostic-rule.md`](tasks/add-diagnostic-rule.md) | neue Diagnose-Logik |

## Regeln für diese Schicht (ADR 0043)

- Keine `mayImport`-Kanten in `.ai/*` — die stehen nur im YAML.
- Keine kopierten API-Listen — verweisen auf `docs/api/*` und die
  Package-READMEs.
- `.ai/generated/` ist **nicht committet** (`.gitignore`): generiert statt
  gespiegelt, sonst entsteht eine zweite, veraltende Quelle.
- Ein neues Lese-Paket folgt dem Muster: Zweck → Lese-Liste → Verweise.
