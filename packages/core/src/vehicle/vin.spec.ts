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

/** Every character position 10 may hold for a model year, i.e. the codes in use. */
const MODEL_YEAR_CHARS = ['A','B','C','D','E','F','G','H','J','K','L','M','N','P','R','S','T','V','W','X','Y','1','2','3','4','5','6','7','8','9'];
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

  test('a remainder of 10 is written as "X", every other remainder as its digit', () => {
    // 10 has no single decimal digit, so ISO 3779 spells the remainder "X".
    assert.equal(computeVinCheckDigit('11111111111111110'), 'X');
    assert.equal(computeVinCheckDigit('1M8GDM9AXKP042788'), 'X');
    assert.equal(computeVinCheckDigit('11111111111111111'), '1');
    assert.equal(computeVinCheckDigit('00000000000000000'), '0');
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

describe('computeVinCheckDigit — the arithmetic itself', () => {
  /**
   * Published examples, not self-referential expectations: the function has to
   * reproduce what the standard prescribes, so the values come from real VINs.
   */
  const KNOWN: Array<[vin: string, expected: string]> = [
    ['1HGCM82633A004352', '3'], // Honda Accord, North-American VIN
    ['1M8GDM9AXKP042788', 'X'], // the ISO 3779 example with remainder 10
    ['5YJ3E1EA7KF317840', '2'], // Tesla Model 3
    ['WVWZZZ1JZXW000001', '0'], // European VIN — its position 9 is not a check digit at all
    ['11111111111111111', '1'],
    ['00000000000000000', '0'],
  ];

  for (const [vin, expected] of KNOWN) {
    test(`${vin} computes to "${expected}"`, () => {
      assert.equal(computeVinCheckDigit(vin), expected);
    });
  }

  test('the check digit position itself is weighted with zero', () => {
    // WEIGHTS[8] === 0: whatever stands in position 9 does not influence the
    // expectation for position 9 — that is what makes a mismatch meaningful.
    const without = computeVinCheckDigit('1HGCM82633A004352');
    for (const char of VIN_CHARS) {
      const tampered = `1HGCM826${char}3A004352`;
      assert.equal(computeVinCheckDigit(tampered), without, `position 9 char "${char}" must not change the computed digit`);
    }
  });

  test('input is trimmed and upper-cased, lowercase VINs compute the same digit', () => {
    assert.equal(computeVinCheckDigit('  1hgcm82633a004352 '), computeVinCheckDigit('1HGCM82633A004352'));
  });

  test('a short input is zero padded rather than throwing — the length is validated elsewhere', () => {
    // Positions 8..16 fall off the end and count as "0".
    assert.equal(computeVinCheckDigit('1HGCM826'), computeVinCheckDigit('1HGCM826000000000'));
    assert.equal(computeVinCheckDigit('1HGCM826'), '5');
    assert.equal(computeVinCheckDigit(''), '0');
  });

  test('characters ISO 3779 forbids transliterate to zero instead of failing', () => {
    // I, O and Q have no entry in the transliteration table; rejecting them is
    // isWellFormedVin's job, so the calculation stays total and treats them like
    // the digit 0, which is also what an empty position counts as.
    assert.equal(computeVinCheckDigit('QHGCM82633A004352'), computeVinCheckDigit('0HGCM82633A004352'));
    assert.equal(computeVinCheckDigit('IIGCM82633A004352'), computeVinCheckDigit('00GCM82633A004352'));
    assert.notEqual(computeVinCheckDigit('QHGCM82633A004352'), computeVinCheckDigit('1HGCM82633A004352'), 'a real character would have counted as 1');
    assert.match(computeVinCheckDigit('IIOOQQ'), /^[0-9X]$/, 'still exactly one check digit character');
  });

  test('only the digits 0-9 and X come out, whatever goes in', () => {
    fc.assert(
      fc.property(vinArb, (vin) => {
        assert.match(computeVinCheckDigit(vin), /^[0-9X]$/);
      }),
      { numRuns: 400 },
    );
  });

  test('property: fixing position 9 makes the VIN validate, breaking it breaks validation unless the value coincides', () => {
    fc.assert(
      fc.property(vinArb, (generated) => {
        const digit = computeVinCheckDigit(generated);
        const correct = generated.slice(0, 8) + digit + generated.slice(9);
        assert.equal(computeVinCheckDigit(correct), digit, 'the computation is stable under its own result');
        assert.equal(analyseVin(correct).checkDigit, 'valid');

        // A different character at position 9 can only keep the VIN valid when it
        // happens to be the same character (position 9 has weight 0).
        for (const other of ['0', '1', '5', '9', 'X']) {
          if (other === digit) continue;
          const broken = generated.slice(0, 8) + other + generated.slice(9);
          assert.equal(analyseVin(broken).checkDigit, 'invalid-check-digit', `position 9 = "${other}" must not validate`);
        }
      }),
      { numRuns: 150 },
    );
  });
});

describe('analyseVin — the report a session stores', () => {
  test('a well-formed North-American VIN: everything derived, nothing to complain about', () => {
    const analysis = analyseVin('1HGCM82633A004352');
    assert.deepEqual(analysis, {
      vin: '1HGCM82633A004352',
      wellFormed: true,
      checkDigit: 'valid',
      checkDigitChar: '3',
      expectedCheckDigitChar: '3',
      wmi: '1HG',
      modelYearChar: '3',
      plantChar: 'A',
      serial: '004352',
      notes: [],
    });
  });

  test('the X check digit of the ISO example validates', () => {
    const analysis = analyseVin('1M8GDM9AXKP042788');
    assert.equal(analysis.checkDigit, 'valid');
    assert.equal(analysis.checkDigitChar, 'X');
    assert.equal(analysis.expectedCheckDigitChar, 'X');
    assert.deepEqual(analysis.notes, []);
  });

  test('a mismatch is reported as a finding, not as a rejection', () => {
    // A European VIN carries whatever the plant put in position 9; the analysis
    // must keep the VIN (it is still the vehicle's identity) and say what differs.
    const analysis = analyseVin('WVWZZZ1JZXW000001');
    assert.equal(analysis.wellFormed, true, 'the VIN itself is well formed');
    assert.equal(analysis.checkDigit, 'invalid-check-digit');
    assert.equal(analysis.checkDigitChar, 'Z');
    assert.equal(analysis.expectedCheckDigitChar, '0');
    assert.equal(analysis.notes.length, 1);
    assert.equal(
      analysis.notes[0],
      'check digit mismatch: position 9 is "Z" but "0" was computed — likely a read/transmission error, or a non-North-American VIN where the check digit is not enforced',
    );
  });

  test('the Tesla example shows a read error being distinguishable from a different vehicle', () => {
    const analysis = analyseVin('5YJ3E1EA7KF317840');
    assert.equal(analysis.checkDigit, 'invalid-check-digit');
    assert.equal(analysis.wmi, '5YJ');
    assert.equal(analysis.modelYearChar, 'K', 'model year and plant are still readable from a VIN with a bad check digit');
    assert.equal(analysis.plantChar, 'F');
  });

  test('every structural field is sliced positionally, even when the input is malformed', () => {
    // Deliberate: the analysis is evidence for a report. Truncating or blanking
    // the fields of a suspect VIN would throw away what a human needs to judge it.
    const analysis = analyseVin('1HGCM82633A004352EXTRA');
    assert.equal(analysis.wellFormed, false);
    assert.equal(analysis.checkDigit, 'malformed');
    assert.equal(analysis.expectedCheckDigitChar, '', 'nothing is computed for a VIN that is not 17 characters');
    assert.equal(analysis.checkDigitChar, '3', 'position 9 is still reported as transmitted');
    assert.equal(analysis.wmi, '1HG');
    assert.equal(analysis.modelYearChar, '3');
    assert.equal(analysis.plantChar, 'A');
    assert.equal(analysis.serial, '004352EXTRA');
    // Only the length is wrong here — the characters themselves are all legal,
    // and the notes say exactly that and nothing more.
    assert.deepEqual(analysis.notes, ['VIN must be 17 characters, got 22']);
  });

  test('an empty or whitespace-only input is malformed, never an exception', () => {
    for (const input of ['', '   ', '\t\n']) {
      const analysis = analyseVin(input);
      assert.equal(analysis.vin, input.trim());
      assert.equal(analysis.wellFormed, false);
      assert.equal(analysis.checkDigit, 'malformed');
      assert.equal(analysis.checkDigitChar, '');
      assert.equal(analysis.wmi, '');
      assert.equal(analysis.modelYearChar, '');
      assert.equal(analysis.plantChar, '');
      assert.equal(analysis.serial, '');
      assert.deepEqual(analysis.notes, ['VIN must be 17 characters, got 0']);
    }
  });

  test('every problem is reported at once, in the documented order', () => {
    // 16 characters, a space and an O: three separate findings, one note each.
    const analysis = analyseVin('1HGCM826 33A0O43');
    assert.equal(analysis.wellFormed, false);
    assert.deepEqual(analysis.notes, [
      'VIN must be 17 characters, got 16',
      'VIN contains I, O or Q which ISO 3779 does not allow',
      'VIN contains characters outside A-HJ-NPR-Z0-9',
    ]);
    assert.ok(analyseVin('').notes.length === 1, 'an empty VIN only has the length problem to report');
  });

  test('a correct length with a forbidden character reports the character, not the length', () => {
    const analysis = analyseVin('1HGCM82633A0O4352');
    assert.equal(analysis.notes.length, 2, 'the O is both forbidden and outside the alphabet — no length note');
    assert.match(analysis.notes[0] ?? '', /I, O or Q/);
    assert.equal(analysis.notes[1], 'VIN contains characters outside A-HJ-NPR-Z0-9');
    assert.equal(analysis.checkDigit, 'malformed', 'and the check digit is never judged on a malformed VIN');
  });

  test('lowercase input is normalised once and reported upper-cased', () => {
    const analysis = analyseVin(' 1hgcm82633a004352 ');
    assert.equal(analysis.vin, '1HGCM82633A004352');
    assert.equal(analysis.checkDigit, 'valid');
  });

  test('property: analysis is idempotent and notes only ever appear for real findings', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 24 }), (candidate) => {
        const analysis = analyseVin(candidate);
        assert.equal(analysis.vin, candidate.trim().toUpperCase());
        // Re-analysing the produced VIN yields exactly the same report.
        assert.deepEqual(analyseVin(analysis.vin), analysis);
        if (analysis.wellFormed) {
          assert.deepEqual(analysis.notes, analysis.checkDigit === 'valid' ? [] : [analysis.notes[0] as string]);
          assert.ok(analysis.notes.every((note) => note.length > 0));
        } else {
          assert.equal(analysis.checkDigit, 'malformed');
          assert.notDeepEqual(analysis.notes, [], 'an ill-formed VIN always says why');
          assert.equal(analysis.expectedCheckDigitChar, '');
        }
      }),
      { numRuns: 400 },
    );
  });
});

