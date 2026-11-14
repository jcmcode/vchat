import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampVolume, isSilencedForMe, playbackFor, selectStage, type StageInput } from './participants.js';

const base: StageInput = { whiteboardOpen: false, localSharing: false, sharingPeers: [], peerIds: ['a', 'b', 'c'], pinned: null };

test('no share, no pin: no stage (everyone in the grid)', () => {
  assert.deepEqual(selectStage(base), { stage: null, stagePeerId: null });
});

test('pinned person takes the stage when nobody is sharing', () => {
  assert.deepEqual(selectStage({ ...base, pinned: 'b' }), { stage: 'pinned', stagePeerId: 'b' });
});

test('a pin for someone who left counts for nothing', () => {
  assert.deepEqual(selectStage({ ...base, pinned: 'gone' }), { stage: null, stagePeerId: null });
  assert.deepEqual(selectStage({ ...base, pinned: '' }), { stage: null, stagePeerId: null });
});

test('a remote screen share beats a pin', () => {
  assert.deepEqual(selectStage({ ...base, sharingPeers: ['c'], pinned: 'b' }), { stage: 'remote-screen', stagePeerId: 'c' });
});

test('with several sharers, the pinned sharer is shown; otherwise the first one present', () => {
  assert.deepEqual(selectStage({ ...base, sharingPeers: ['a', 'c'], pinned: 'c' }), { stage: 'remote-screen', stagePeerId: 'c' });
  assert.deepEqual(selectStage({ ...base, sharingPeers: ['a', 'c'], pinned: 'b' }), { stage: 'remote-screen', stagePeerId: 'a' });
  // A "sharer" who isn't in the call is ignored
  assert.deepEqual(selectStage({ ...base, sharingPeers: ['ghost', 'c'] }), { stage: 'remote-screen', stagePeerId: 'c' });
  assert.deepEqual(selectStage({ ...base, sharingPeers: ['ghost'], pinned: 'b' }), { stage: 'pinned', stagePeerId: 'b' });
});

test('your own screen share and the whiteboard come first', () => {
  assert.deepEqual(selectStage({ ...base, localSharing: true, sharingPeers: ['c'], pinned: 'b' }), { stage: 'local-screen', stagePeerId: null });
  assert.deepEqual(selectStage({ ...base, whiteboardOpen: true, localSharing: true, pinned: 'b' }), { stage: 'whiteboard', stagePeerId: null });
});

test('accepts sets as well as arrays', () => {
  assert.deepEqual(
    selectStage({ ...base, sharingPeers: new Set<string>(), peerIds: new Set(['x']), pinned: 'x' }),
    { stage: 'pinned', stagePeerId: 'x' }
  );
});

test('volume is a whole percentage from 0 to 100; junk keeps the previous value', () => {
  assert.equal(clampVolume(55), 55);
  assert.equal(clampVolume(55.6), 56);
  assert.equal(clampVolume(-10), 0);
  assert.equal(clampVolume(250), 100);
  assert.equal(clampVolume('40'), 40);
  assert.equal(clampVolume(NaN, 70), 70);
  assert.equal(clampVolume(Infinity, 70), 70);
  assert.equal(clampVolume('', 70), 70);
  assert.equal(clampVolume(undefined, 30), 30);
  assert.equal(clampVolume({}, 30), 30);
});

test('playback: default is full volume, "Mute for me" and 0% both silence', () => {
  assert.deepEqual(playbackFor(undefined), { volume: 1, muted: false });
  assert.deepEqual(playbackFor({ volume: 50, muted: false }), { volume: 0.5, muted: false });
  assert.deepEqual(playbackFor({ volume: 50, muted: true }), { volume: 0.5, muted: true });
  assert.deepEqual(playbackFor({ volume: 0, muted: false }), { volume: 0, muted: true });
  assert.deepEqual(playbackFor({ volume: 999, muted: false }), { volume: 1, muted: false });
  assert.equal(isSilencedForMe({ volume: 0, muted: false }), true);
  assert.equal(isSilencedForMe({ volume: 10, muted: false }), false);
  assert.equal(isSilencedForMe(undefined), false);
});
