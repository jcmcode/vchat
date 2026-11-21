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

test('earlyState also keeps what their version supports and how they show our camera, validated', () => {
  assert.deepEqual(earlyState({ type: 'caps', iceRestart: true, extra: 1 }), { type: 'caps', iceRestart: true });
  assert.deepEqual(earlyState({ type: 'caps', iceRestart: 'yes' }), { type: 'caps', iceRestart: false });
  assert.deepEqual(earlyState({ type: 'view', w: 640, h: 360, fit: 'cover', extra: 'x' }), { type: 'view', w: 640, h: 360, fit: 'cover' });
  assert.deepEqual(earlyState({ type: 'view', w: 0, h: 0, fit: 'cover' }), { type: 'view', w: 0, h: 0 });
  assert.deepEqual(earlyState({ type: 'view', full: true }), { type: 'view', full: true });
  assert.equal(earlyState({ type: 'view', w: 640, h: 360, fit: 'bogus' }), null);
  assert.equal(earlyState({ type: 'view', w: -5, h: 360, fit: 'cover' }), null);
});

test('a viewer joining an ongoing share retains its verified audio metadata', () => {
  const share = { type: 'screen-state', sharing: true, mid: '2', audio: true };
  const caps = { type: 'caps', iceRestart: true, screenAudio: true };
  assert.deepEqual(earlyState(share), share);
  assert.deepEqual(earlyState(caps), caps);
  assert.deepEqual(earlyState({ ...share, mid: '' }), { type: 'screen-state', sharing: true });
  assert.deepEqual(earlyState({ ...share, audio: 'yes' }), { type: 'screen-state', sharing: true, mid: '2' });
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
