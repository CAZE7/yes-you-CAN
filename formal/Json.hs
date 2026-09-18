{-# LANGUAGE LambdaCase #-}

{- |
Module      : Json
Description : A strict, dependency-free JSON reader/writer for the conformance vectors.
Copyright   : (c) yes-you-CAN Diagnostic Platform, 2026
License     : MIT

The formal reference stays base-only (ADR 0002/0044): no aeson, no lens.
This parser covers exactly the grammar the vector files use — objects, arrays,
strings (plain ASCII; \\u escapes are rejected loudly, never silently),
numbers, true/false/null. Strict means: trailing garbage is an error, and a
parse error names the offset, so a malformed vector can never read as an
empty vector set.
-}
module Json
  ( JValue(..)
  , parseJson
  , renderJson
  , lookupKey
  , asObject
  , asArray
  , asString
  , asBool
  , asNumber
  , asInt
  ) where

import Data.Char (isDigit, isSpace)
import Data.List (intercalate)

data JValue
  = JNull
  | JBool Bool
  | JNum Double
  | JStr String
  | JArr [JValue]
  | JObj [(String, JValue)]
  deriving (Eq, Show)

-- | Parse the whole document; any leftover input is an error.
parseJson :: String -> Either String JValue
parseJson input = do
  (value, rest) <- parseValue (strip input)
  case strip rest of
    [] -> Right value
    leftover -> Left ("trailing garbage after JSON value: " ++ take 40 leftover)

lookupKey :: String -> JValue -> Maybe JValue
lookupKey key = \case
  JObj entries -> lookup key entries
  _ -> Nothing

asObject :: JValue -> Maybe [(String, JValue)]
asObject (JObj entries) = Just entries
asObject _ = Nothing

asArray :: JValue -> Maybe [JValue]
asArray (JArr items) = Just items
asArray _ = Nothing

asString :: JValue -> Maybe String
asString (JStr s) = Just s
asString _ = Nothing

asBool :: JValue -> Maybe Bool
asBool (JBool b) = Just b
asBool _ = Nothing

asNumber :: JValue -> Maybe Double
asNumber (JNum n) = Just n
asNumber _ = Nothing

asInt :: JValue -> Maybe Int
asInt (JNum n) = if n == fromIntegral (truncate n :: Integer) then Just (truncate n) else Nothing
asInt _ = Nothing

-- ------------------------------------------------------------------ parsing

parseValue :: String -> Either String (JValue, String)
parseValue = \case
  ('{' : rest) -> parseObject rest
  ('[' : rest) -> parseArray rest
  ('"' : rest) -> parseString rest
  s@(c : _)
    | isDigit c || c == '-' -> parseNumber s
  ('t' : 'r' : 'u' : 'e' : rest) -> Right (JBool True, rest)
  ('f' : 'a' : 'l' : 's' : 'e' : rest) -> Right (JBool False, rest)
  ('n' : 'u' : 'l' : 'l' : rest) -> Right (JNull, rest)
  other -> Left ("expected a JSON value at: " ++ take 40 other)

parseObject :: String -> Either String (JValue, String)
parseObject s0 = case strip s0 of
  ('}' : rest) -> Right (JObj [], rest)
  _ -> go s0 []
  where
    go s acc = do
      (key, afterKey) <- case strip s of
        ('"' : r) -> do
          (k, r') <- parseStringBody r
          case strip r' of
            (':' : r'') -> Right (k, r'')
            _ -> Left "object member without ':'"
        _ -> Left "expected '\"' as object key"
      (value, afterValue) <- parseValue (strip afterKey)
      case strip afterValue of
        (',' : more) -> go more ((key, value) : acc)
        ('}' : more) -> Right (JObj (reverse ((key, value) : acc)), more)
        _ -> Left "expected ',' or '}' inside an object"

parseArray :: String -> Either String (JValue, String)
parseArray s0 = case strip s0 of
  (']' : rest) -> Right (JArr [], rest)
  _ -> go s0 []
  where
    go s acc = do
      (item, afterItem) <- parseValue (strip s)
      case strip afterItem of
        (',' : more) -> go more (item : acc)
        (']' : more) -> Right (JArr (reverse (item : acc)), more)
        _ -> Left "expected ',' or ']' inside an array"

parseString :: String -> Either String (JValue, String)
parseString s = do
  (str, rest) <- parseStringBody s
  Right (JStr str, rest)

parseStringBody :: String -> Either String (String, String)
parseStringBody = go id
  where
    go acc = \case
      ('"' : rest) -> Right (acc [], rest)
      ('\\' : c : rest) ->
        case c of
          '"' -> go (acc . ('"' :)) rest
          '\\' -> go (acc . ('\\' :)) rest
          '/' -> go (acc . ('/' :)) rest
          'n' -> go (acc . ('\n' :)) rest
          't' -> go (acc . ('\t' :)) rest
          'r' -> go (acc . ('\r' :)) rest
          'u' -> Left "\\u escapes are not part of the vector grammar — keep the files ASCII"
          _ -> Left ("unknown escape: \\" ++ [c])
      [] -> Left "unterminated string"
      (c : rest) -> go (acc . (c :)) rest

parseNumber :: String -> Either String (JValue, String)
parseNumber s =
  case span (\c -> c `elem` "+-.eE" || isDigit c) s of
    ([], _) -> Left ("expected a number at: " ++ take 20 s)
    (digits, rest) ->
      case reads digits of
        [(value, "")] -> Right (JNum value, rest)
        _ -> Left ("malformed number: " ++ digits)
strip :: String -> String
strip = dropWhile isSpace

-- ----------------------------------------------------------------- writing

renderJson :: JValue -> String
renderJson = \case
  JNull -> "null"
  JBool b -> if b then "true" else "false"
  JNum n -> renderNumber n
  JStr s -> renderString s
  JArr items -> "[" ++ intercalate "," (map renderJson items) ++ "]"
  JObj entries -> "{" ++ intercalate "," [renderString k ++ ":" ++ renderJson v | (k, v) <- entries] ++ "}"

renderNumber :: Double -> String
renderNumber n
  | n == fromIntegral i = show i
  | otherwise = show n
  where
    i = truncate n :: Integer

renderString :: String -> String
renderString s = '"' : concatMap esc s ++ "\""
  where
    esc '"' = "\\\""
    esc '\\' = "\\\\"
    esc '\n' = "\\n"
    esc '\t' = "\\t"
    esc '\r' = "\\r"
    esc c = [c]
