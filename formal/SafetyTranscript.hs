{-# LANGUAGE LambdaCase #-}

{- |
Module      : SafetyTranscript
Description : The reference interpretation of the write-safety conformance
              vectors (ADR 0044): the rule table, the staged WritePort flow,
              and the raw stage-order table of the transaction.
Copyright   : (c) yes-you-CAN Diagnostic Platform, 2026
License     : MIT

This module models the /production contract/ — the same three families the
TypeScript harness runs against the real classes:

* precheck: `SafetyManager.evaluate` as a rule table. Every blocking reason
  counts as failed; a missing proof counts as failed and unproven
  (fail-closed, ADR 0033). The comparison counts reasons instead of quoting
  them, so the two models may reword while they keep agreeing — and the
  harness separately asserts that unproven stays a subset of failed.
* flow: `WritePort.run` — prepare fails closed before the permit, a refused
  permit aborts, a failed write follows the rollback policy, a verification
  failure leaves the write executed-but-unverified (the caller decides what
  comes after), and the bus is reached only after the permit re-check.
* stages: `DiagnosticTransaction.stage` — the order table, the permit guard on
  execute, and terminal states that never move again.

The GADT typestate in "SafetyCore" remains the machine-checked statement of
the invariant “no Executing without a valid, non-expired permit”. This module
adds the interpretation of the vector grammar. Base only (ADR 0002).
-}
module SafetyTranscript
  ( SafetyOutcome(..)
  , outcomeJson
  , runSafetyVector
  , fileDefaultMinVoltage
  ) where

import Data.Maybe (fromMaybe)
import Json (JValue (..), asArray, asBool, asInt, asNumber, asString, lookupKey)

data SafetyOutcome
  = Precheck Bool Int Int -- granted, failed, unproven
  | Flow Bool String Bool Bool Bool Int Int -- ok, state, writeReached, verified, rolledBack, failed, unproven
  | Stages String [Bool]

outcomeJson :: SafetyOutcome -> JValue
outcomeJson = \case
  Precheck g f u ->
    JObj
      [ ("kind", JStr "precheck")
      , ("granted", JBool g)
      , ("failed", jint f)
      , ("unproven", jint u)
      ]
  Flow ok state reached verified rolled failed unproven ->
    JObj
      [ ("kind", JStr "flow")
      , ("ok", JBool ok)
      , ("state", JStr state)
      , ("writeReached", JBool reached)
      , ("verified", JBool verified)
      , ("rolledBack", JBool rolled)
      , ("failed", jint failed)
      , ("unproven", jint unproven)
      ]
  Stages state oks ->
    JObj
      [ ("kind", JStr "stages")
      , ("state", JStr state)
      , ("stageOk", JArr (map JBool oks))
      ]
  where
    jint = JNum . fromIntegral

-- ------------------------------------------------------------------ precheck

-- | Everything `SafetyManager.evaluate` sees. The vector file names every
-- field; `null` means “never reported”.
data Ctx = Ctx
  { cxRisk :: String
  , cxUserConfirmed :: Bool
  , cxBackup :: Bool
  , cxSessionType :: Int
  , cxDefinitionVersion :: Maybe String
  , cxExpectedType :: Maybe String
  , cxActualType :: Maybe String
  , cxExpectedVariant :: Maybe String
  , cxActualVariant :: Maybe String
  , cxNetwork :: Maybe (Maybe Bool, Maybe Bool, Bool)
  }

data Veh = Veh
  { vhStationary :: Bool
  , vhIgnition :: Maybe Bool
  , vhVoltage :: Maybe Double
  , vhBrake :: Maybe Bool
  }

-- | One blocking reason: a proven violation, or a missing proof.
data Fail = Violated | Unproven

checkSafety :: Double -> Ctx -> Veh -> [Fail]
checkSafety minV cx vh = concat [vehicleRules, identityRules, writeRules, networkRules]
  where
    vehicleRules =
      [Violated | not (vhStationary vh)]
        ++ ( case vhVoltage vh of
               Nothing -> [Unproven]
               Just v -> [Violated | v < minV]
           )
        ++ ( case vhIgnition vh of
               Nothing -> [Unproven]
               Just False -> [Violated]
               Just True -> []
           )
        ++ ( if cxRisk cx /= "low"
               then case vhBrake vh of
                 Nothing -> [Unproven]
                 Just False -> [Violated]
                 Just True -> []
               else []
           )
    identityRules =
      rulePair (cxExpectedType cx) (cxActualType cx)
        ++ rulePair (cxExpectedVariant cx) (cxActualVariant cx)
    rulePair Nothing _ = []
    rulePair (Just _) Nothing = [Unproven]
    rulePair (Just e) (Just a) = [Violated | e /= a]
    writeRules =
      [Violated | maybe True null (cxDefinitionVersion cx)]
        ++ [Violated | not (cxBackup cx)]
        ++ [Violated | not (cxUserConfirmed cx)]
        ++ [Violated | cxSessionType cx == 1]
    networkRules = case cxNetwork cx of
      Nothing -> []
      Just (tls, routing, unauthorized) ->
        ( case tls of
            Nothing -> [Unproven]
            Just False -> [Violated]
            Just True -> []
        )
          ++ ( case routing of
                 Nothing -> [Unproven]
                 Just False -> [Violated]
                 Just True -> []
             )
          ++ [Violated | unauthorized]

counted :: [Fail] -> (Bool, Int, Int)
counted fails = (null fails, length fails, length (filter isUnproven fails))
  where
    isUnproven Unproven = True
    isUnproven Violated = False

-- ---------------------------------------------------------------- flow (port)

data Script = Script
  { scPrepareOk :: Bool
  , scExecuteOk :: Bool
  , scWriteBeforeFail :: Bool
  , scVerify :: String
  , scRollback :: String
  , scPermitExpired :: Bool
  }

-- | The staged flow of `WritePort.run` with the scripted operation. Reason
-- counts follow the port exactly: the failure reasons of the stage that
-- denied the write (deduplicated to one there), the precheck list at confirm.
runFlow :: Double -> Ctx -> Veh -> Script -> SafetyOutcome
runFlow minV cx vh sc
  | not (scPrepareOk sc) = Flow False "aborted" False False False 1 0
  | not granted = Flow False "aborted" False False False (length fails) unprovenCount
  | scPermitExpired sc = deniedAtExecute
  | not (scExecuteOk sc) = deniedAtExecute
  | otherwise = case scVerify sc of
      "match" -> Flow True "verified" True True False 0 0
      "mismatch" -> Flow False "executed" True False False 1 0
      _ -> Flow True "executed" True False False 0 0
  where
    (granted, _, unprovenCount) = counted fails
    fails = checkSafety minV cx vh
    deniedAtExecute = case scRollback sc of
      "ok" -> Flow False "rolled-back" (scWriteBeforeFail sc) False True 1 0
      "fail" -> Flow False "aborted" (scWriteBeforeFail sc) False False 1 0
      _ -> Flow False "aborted" (scWriteBeforeFail sc) False False 1 0

-- ---------------------------------------------------------------- stages (tx)

-- | The order table of `DiagnosticTransaction.stage`. Three guards, in the
-- production order: a terminal transaction reports every stage as refused and
-- never moves; an out-of-order stage fails and aborts (fail-closed); and
-- `execute` without an attached permit fails and aborts. A stage whose body
-- reports failure does not move the state by itself — that is the port's
-- policy (above), not the transaction's.
runStages :: [(String, Bool, Bool)] -> SafetyOutcome
runStages ops = go "open" False [] ops
  where
    go state _permit oks [] = Stages state (reverse oks)
    go state permit oks ((name, bodyOk, grant) : rest) =
      let attached = permit || grant
       in if isTerminal state
            then go state attached (False : oks) rest
            else
              if not (allowedFrom name state)
                then go "aborted" attached (False : oks) rest
                else
                  if name == "execute" && not attached
                    then go "aborted" attached (False : oks) rest
                    else
                      if not bodyOk
                        then go state attached (False : oks) rest
                        else go (nextState name) attached (True : oks) rest
    allowedFrom name st = case name of
      "prepare" -> st == "open"
      "confirm" -> st == "prepared"
      "execute" -> st == "confirmed" || st == "suspended"
      "verify" -> st == "executed" || st == "suspended"
      "rollback" -> st == "confirmed" || st == "executed" || st == "suspended"
      _ -> False
    nextState = \case
      "prepare" -> "prepared"
      "confirm" -> "confirmed"
      "execute" -> "executed"
      "verify" -> "verified"
      "rollback" -> "rolled-back"
      _ -> "aborted"
    isTerminal s = s `elem` ["verified", "aborted", "rolled-back"]

-- ------------------------------------------------------------------ vectors

fileDefaultMinVoltage :: JValue -> Double
fileDefaultMinVoltage file = case lookupKey "config" file >>= asObjectOf of
  Nothing -> 12.0
  Just entries -> fromMaybe 12.0 (lookup "minBatteryVoltage" entries >>= asNumber)
  where
    asObjectOf (JObj es) = Just es
    asObjectOf _ = Nothing

-- | Interpret one safety vector with the file's default minimum voltage and
-- the flow's binding session type. The driver checked the family earlier;
-- unknown families are still a hard error, never a silent pass.
runSafetyVector :: Double -> JValue -> Either String JValue
runSafetyVector defaultMin vector = do
  family <- note "family missing" (lookupKey "family" vector >>= asString)
  minV <- minVoltageOf vector
  case family of
    "precheck" -> do
      cx <- contextOf Nothing vector -- precheck must state the session itself
      vx <- vehicleOf vector
      let (g, f, u) = counted (checkSafety minV cx vx)
      pure (outcomeJson (Precheck g f u))
    "flow" -> do
      session <- note "bindingSessionType missing" (lookupKey "bindingSessionType" vector >>= asInt)
      cx <- contextOf (Just session) vector
      vx <- vehicleOf vector
      sc <- scriptOf vector
      pure (outcomeJson (runFlow minV cx vx sc))
    "stages" -> do
      ops <- opsOf vector
      pure (outcomeJson (runStages ops))
    other -> Left ("unknown safety family: " ++ other)
  where
    minVoltageOf vector' = case lookupKey "minBatteryVoltage" vector' of
      Nothing -> Right defaultMin
      Just JNull -> Right defaultMin
      Just j -> note "minBatteryVoltage must be a number" (asNumber j)

note :: String -> Maybe a -> Either String a
note msg = maybe (Left msg) Right

contextOf :: Maybe Int -> JValue -> Either String Ctx
contextOf defaultSession vector = case lookupKey "context" vector of
  Nothing -> Left "context missing"
  Just ctxJson -> case asObjectOf ctxJson of
    Nothing -> Left "context must be an object"
    Just raw -> do
      let find k = lookup k raw
      risk <- note "context.risk missing" (find "risk" >>= asString)
      userConfirmed <- note "context.userConfirmed missing" (find "userConfirmed" >>= asBool)
      backup <- note "context.backupAvailable missing" (find "backupAvailable" >>= asBool)
      sessionType <- case find "sessionType" of
        Nothing -> case defaultSession of
          Just s -> Right s
          Nothing -> Left "context.sessionType must be stated in a precheck vector"
        Just j -> note "context.sessionType must be an integer" (asInt j)
      definitionVersion <- case find "definitionVersion" of
        Nothing -> Left "context.definitionVersion must be named (null for “absent”)"
        Just JNull -> Right Nothing
        Just j -> note "context.definitionVersion must be a string or null" (asString j)
      let network = case find "network" of
            Nothing -> Nothing
            Just net -> case asObjectOf net of
              Nothing -> Nothing
              Just entries ->
                Just
                  ( nullableBool (lookup "tls" entries)
                  , nullableBool (lookup "routing" entries)
                  , fromMaybe False (lookup "unauthorized" entries >>= asBool)
                  )
      pure
        Ctx
          { cxRisk = risk
          , cxUserConfirmed = userConfirmed
          , cxBackup = backup
          , cxSessionType = sessionType
          , cxDefinitionVersion = definitionVersion
          , cxExpectedType = nullableStr (find "expectedEcuType")
          , cxActualType = nullableStr (find "actualEcuType")
          , cxExpectedVariant = nullableStr (find "expectedSoftwareVariant")
          , cxActualVariant = nullableStr (find "actualSoftwareVariant")
          , cxNetwork = network
          }
  where
    nullableStr v = case v of
      Nothing -> Nothing
      Just JNull -> Nothing
      Just j -> asString j
    nullableBool v = case v of
      Nothing -> Nothing
      Just JNull -> Nothing
      Just j -> asBool j

-- | The vehicle state. Every field must be *named* — an absent key would
-- otherwise read as “never measured” and turn a typo into a fail-closed
-- result; `null` is the statement that it was not measured.
vehicleOf :: JValue -> Either String Veh
vehicleOf vector = case lookupKey "vehicle" vector of
  Nothing -> Left "vehicle missing"
  Just v -> case asObjectOf v of
    Nothing -> Left "vehicle must be an object"
    Just raw -> do
      let find k = lookup k raw
      stationary <- note "vehicle.stationary missing" (find "stationary" >>= asBool)
      ignition <- case find "ignitionOn" of
        Nothing -> Left "vehicle.ignitionOn must be named"
        Just JNull -> Right Nothing
        Just j -> note "vehicle.ignitionOn must be a bool or null" (asBool j)
      voltage <- case find "batteryVoltage" of
        Nothing -> Left "vehicle.batteryVoltage must be named"
        Just JNull -> Right Nothing
        Just j -> note "vehicle.batteryVoltage must be a number or null" (asNumber j)
      brake <- case find "parkingBrake" of
        Nothing -> Left "vehicle.parkingBrake must be named"
        Just JNull -> Right Nothing
        Just j -> note "vehicle.parkingBrake must be a bool or null" (asBool j)
      pure (Veh stationary ignition voltage brake)
  where
    asObjectOf (JObj entries) = Just entries
    asObjectOf _ = Nothing

scriptOf :: JValue -> Either String Script
scriptOf vector = do
  expiry <- note "permitExpiry missing" (lookupKey "permitExpiry" vector >>= asString)
  case lookupKey "script" vector of
    Nothing -> Left "script missing"
    Just s -> case asObjectOf s of
      Nothing -> Left "script must be an object"
      Just raw -> do
        let find k = lookup k raw
        prepareOk <- note "script.prepareOk missing" (find "prepareOk" >>= asBool)
        executeOk <- note "script.executeOk missing" (find "executeOk" >>= asBool)
        verify <- note "script.verify missing" (find "verify" >>= asString)
        rollback <- note "script.rollback missing" (find "rollback" >>= asString)
        let writeBeforeFail = fromMaybe False (find "writeBeforeFail" >>= asBool)
        pure (Script prepareOk executeOk writeBeforeFail verify rollback (expiry == "expired"))
  where
    asObjectOf (JObj entries) = Just entries
    asObjectOf _ = Nothing

opsOf :: JValue -> Either String [(String, Bool, Bool)]
opsOf vector = do
  list <- note "ops missing" (lookupKey "ops" vector >>= asArray)
  mapM opOf list
  where
    opOf entry = case entry of
      JObj entries -> do
        name <- note "op.op missing" (lookup "op" entries >>= asString)
        let bodyOk = fromMaybe True (lookup "bodyOk" entries >>= asBool)
            grant = fromMaybe False (lookup "grant" entries >>= asBool)
        pure (name, bodyOk, grant)
      _ -> Left "op must be an object"
