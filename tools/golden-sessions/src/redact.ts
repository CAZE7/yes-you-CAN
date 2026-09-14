/**
 * Redaction of a recorded session (master backlog P0 #10, AGENTS 24).
 *
 * A session that leaves the workshop must not carry the identity of the car it
 * came from. The VIN is the one field that does, and it is not enough to blank
 * `meta.vin`: the VIN is also part of the *wire trace*, because the tester read
 * it from DID 0xF190. A golden file whose meta says `[redacted]` while the frames
 * still contain the real number would be a privacy claim that is not true.
 *
 * So the replacement happens on the bytes: every occurrence of the VIN is
 * replaced by {@link VIN_PLACEHOLDER} of the *same length*. Length is what keeps
 * the recording usable — ISO-TP frames, UDS response lengths and every decoder
 * downstream stay exactly as they were, only the characters change. That is also
 * why the placeholder is 17 characters and contains a hyphen: a reader can see it
 * is a placeholder, and the VIN pattern of a real vehicle can never match it.
 */

import { toHex } from "@vdp/shared";
import type { GoldenRecording, GoldenSession, GoldenTraceEntry } from "./format.js";
import { VIN_PATTERN, VIN_PLACEHOLDER } from "./format.js";
import { applyReplacements, containsInMessages, findBytesInMessages } from "./isobytes.js";

/** ASCII bytes of the placeholder — same length as the VIN it replaces. */
export function redactedVinBytes(placeholder: string = VIN_PLACEHOLDER): Uint8Array {
  const bytes = new Uint8Array(placeholder.length);
  for (let i = 0; i < placeholder.length; i++) bytes[i] = placeholder.charCodeAt(i) & 0xff;
  return bytes;
}

function bytesOf(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
  return bytes;
}

/** Hex spellings a VIN can have inside a trace entry (no separator, or spaced). */
export function vinHexForms(vin: string): string[] {
  const bytes = bytesOf(vin);
  return [toHex(bytes, ""), toHex(bytes, " "), toHex(bytes, ":")]
    .map((form) => form.toUpperCase())
    .filter((form, index, all) => all.indexOf(form) === index);
}

function replaceAllInsensitive(text: string, search: string, replacement: string): string {
  if (!search) return text;
  const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(escaped, "gi"), replacement);
}

/**
 * Replace every VIN occurrence in a string: as text (meta fields, notes, paths)
 * and as hex (trace payloads, raw byte fields).
 */
export function redactText(text: string, vin: string, placeholder = VIN_PLACEHOLDER): string {
  if (!vin) return text;
  let out = replaceAllInsensitive(text, vin, placeholder);
  const placeholderHex = toHex(redactedVinBytes(placeholder), "");
  for (const form of vinHexForms(vin)) {
    out = replaceAllInsensitive(out, form, placeholderHex);
  }
  return out;
}

function redactValue(value: unknown, vin: string, placeholder: string, key?: string): unknown {
  if (typeof value === "string") {
    // `meta.vin` is the identity itself; anywhere else the VIN may appear inside
    // a longer string (a note, a path), so it is replaced in place.
    if (key === "vin") return value === vin ? placeholder : value;
    return redactText(value, vin, placeholder);
  }
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, vin, placeholder));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
      out[entryKey] = redactValue(entryValue, vin, placeholder, entryKey);
    }
    return out;
  }
  return value;
}

/**
 * Redact a whole recording. The input is not modified — a redacted recording is a
 * new object, so nothing can accidentally keep the original around.
 */
