{- |
Module      : IsoTpStateMachine
Description : Formal Mealy/Moore State Machine for ISO 15765-2 (ISO-TP) Network Layer.
Copyright   : (c) yes-you-CAN Diagnostic Platform, 2026
License     : MIT

Formally models the ISO-TP multi-frame segmentation, flow control, and pacing protocol.
-}

module IsoTpStateMachine where

import Data.Word (Word8, Word16, Word32)

-- | ISO-TP Protocol Data Unit (PDU) Frame Types (ISO 15765-2: 6.5).
data PduType
  = SingleFrame       !Word8            -- ^ Length <= 7 (Standard CAN) or <= 63 (CAN FD)
  | FirstFrame        !Word16           -- ^ Total payload length
  | ConsecutiveFrame  !Word8            -- ^ Sequence number (0..15 modulo 16)
  | FlowControl       !FlowStatus !Word8 !Word8 -- ^ FS (0=CTS, 1=WT, 2=OVFLW), BlockSize (BS), STmin
  deriving (Eq, Show)

data FlowStatus
  = CTS       -- ^ Clear to Send
  | Wait      -- ^ Wait (receiver temporarily busy)
  | Overflow  -- ^ Buffer Overflow / abort
  deriving (Eq, Show)

-- | Transmitter State.
data TxState
  = TxIdle
  | TxSendingSingleFrame
  | TxWaitingFlowControl
      { txTotalLength  :: !Word16
      , txBytesSent    :: !Word16
      , txSequenceNum  :: !Word8
      , txBlockCount   :: !Word8
      , txBlockSize    :: !Word8
      , txStMinMs      :: !Word8
      }
  | TxSendingConsecutiveFrames
      { txTotalLength  :: !Word16
      , txBytesSent    :: !Word16
      , txSequenceNum  :: !Word8
      , txBlockCount   :: !Word8
      , txBlockSize    :: !Word8
      , txStMinMs      :: !Word8
      }
  | TxDone
  | TxFailed !String
  deriving (Eq, Show)

-- | Receiver State.
data RxState
  = RxIdle
  | RxReceiving
      { rxTotalLength  :: !Word16
      , rxBytesReceived:: !Word16
      , rxExpectedSeq  :: !Word8
      , rxBlockSize    :: !Word8
      , rxBlockCount   :: !Word8
      }
  | RxComplete ![Word8]
  | RxFailed !String
  deriving (Eq, Show)

-- | Invariant: Single frame maximum size check.
isValidSingleFrameLength :: Word16 -> Bool
isValidSingleFrameLength len = len > 0 && len <= 7

-- | Invariant: Sequence number progression modulo 16.
nextSequenceNumber :: Word8 -> Word8
nextSequenceNumber seqNum = (seqNum + 1) `mod` 16

-- | ISO-TP Transmitter step function.
stepTransmitter :: TxState -> Maybe PduType -> Either String (TxState, Maybe PduType)
stepTransmitter TxIdle input = case input of
  Just (SingleFrame len)
    | isValidSingleFrameLength (fromIntegral len) ->
        Right (TxDone, Just (SingleFrame len))
    | otherwise ->
        Left "Invalid single frame length"
  Just (FirstFrame len)
    | len > 7 ->
        Right (TxWaitingFlowControl len 6 1 0 0 0, Just (FirstFrame len))
    | otherwise ->
        Left "FirstFrame length must exceed SingleFrame capacity (>7 bytes)"
  _ -> Right (TxIdle, Nothing)

stepTransmitter (TxWaitingFlowControl total sent seqNum _ _ _) (Just (FlowControl status bs stmin)) =
  case status of
    CTS ->
      Right (TxSendingConsecutiveFrames total sent seqNum 0 bs stmin, Nothing)
    Wait ->
      Right (TxWaitingFlowControl total sent seqNum 0 bs stmin, Nothing)
    Overflow ->
      Left "Receiver signaled FlowControl OVERFLOW"

stepTransmitter (TxSendingConsecutiveFrames total sent seqNum count bs stmin) _
  | sent >= total = Right (TxDone, Nothing)
  | bs > 0 && count >= bs =
      -- Block size reached, must wait for next Flow Control frame
      Right (TxWaitingFlowControl total sent seqNum 0 bs stmin, Nothing)
  | otherwise =
      let remaining = total - sent
          chunkSize = min 7 remaining
          nextSent = sent + chunkSize
          nextSeq = nextSequenceNumber seqNum
          nextCount = count + 1
          nextState = if nextSent >= total
                        then TxDone
                        else TxSendingConsecutiveFrames total nextSent nextSeq nextCount bs stmin
      in Right (nextState, Just (ConsecutiveFrame seqNum))

stepTransmitter other _ = Right (other, Nothing)
