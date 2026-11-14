import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addRecipients, isValidEmail, parseEmailList, splitTyped } from './email-list.js';
import { durationLabel, toDatetimeLocal } from './invites.js';

test('splits on commas, semicolons, spaces and newlines', () => {
  assert.deepEqual(parseEmailList('a@example.com, b@example.com;c@example.com\nd@example.com e@example.com'), [
    'a@example.com',
    'b@example.com',
    'c@example.com',
    'd@example.com',
    'e@example.com',
  ]);
});

test('takes the address out of "Name <address>" and drops display names', () => {
  assert.deepEqual(
    parseEmailList('Ann Example <ann@example.com>, "Smith, Jo" <jo@example.com>; Bo Example bo@example.com'),
    ['ann@example.com', 'jo@example.com', 'bo@example.com']
  );
  assert.deepEqual(parseEmailList('mailto:x@example.com (y@example.com)'), ['x@example.com', 'y@example.com']);
});

test('dedupes ignoring case and keeps non-addresses so they can be marked', () => {
  assert.deepEqual(parseEmailList('A@Example.com a@example.com, nope, '), ['A@Example.com', 'nope']);
  assert.deepEqual(parseEmailList('  ,; \n'), []);
});

test('validates addresses', () => {
  for (const ok of ['a@example.com', 'first.last+tag@mail.example.co.uk', 'x@xn--bcher-kva.example']) {
    assert.ok(isValidEmail(ok), ok);
  }
  for (const bad of ['nope', 'a@b', 'a@@example.com', 'a b@example.com', '@example.com', 'a@example.', 'a@.example.com', 'a@example.c0m']) {
    assert.ok(!isValidEmail(bad), bad);
  }
  assert.ok(!isValidEmail(`${'a'.repeat(250)}@example.com`));
});

test('adding recipients dedupes and caps at 20', () => {
  const many = Array.from({ length: 25 }, (_, i) => `p${i}@example.com`);
  const { list, dropped } = addRecipients(['p0@example.com'], many);
  assert.equal(list.length, 20);
  assert.equal(dropped, 5);
  assert.equal(list[0], 'p0@example.com');
});

test('typing: an address ends at a separator, or a space once it has an @', () => {
  assert.deepEqual(splitTyped('a@example.com, b@exa'), { done: ['a@example.com'], rest: 'b@exa' });
  assert.deepEqual(splitTyped('a@example.com '), { done: ['a@example.com'], rest: '' });
  assert.deepEqual(splitTyped('Ann '), { done: [], rest: 'Ann ' });
  assert.deepEqual(splitTyped('Ann <ann@example.com '), { done: [], rest: 'Ann <ann@example.com ' });
  assert.deepEqual(splitTyped('Ann <ann@example.com> '), { done: ['ann@example.com'], rest: '' });
});

test('meeting helpers', () => {
  assert.equal(durationLabel(45), '45 min');
  assert.equal(durationLabel(60), '1 h');
  assert.equal(durationLabel(90), '1 h 30');
  const ms = new Date(2026, 11, 24, 9, 5).getTime();
  assert.equal(toDatetimeLocal(ms), '2026-12-24T09:05');
  assert.equal(new Date(toDatetimeLocal(ms)).getTime(), ms);
});
