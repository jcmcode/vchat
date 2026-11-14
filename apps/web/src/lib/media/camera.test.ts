import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  audioConstraints,
  videoConstraints,
  facingOf,
  nextFacing,
  shouldMirror,
  nextDeviceId,
  openTrack,
  openCamera,
  openFlippedCamera,
} from './camera.js';
import { FakeGetUserMedia, FakeTrack, asTrack, mediaError } from './fake-media.test-helpers.js';

test('remembered devices are preferred, picked devices are required', () => {
  assert.deepEqual(audioConstraints({ deviceId: 'm1' }).deviceId, { ideal: 'm1' });
  assert.deepEqual(audioConstraints({ deviceId: 'm1', exact: true }).deviceId, { exact: 'm1' });
  assert.equal(audioConstraints().deviceId, undefined);
  assert.equal(audioConstraints().echoCancellation, true);
  assert.deepEqual(videoConstraints({ deviceId: 'c1', exact: true }).deviceId, { exact: 'c1' });
  assert.deepEqual(videoConstraints().frameRate, { ideal: 30, max: 30 });
});

test('facing mode: exact for a flip, ignored when a device is named', () => {
  assert.deepEqual(videoConstraints({ facingMode: 'environment', exactFacing: true }).facingMode, { exact: 'environment' });
  assert.deepEqual(videoConstraints({ facingMode: 'user' }).facingMode, { ideal: 'user' });
  assert.equal(videoConstraints({ deviceId: 'c1', facingMode: 'user' }).facingMode, undefined);
});

test('flip direction and mirroring', () => {
  assert.equal(nextFacing('user'), 'environment');
  assert.equal(nextFacing('environment'), 'user');
  assert.equal(nextFacing(undefined), 'environment');
  assert.equal(shouldMirror('user'), true);
  assert.equal(shouldMirror(undefined), true); // webcams: mirrored like a mirror
  assert.equal(shouldMirror('environment'), false); // back camera: text must read the right way
  assert.equal(facingOf(asTrack(new FakeTrack('video', { facingMode: 'environment' }))), 'environment');
  assert.equal(facingOf(asTrack(new FakeTrack('video', { facingMode: 'left' }))), undefined);
  assert.equal(facingOf(null), undefined);
});

test('next camera wraps round and ignores devices without ids', () => {
  const devices = [{ deviceId: 'a' }, { deviceId: '' }, { deviceId: 'b' }, { deviceId: 'c' }];
  assert.equal(nextDeviceId(devices, 'a'), 'b');
  assert.equal(nextDeviceId(devices, 'c'), 'a');
  assert.equal(nextDeviceId(devices, 'unknown'), 'a');
  assert.equal(nextDeviceId([{ deviceId: 'a' }], 'a'), null);
  assert.equal(nextDeviceId([], undefined), null);
});

test('openTrack keeps only the track asked for', async () => {
  const extra = new FakeTrack('audio');
  const gum = new FakeGetUserMedia().then(() => [extra, new FakeTrack('video')]);
  const track = await openTrack(gum.fn, 'video', {});
  assert.equal(track.kind, 'video');
  assert.equal(extra.stopCount, 1);
  assert.equal(gum.calls[0].audio, false);
  await assert.rejects(openTrack(new FakeGetUserMedia().then(() => []).fn, 'audio', {}), { name: 'NotFoundError' });
});

test('a phone that cannot run two cameras: the current one is released and it tries again', async () => {
  const current = new FakeTrack('video', { deviceId: 'front' });
  const gum = new FakeGetUserMedia().then(() => mediaError('NotReadableError'));
  const track = await openCamera(gum.fn, {}, asTrack(current));
  assert.equal(track.kind, 'video');
  assert.equal(current.readyState, 'ended');
  assert.equal(gum.calls.length, 2);

  // Other errors don't release the current camera.
  const kept = new FakeTrack('video');
  await assert.rejects(openCamera(new FakeGetUserMedia().then(() => mediaError('NotAllowedError')).fn, {}, asTrack(kept)));
  assert.equal(kept.readyState, 'live');

  // If the retry fails too, the camera ends up off (never silently left on).
  const both = new FakeTrack('video');
  const failing = new FakeGetUserMedia(() => mediaError('NotReadableError'));
  await assert.rejects(openCamera(failing.fn, {}, asTrack(both)), { name: 'NotReadableError' });
  assert.equal(both.readyState, 'ended');
});

test('flip asks for the other facing, and falls back to the next camera', async () => {
  const front = new FakeTrack('video', { deviceId: 'front', facingMode: 'user' });
  const gum = new FakeGetUserMedia().then(() => [new FakeTrack('video', { deviceId: 'back', facingMode: 'environment' })]);
  const flipped = await openFlippedCamera(gum.fn, asTrack(front), []);
  assert.equal(flipped.facing, 'environment');
  assert.deepEqual((gum.calls[0].video as MediaTrackConstraints).facingMode, { exact: 'environment' });

  // A laptop with two webcams: no "environment" camera, so the next device is used.
  const webcam = new FakeTrack('video', { deviceId: 'cam-a' });
  const laptop = new FakeGetUserMedia()
    .then(() => mediaError('OverconstrainedError'))
    .then((c) => [new FakeTrack('video', { deviceId: String(((c.video as MediaTrackConstraints).deviceId as { exact: string }).exact) })]);
  const next = await openFlippedCamera(laptop.fn, asTrack(webcam), [{ deviceId: 'cam-a' }, { deviceId: 'cam-b' }]);
  assert.equal(next.track.getSettings().deviceId, 'cam-b');
  assert.equal(next.facing, undefined);

  // Only one camera: the error is reported.
  const lone = new FakeGetUserMedia().then(() => mediaError('OverconstrainedError'));
  await assert.rejects(openFlippedCamera(lone.fn, asTrack(new FakeTrack('video', { deviceId: 'x' })), [{ deviceId: 'x' }]));
});
