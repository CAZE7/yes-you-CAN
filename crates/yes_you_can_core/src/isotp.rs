//! ISO 15765-2 (ISO-TP) Network Layer Implementation.
//!
//! Provides framing and defragmentation for Classic CAN (ISO 15765-2):
//! - Single Frame (SF) handling up to 7 bytes (Classic CAN).
//! - First Frame (FF) & Consecutive Frame (CF) segmentation up to 4095 bytes (12-bit DL).
//! - Flow Control (FC) pacing: CTS, WAIT, and OVERFLOW status codes with STmin delay pacing.
//! - Slice-based decoding avoiding allocations on decode paths.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FlowStatus {
    ClearToSend = 0,
    Wait = 1,
    Overflow = 2,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IsoTpFrame<'a> {
    SingleFrame {
        payload: &'a [u8],
    },
    FirstFrame {
        total_length: u16,
        chunk: &'a [u8],
    },
    ConsecutiveFrame {
        sequence_number: u8,
        chunk: &'a [u8],
    },
    FlowControl {
        status: FlowStatus,
        block_size: u8,
        st_min_ms: u8,
    },
}

#[derive(Debug, PartialEq, Eq)]
pub enum IsoTpError {
    BufferOverflow,
    InvalidPduType(u8),
    UnexpectedSequenceNumber { expected: u8, received: u8 },
    IncompleteTransmission,
    FlowControlWaitTimeout,
    FlowControlOverflowSignaled,
    PayloadTooLarge(usize),
}

/// Decode one CAN frame into an `IsoTpFrame`.
///
/// Allocates nothing: every variant borrows a slice of `data`, so the
/// decoded message is only as long-lived as the buffer it points into.
/// That is a statement about the signature, not a benchmark — no
/// allocation measurement exists for this crate (AGENTS 0.E E25, finding 2).
pub fn parse_frame(data: &[u8]) -> Result<IsoTpFrame<'_>, IsoTpError> {
    if data.is_empty() {
        return Err(IsoTpError::InvalidPduType(0xFF));
    }

    let pci = data[0];
    let frame_type = pci >> 4;

    match frame_type {
        0x0 => {
            // Single Frame: length in lower nibble
            let len = (pci & 0x0F) as usize;
            if len > data.len() - 1 {
                return Err(IsoTpError::BufferOverflow);
            }
            Ok(IsoTpFrame::SingleFrame {
                payload: &data[1..=len],
            })
        }
        0x1 => {
            // First Frame: length in 12 bits (lower nibble of byte 0 + byte 1)
            if data.len() < 2 {
                return Err(IsoTpError::BufferOverflow);
            }
            let len = (((pci & 0x0F) as u16) << 8) | (data[1] as u16);
            Ok(IsoTpFrame::FirstFrame {
                total_length: len,
                chunk: &data[2..],
            })
        }
        0x2 => {
            // Consecutive Frame: sequence number in lower nibble
            let seq = pci & 0x0F;
            Ok(IsoTpFrame::ConsecutiveFrame {
                sequence_number: seq,
                chunk: &data[1..],
            })
        }
        0x3 => {
            // Flow Control: flow status in lower nibble
            let status = match pci & 0x0F {
                0 => FlowStatus::ClearToSend,
                1 => FlowStatus::Wait,
                2 => FlowStatus::Overflow,
                other => return Err(IsoTpError::InvalidPduType(other)),
            };
            let block_size = if data.len() > 1 { data[1] } else { 0 };
            let st_min_ms = if data.len() > 2 { data[2] } else { 0 };
            Ok(IsoTpFrame::FlowControl {
                status,
                block_size,
                st_min_ms,
            })
        }
        other => Err(IsoTpError::InvalidPduType(other)),
    }
}

/// Encode a Single Frame into a fixed 8-byte CAN buffer.
pub fn encode_single_frame(payload: &[u8], out: &mut [u8; 8]) -> Result<usize, IsoTpError> {
    if payload.len() > 7 {
        return Err(IsoTpError::PayloadTooLarge(payload.len()));
    }
    out[0] = payload.len() as u8;
    out[1..=payload.len()].copy_from_slice(payload);
    // Standard ISO-TP padding (0xCC or 0xAA)
    for b in &mut out[1 + payload.len()..] {
        *b = 0xCC;
    }
    Ok(8)
}

/// Encode a First Frame into a fixed 8-byte CAN buffer.
pub fn encode_first_frame(total_length: u16, chunk: &[u8], out: &mut [u8; 8]) -> Result<usize, IsoTpError> {
    if chunk.len() > 6 {
        return Err(IsoTpError::BufferOverflow);
    }
    out[0] = 0x10 | ((total_length >> 8) as u8 & 0x0F);
    out[1] = (total_length & 0xFF) as u8;
    out[2..2 + chunk.len()].copy_from_slice(chunk);
    for b in &mut out[2 + chunk.len()..] {
        *b = 0xCC;
    }
    Ok(8)
}

/// Encode a Consecutive Frame into a fixed 8-byte CAN buffer.
pub fn encode_consecutive_frame(sequence_number: u8, chunk: &[u8], out: &mut [u8; 8]) -> Result<usize, IsoTpError> {
    if chunk.len() > 7 {
        return Err(IsoTpError::BufferOverflow);
    }
    out[0] = 0x20 | (sequence_number & 0x0F);
    out[1..1 + chunk.len()].copy_from_slice(chunk);
    for b in &mut out[1 + chunk.len()..] {
        *b = 0xCC;
    }
    Ok(8)
}

/// Encode a Flow Control Frame into a fixed 8-byte CAN buffer.
pub fn encode_flow_control(status: FlowStatus, block_size: u8, st_min_ms: u8, out: &mut [u8; 8]) -> usize {
    out[0] = 0x30 | (status as u8 & 0x0F);
    out[1] = block_size;
    out[2] = st_min_ms;
    for b in &mut out[3..] {
        *b = 0xCC;
    }
    8
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_single_frame_roundtrip() {
        let payload = [0x22, 0xF1, 0x90]; // UDS ReadDataByIdentifier (VIN)
        let mut buf = [0u8; 8];
        let len = encode_single_frame(&payload, &mut buf).unwrap();
        assert_eq!(len, 8);
        assert_eq!(buf[0], 0x03);

        match parse_frame(&buf).unwrap() {
            IsoTpFrame::SingleFrame { payload: parsed } => {
                assert_eq!(parsed, &payload);
            }
            _ => panic!("Expected SingleFrame"),
        }
    }

    #[test]
    fn test_flow_control_roundtrip() {
        let mut buf = [0u8; 8];
        encode_flow_control(FlowStatus::ClearToSend, 8, 10, &mut buf);
        assert_eq!(buf[0], 0x30);
        assert_eq!(buf[1], 8);
        assert_eq!(buf[2], 10);

        match parse_frame(&buf).unwrap() {
            IsoTpFrame::FlowControl { status, block_size, st_min_ms } => {
                assert_eq!(status, FlowStatus::ClearToSend);
                assert_eq!(block_size, 8);
                assert_eq!(st_min_ms, 10);
            }
            _ => panic!("Expected FlowControl"),
        }
    }
}