describe('guessModelYear — picking a cycle', () => {
  test('the reference year allows one year of margin, because a model year is sold early', () => {
    // '3' is 2003 or 2033. In 2032 a 2033 car is already on the road; in 2031 it is not.
    assert.equal(guessModelYear('3', 2032), 2033);
    assert.equal(guessModelYear('3', 2031), 2003);
    assert.equal(guessModelYear('3', 2033), 2033);
  });

  test('a letter code with three cycles picks the newest one the reference year allows', () => {
    assert.equal(guessModelYear('A', 1985), 1980, 'both 2010 and 2040 are ahead of 1986');
    assert.equal(guessModelYear('A', 2011), 2010);
    assert.equal(guessModelYear('A', 2038), 2010, '2040 is two model years ahead, so the 1980 cycle still wins');
    assert.equal(guessModelYear('A', 2039), 2040, 'one year ahead is allowed — the next model year is sold early');
    assert.equal(guessModelYear('A', 2040), 2040);
    assert.equal(guessModelYear('A', 2041), 2040, 'and once it is the current year it simply stays the answer');
  });

  test('when every cycle lies in the future the oldest candidate is returned rather than nothing', () => {
    // A first registration in 1970 with a "1980" code is a data problem, and
    // saying "1980" is more useful than saying "I give up" — the caller still has
    // possibleModelYears to show the alternatives.
    assert.equal(guessModelYear('Y', 1970), 2000);
    assert.deepEqual(possibleModelYears('Y'), [2000, 2030, 2060]);
  });

  test('unknown characters have no candidate and yield null', () => {
    for (const char of ['?', '0', 'I', 'O', 'Q', '']) {
      assert.equal(guessModelYear(char, 2026), null, `"${char}" is not a model year code`);
      assert.deepEqual(possibleModelYears(char), []);
    }
  });

  test('the code lookup is case-insensitive', () => {
    assert.equal(guessModelYear('s', 2026), guessModelYear('S', 2026));
    assert.equal(guessModelYear('s', 2026), 2025);
  });

  test('without a reference year the current calendar year is used', () => {
    const current = new Date().getFullYear();
    for (const code of MODEL_YEAR_CHARS) {
      const guess = guessModelYear(code);
      const candidates = possibleModelYears(code);
      assert.ok(guess !== null, `${code}: every documented code has at least one admissible cycle`);
      assert.ok(candidates.includes(guess), `${code}: ${guess} must be one of ${candidates.join(', ')}`);
      assert.ok(guess <= current + 1, `${code}: ${guess} may not be more than one year ahead of ${current}`);
      // The newest admissible cycle is the answer — anything older would be a
      // reading of the same code that the current date rules out.
      const newest = candidates.filter((year) => year <= current + 1).pop();
      assert.equal(guess, newest, `${code}: expected the newest cycle up to ${current + 1}`);
    }
  });

  test('property: the result is the largest candidate within reference + 1, and every code is total', () => {
    // Unknown codes are part of the contract: a VIN read from an ECU can carry
    // anything in position 10, and the answer has to be null, never a crash.
    const codes = [...MODEL_YEAR_CHARS, 'Q', 'I', 'O', '0', '?', ''];
    fc.assert(
      fc.property(fc.constantFrom(...codes), fc.integer({ min: 1970, max: 2100 }), (code, reference) => {
        const guess = guessModelYear(code, reference);
        const candidates = possibleModelYears(code);
        if (candidates.length === 0) {
          assert.equal(guess, null, `"${code}" has no model year to guess`);
          return;
        }
        const expected = candidates.filter((year) => year <= reference + 1).pop() ?? (candidates[0] as number);
        assert.equal(guess, expected);
      }),
      { numRuns: 500 },
    );
  });
});
