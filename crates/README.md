# `crates/` — experimental reference, not production

TypeScript is the production stack (ADR 0002). Nothing in `packages/`,
`apps/`, or `tools/` imports this directory. There is no `cargo` step in
`package.json` or `.github/workflows/ci.yml`. `npm test` does not compile
Rust.

`yes_you_can_core` is a **reference sketch** (AGENTS 0.E E25):

| Module | What it actually is |
|---|---|
| `isotp.rs` | Classic-CAN ISO-TP SF/FF/CF/FC. Encode target is `[u8; 8]`. No CAN-FD, no 32-bit `FF_DL` escape. Two round-trip tests. |
| `signal.rs` | Statistics + radix-2 FFT. Allocates (`Vec`). No Hampel filter. No tests. |
| `safety.rs` | Typestate sketch. `execute` takes permit expiry from the **caller**, not from `WritePermit::expires_at_epoch_ms`. No tests. |

Production ISO-TP and write-safety live in `@vdp/transport-iso-tp` and
`@vdp/core`. Conformance vectors are TypeScript (+ optional Haskell) in
`tools/formal-conformance/vectors/` — this crate is not a third subject.

Do not integrate until a measured hot path exists (E25). Until then, claims
about this crate belong here and in E25, not in product docs.
