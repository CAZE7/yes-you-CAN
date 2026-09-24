//! yes-you-CAN reference core (ISO-TP framing, signal statistics, write-safety typestate).
//!
//! Exposes:
//! - `isotp`: ISO 15765-2 framing & flow control; decoding returns slices into
//!   the caller's buffer (`IsoTpFrame` borrows, it does not copy)
//! - `signal`: Fourier Transform, Hann windowing, skewness, kurtosis, SNR, and
//!   Hampel filtering. **Allocates**: `compute_statistics` clones the input to
//!   sort it, `compute_fft` allocates its two work buffers. Nothing here is
//!   zero-allocation, and saying so was a claim without a measurement.
//! - `safety`: Compile-time typestate pattern for automotive write operations
//!
//! ## Status: reference / experimental
//!
//! This crate is **not** part of the platform and **not** part of any gate:
//! no `cargo` step exists in `package.json` or in any workflow, and nothing
//! under `packages/`, `apps/` or `tools/` imports it. `tests/architecture/`
//! enforces both facts. See `crates/yes_you_can_core/README.md`.

pub mod isotp;
pub mod safety;
pub mod signal;

pub use isotp::{FlowStatus, IsoTpError, IsoTpFrame};
pub use safety::{HumanConfirmationToken, WritePermit, WriteTransaction};
pub use signal::{FrequencySpectrum, SignalStatistics};
