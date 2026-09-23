//! Compile-Time Safety Typestate Architecture for Automotive Diagnostic Writes.
//!
//! Enforces zero-regression formal invariants at compile time:
//! - State transitions: `Prepared` -> `Confirmed` -> `Permitted` -> `Executing` -> `Verifying` -> `Verified`
//! - It is syntactically impossible to transition into `Executing` without both a confirmed token and an active permit.
//! - Readback verification is required before achieving the `Verified` state.

use std::marker::PhantomData;

pub struct Prepared;
pub struct Confirmed;
pub struct Permitted;
pub struct Executing;
pub struct Verifying;
pub struct Verified;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HumanConfirmationToken {
    pub token: String,
    pub confirmed_at_epoch_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
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
    pub permit: Option<WritePermit>,
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
            permit: None,
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
            permit: self.permit,
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
            permit: Some(permit),
            _state: PhantomData,
        })
    }
}

impl WriteTransaction<Permitted> {
    /// Transition to Executing if permit is still active.
    ///
    /// Validates `current_time_ms` against the permit's own `expires_at_epoch_ms`.
    /// The caller cannot arbitrarily extend the window (AGENTS 26, E25).
    pub fn execute(self, current_time_ms: u64) -> Result<WriteTransaction<Executing>, &'static str> {
        let permit = match &self.permit {
            Some(p) => p,
            None => return Err("Safety permit missing"),
        };
        if current_time_ms > permit.expires_at_epoch_ms {
            return Err("Safety permit expired");
        }
        Ok(WriteTransaction {
            tx_id: self.tx_id,
            target_ecu: self.target_ecu,
            target_did: self.target_did,
            payload: self.payload,
            previous_value: self.previous_value,
            permit: self.permit,
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
            permit: self.permit,
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
            permit: self.permit,
            _state: PhantomData,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_happy_path_typestate_transition() {
        let tx = WriteTransaction::new("tx-001".into(), 0x7E0, 0xF190, vec![1, 2, 3]);
        let confirmed = tx.confirm(HumanConfirmationToken {
            token: "TOKEN-123".into(),
            confirmed_at_epoch_ms: 1000,
        });
        let permit = WritePermit {
            target_ecu: 0x7E0,
            target_did: 0xF190,
            expires_at_epoch_ms: 2000,
        };
        let permitted = confirmed.permit(permit).expect("permit should match");
        let executing = permitted.execute(1500).expect("should execute within permit window");
        let verifying = executing.enter_verification();
        let verified = verifying.verify(&[1, 2, 3]).expect("readback match");
        assert_eq!(verified.payload, vec![1, 2, 3]);
    }

    #[test]
    fn test_expired_permit_rejected() {
        let tx = WriteTransaction::new("tx-002".into(), 0x7E0, 0xF190, vec![1]);
        let confirmed = tx.confirm(HumanConfirmationToken {
            token: "TOKEN-456".into(),
            confirmed_at_epoch_ms: 1000,
        });
        let permit = WritePermit {
            target_ecu: 0x7E0,
            target_did: 0xF190,
            expires_at_epoch_ms: 2000,
        };
        let permitted = confirmed.permit(permit).unwrap();
        // Time 2001 ms is past expires_at_epoch_ms of 2000 ms
        let result = permitted.execute(2001);
        assert_eq!(result.err(), Some("Safety permit expired"));
    }

    #[test]
    fn test_permit_target_mismatch_rejected() {
        let tx = WriteTransaction::new("tx-003".into(), 0x7E0, 0xF190, vec![1]);
        let confirmed = tx.confirm(HumanConfirmationToken {
            token: "TOKEN-789".into(),
            confirmed_at_epoch_ms: 1000,
        });
        let permit = WritePermit {
            target_ecu: 0x7E8, // mismatched ECU
            target_did: 0xF190,
            expires_at_epoch_ms: 2000,
        };
        let result = confirmed.permit(permit);
        assert_eq!(result.err(), Some("Permit target does not match transaction target"));
    }
}
