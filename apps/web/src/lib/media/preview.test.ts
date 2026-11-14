import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MediaPreview } from './preview.js';
import { FakeGetUserMedia, FakeTrack, deferred, mediaError, defaultResponder, flush } from './fake-media.test-helpers.js';

const tracksOf = (p: MediaPreview) => ({
  audio: p.snapshot.audioTrack as unknown as FakeTrack | null,
  video: p.snapshot.videoTrack as unknown as FakeTrack | null,
});

test('nothing is opened until the user chooses a mode that needs it', async () => {
  const gum = new FakeGetUserMedia();
  const preview = new MediaPreview({ getUserMedia: gum.fn });
  preview.setMic(false);
  await preview.setCamera(false);
  await preview.setCamera(true);
  await preview.useMic('mic-2');
  await preview.useCamera('cam-2');
  await preview.use('chat');
  assert.equal(gum.calls.length, 0);
  assert.equal(preview.snapshot.status, 'idle');
});

test('camera & mic asks once, with remembered devices preferred (not required)', async () => {
  const gum = new FakeGetUserMedia();
  const preview = new MediaPreview({ getUserMedia: gum.fn }, { audioDevice: 'mic-9', videoDevice: 'cam-9' });
  await preview.use('video');
  assert.equal(gum.calls.length, 1);
  assert.deepEqual((gum.calls[0].audio as MediaTrackConstraints).deviceId, { ideal: 'mic-9' });
  assert.deepEqual((gum.calls[0].video as MediaTrackConstraints).deviceId, { ideal: 'cam-9' });
  assert.equal(preview.snapshot.status, 'live');
  assert.equal(preview.snapshot.facing, 'user');
  const { audio, video } = tracksOf(preview);
  assert.ok(audio && video);
});

test('audio only and chat only release what they do not need', async () => {
  const preview = new MediaPreview({ getUserMedia: new FakeGetUserMedia().fn });
  await preview.use('video');
  const { audio, video } = tracksOf(preview);
  await preview.use('audio');
  assert.equal(video!.readyState, 'ended');
  assert.equal(audio!.readyState, 'live');
  assert.equal(preview.snapshot.videoTrack, null);
  await preview.use('chat');
  assert.equal(audio!.readyState, 'ended');
  assert.equal(preview.snapshot.status, 'idle');
});

test('a slow permission prompt answered after switching to chat only leaves nothing on', async () => {
  const answer = deferred<FakeTrack[]>();
  const gum = new FakeGetUserMedia().then(() => answer.promise);
  const preview = new MediaPreview({ getUserMedia: gum.fn });
  const opening = preview.use('video');
  assert.equal(preview.snapshot.status, 'requesting');
  await preview.use('chat');
  const late = [new FakeTrack('audio'), new FakeTrack('video')];
  answer.resolve(late);
  await opening;
  assert.ok(late.every((t) => t.readyState === 'ended'));
  assert.equal(preview.snapshot.audioTrack, null);
  assert.equal(preview.snapshot.videoTrack, null);
});

test('turning the camera off releases it, and a late camera is stopped', async () => {
  const preview = new MediaPreview({ getUserMedia: new FakeGetUserMedia().fn });
  await preview.use('video');
  const { video } = tracksOf(preview);
  await preview.setCamera(false);
  assert.equal(video!.readyState, 'ended');
  assert.equal(preview.snapshot.camOn, false);

  // Camera on asks for the camera only.
  const answer = deferred<FakeTrack[]>();
  const gum = new FakeGetUserMedia();
  const p2 = new MediaPreview({ getUserMedia: gum.fn });
  await p2.setCamera(false);
  await p2.use('video');
  assert.equal(gum.calls.length, 1); // microphone only
  assert.equal(gum.calls[0].video, false);
  gum.then(() => answer.promise);
  const turningOn = p2.setCamera(true);
  assert.equal(gum.calls[1].audio, false);
  await p2.setCamera(false); // changed their mind while the browser was opening it
  const lateCamera = new FakeTrack('video');
  answer.resolve([lateCamera]);
  await turningOn;
  assert.equal(lateCamera.readyState, 'ended');
});

