import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextActiveSpeaker, pickPipPeer, type PipCandidate } from './pip-target.js';

const c = (id: string, hasVideo = true, sharing = false): PipCandidate => ({ id, hasVideo, sharing });

test('a shared screen comes first', () => {
  assert.equal(pickPipPeer([c('a'), c('b', true, true)], 'a', 'a'), 'b');
});

test('then the active speaker, then whoever is shown now, then the first with video', () => {
  assert.equal(pickPipPeer([c('a'), c('b')], 'b', 'a'), 'b');
  assert.equal(pickPipPeer([c('a'), c('b')], null, 'b'), 'b');
  assert.equal(pickPipPeer([c('a'), c('b')], 'gone', null), 'a');
});

test('people without video (camera off, or not verified yet) are skipped', () => {
  assert.equal(pickPipPeer([c('a', false), c('b')], 'a', 'a'), 'b');
  // A sharer whose picture we may not show (unverified connection) doesn't count.
  assert.equal(pickPipPeer([c('a', false, true), c('b')], null, null), 'b');
  assert.equal(pickPipPeer([c('a', false), c('b', false)], 'a', 'a'), null);
  assert.equal(pickPipPeer([], null, null), null);
});

test('the active speaker sticks while speaking and after, until someone else speaks', () => {
  const present = () => true;
  assert.equal(nextActiveSpeaker(null, ['b'], present), 'b');
  assert.equal(nextActiveSpeaker('b', ['a', 'b'], present), 'b');
  assert.equal(nextActiveSpeaker('b', [], present), 'b');
  assert.equal(nextActiveSpeaker('b', ['a'], present), 'a');
});

test('we never count as the active speaker, and nor does someone who left', () => {
  assert.equal(nextActiveSpeaker(null, ['local'], () => true), null);
  assert.equal(nextActiveSpeaker('b', ['local'], (id) => id !== 'b'), null);
  assert.equal(nextActiveSpeaker('b', ['x', 'a'], (id) => id === 'a'), 'a');
});
