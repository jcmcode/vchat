import { test } from 'node:test';
import assert from 'node:assert/strict';
import { get } from 'svelte/store';
import { localStream, selectedVideoDevice, videoEnabled } from './manager.js';
import { reopenCamera, chooseCameraForLater, cameraNeedsReopen } from './call-camera.js';
import { FakeGetUserMedia, FakeTrack, deferred } from './fake-media.test-helpers.js';

class FakeStream {
  constructor(public tracks: FakeTrack[]) {}
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === 'video');
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === 'audio');
  }
  addTrack(t: FakeTrack) {
    this.tracks.push(t);
  }
  removeTrack(t: FakeTrack) {
    this.tracks = this.tracks.filter((x) => x !== t);
  }
}

/** A call whose camera is released (joined with it off). */
function callWithCameraOff(): FakeStream {
  const placeholder = new FakeTrack('video');
  placeholder.stop();
  const stream = new FakeStream([new FakeTrack('audio'), placeholder]);
  localStream.set(stream as unknown as MediaStream);
  videoEnabled.set(false);
  return stream;
}

const gum = new FakeGetUserMedia((c) => {
  const id = ((c.video as MediaTrackConstraints).deviceId as { ideal?: string } | undefined)?.ideal ?? 'cam-default';
  return [new FakeTrack('video', { deviceId: id })];
});
Object.defineProperty(globalThis.navigator, 'mediaDevices', { value: { getUserMedia: gum.fn }, configurable: true });

const saved = new Map<string, string>();
Object.defineProperty(globalThis, 'window', {
  value: {
    localStorage: {
      getItem: (k: string) => saved.get(k) ?? null,
      setItem: (k: string, v: string) => saved.set(k, v),
      removeItem: (k: string) => saved.delete(k),
    },
  },
  configurable: true,
});

test('a camera prompt left unanswered in one call does not block the next call', async () => {
  const unanswered = deferred<FakeTrack[]>();
  gum.then(() => unanswered.promise);
  callWithCameraOff();
  const first = reopenCamera();

  localStream.set(null); // left the call
  const second = callWithCameraOff();
  assert.equal(cameraNeedsReopen(), true);
  const track = await reopenCamera();
  assert.ok(track);
  assert.equal(second.getVideoTracks()[0].readyState, 'live');
  assert.equal(get(videoEnabled), true);

  // The first call's camera, granted late, is released straight away.
  const late = new FakeTrack('video');
  unanswered.resolve([late]);
  assert.equal(await first, null);
  assert.equal(late.readyState, 'ended');
});

test('a camera picked while turning it on is only remembered if it is the one in use', async () => {
  saved.clear();
  const answer = deferred<FakeTrack[]>();
  gum.then(() => answer.promise);
  callWithCameraOff();
  selectedVideoDevice.set('cam-a');
  const opening = reopenCamera();
  chooseCameraForLater('cam-b'); // picked while cam-a was still opening
  answer.resolve([new FakeTrack('video', { deviceId: 'cam-a' })]);
  await opening;
  assert.equal(get(selectedVideoDevice), 'cam-a');
  assert.equal(saved.get('vchat_devices'), undefined);

  // Picked while off, and that's the camera that opens: remembered.
  callWithCameraOff();
  chooseCameraForLater('cam-c');
  const track = await reopenCamera();
  assert.equal(track?.getSettings().deviceId, 'cam-c');
  assert.equal(JSON.parse(saved.get('vchat_devices')!).videoInput, 'cam-c');
  localStream.set(null);
});
