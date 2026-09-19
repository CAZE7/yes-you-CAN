{-# LANGUAGE LambdaCase #-}

{- |
Module      : IsoTpTranscript
Description : The reference interpretation of the conformance vectors — receiver
              and sender transcripts in the canonical vocabulary of ADR 0044,
              using the states of "IsoTpStateMachine" as their vocabulary.
Copyright   : (c) yes-you-CAN Diagnostic Platform, 2026
License     : MIT

The state machine in "IsoTpStateMachine" defines the states, PDU types and the
step functions. This module adds exactly one thing: the /transcript runner/
that turns a vector file's frame events into the canonical result the
TypeScript runner must reproduce — delivery, emitted frames, counters. Base
only (ADR 0002/0044). The modelled domain is the classic-CAN subset the vector
file names: normal addressing, no padding, no CAN FD escape frames, no
wall-clock pacing — timeouts are /events/ in a transcript, never durations.
-}
module IsoTpTranscript
  ( TranscriptResult(..)
  , finalizeResult
  , runReceiverVector
  , runSenderVector
  ) where

import Data.List (foldl')
import Data.Maybe (fromMaybe)
import Json (JValue (..), asArray, asBool, asInt, lookupKey)

-- | The timing and flow-control knobs a vector may override. The defaults are
-- the ones documented in the vector file — the same numbers the TypeScript
-- runner starts from.
data Cfg = Cfg
  { cNbs :: Int
  , cNcr :: Int
  , cWftMax :: Int
  , cMaxRetries :: Int
  , cBlockSize :: Int
  , cStMin :: Int
  }

defaultCfg :: Cfg
defaultCfg = Cfg {cNbs = 60, cNcr = 60, cWftMax = 8, cMaxRetries = 0, cBlockSize = 0, cStMin = 0}

configOf :: Maybe JValue -> Cfg
configOf Nothing = defaultCfg
configOf (Just json) =
  let pick key fallback = fromMaybe fallback (lookupKey key json >>= asInt)
   in Cfg
        { cNbs = pick "nBsMs" (cNbs defaultCfg)
        , cNcr = pick "nCrMs" (cNcr defaultCfg)
        , cWftMax = pick "wftMax" (cWftMax defaultCfg)
        , cMaxRetries = pick "maxRetries" (cMaxRetries defaultCfg)
        , cBlockSize = pick "blockSize" (cBlockSize defaultCfg)
        , cStMin = pick "stMinMs" (cStMin defaultCfg)
        }

-- | The comparable result — the same schema the TypeScript runner emits.
data TranscriptResult = TranscriptResult
  { trDelivered :: Maybe [Int]
  , trError :: Maybe String
  , trSent :: [[Int]]
  , trSeqErrors :: Int
  , trTimeouts :: Int
  , trRetries :: Int
  }

freshResult :: TranscriptResult
freshResult = TranscriptResult Nothing Nothing [] 0 0 0

-- | Render the result for the driver. Emitted frames go through the canonical
-- decoder; a frame that does not decode is a model failure, not a deviation
-- to compare.
finalizeResult :: TranscriptResult -> Either String JValue
finalizeResult r = do
  frames <- mapM decodeSent (trSent r)
  pure $
    JObj
      [ ("delivered", maybe JNull jbytes (trDelivered r))
      , ("error", maybe JNull JStr (trError r))
      , ("sentFrames", JArr frames)
      ,
        ( "counters"
        , JObj
            [ ("sequenceErrors", jint (trSeqErrors r))
            , ("timeouts", jint (trTimeouts r))
            , ("retries", jint (trRetries r))
            ]
        )
      ]
  where
    jbytes = JArr . map (JNum . fromIntegral)
    jint = JNum . fromIntegral

decodeSent :: [Int] -> Either String JValue
decodeSent [] = Left "sent frame without PCI"
decodeSent (pci : body) = case pci `div` 16 of
  0 ->
    let declared = pci `mod` 16
     in if declared < 1 || declared > 7 || length body < declared
          then Left ("sent malformed single frame: " ++ show (pci : body))
          else Right (JObj [("pci", JStr "single"), ("payload", jbytes (take declared body))])
  1 ->
    let firstByte = case body of { (b : _) -> b; [] -> 0 }
        total = (pci `mod` 16) * 256 + firstByte
     in if total < 8 || total > 4095
          then Left ("sent first frame with impossible FF_DL: " ++ show total)
          else Right (JObj [("pci", JStr "first"), ("totalLength", jint total), ("payload", jbytes (drop 1 body))])
  2 ->
    if null body
      then Left "sent consecutive frame without payload"
      else Right (JObj [("pci", JStr "consecutive"), ("sn", jint (pci `mod` 16)), ("payload", jbytes body)])
  3 ->
    let status = pci `mod` 16
        bs = case body of { (_ : x : _) -> x; _ -> 0 }
        st = case body of { (_ : _ : x : _) -> x; _ -> 0 }
     in if status > 2
          then Left ("sent flow control with unknown status: " ++ show status)
          else Right (JObj [("pci", JStr "flow-control"), ("status", jint status), ("blockSize", jint bs), ("stMin", jint st)])
  other -> Left ("sent frame with unknown PCI type: " ++ show other)
  where
    jbytes = JArr . map (JNum . fromIntegral)
    jint = JNum . fromIntegral

note :: String -> Maybe a -> Either String a
note msg = maybe (Left msg) Right

bytesOf :: JValue -> Either String [Int]
bytesOf raw = case asArray raw of
  Nothing -> Left "frame must be an array of byte numbers"
  Just items -> mapM byteOf items
  where
    byteOf (JNum n)
      | n >= 0 && n <= 255 && n == fromIntegral (truncate n :: Integer) = Right (truncate n)
    byteOf _ = Left "byte out of range"

-- | A payload is either the array in `payload` or the materialised form
-- `payloadLength` (n copies of 0x5A — the canonical fill both readers apply).
payloadOf :: JValue -> Either String [Int]
payloadOf vector = case lookupKey "payload" vector of
  Just raw -> bytesOf raw
  Nothing -> case lookupKey "payloadLength" vector of
    Just n -> do
      length' <- note "payloadLength must be an integer" (asInt n)
      if length' < 1 || length' > 8192
        then Left "payloadLength out of range"
        else Right (replicate length' 0x5A)
    Nothing -> Left "sender vector without payload"

-- ------------------------------------------------------------------ receiver

data RxEvent
  = Feed [Int]
  | TickMs Int
  | CheckCr

-- | A partial reception: expected bytes, chunks collected, the sequence
-- number the next frame must carry, frames since our last Flow Control, and
-- the model time of the last frame.
data Partial = Partial
  { pExpected :: Int
  , pChunks :: [[Int]]
  , pGot :: Int
  , pNextSn :: Int
  , pBlock :: Int
  , pLastAt :: Int
  }

runReceiverVector :: JValue -> Either String TranscriptResult
runReceiverVector vector = do
  eventsJson <- note "receiver vector without input array" (lookupKey "input" vector >>= asArray)
  events <- mapM decodeEvent eventsJson
  let cfg = configOf (lookupKey "config" vector)
  pure (stepAll cfg events)
  where
    stepAll cfg events =
      let (result, _, _) = foldl' (stepRx cfg) (freshResult, Nothing, 0) events
       in result
    decodeEvent event = case lookupKey "in" event of
      Just raw -> Feed <$> bytesOf raw
      Nothing -> case lookupKey "tickMs" event of
        Just n -> TickMs <$> note "tickMs must be an integer" (asInt n)
        Nothing -> case lookupKey "checkCr" event of
          Just (JBool True) -> Right CheckCr
          _ -> Left "input entry must name in, tickMs or checkCr"

stepRx :: Cfg -> (TranscriptResult, Maybe Partial, Int) -> RxEvent -> (TranscriptResult, Maybe Partial, Int)
stepRx cfg (res, pstate, now) event = case event of
  TickMs ms -> (res, pstate, now + ms)
  CheckCr -> case pstate of
    Nothing -> (res, Nothing, now)
    Just p
      | now - pLastAt p > cNcr cfg ->
          (res {trTimeouts = trTimeouts res + 1, trError = Just "timeout-nCr"}, Nothing, now)
      | otherwise -> (res, pstate, now)
  Feed frame -> feed cfg res pstate now frame

feed :: Cfg -> TranscriptResult -> Maybe Partial -> Int -> [Int] -> (TranscriptResult, Maybe Partial, Int)
feed cfg res pstate now frame = case frame of
  [] -> (res, pstate, now)
  (pci : body) -> case pci `div` 16 of
    -- Single Frame. The escape form (declared 0) is CAN FD only; a declared
    -- length the frame does not carry is a wire violation. Both are dropped,
    -- never delivered short (ISO 15765-2 §9.4).
    0 ->
      let declared = pci `mod` 16
       in if declared == 0 || 1 + declared > length frame
            then (res, pstate, now)
            else (res {trDelivered = Just (take declared body)}, Nothing, now)
    -- First Frame. FF_DL ≤ 7 claims a message a Single Frame would carry; the
    -- escape form does not exist on classic CAN. Both are refused.
    1 ->
      let firstByte = case body of { (b : _) -> b; [] -> 0 }
          ffDl = (pci `mod` 16) * 256 + firstByte
          accepted = ffDl > 7 && ffDl <= 4095
       in if not accepted
            then (res, pstate, now)
            else
              let p =
                    Partial
                      { pExpected = ffDl
                      , -- body[0] is the FF_DL low byte — PCI, not payload (the
                        -- escape form reads two header bytes exactly like the
                        -- transport's `handleFrame`).
                        pChunks = [drop 1 body]
                      , pGot = length body - 1
                      , pNextSn = 1
                      , pBlock = 0
                      , pLastAt = now
                      }
                  fc = [0x30, cBlockSize cfg, cStMin cfg]
               in (res {trSent = trSent res ++ [fc]}, Just p, now)
    -- Consecutive Frame. A lone CF counts as a sequence error; a wrong SN
    -- aborts the reception the same way — both match the transport's
    -- `handleFrame`. Chunks are clamped to the declared length: bytes beyond
    -- FF_DL are truncated, never appended.
    2 -> case pstate of
      Nothing -> (res {trSeqErrors = trSeqErrors res + 1}, Nothing, now)
      Just p ->
        let sn = pci `mod` 16
         in if sn /= pNextSn p
              then (res {trSeqErrors = trSeqErrors res + 1}, Nothing, now)
              else
                let remaining = pExpected p - pGot p
                    chunk = take remaining body
                    p' =
                      p
                        { pChunks = chunk : pChunks p
                        , pGot = pGot p + length chunk
                        , pNextSn = (sn + 1) `mod` 16
                        , pBlock = pBlock p + 1
                        , pLastAt = now
                        }
                 in if pGot p' >= pExpected p'
                      then
                        let payload = take (pExpected p') (concat (reverse (pChunks p')))
                         in (res {trDelivered = Just payload}, Nothing, now)
                      else
                        if cBlockSize cfg > 0 && pBlock p' >= cBlockSize cfg
                          then
                            ( res {trSent = trSent res ++ [[0x30, cBlockSize cfg, cStMin cfg]]}
                            , Just p' {pBlock = 0}
                            , now
                            )
                          else (res, Just p', now)
    -- Flow Control frames and unknown PCIs change nothing for a pure receiver.
    3 -> (res, pstate, now)
    _ -> (res, pstate, now)

-- -------------------------------------------------------------------- sender

-- | Peer answers, in file order, each scheduled after an emission count:
-- `after: n` means “fed right after our n-th frame (0-based) left the
-- connection”.
type Peer = [(Int, [Int])]

-- | The first peer entry, in order, that is due (its frame index has been
-- emitted) and matches. Consumed entries leave the list.
dueFrames :: ([Int] -> Bool) -> Int -> Peer -> (Maybe [Int], Peer)
dueFrames p sentCount = go []
  where
    go _ [] = (Nothing, [])
    go seen (e@(_, f) : rest)
      | fst e < sentCount && p f = (Just f, reverse seen ++ rest)
      | otherwise = go (e : seen) rest

isResponseFrame :: [Int] -> Bool
isResponseFrame (pci : _) = pci `div` 16 == 0 && pci `mod` 16 > 0
isResponseFrame [] = False

isFlowControlFrame :: [Int] -> Bool
isFlowControlFrame (pci : _) = pci `div` 16 == 3
isFlowControlFrame [] = False

-- | Decode a response Single Frame under the receiver's validation rules — an
-- invalid answer never reaches the application.
decodeSf :: [Int] -> Maybe [Int]
decodeSf frame@(pci : body)
  | pci `div` 16 == 0 && d >= 1 && 1 + d <= length frame = Just (take d body)
  where
    d = pci `mod` 16
decodeSf _ = Nothing

runSenderVector :: JValue -> Either String TranscriptResult
runSenderVector vector = do
  payload <- payloadOf vector
  peerJson <- note "peer must be an array" (maybe (Just (JArr [])) Just (lookupKey "peer" vector) >>= asArray)
  peer <- mapM peerEntry peerJson
  let cfg = configOf (lookupKey "config" vector)
      total = length payload
  pure $
    if null payload
      then freshResult {trError = Just "empty-payload"}
      else
        if total > 4095
          then freshResult {trError = Just "message-too-long"}
          else
            if total <= 7
              then sendSingle payload peer
              else sendSegmented cfg payload peer
  where
    peerEntry entry = case lookupKey "frame" entry of
      Nothing -> Left "peer entry without frame"
      Just raw -> do
        frame <- bytesOf raw
        after <- case lookupKey "after" entry of
          Nothing -> Right 0
          Just (JStr "immediate") -> Left "tx vectors must schedule peer frames after an emission (immediate is refused)"
          Just j -> note "after must be an integer" (asInt j)
        Right (after, frame)

sendSingle :: [Int] -> Peer -> TranscriptResult
sendSingle payload peer =
  let sf = length payload : payload
      res = freshResult {trSent = [sf]}
      (resp, _) = dueFrames isResponseFrame 1 peer
   in case resp >>= decodeSf of
        Just bytes -> res {trDelivered = Just bytes}
        Nothing -> res {trTimeouts = 1, trError = Just "timeout-response"}

-- | The full state of one segmented transmission. `sPeer` loses consumed
-- entries; `sResponse` records a Single Frame that became due mid-transmission
-- exactly when the production connection hands it to the waiting request.
data S = S
  { sRes :: TranscriptResult
  , sSent :: Int
  , sLeft :: [Int]
  , sSn :: Int
  , sBlockLeft :: Int
  , sBlock :: Int
  , sWaits :: Int
  , sRetries :: Int
  , sPeer :: Peer
  , sResponse :: Maybe [Int]
  }

sendSegmented :: Cfg -> [Int] -> Peer -> TranscriptResult
sendSegmented cfg payload peer =
  let total = length payload
      ffData = take 6 payload
      ffFrame = (0x10 + (total `div` 256)) : (total `mod` 256) : ffData
      s0 =
        S
          { sRes = freshResult {trSent = [ffFrame]}
          , sSent = 1
          , sLeft = drop 6 payload
          , sSn = 1
          , sBlockLeft = -1 -- no Flow Control granted yet
          , sBlock = 0
          , sWaits = 0
          , sRetries = 0
          , sPeer = peer
          , sResponse = Nothing
          }
   in awaitFc cfg payload s0

push :: [Int] -> S -> S
push f s = s {sRes = (sRes s) {trSent = trSent (sRes s) ++ [f]}, sSent = sSent s + 1}

-- | A Single Frame from the peer that has become due is handed to the waiting
-- request the moment it arrives — mid-transmission or after it, the production
-- connection resolves its pending slot either way and keeps segmenting.
captureResponse :: S -> S
captureResponse s = case sResponse s of
  Just _ -> s
  Nothing -> case dueFrames isResponseFrame (sSent s) (sPeer s) of
    (Just f, rest) -> case decodeSf f of
      Just bytes -> s {sResponse = Just bytes, sPeer = rest}
      Nothing -> s {sPeer = rest}
    (Nothing, _) -> s

awaitFc :: Cfg -> [Int] -> S -> TranscriptResult
awaitFc cfg payload s = case dueFrames isFlowControlFrame (sSent s1) (sPeer s1) of
  (Just frame@(pci : body), rest) ->
    let s2 = s1 {sPeer = rest}
     in case pci `mod` 16 of
          0 ->
            let bs = case body of { (x : _) -> x; _ -> 0 }
             in sendCf cfg payload s2 {sBlockLeft = bs, sBlock = bs}
          1 ->
            if sWaits s2 + 1 > cWftMax cfg
              then (sRes s2) {trTimeouts = trTimeouts (sRes s2) + 1, trError = Just "wftmax"}
              else awaitFc cfg payload (s2 {sWaits = sWaits s2 + 1})
          _ -> (sRes s2) {trError = Just "buffer-overflow"}
  (Nothing, _)
    | sRetries s1 < cMaxRetries cfg ->
        -- A retry restarts the transmission: the First Frame goes out again,
        -- the payload starts from the top, the wait budget resets. The peer
        -- schedule stays absolute in emissions of this vector run.
        let total = length payload
            ffData = take 6 payload
            ffFrame = (0x10 + (total `div` 256)) : (total `mod` 256) : ffData
         in awaitFc cfg payload $
              (push ffFrame s1)
                { sRes =
                    (sRes s1)
                      { trTimeouts = trTimeouts (sRes s1) + 1
                      }
                , sLeft = drop 6 payload
                , sSn = 1
                , sBlockLeft = -1
                , sBlock = 0
                , sWaits = 0
                , sRetries = sRetries s1 + 1
                }
    | otherwise -> (sRes s1) {trTimeouts = trTimeouts (sRes s1) + 1, trError = Just "timeout-nBs"}
  where
    -- No wait-budget reset here: the budget spans the whole transmission and the
    -- retry branch below installs its own fresh `sWaits = 0`. Resetting on every
    -- recursion made `wftMax` unreachable — the counter never climbed past 1.
    s1 = captureResponse s

sendCf :: Cfg -> [Int] -> S -> TranscriptResult
sendCf cfg payload s
  | null (sLeft s) = awaitResponse s
  | otherwise =
      let chunk = take 7 (sLeft s)
          cfFrame = (0x20 + sSn s) : chunk
          s1 = push cfFrame s
          s2 =
            s1
              { sLeft = drop 7 (sLeft s)
              , sSn = (sSn s + 1) `mod` 16
              , sBlockLeft = sBlockLeft s1 - 1
              }
          s3 = captureResponse s2
       in if null (sLeft s3)
            then awaitResponse s3
            else
              if sBlock s3 > 0 && sBlockLeft s3 <= 0
                then awaitFc cfg payload s3
                else sendCf cfg payload s3

awaitResponse :: S -> TranscriptResult
awaitResponse s = case sResponse s of
  Just bytes -> (sRes s) {trDelivered = Just bytes}
  Nothing -> case dueFrames isResponseFrame (sSent s) (sPeer s) of
    (Just frame, _) -> case decodeSf frame of
      Just bytes -> (sRes s) {trDelivered = Just bytes}
      Nothing -> (sRes s) {trTimeouts = trTimeouts (sRes s) + 1, trError = Just "timeout-response"}
    (Nothing, _) -> (sRes s) {trTimeouts = trTimeouts (sRes s) + 1, trError = Just "timeout-response"}