test('mute keeps the microphone open but silent', async () => {
  const preview = new MediaPreview({ getUserMedia: new FakeGetUserMedia().fn });
  preview.setMic(false);
  await preview.use('audio');
  const { audio } = tracksOf(preview);
  assert.equal(audio!.enabled, false);
  preview.setMic(true);
  assert.equal(audio!.enabled, true);
});

test('no camera: carries on with the microphone and says why', async () => {
  const gum = new FakeGetUserMedia().then(() => mediaError('NotFoundError'));
  const preview = new MediaPreview({ getUserMedia: gum.fn });
  await preview.use('video');
  assert.equal(gum.calls.length, 2);
  assert.equal(gum.calls[1].video, false);
  assert.ok(preview.snapshot.audioTrack);
  assert.deepEqual(preview.snapshot.cameraProblem, { kind: 'notfound', devices: 'camera' });
  assert.equal(preview.snapshot.problem, null);
  assert.equal(preview.snapshot.status, 'live');
});

test('blocked: retries with the microphone only if that would not prompt again', async () => {
  // Microphone already allowed (only the camera is blocked): quiet retry.
  const allowed = new FakeGetUserMedia().then(() => mediaError('NotAllowedError'));
  const p1 = new MediaPreview({ getUserMedia: allowed.fn, permission: async () => 'granted' });
  await p1.use('video');
  assert.ok(p1.snapshot.audioTrack);
  assert.deepEqual(p1.snapshot.cameraProblem, { kind: 'denied', devices: 'camera' });

  // Otherwise no second prompt: the problem is shown with guidance.
  const blocked = new FakeGetUserMedia().then(() => mediaError('NotAllowedError'));
  const p2 = new MediaPreview({ getUserMedia: blocked.fn, permission: async () => 'prompt' });
  await p2.use('video');
  assert.equal(blocked.calls.length, 1);
  assert.deepEqual(p2.snapshot.problem, { kind: 'denied', devices: 'both' });
  assert.equal(p2.snapshot.status, 'error');

  // A failing Permissions API counts as unknown (no retry).
  const p3 = new MediaPreview({
    getUserMedia: new FakeGetUserMedia().then(() => mediaError('NotAllowedError')).fn,
    permission: async () => {
      throw new Error('unsupported');
    },
  });
  await p3.use('video');
  assert.equal(p3.snapshot.problem?.kind, 'denied');

  // Audio only and blocked.
  const p4 = new MediaPreview({ getUserMedia: new FakeGetUserMedia(() => mediaError('NotAllowedError')).fn });
  await p4.use('audio');
  assert.deepEqual(p4.snapshot.problem, { kind: 'denied', devices: 'microphone' });

  // Trying again after allowing access works and clears the problem.
  const p5 = new MediaPreview({ getUserMedia: new FakeGetUserMedia().then(() => mediaError('NotAllowedError')).fn });
  await p5.use('audio');
  assert.ok(p5.snapshot.problem);
  await p5.use('audio');
  assert.equal(p5.snapshot.problem, null);
  assert.equal(p5.snapshot.status, 'live');
});

test('no microphone at all is reported as the microphone', async () => {
  const gum = new FakeGetUserMedia(() => mediaError('NotFoundError'));
  const preview = new MediaPreview({ getUserMedia: gum.fn });
  await preview.use('video');
  assert.deepEqual(preview.snapshot.problem, { kind: 'notfound', devices: 'microphone' });
});

test('no camera/microphone API (plain http)', async () => {
  const preview = new MediaPreview({});
  await preview.use('audio');
  assert.deepEqual(preview.snapshot.problem, { kind: 'insecure', devices: 'microphone' });
});

test('switching devices: picked ones are required, the old track is released', async () => {
  const gum = new FakeGetUserMedia();
  const preview = new MediaPreview({ getUserMedia: gum.fn });
  await preview.use('video');
  const { audio, video } = tracksOf(preview);
  await preview.useMic('mic-2');
  assert.deepEqual((gum.calls[1].audio as MediaTrackConstraints).deviceId, { exact: 'mic-2' });
  assert.equal(audio!.readyState, 'ended');
  await preview.useCamera('cam-2');
  assert.deepEqual((gum.calls[2].video as MediaTrackConstraints).deviceId, { exact: 'cam-2' });
  assert.equal(video!.readyState, 'ended');

  // A failed switch keeps the current microphone.
  const current = tracksOf(preview).audio!;
  gum.then(() => mediaError('NotReadableError'));
  await assert.rejects(preview.useMic('mic-3'));
  assert.equal(current.readyState, 'live');
  assert.equal(preview.snapshot.audioTrack, current as unknown as MediaStreamTrack);
});

