# Public API: `@vdp/protocols-uds/src/security` — die Seed&Key-Naht

> Modul: `packages/protocols/uds/src/security.ts` (Vertrag: **nicht** das Paket, nur
> dieses Modul — `entry` im Record) ·
> Paket: [`packages/protocols/uds/`](../../packages/protocols/uds/README.md) ·
> ADRs: [0013](../adr/0013-transport-transaction-scope.md), [0059](../adr/0059-contracts-are-frozen-and-measured.md) ·
> Regeln: AGENTS 26 (Write-Safety), AGENTS 34.12

Security Access (`0x27`) ist die Stelle, an der ein Diagnosewerkzeug entweder ein
Herstellergeheimnis kennt oder nichts tut. Dieses Modul ist die Naht dafür: Die Plattform
liefert den **Ablauf** (Seed anfordern, Schlüssel berechnen, senden) und den **Standard,
der verweigert**; wer einen Algorithmus besitzt, registriert ihn — und nur er.

## Was hier Vertrag ist

```ts
export interface SeedKeyContext { /* was ein Algorithmus wissen darf: Level, Seed, … */ }

export interface SeedKeyAlgorithm {
  readonly id: string;
  readonly label?: string;
  computeKey(ctx: SeedKeyContext): Uint8Array;
}

export class SecurityAccessRefusedError extends Error { /* … */ }

export const refuseAllSecurityAccess: SeedKeyAlgorithm;   // der Default
export function xorSeedKeyAlgorithm(pattern: number, id?: string): SeedKeyAlgorithm;
```

**Der Default ist die wichtigste Zeile.** Ohne registrierten Algorithmus **verweigert** die
Plattform den Zugang (`refuseAllSecurityAccess`, `SecurityAccessRefusedError`) — sie
versucht nicht, etwas zu erraten. Damit ist „kein Algorithmus“ ein definierter Zustand mit
einem Typ, nicht ein `undefined`, das irgendwo zu spät auffällt.

**`xorSeedKeyAlgorithm` ist ein Beispiel und eine Warnung.** Es steht hier, damit die Naht
verifizierbar ist (und der Simulator Bedienung zeigen kann), **nicht** damit jemand sie für
ein reales Steuergerät hält. Ein echter Algorithmus gehört in ein Modul, für das der
Betreiber die Berechtigung hat (OEM-Freigabe, eigener Vertrag, eigene Lizenz) — die
Plattform verlangt die Registrierung, nicht die Herkunft.

## Die Kanten (maschinell geprüft)

1. **Nichts in der Plattform umgeht die Naht.** Ein `0x27`-Ablauf ohne Algorithmus endet
   in der Verweigerung, und die Verweigerung ist typisiert (`SecurityAccessRefusedError`).
   Ein „tue so als ob“ mit festem Schlüssel wäre ein Defekt, kein Feature.
2. **Der Vertrag ist auf ein Modul geschnitten** (`entry:
   dist/src/security.d.ts`, 1 Datei im Record). Der UDS-Client ist offen und wird
   weiterentwickelt; diese Naht bewegt sich langsam — genau die Trennung, die ein
   Closed-Modul braucht.
3. **Ein geschlossenes Modul bekommt hier Autorität — aber nur diese.** Es darf einen
   Schlüssel *berechnen*; es bekommt keinen Transport, keinen Bus und kein Steuergerät.
   Die Entscheidung, ob gesendet wird, bleibt im offenen Ablauf inklusive
   `SafetyManager`-Kette (AGENTS 26).

## Häufige Fehler

- **`SecurityAccessRefusedError` schlucken** und trotzdem weiterlaufen — dann ist die
  Verweigerung eine Log-Zeile und der Ablauf lügt.
- **Den Algorithmus an einer zweiten Stelle registrieren** (z. B. direkt im Client) — dann
  gibt es zwei Wege in dieselbe Session und keinen Ort, an dem die Berechtigung geprüft
  wird.
- **`xorSeedKeyAlgorithm` produktiv nutzen.** Es ist der Testvektor, nicht die Antwort.

**Zugehörig:** [`docs/api/uds.md`](uds.md) (der offene Dienstumfang), der Flow
[`docs/flows/diagnostic-write.md`](../flows/diagnostic-write.md),
[`docs/flows/open-core-boundary.md`](../flows/open-core-boundary.md) (warum der
Schreibpfad offen bleibt).
