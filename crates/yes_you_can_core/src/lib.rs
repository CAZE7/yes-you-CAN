//! Experimental Rust reference for yes-you-CAN — **not in CI, not called from TypeScript**.
//!
//! Exposes:
//! - `isotp`: Classic-CAN ISO 15765-2 SF/FF/CF/FC framing (`[u8; 8]`, no CAN-FD)
//! - `signal`: descriptive statistics and a radix-2 FFT (allocates; no Hampel filter)
//! - `safety`: typestate sketch for write transactions (permit expiry is caller-supplied)

pub mod isotp;
pub mod safety;
pub mod signal;

pub use isotp::{FlowStatus, IsoTpError, IsoTpFrame};
pub use safety::{HumanConfirmationToken, WritePermit, WriteTransaction};
pub use signal::{FrequencySpectrum, SignalStatistics};