test('flip opens the other camera and un-mirrors for the back camera', async () => {
  const gum = new FakeGetUserMedia((c) =>
    c.video && (c.video as MediaTrackConstraints).facingMode
      ? [new FakeTrack('video', { deviceId: 'cam-back', facingMode: 'environment' })]
      : defaultResponder(c)
  );
  const preview = new MediaPreview({ getUserMedia: gum.fn });
  await preview.use('video');
  const front = tracksOf(preview).video!;
  await preview.flip([]);
  assert.equal(front.readyState, 'ended');
  assert.equal(preview.snapshot.facing, 'environment');
  assert.equal(tracksOf(preview).video!.getSettings().deviceId, 'cam-back');
  // Turning the camera off and on again reopens the camera that was flipped to.
  await preview.setCamera(false);
  await preview.setCamera(true);
  assert.deepEqual((gum.calls.at(-1)!.video as MediaTrackConstraints).deviceId, { ideal: 'cam-back' });
});

test('an unplugged device is forgotten and reopened on join', async () => {
  const gum = new FakeGetUserMedia();
  const preview = new MediaPreview({ getUserMedia: gum.fn });
  await preview.use('audio');
  const mic = tracksOf(preview).audio!;
  mic.end();
  assert.equal(preview.snapshot.audioTrack, null);
  await preview.use('audio');
  assert.equal(gum.calls.length, 2);
  assert.ok(preview.snapshot.audioTrack);
});

test('hand-off gives the tracks to the call: stop() no longer touches them, late results are stopped', async () => {
  const answer = deferred<FakeTrack[]>();
  const gum = new FakeGetUserMedia();
  const preview = new MediaPreview({ getUserMedia: gum.fn });
  preview.setMic(false);
  await preview.use('video');
  const { audio, video } = tracksOf(preview);
  gum.then(() => answer.promise);
  const pending = preview.useCamera('cam-2');
  const handed = preview.handOff();
  assert.equal(handed.audioTrack, audio as unknown as MediaStreamTrack);
  assert.equal(handed.videoTrack, video as unknown as MediaStreamTrack);
  assert.equal(handed.micOn, false);
  assert.equal(handed.camOn, true);
  assert.equal(handed.facing, 'user');
  assert.equal(handed.videoDevice, 'cam-2');
  assert.equal(audio!.listenerCount, 0);
  preview.stop();
  assert.equal(audio!.readyState, 'live');
  assert.equal(video!.readyState, 'live');
  const late = new FakeTrack('video');
  answer.resolve([late]);
  await pending;
  assert.equal(late.readyState, 'ended');
  await preview.use('video'); // closed: does nothing
  assert.equal(gum.calls.length, 2);
});

test('hand-off with the camera off, and cancelling releases everything', async () => {
  const preview = new MediaPreview({ getUserMedia: new FakeGetUserMedia().fn });
  await preview.use('video');
  await preview.setCamera(false);
  const handed = preview.handOff();
  assert.ok(handed.audioTrack);
  assert.equal(handed.videoTrack, null);
  assert.equal(handed.camOn, false);

  const cancelled = new MediaPreview({ getUserMedia: new FakeGetUserMedia().fn });
  await cancelled.use('video');
  const { audio, video } = tracksOf(cancelled);
  cancelled.stop();
  assert.equal(audio!.readyState, 'ended');
  assert.equal(video!.readyState, 'ended');
  await flush();
});

test('subscribers see every change (Svelte store contract)', async () => {
  const preview = new MediaPreview({ getUserMedia: new FakeGetUserMedia().fn });
  const seen: string[] = [];
  const unsubscribe = preview.subscribe((s) => seen.push(s.status));
  await preview.use('audio');
  unsubscribe();
  preview.setMic(false);
  assert.equal(seen[0], 'idle');
  assert.ok(seen.includes('requesting'));
  assert.equal(seen.at(-1), 'live');
});
