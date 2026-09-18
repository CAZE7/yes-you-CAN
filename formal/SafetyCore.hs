{-# LANGUAGE GADTs #-}
{-# LANGUAGE DataKinds #-}
{-# LANGUAGE KindSignatures #-}
{-# LANGUAGE StandaloneDeriving #-}

{- |
Module      : SafetyCore
Description : Formal specification and invariant proofs for ECU write transactions.
Copyright   : (c) yes-you-CAN Diagnostic Platform, 2026
License     : MIT

This module specifies the write-safety state machine the platform implements:

  Prepared → Confirmed → Permitted → Executing → Verifying → Verified

Key Invariants:

  1. No write operation can reach the bus without an explicit Human
     Confirmation Token (AGENTS 34.11 — `userConfirmed` is a precondition, and
     `ConfirmationToken` is the type that carries it).
  2. No write can execute without a valid WritePermit within its non-expired
     time window (ADR 0028; 'beginExecution' refuses an expired permit).
  3. Every write must be read back and verified before being reported
     verified; a mismatch is never reported as a success (AGENTS 25).
  4. Any anomaly on a stage that must not run — an out-of-order transition, a
     missing precondition, a denied write — fails closed (ADR 0033: a missing
     proof blocks exactly like a violation).

Historical note (ADR 0044): the first sketch of this file required the engine
to stand still and the gear to be in P/N. The production contract
(`SafetyManager.evaluate`) instead requires the vehicle stationary, the
ignition on, a voltage at or above its floor, and — for medium/high risk — the
parking brake. The model now states the contract that ships; the vector harness
in "SafetyTranscript" grades both models against each other, so a future
divergence is a red build, not a stale comment.
-}

module SafetyCore where

import Data.Word (Word64, Word8)

-- | Formal ECU Address identifier (e.g., 0x07E0 for Engine ECU).
type EcuAddress = Word64

-- | Data Identifier (UDS DID 0x0000 - 0xFFFF).
type DataId = Word64

-- | Vehicle conditions the safety chain reads, in the vocabulary of the
-- production contract. `Nothing` means “never measured” — and by ADR 0033
-- that is a blocker, not a pass.
data VehicleConditions = VehicleConditions
  { vStationary :: Bool
  , vIgnitionOn :: Maybe Bool
  , vBatteryVoltage :: Maybe Double
  , vParkingBrake :: Maybe Bool
  } deriving (Eq, Show)

-- | A blocking reason: a proven violation, or a missing proof. Both block.
data SafetyFail
  = Violated String
  | Unproven String
  deriving (Eq, Show)

-- | Battery floor of the standard configuration (the production default,
-- `DEFAULT_MIN_BATTERY_VOLTAGE`). Vectors may set their own floor; this is
-- the constant the specification names.
defaultMinBatteryVoltage :: Double
defaultMinBatteryVoltage = 12.0

-- | The rule table as data: one list of blockers, exactly the shape
-- 'SafetyTranscript.checkSafety' interprets for the conformance vectors and
-- `SafetyManager.evaluate` produces in production.
precheckBlockers :: Double -> VehicleConditions -> Bool -> [SafetyFail]
precheckBlockers floorV conds brakeRequired = concat
  [ [Violated "vehicle is not stationary" | not (vStationary conds)]
  , case vBatteryVoltage conds of
      Nothing -> [Unproven "battery voltage unknown — cannot prove the supply is stable"]
      Just v -> [Violated ("battery voltage below the required " ++ show floorV ++ " V") | v < floorV]
  , case vIgnitionOn conds of
      Nothing -> [Unproven "ignition state unknown — cannot prove the ignition is on"]
      Just False -> [Violated "ignition is off"]
      Just True -> []
  , if brakeRequired
      then case vParkingBrake conds of
        Nothing -> [Unproven "parking brake state unknown — cannot prove the vehicle is held"]
        Just False -> [Violated "parking brake not engaged"]
        Just True -> []
      else []
  ]

-- | The one-line answer the stage machine consumes: permitted means “no
-- blocker, proven or unproven”.
precheckPermitted :: Double -> VehicleConditions -> Bool -> Either String ()
precheckPermitted floorV conds brakeRequired =
  case precheckBlockers floorV conds brakeRequired of
    [] -> Right ()
    (f : _) -> Left (reasonOf f)
  where
    reasonOf (Violated r) = r
    reasonOf (Unproven r) = r

-- | Nonce token generated upon explicit user confirmation.
newtype ConfirmationToken = ConfirmationToken String
  deriving (Eq, Show)

-- | Bounded write permit: issued only from a confirmed transaction with a
-- token, and only valid inside its window.
data WritePermit = WritePermit
  { permitToken :: !ConfirmationToken
  , permitEcu :: !EcuAddress
  , permitDid :: !DataId
  , issuedAtMillis :: !Word64
  , expiresAtMillis :: !Word64
  } deriving (Eq, Show)

-- | Check whether a permit is valid at a timestamp. The lower bound makes the
-- model stricter than the production check (which only refuses expiry, since
-- it issues the permit itself); no vector can distinguish the two because no
-- production caller can hand a back-dated permit to the check (ADR 0044).
isPermitValid :: WritePermit -> Word64 -> Bool
isPermitValid permit now =
  now >= issuedAtMillis permit && now < expiresAtMillis permit

-- | The stages of a write transaction, as type-level tags.
data TransactionStage
  = SPrepared
  | SConfirmed
  | SPermitted
  | SExecuting
  | SVerifying
  | SVerified
  | SAborted

-- | Write transaction with the state encoded in its type (typestate). The
-- GADT makes illegal states unrepresentable: a value of type
-- @WriteTransaction 'SExecuting@ only exists if it passed through a granted
-- 'WritePermit', and 'Verified' only exists around matching read-back bytes.
data WriteTransaction (s :: TransactionStage) where
  Prepared ::
    { txId :: !String
    , txEcu :: !EcuAddress
    , txDid :: !DataId
    , txPayload :: ![Word8]
    , txPrechecked :: !Bool
    } -> WriteTransaction 'SPrepared

  Confirmed ::
    { confirmedTx :: !(WriteTransaction 'SPrepared)
    , userToken :: !ConfirmationToken
    , confirmedAt :: !Word64
    } -> WriteTransaction 'SConfirmed

  Permitted ::
    { permittedTx :: !(WriteTransaction 'SConfirmed)
    , safetyPermit :: !WritePermit
    } -> WriteTransaction 'SPermitted

  Executing ::
    { executingTx :: !(WriteTransaction 'SPermitted)
    , startedAt :: !Word64
    } -> WriteTransaction 'SExecuting

  Verifying ::
    { verifyingTx :: !(WriteTransaction 'SExecuting)
    , writtenBytes :: ![Word8]
    } -> WriteTransaction 'SVerifying

  Verified ::
    { verifiedTx :: !(WriteTransaction 'SVerifying)
    , readbackBytes :: ![Word8]
    , completedAt :: !Word64
    } -> WriteTransaction 'SVerified

  Aborted ::
    { failedStage :: !String
    , abortReason :: !String
    , rolledBack :: !Bool
    } -> WriteTransaction 'SAborted

deriving instance Show (WriteTransaction s)

-- | Step 1: a user token confirms a transaction whose precheck passed.
confirmTransaction ::
  WriteTransaction 'SPrepared -> ConfirmationToken -> Word64 -> Either String (WriteTransaction 'SConfirmed)
confirmTransaction tx token now
  | not (txPrechecked tx) = Left "Cannot confirm transaction before precheck passes"
  | otherwise = Right (Confirmed tx token now)

-- | Step 2: grant the permit under valid vehicle conditions. The validity
-- window starts at grant time; 'beginExecution' re-checks it.
grantPermit ::
  WriteTransaction 'SConfirmed
  -> Double
  -> VehicleConditions
  -> Bool
  -> Word64
  -> Word64
  -> Either String (WriteTransaction 'SPermitted)
grantPermit ctx@(Confirmed pTx _ _) floorV conds brakeRequired now validityDuration = do
  precheckPermitted floorV conds brakeRequired
  let permit =
        WritePermit
          { permitToken = userToken ctx
          , permitEcu = txEcu pTx
          , permitDid = txDid pTx
          , issuedAtMillis = now
          , expiresAtMillis = now + validityDuration
          }
  Right (Permitted ctx permit)

-- | Step 3: begin execution with a still-valid permit — the guard that makes
-- “Executing is never reachable without a permit” a type-level fact.
beginExecution :: WriteTransaction 'SPermitted -> Word64 -> Either String (WriteTransaction 'SExecuting)
beginExecution p@(Permitted _ permit) now
  | not (isPermitValid permit now) = Left "Write permit expired or not yet valid"
  | otherwise = Right (Executing p now)

-- | Step 4: the physical write completed; verification is owed.
finishWrite :: WriteTransaction 'SExecuting -> [Word8] -> WriteTransaction 'SVerifying
finishWrite exec payload = Verifying exec payload

-- | Step 5: read-back invariant. Equal bytes verify; anything else is an
-- aborted transaction with the rollback verdict recorded. (What the /caller/
-- does with a failed verification — retry, abort, roll back — is the port’s
-- policy, modelled and vector-tested in "SafetyTranscript"; the typestate here
-- states that the failure can never read as a success.)
verifyReadback ::
  WriteTransaction 'SVerifying -> [Word8] -> Word64 -> Either (WriteTransaction 'SAborted) (WriteTransaction 'SVerified)
verifyReadback v@(Verifying _ expected) actual now
  | expected == actual = Right (Verified v actual now)
  | otherwise = Left (Aborted "Verifying" "Readback mismatch with expected data" True)
