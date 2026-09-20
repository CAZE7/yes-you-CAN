# `tests/hardware/` — real adapters, honestly gated

These tests talk to a **real** SocketCAN interface (usually `vcan0`). They are
not part of `npm test`. Run them with:

```bash
sudo modprobe vcan
sudo ip link add dev vcan0 type vcan
sudo ip link set up vcan0
npm run test:hardware
```

Without `vcan0` the suite **skips with the missing precondition in the
message**. A skip that names its reason is a finding; an unrun test dressed as
green is not (AGENTS 34.21).

| File | What it proves | What it does *not* |
|---|---|---|
| `vcan.test.ts` | The `hardware` project is never empty; `vcan0` is present or the skip is named | A UDS ping. That lands once the SocketCAN binding is productively wired. |
| `socketcan-conformance.test.ts` | The ISO-TP conformance vectors over a real `CanBus` (vcan0 + binding) | CANable / ELM327 / PCAN. Those sit on the same contract; PCAN has no adapter package yet. |

## DoIP TLS (ISO 13400-2 port 3496)

The constant `DOIP_TLS_PORT = 3496` is **announced, not implemented**.
`DoipTransport` can *require* a socket that already claims TLS
(`requireTls: true`); it does not open a TLS listener, does not speak the
ISO 13400-3 handshake, and does not bind 3496. A test that asserted otherwise
would be a claim without a measurement.

The workbench does not wire DoIP at all (AGENTS 0.A, MVP §29). Hardware DoIP
belongs here the day a transport actually listens.

## What is not here

- Licensed OEM traces
- Nightly GitHub `hardware.yml` — the workflow exists as a working copy, but
  the GitHub App cannot push workflow files (0.E E10)
