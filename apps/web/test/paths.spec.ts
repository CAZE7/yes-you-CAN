/**
 * Static asset containment (AGENTS 27, ADR 0009).
 *
 * The workbench answers `/…` and `/lib/…` from two directories, and the guard that
 * keeps a request inside them is the whole difference between "serves the front
 * end" and "serves the checkout". The bug this file exists for is the
 * prefix match: `/srv/app/public-internal/keys.json` starts with the character
 * string `/srv/app/public`, so a `startsWith` check lets a sibling directory be
 * read through `../public-internal/…`. Comparing resolved *segments* is the fix,
 * and every case below is a request a browser can actually send.
 *
 * These are pure string functions on purpose — the file system is not involved, so
 * nothing here depends on what happens to be built in the checkout. `server.spec.ts`
 * covers the HTTP side with a real server on an ephemeral port.
 */

import assert from 'node:assert/strict';
import { join, resolve, sep } from 'node:path';
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { isInsideDirectory, resolveContained } from '../src/paths.js';

/** An absolute root that does not exist, because it never has to. */
const ROOT = resolve('/srv/workbench/public');
const SIBLING = `${ROOT}-internal`;

describe('isInsideDirectory — segment comparison', () => {
  test('the root itself and anything below it are inside', () => {
    assert.equal(isInsideDirectory(ROOT, ROOT), true);
    assert.equal(isInsideDirectory(ROOT, join(ROOT, 'app.js')), true);
    assert.equal(isInsideDirectory(ROOT, join(ROOT, 'lib', 'chart', 'core.js')), true);
  });

  test('a sibling whose name starts with the root name is NOT inside', () => {
    // The finding: `/srv/workbench/public-internal/keys.json` matches
    // `/srv/workbench/public` character by character and is a different directory.
    assert.equal(isInsideDirectory(ROOT, join(SIBLING, 'keys.json')), false);
    assert.equal(isInsideDirectory(ROOT, `${ROOT}.env`), false, 'the same holds for a file next to the root');
    assert.equal(isInsideDirectory(ROOT, SIBLING), false);
  });

  test('the parent and any outside path are not inside', () => {
    assert.equal(isInsideDirectory(ROOT, resolve(ROOT, '..')), false);
    assert.equal(isInsideDirectory(ROOT, '/etc/passwd'), false);
    assert.equal(isInsideDirectory(ROOT, resolve('/srv/other/public/app.js')), false);
  });

  test('a hop up and back down is inside, and a hop up past the root is not', () => {
    assert.equal(isInsideDirectory(ROOT, join(ROOT, 'lib', '..', 'app.js')), true, 'resolve folds it back into the root');
    assert.equal(isInsideDirectory(ROOT, join(ROOT, '..', 'app.js')), false);
    assert.equal(isInsideDirectory(ROOT, join(ROOT, 'a', 'b', '..', '..', '..', 'keys.json')), false);
  });

  test('a trailing separator on the root changes nothing', () => {
    assert.equal(isInsideDirectory(`${ROOT}${sep}`, join(ROOT, 'app.js')), true);
    assert.equal(isInsideDirectory(`${ROOT}/`, `${SIBLING}${sep}keys.json`), false, 'and neither does one on the candidate');
    assert.equal(isInsideDirectory(`${ROOT}/`, ROOT), true, 'the root is still inside a root written with a slash');
  });

  test('redundant separators and dots are normalised before comparing', () => {
    assert.equal(isInsideDirectory(`${ROOT}//`, `${ROOT}/.//app.js`), true);
    assert.equal(isInsideDirectory(`${ROOT}/./`, `${ROOT}/../public-internal/x`), false);
  });

  test('a relative root is judged from the working directory', () => {
    assert.equal(isInsideDirectory('.', 'src'), true);
    assert.equal(isInsideDirectory('.', join('src', '..', 'package.json')), true);
    assert.equal(isInsideDirectory('.', '../outside/file'), false, 'a relative root does not mean "everything"');
  });

  test('an empty root is the working directory, not a wildcard', () => {
    assert.equal(isInsideDirectory('', resolve('.')), true);
    assert.equal(isInsideDirectory(ROOT, ''), false, 'an empty candidate resolves to the working directory, which is outside a deploy root');
  });

  test('property: any path built below the root is inside it', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('a', 'b', 'index.html', 'sub.dir', 'x-y', 'ünïcøde', ' sp ace '), { minLength: 1, maxLength: 5 }),
        (segments) => {
          assert.equal(isInsideDirectory(ROOT, join(ROOT, ...segments)), true);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('resolveContained — the request path a route hands over', () => {
  test('a plain relative request is joined onto the root', () => {
    assert.equal(resolveContained(ROOT, 'app.js'), join(ROOT, 'app.js'));
    assert.equal(resolveContained(ROOT, 'lib/chart/core.js'), join(ROOT, 'lib', 'chart', 'core.js'));
    assert.equal(resolveContained(ROOT, './app.js'), join(ROOT, 'app.js'), 'a leading ./ is decoration');
    assert.equal(resolveContained(ROOT, 'sub/'), resolve(join(ROOT, 'sub')), 'a trailing slash does not change the target');
  });

  test('a path that walks out of the root is refused', () => {
    assert.equal(resolveContained(ROOT, '../package.json'), null);
    assert.equal(resolveContained(ROOT, '..'), null);
    assert.equal(
      resolveContained(ROOT, '.'),
      ROOT,
      'a request for the root is contained, so the route hands it to the file system and reports whatever comes back (a directory read is a 404 there, not an escape)',
    );
    assert.equal(resolveContained(ROOT, 'a/../../keys.json'), null);
    assert.equal(resolveContained(ROOT, 'a/../../../etc/passwd'), null);
  });

  test('the sibling-prefix escape is refused', () => {
    // This is the request that a `startsWith` check used to let through, with the
    // `..` folded by the browser or by `decodeURIComponent` on the way in.
    assert.equal(resolveContained(ROOT, '../public-internal/keys.json'), null);
    assert.equal(resolveContained(ROOT, 'lib/../../public-internal/keys.json'), null);
    assert.equal(resolveContained(ROOT, `..${sep}public-internal${sep}keys.json`), null);
  });

  test('an absolute or root-relative request is refused before any resolution', () => {
    assert.equal(resolveContained(ROOT, '/etc/passwd'), null, 'resolve() would have honoured the last absolute argument and left the root');
    assert.equal(resolveContained(ROOT, '/app.js'), null);
    assert.equal(resolveContained(ROOT, resolve('/etc', 'passwd')), null);
    assert.equal(resolveContained(ROOT, join(ROOT, 'app.js')), null, 'only request-relative paths are accepted here');
  });

  test('an empty relative path is refused: it would name the directory itself', () => {
    assert.equal(resolveContained(ROOT, ''), null);
  });

  test('a NUL byte is refused, because the underlying syscalls truncate at it', () => {
    assert.equal(resolveContained(ROOT, 'app.js\0../../keys.json'), null, 'without the check this reads app.js while looking safe');
    assert.equal(resolveContained(ROOT, '\0'), null);
    assert.equal(resolveContained(ROOT, 'a/b\0'), null);
  });

  test('a backslash is part of a file name here, not a separator', () => {
    // On POSIX `..\keys.json` is one legal name inside the root; on Windows the same
    // string is a parent hop and has to be refused. Both answers keep the root.
    const found = resolveContained(ROOT, '..\\keys.json');
    if (sep === '/') assert.equal(found, join(ROOT, '..\\keys.json'));
    else assert.equal(found, null);
  });

  test('dot and dot-dot segments inside the root stay usable', () => {
    assert.equal(resolveContained(ROOT, 'lib/../app.js'), join(ROOT, 'app.js'));
    assert.equal(resolveContained(ROOT, 'lib/./chart.js'), join(ROOT, 'lib', 'chart.js'));
    assert.equal(resolveContained(ROOT, '.hidden/rc'), join(ROOT, '.hidden', 'rc'), 'dotfiles are contained like any other name');
  });

  test('a relative root is resolved against the working directory first', () => {
    assert.equal(resolveContained('public', 'app.js'), join(resolve('public'), 'app.js'));
    assert.equal(resolveContained('.', 'src/app.js'), join(resolve('.'), 'src', 'app.js'));
    assert.equal(resolveContained('.', '../src/app.js'), null);
  });

  test('the result is always an absolute path inside the root', () => {
    for (const request of ['a.js', 'a/b.js', 'a/b/c/d.js', './a/../b.js']) {
      const found = resolveContained(ROOT, request);
      assert.ok(found, `${request} is contained`);
      assert.ok(found.startsWith(`${ROOT}${sep}`), `${found} stays below ${ROOT}`);
      assert.ok(!found.includes('..'), 'no parent hop survives into the answer');
    }
  });

  test('property: safe segment lists never escape, and one hop too many is always refused', () => {
    const SAFE = ['a', 'b', 'c', 'x.js', 'lib', 'sub.dir'];
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...SAFE), { minLength: 1, maxLength: 6 }), (segments) => {
        const request = segments.join('/');
        assert.equal(resolveContained(ROOT, request), join(ROOT, ...segments));
        // The same segments, prefixed with enough `..` to leave the root: no answer.
        const escape = [...segments.map(() => '..'), 'outside.txt'].join('/');
        assert.equal(resolveContained(ROOT, escape), null);
      }),
      { numRuns: 200 },
    );
  });

  test('a name that only looks like the root is refused from the outside in', () => {
    // The attacker controls only the request, so they can also try to reach a
    // *deeper* sibling that begins with the root name plus a separator.
    assert.equal(resolveContained(ROOT, `..${sep}${ROOT.split(sep).pop()}-deeper${sep}secret`), null);
    expect(resolveContained(SIBLING, 'keys.json')).toEqual(join(SIBLING, 'keys.json'));
    assert.equal(isInsideDirectory(SIBLING, ROOT), false, 'the containment relation is not symmetric');
  });
});
