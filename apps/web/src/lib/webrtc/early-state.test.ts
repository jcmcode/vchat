import { test } from 'node:test';
import assert from 'node:assert/strict';
import { earlyState, holdEarlyState, type EarlyState } from './early-state.js';

test('earlyState keeps a validated copy of screen-state and media-state only', () => {
  assert.deepEqual(earlyState({ type: 'screen-state', sharing: true, mid: '2' }), { type: 'screen-state', sharing: true, mid: '2' });
  assert.deepEqual(earlyState({ type: 'screen-state', sharing: false, mid: '2' }), { type: 'screen-state', sharing: false });
  assert.deepEqual(earlyState({ type: 'screen-state', sharing: 'yes', mid: '2' }), { type: 'screen-state', sharing: false });
  assert.deepEqual(earlyState({ type: 'screen-state', sharing: true, mid: '<b>' }), { type: 'screen-state', sharing: true });
  assert.deepEqual(earlyState({ type: 'media-state', audio: false, video: 0 }), { type: 'media-state', audio: false, video: true });
  // Nothing else is ever held before trust, and nothing extra rides along.
  for (const other of [{ type: 'chat', text: 'hi' }, { type: 'annot' }, { type: 'e2e-auth' }, null, 'x', 5, []]) {
    assert.equal(earlyState(other), null);
  }
  const copy = earlyState({ type: 'media-state', audio: true, video: true, extra: 'x'.repeat(1000) });
  assert.deepEqual(Object.keys(copy ?? {}).sort(), ['audio', 'type', 'video']);
});

test('holdEarlyState keeps only the latest of each type', () => {
  const store = new Map<EarlyState['type'], EarlyState>();
  assert.equal(holdEarlyState(store, { type: 'screen-state', sharing: true, mid: '1' }), true);
  holdEarlyState(store, { type: 'screen-state', sharing: true, mid: '2' });
  holdEarlyState(store, { type: 'media-state', audio: true, video: false });
  for (let i = 0; i < 100; i++) holdEarlyState(store, { type: 'media-state', audio: i % 2 === 0, video: true });
  assert.equal(holdEarlyState(store, { type: 'chat', text: 'not kept' }), false);
  assert.equal(store.size, 2);
  assert.deepEqual(store.get('screen-state'), { type: 'screen-state', sharing: true, mid: '2' });
  assert.deepEqual(store.get('media-state'), { type: 'media-state', audio: false, video: true });
});
