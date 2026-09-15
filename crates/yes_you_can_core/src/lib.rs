//! yes-you-CAN High-Performance Core Library.
//!
//! Exposes:
//! - `isotp`: Zero-copy ISO 15765-2 framing & flow control
//! - `signal`: Fast Fourier Transform, Hann windowing, skewness, kurtosis, SNR, and Hampel filtering
//! - `safety`: Compile-time typestate pattern for automotive write operations

pub mod isotp;
pub mod safety;
pub mod signal;

pub use isotp::{FlowStatus, IsoTpError, IsoTpFrame};
pub use safety::{HumanConfirmationToken, WritePermit, WriteTransaction};
pub use signal::{FrequencySpectrum, SignalStatistics};
