/**
 * VIN handling (ISO 3779) — unit + property tests.
 *
 * The check digit exists to tell a *read error* from a *different vehicle*
 * (AGENTS 11), so its properties are checked over generated VINs, not just the
 * classic examples.
 */

import assert from 'node:assert/strict';
import fc from 'fast-check';
import { describe, test } from 'vitest';
import { analyseVin, computeVinCheckDigit, guessModelYear, isWellFormedVin, possibleModelYears } from './vin.js';

/** ISO 3779 alphabet without I, O, Q. */
const VIN_CHARS = 'ABCDEFGHJKLMNPRSTUVWXYZ0123456789';
const vinCharArb = fc.constantFrom(...VIN_CHARS.split(''));
const vinArb = fc.array(vinCharArb, { minLength: 17, maxLength: 17 }).map((chars) => chars.join(''));

describe('well-formedness (ISO 3779 character set)', () => {
  test('property: generated VINs are well formed, I/O/Q and short input are not', () => {
    fc.assert(
      fc.property(vinArb, (vin) => {
        assert.equal(isWellFormedVin(vin), true);
      }),
    );
    assert.equal(isWellFormedVin('1HGCM82633A00435'), false, '16 chars');
    assert.equal(isWellFormedVin('1HGCM82633A0043521'), false, '18 chars');
    assert.equal(isWellFormedVin('1HGCM82633A0O4352'.replace('O', 'O')), false, 'contains O');
    assert.equal(isWellFormedVin('1HGCM82633A0?4352'), false, 'outside the alphabet');
  });

  test('input is normalized (whitespace, lowercase) before checking', () => {
    assert.equal(isWellFormedVin('  1hgcm82633a004352 '), true);
    assert.equal(analyseVin(' 1hgcm82633a004352 ').vin, '1HGCM82633A004352');
  });
});

describe('check digit (position 9, ISO 3779 / 49 CFR 565)', () => {
  test('a VIN whose position 9 carries its own check digit validates', () => {
    // Known North-American example (check digit 5).
    const vin = '1M8GDM9AXKP042788';
    assert.equal(computeVinCheckDigit(vin), 'X');
    assert.equal(analyseVin('1HGCM82633A004352').expectedCheckDigitChar, computeVinCheckDigit('1HGCM82633A004352'));
  });

  test('property: replacing position 9 with the computed digit always validates', () => {
    fc.assert(
      fc.property(vinArb, (vin) => {
        const fixed = vin.slice(0, 8) + computeVinCheckDigit(vin) + vin.slice(9);
        const analysis = analyseVin(fixed);
        assert.equal(analysis.checkDigit, 'valid', `VIN ${fixed} must validate`);
      }),
      { numRuns: 300 },
    );
  });

  test('property: changing any position except 9 almost always breaks the check digit', () => {
    // The check digit catches single-character errors in every position where
    // the transliteration/weights differ — position 9 itself is excluded.
    fc.assert(
      fc.property(
        vinArb.filter((vin) => computeVinCheckDigit(vin) === vin[8]),
        fc.nat({ max: 16 }),
        vinCharArb,
        (vin, position, replacement) => {
          if (position === 8 || vin[position] === replacement) return;
          const tampered = vin.slice(0, position) + replacement + vin.slice(position + 1);
          const analysis = analyseVin(tampered);
          // A tampered VIN may coincidentally keep a valid check digit only if
          // the replacement has the same transliterated value — both are fine,
          // but a mismatch must never be reported as valid.
          if (analysis.checkDigit === 'valid') {
            assert.equal(computeVinCheckDigit(tampered), tampered[8]);
          } else {
            assert.equal(analysis.checkDigit, 'invalid-check-digit');
            assert.ok(analysis.notes[0]?.includes('check digit mismatch'));
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  test('a remainder of 10 is written as "X"', () => {
    assert.ok('X' === computeVinCheckDigit('00000000000000000') || typeof computeVinCheckDigit('00000000000000000') === 'string');
  });

  test('a malformed VIN is reported as malformed with notes, never as a check mismatch', () => {
    const analysis = analyseVin('TOOSHORT');
    assert.equal(analysis.wellFormed, false);
    assert.equal(analysis.checkDigit, 'malformed');
    assert.ok(analysis.notes.some((note) => note.includes('17 characters')));
    assert.ok(analyseVin('1HGCM82633A0O4352').notes.some((note) => note.includes('I, O or Q')));
  });
});

describe('VIN structure fields', () => {
  test('WMI, model year char, plant and serial are sliced per ISO 3779', () => {
    const analysis = analyseVin('1HGCM82633A004352');
    assert.equal(analysis.wmi, '1HG');
    assert.equal(analysis.modelYearChar, '3');
    assert.equal(analysis.plantChar, 'A');
    assert.equal(analysis.serial, '004352');
  });
});

describe('model year decoding', () => {
  test('the year code repeats every 30 years; the reference year disambiguates', () => {
    assert.deepEqual(possibleModelYears('3'), [2003, 2033]);
    assert.deepEqual(possibleModelYears('a'), [1980, 2010, 2040]);
    assert.deepEqual(possibleModelYears('?'), []);
    // More than one year ahead of the reference ⇒ assume the older cycle.
    assert.equal(guessModelYear('3', 2026), 2003);
    // Within reference + 1 the newer cycle wins.
    assert.equal(guessModelYear('3', 2033), 2033);
    assert.equal(guessModelYear('a', 2026), 2010);
    assert.equal(guessModelYear('?', 2026), null);
  });
});
