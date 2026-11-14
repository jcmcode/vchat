import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampVolume, isSilencedForMe, playbackFor, selectStage, type StageInput } from './participants.js';

/** Screens actually arriving: everyone's except "claimer", who only says they're sharing. */
const arriving = (id: string) => id !== 'claimer';
const base: StageInput = {
  whiteboardOpen: false,
  localSharing: false,
  sharingPeers: [],
  hasScreen: arriving,
  peerIds: ['a', 'b', 'c', 'claimer'],
  pinned: null,
};

const none = { stagePeerId: null, otherSharer: null };

test('no share, no pin: no stage (everyone in the grid)', () => {
  assert.deepEqual(selectStage(base), { stage: null, ...none });
});

test('pinned person takes the stage when nobody is sharing', () => {
  assert.deepEqual(selectStage({ ...base, pinned: 'b' }), { stage: 'pinned', stagePeerId: 'b', otherSharer: null });
});

test('a pin for someone who left counts for nothing', () => {
  assert.deepEqual(selectStage({ ...base, pinned: 'gone' }), { stage: null, ...none });
  assert.deepEqual(selectStage({ ...base, pinned: '' }), { stage: null, ...none });
  assert.deepEqual(selectStage({ ...base, pinned: 'gone', sharingPeers: ['c'] }), { stage: 'remote-screen', stagePeerId: 'c', otherSharer: null });
});

test('without a pin, the latest sharer whose screen is arriving takes the stage', () => {
  assert.deepEqual(selectStage({ ...base, sharingPeers: ['c'] }), { stage: 'remote-screen', stagePeerId: 'c', otherSharer: null });
  assert.deepEqual(selectStage({ ...base, sharingPeers: ['a', 'c'] }), { stage: 'remote-screen', stagePeerId: 'c', otherSharer: null });
  // A bare claim (no screen arriving) or someone who isn't in the call can't take or blank it
  assert.deepEqual(selectStage({ ...base, sharingPeers: ['a', 'claimer'] }), { stage: 'remote-screen', stagePeerId: 'a', otherSharer: null });
  assert.deepEqual(selectStage({ ...base, sharingPeers: ['a', 'ghost'] }), { stage: 'remote-screen', stagePeerId: 'a', otherSharer: null });
  assert.deepEqual(selectStage({ ...base, sharingPeers: ['claimer', 'ghost'] }), { stage: null, ...none });
});

test('your pin outranks someone else sharing, and offers their share instead of taking the stage', () => {
  assert.deepEqual(selectStage({ ...base, sharingPeers: ['c'], pinned: 'b' }), { stage: 'pinned', stagePeerId: 'b', otherSharer: 'c' });
  assert.deepEqual(selectStage({ ...base, sharingPeers: ['a', 'c', 'claimer'], pinned: 'b' }), { stage: 'pinned', stagePeerId: 'b', otherSharer: 'c' });
  // Claims and absent "sharers" are never offered
  assert.deepEqual(selectStage({ ...base, sharingPeers: ['claimer', 'ghost'], pinned: 'b' }), { stage: 'pinned', stagePeerId: 'b', otherSharer: null });
});

test('when the pinned person shares, their screen is on the stage once it arrives', () => {
  assert.deepEqual(selectStage({ ...base, sharingPeers: ['c', 'a'], pinned: 'c' }), { stage: 'remote-screen', stagePeerId: 'c', otherSharer: null });
  // Pinned and only claiming: their tile stays on the stage, and a real share is offered
  assert.deepEqual(selectStage({ ...base, sharingPeers: ['a', 'claimer'], pinned: 'claimer' }), { stage: 'pinned', stagePeerId: 'claimer', otherSharer: 'a' });
});

test('your own screen share and the whiteboard come first', () => {
  assert.deepEqual(selectStage({ ...base, localSharing: true, sharingPeers: ['c'], pinned: 'b' }), { stage: 'local-screen', ...none });
  assert.deepEqual(selectStage({ ...base, whiteboardOpen: true, localSharing: true, pinned: 'b' }), { stage: 'whiteboard', ...none });
});

test('accepts sets and iterators as well as arrays', () => {
  assert.deepEqual(
    selectStage({ ...base, sharingPeers: new Set(['y']), peerIds: new Map([['x', 1], ['y', 2]]).keys(), pinned: 'x' }),
    { stage: 'pinned', stagePeerId: 'x', otherSharer: 'y' }
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