export function redactRecording(
  recording: GoldenRecording,
  vin: string,
  placeholder: string = VIN_PLACEHOLDER,
): GoldenRecording {
  if (!vin) return recording;
  // Step 1 covers text and any hex spelling that happens to be contiguous in one
  // frame (meta fields, log lines, samples, short messages).
  const redacted = redactValue(recording, vin, placeholder) as GoldenRecording;
  // Step 2 covers the case that made step 1 insufficient: an ISO-TP message whose
  // payload is spread over a First Frame and Consecutive Frames. The bytes are
  // replaced inside the reassembled message and written back into the same frames.
  const hits = findBytesInMessages(redacted.trace, [...bytesOf(vin)]);
  const trace = applyReplacements(redacted.trace, hits, [...redactedVinBytes(placeholder)]);
  return { ...redacted, trace: trace.map((entry) => ({ ...entry }) as GoldenTraceEntry) };
}

/**
 * Redact a whole golden session — recording, expectations, title and note.
 *
 * The expectation carries the observed values, and one of them is the VIN read
 * from DID 0xF190. A redaction that only cleans the trace would leave the number
 * in the expectation, which is exactly the kind of half-done privacy claim this
 * module exists to prevent.
 */
export function redactGoldenSession(
  session: GoldenSession,
  vin: string,
  placeholder: string = VIN_PLACEHOLDER,
): GoldenSession {
  if (!vin) return session;
  return {
    ...session,
    title: redactText(session.title, vin, placeholder),
    recording: redactRecording(session.recording, vin, placeholder),
    expectations: redactValue(
      session.expectations,
      vin,
      placeholder,
    ) as GoldenSession["expectations"],
    provenance: {
      ...session.provenance,
      ...(session.provenance.note !== undefined
        ? { note: redactText(session.provenance.note, vin, placeholder) }
        : {}),
    },
  };
}

/** VIN-like tokens in a file — the check that makes the promise testable. */
export function findVinLikeTokens(text: string): string[] {
  const pattern = new RegExp(VIN_PATTERN.source, VIN_PATTERN.flags);
  return [...new Set(text.match(pattern) ?? [])];
}

/**
 * Every spelling of *this* VIN still in the text — text or hex.
 *
 * Used while writing a golden file, where the VIN is still known: the file is only
 * written when this comes back empty.
 */
export function findVinOccurrences(text: string, vin: string): string[] {
  if (!vin) return [];
  const found: string[] = [];
  if (text.toUpperCase().includes(vin.toUpperCase())) found.push(vin);
  for (const form of vinHexForms(vin)) {
    if (text.toUpperCase().includes(form)) found.push(form);
  }
  return [...new Set(found)];
}

/**
 * Throws when a file still carries the VIN. Called by the recorder *before* the
 * file is written — a privacy rule that is only checked by a reader is a promise;
 * one that stops the writer is a guarantee.
 */
export function assertVinGone(text: string, vin: string, where: string): void {
  const occurrences = findVinOccurrences(text, vin);
  if (occurrences.length > 0) {
    throw new Error(
      `${where} still contains the VIN in ${occurrences.length} spelling(s) — refusing to write the file`,
    );
  }
}

/**
 * The writer-side guarantee: the VIN is gone from text, from hex and from the
 * reassembled ISO-TP messages. Called before a file is written; a redaction that
 * is only checked by a reader can be forgotten by a writer.
 */
export function assertGoldenRedacted(session: GoldenSession, vin: string, where: string): void {
  if (!vin) return;
  assertVinGone(JSON.stringify(session), vin, where);
  if (containsInMessages(session.recording.trace, [...bytesOf(vin)])) {
    throw new Error(
      `${where} still carries the VIN in an ISO-TP message — refusing to write the file`,
    );
  }
}

/**
 * A golden file must not contain a VIN-like token either (the reader-side check,
 * for files that were committed by somebody else’s recorder).
 */
export function assertNoVinLikeTokens(text: string, where: string): void {
  const tokens = findVinLikeTokens(text).filter((token) => token !== VIN_PLACEHOLDER);
  if (tokens.length > 0) {
    throw new Error(
      `${where} contains ${tokens.length} VIN-like token(s) — a golden session must be redacted: ${tokens.join(", ")}`,
    );
  }
}
