import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nameKey } from './name-key.js';

test('nameKey folds case, accents and look-alike letters', () => {
  assert.equal(nameKey('ALEX'), nameKey('alex'));
  assert.equal(nameKey('Ałex'), nameKey('alex'));
  assert.equal(nameKey('Аlex'), nameKey('Alex')); // Cyrillic А
  assert.equal(nameKey('  Al   ex '), nameKey('Al ex'));
  assert.equal(nameKey('AIice'), nameKey('Alice')); // capital I for l
  assert.notEqual(nameKey('Alex'), nameKey('Alex (2)'));
  assert.notEqual(nameKey('Alice'), nameKey('Bob'));
});
