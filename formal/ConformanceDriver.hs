{- |
Module      : ConformanceDriver
Description : Reads a shared test-vector file and emits one JSON line per
              vector — the Haskell reference's answer, in the canonical
              vocabulary both sides of ADR 0044 compare.
Copyright   : (c) yes-you-CAN Diagnostic Platform, 2026
License     : MIT

Usage:

> runghc formal/ConformanceDriver.hs isotp tools/formal-conformance/vectors/isotp.json
> runghc formal/ConformanceDriver.hs safety tools/formal-conformance/vectors/safety.json

Output: JSONL — `{"name": "...", "result": {…}}` per vector; a vector the
model cannot interpret becomes `{"name": "...", "error": "..."}` (never a
silent omission: a missing line is the difference between “refused” and
“nobody looked”). Exit code 2 means the /file/ could not be read as a vector
file at all, so the caller can tell a broken set from one broken vector.
Base only (ADR 0002) — this driver never links an implementation; it runs the
formal models in "IsoTpTranscript" and "SafetyTranscript".
-}
module Main (main) where

import Control.Exception (SomeException, try)
import IsoTpTranscript (finalizeResult, runReceiverVector, runSenderVector)
import Json
  ( JValue (..),
    asArray,
    asString,
    lookupKey,
    parseJson,
    renderJson,
  )
import SafetyTranscript (fileDefaultMinVoltage, runSafetyVector)
import System.Environment (getArgs)
import System.Exit (exitWith, ExitCode (..))
import System.IO (hPutStrLn, stderr)

main :: IO ()
main = do
  args <- getArgs
  case args of
    [set, path] | set `elem` ["isotp", "safety"] -> do
      readResult <- try (readFile path) :: IO (Either SomeException String)
      case readResult of
        Left err -> failWith ("cannot read " ++ path ++ ": " ++ show err)
        Right text -> case run set text of
          Left err -> failWith err
          Right out -> putStr out
    _ -> failWith "usage: runghc formal/ConformanceDriver.hs <isotp|safety> <vector-file.json>"

failWith :: String -> IO a
failWith msg = hPutStrLn stderr ("conformance-driver: " ++ msg) >> exitWith (ExitFailure 2)

run :: String -> String -> Either String String
run set text = do
  file <- parseJson text
  vectors <- note "vector file without a vectors array" (lookupKey "vectors" file >>= asArray)
  if null vectors
    then Left "vector file carries no vectors"
    else do
      linesOut <- mapM (renderVector set file) (zip [0 :: Int ..] vectors)
      Right (unlines linesOut)
  where
    note msg = maybe (Left msg) Right

renderVector :: String -> JValue -> (Int, JValue) -> Either String String
renderVector set file (index, vector) = do
  name <- note "vector without a name" (lookupKey "name" vector >>= asString)
  pure $ case interpret of
    Left err -> renderJson (JObj [("name", JStr name), ("error", JStr err)])
    Right result -> renderJson (JObj [("name", JStr name), ("result", result)])
  where
    note msg = maybe (Left msg) Right
    interpret = case set of
      "isotp" -> runIsoTp vector
      "safety" -> runSafety file vector
      other -> Left ("unknown set: " ++ other)
    -- A vector the model refuses is reported as an error line for that name —
    -- the comparison tool shows it next to the TypeScript result, with the
    -- index so the failing vector can be found in the file.
    runIsoTp vector' = case lookupKey "side" vector' >>= asString of
      Just "rx" -> either (Left . withIndex) id (runReceiverVector vector') >>= finalizeResult'
      Just "tx" -> either (Left . withIndex) id (runSenderVector vector') >>= finalizeResult'
      _ -> Left (withIndex "isotp vector without side rx|tx")
    finalizeResult' r = either (Left . withIndex) Right (finalizeResult r)
    runSafety file' vector' = either (Left . withIndex) Right (runSafetyVector (fileDefaultMinVoltage file') vector')
    withIndex = (++) ("vectors[" ++ show index ++ "]: ")
