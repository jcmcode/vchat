import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nameKey, stripInvisible } from './name-key.js';

test('nameKey folds case, accents and look-alike letters', () => {
  assert.equal(nameKey('ALEX'), nameKey('alex'));
  assert.equal(nameKey('Ałex'), nameKey('alex'));
  assert.equal(nameKey('Аlex'), nameKey('Alex')); // Cyrillic А
  assert.equal(nameKey('  Al   ex '), nameKey('Al ex'));
  assert.equal(nameKey('AIice'), nameKey('Alice')); // capital I for l
  assert.notEqual(nameKey('Alex'), nameKey('Alex (2)'));
  assert.notEqual(nameKey('Alice'), nameKey('Bob'));
});

test('invisible and blank characters do not make a name different', () => {
  for (const extra of ['\u3164', '\u115f', '\u1160', '\uffa0', '\u2800', '\u180e', '\u200b', '\u{e0041}']) {
    assert.equal(nameKey(`Bob${extra}`), nameKey('Bob'), `U+${extra.codePointAt(0)!.toString(16)}`);
    assert.equal(stripInvisible(`Bob${extra}`), 'Bob');
  }
  assert.equal(stripInvisible('\u3164\u2800'), '');
});
