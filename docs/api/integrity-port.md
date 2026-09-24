# Public API: `@vdp/core/src/logging/integrity` — die Integritätsnaht

> Modul: `packages/core/src/logging/integrity.ts` (Vertrag: **nicht** das Paket, nur
> dieses Modul — `entry` im Record) ·
> Paket: [`packages/core/`](../../packages/core/README.md) ·
> ADRs: [0047](../adr/0047-integrity-port.md), [0057](../adr/0057-provenance-and-replay-same-recording-same-diagnosis.md),
> [0059](../adr/0059-contracts-are-frozen-and-measured.md) ·
> Verbraucher: [`packages/storage/`](../../packages/storage/README.md)

`@vdp/core` ist als Ganzes **kein** Vertrag — es ist die Engine. Vertrag ist der Teil, den
jemand *außerhalb* implementiert: das Hashing und die Signatur eines Roh-Traces. Der Kern
sagt, **was** gehasht wird; die Umgebung sagt, **wie**. Ein Cloud-Worker, eine
Hardware-Signatur oder ein Kurier-Format setzen genau hier an (ADR 0047).

## Was hier Vertrag ist

**Ports.**

```ts
export interface IntegrityPort {
  digest(bytes: Uint8Array, algorithm: RawTraceHashAlgorithm): IntegrityDigest;
}
export interface ManifestSigner {
  sign(binding: string): RawTraceSignature;
}
export interface ManifestVerifier {
  verify(binding: string, signature: RawTraceSignature): boolean;
}
```

`ManifestSigner`/`ManifestVerifier` sind **bewusst getrennt** von `IntegrityPort`:
„unverändert“ (Digest) und „von einem Schlüssel attestiert, den ich kenne“ (Signatur) sind
zwei Behauptungen, und wer sie in eine zusammenzieht, verliert die Unterscheidung.

**Der Record — `RawTraceManifest`.** `RAW_TRACE_MANIFEST_VERSION = 2`,
`SUPPORTED_RAW_TRACE_MANIFEST_VERSIONS = [1, 2]`, `RAW_TRACE_HASH_ALGORITHM = "sha256"`,
`RawTraceManifestIdentity` (`format|version|algorithm|entries|sha256`),
`RawTraceSignature { keyId, algorithm: "ed25519", value }`. Eine V1-Datei verifiziert
weiter — V1 gültig heißt: der Digest bleibt derselbe, die *Version* wächst (ADR 0057).

**Die Funktionen, die die Naht definieren.** `canonicalManifestBinding(manifest)` (**die
eine Stelle**, die festlegt, was signiert wird), `canonicalRawTraceChunks`,
`hashRawTrace(entries, port)`, `createRawTraceManifest(entries, port)`,
`traceIdFromManifest` (content-adressierte Id `t-<16 hex>`),
`signRawTraceManifest`, `verifyRawTraceManifestSignature`, `verifyRawTraceManifest`,
`withRawTraceManifest`.

**Was das für einen Closed-Teil heißt.** Ein geschlossenes Modul *darf* diese Datei
kompilieren, weil sie den Vertrag trägt. Es darf **nicht** verlangen, dass eine fremde
Umgebung das Hashing anders macht — die kanonische Bindung ist Teil des Vertrags, sonst
sind zwei Implementierungen desselben Formats nicht mehr vergleichbar.

## Die Kanten (maschinell geprüft)

1. **Der Vertrag ist auf ein Modul geschnitten**, nicht auf das Paket: `entry` in
   `architecture/architecture.yaml` (`dist/src/logging/integrity.d.ts`). Die 5 Dateien im
   Record sind das Modul **plus** das, was es referenziert (`session-logger`, `recorder`,
   …) — die transitive Hülle ist Teil der Zusage (ADR 0059).
2. **Kein geschlossenes Modul bekommt hier eine größere Autorität.** Die Signatur
   *attestiert*, sie *erlaubt* nichts: kein Typ dieser Datei kann eine Write-Operation
   auslösen (AGENTS 26).
3. **Signatur ≠ Digest.** `verifyRawTraceManifestSignature` ist ein eigener Aufruf; die
   Verifikation („Bytes unverändert“) bleibt auch dann gültig, wenn niemand den Schlüssel
   kennt.

## Häufige Fehler

- **`canonicalManifestBinding` nachbauen** (im Closed-Modul oder in einem Test) — dann
  gibt es zwei Definitionen von „das wird signiert“, und die nächste Änderung bricht eine
  davon still.
- **Einen Digest als Signatur verkaufen.** Ein Hash beweist Unversehrtheit, nicht
  Urheberschaft; das Feld heißt `signature`, und es braucht einen `keyId`.
- **Die Manifest-Version erhöhen und dabei V1 brechen.** Der goldene Digest ist gepinnt;
  „gleicher Digest, neue Version“ ist die Regel (ADR 0057).

**Zugehörig:** [`docs/flows/recording-replay.md`](../flows/recording-replay.md),
[`docs/api/runtime.md`](runtime.md), `packages/storage/src/manifest-signer.ts` (die
Node-Implementierung der Naht).
