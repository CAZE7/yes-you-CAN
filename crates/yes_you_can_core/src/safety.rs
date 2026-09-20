//! Typestate sketch for diagnostic writes (experimental reference).
//!
//! States: `Prepared` → `Confirmed` → `Permitted` → `Executing` → `Verifying` → `Verified`.
//! The type system stops `execute` on a `Prepared` value. It does **not** bind
//! the permit: `WriteTransaction<Permitted>::execute` takes `permit_expiry_ms`
//! from the caller instead of `WritePermit::expires_at_epoch_ms`, so a caller
//! can extend the window. No tests. Not in CI. Production safety is
//! `packages/core/src/safety` (TypeScript).

use std::marker::PhantomData;

pub struct Prepared;
pub struct Confirmed;
pub struct Permitted;
pub struct Executing;
pub struct Verifying;
pub struct Verified;

#[derive(Debug, Clone)]
pub struct HumanConfirmationToken {
    pub token: String,
    pub confirmed_at_epoch_ms: u64,
}

#[derive(Debug, Clone)]
pub struct WritePermit {
    pub target_ecu: u16,
    pub target_did: u16,
    pub expires_at_epoch_ms: u64,
}

#[derive(Debug, Clone)]
pub struct WriteTransaction<State> {
    pub tx_id: String,
    pub target_ecu: u16,
    pub target_did: u16,
    pub payload: Vec<u8>,
    pub previous_value: Option<Vec<u8>>,
    _state: PhantomData<State>,
}

impl WriteTransaction<Prepared> {
    pub fn new(tx_id: String, target_ecu: u16, target_did: u16, payload: Vec<u8>) -> Self {
        Self {
            tx_id,
            target_ecu,
            target_did,
            payload,
            previous_value: None,
            _state: PhantomData,
        }
    }

    /// Transition to Confirmed upon human token presentation.
    pub fn confirm(self, _token: HumanConfirmationToken) -> WriteTransaction<Confirmed> {
        WriteTransaction {
            tx_id: self.tx_id,
            target_ecu: self.target_ecu,
            target_did: self.target_did,
            payload: self.payload,
            previous_value: self.previous_value,
            _state: PhantomData,
        }
    }
}

impl WriteTransaction<Confirmed> {
    /// Transition to Permitted once safety engine validates prechecks.
    pub fn permit(self, permit: WritePermit) -> Result<WriteTransaction<Permitted>, &'static str> {
        if permit.target_ecu != self.target_ecu || permit.target_did != self.target_did {
            return Err("Permit target does not match transaction target");
        }
        Ok(WriteTransaction {
            tx_id: self.tx_id,
            target_ecu: self.target_ecu,
            target_did: self.target_did,
            payload: self.payload,
            previous_value: self.previous_value,
            _state: PhantomData,
        })
    }
}

impl WriteTransaction<Permitted> {
    /// Transition to Executing if permit is still active.
    pub fn execute(self, current_time_ms: u64, permit_expiry_ms: u64) -> Result<WriteTransaction<Executing>, &'static str> {
        if current_time_ms > permit_expiry_ms {
            return Err("Safety permit expired");
        }
        Ok(WriteTransaction {
            tx_id: self.tx_id,
            target_ecu: self.target_ecu,
            target_did: self.target_did,
            payload: self.payload,
            previous_value: self.previous_value,
            _state: PhantomData,
        })
    }
}

impl WriteTransaction<Executing> {
    /// Transition to Verifying once write frames are transmitted.
    pub fn enter_verification(self) -> WriteTransaction<Verifying> {
        WriteTransaction {
            tx_id: self.tx_id,
            target_ecu: self.target_ecu,
            target_did: self.target_did,
            payload: self.payload,
            previous_value: self.previous_value,
            _state: PhantomData,
        }
    }
}

impl WriteTransaction<Verifying> {
    /// Transition to Verified ONLY if readback matches written payload.
    pub fn verify(self, readback_bytes: &[u8]) -> Result<WriteTransaction<Verified>, &'static str> {
        if self.payload.as_slice() != readback_bytes {
            return Err("Readback verification failed: mismatch with written bytes");
        }
        Ok(WriteTransaction {
            tx_id: self.tx_id,
            target_ecu: self.target_ecu,
            target_did: self.target_did,
            payload: self.payload,
            previous_value: self.previous_value,
            _state: PhantomData,
        })
    }
}
