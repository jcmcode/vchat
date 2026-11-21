// Camera on/off and switching, with fake media devices (no browser needed).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { get } from 'svelte/store';
import { localStream, screenStream, selectedAudioDevice, selectedVideoDevice, startScreenShare, stopScreenShare, switchAudioDevice, switchVideoDevice, toggleVideo, videoEnabled, voiceOnlyMode } from './manager.js';
import { deferred } from './fake-media.test-helpers.js';

let nextId = 0;
const opened: FakeTrack[] = [];

class FakeTrack {
  id = `t${++nextId}`;
  readyState: 'live' | 'ended' = 'live';
  enabled = true;
  private listeners: (() => void)[] = [];
  constructor(
    public kind: 'audio' | 'video',
    public deviceId = 'cam-default'
  ) {
    if (kind === 'video') opened.push(this);
  }
  stop() {
    this.readyState = 'ended';
  }
  getSettings() {
    return { deviceId: this.deviceId, width: 1280, height: 720 };
  }
  addEventListener(_type: string, fn: () => void) {
    this.listeners.push(fn);
  }
  /** The device went away by itself. */
  unplug() {
    this.readyState = 'ended';
    for (const fn of this.listeners) fn();
  }
}

class FakeStream {
  constructor(private tracks: FakeTrack[] = []) {}
  getTracks() {
    return [...this.tracks];
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === 'video');
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === 'audio');
  }
  addTrack(t: FakeTrack) {
    if (!this.tracks.includes(t)) this.tracks.push(t);
  }
  removeTrack(t: FakeTrack) {
    this.tracks = this.tracks.filter((x) => x !== t);
  }
}

/** getUserMedia that waits until released, so tests can interleave calls. */
let pending: { resolve: () => void; reject: (e: unknown) => void; deviceId?: string }[] = [];
let failWith: string | null = null;
let missingDevices = new Set<string>();

Object.defineProperty(globalThis.navigator, 'mediaDevices', {
  configurable: true,
  value: {
    getUserMedia(constraints: { video?: { deviceId?: { exact: string } } }) {
      const deviceId = constraints.video?.deviceId?.exact;
      return new Promise((resolve, reject) => {
        pending.push({
          deviceId,
          resolve: () => {
            if (failWith) return reject(new DOMException('no', failWith));
            if (deviceId && missingDevices.has(deviceId)) return reject(new DOMException('gone', 'OverconstrainedError'));
            resolve(new FakeStream([new FakeTrack('video', deviceId ?? 'cam-default')]));
          },
          reject,
        });
      });
    },
  },
});

/** Let every queued step run, answering device requests as they come. */
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 0));
    const batch = pending;
    pending = [];
    batch.forEach((p) => p.resolve());
  }
}

const liveCameras = () => opened.filter((t) => t.readyState === 'live');
const streamCameras = () => (get(localStream) as unknown as FakeStream).getVideoTracks();

beforeEach(() => {
  opened.length = 0;
  pending = [];
  failWith = null;
  missingDevices = new Set();
  selectedVideoDevice.set('');
  voiceOnlyMode.set(false);
  const cam = new FakeTrack('video', 'cam-a');
  localStream.set(new FakeStream([new FakeTrack('audio'), cam]) as unknown as MediaStream);
  videoEnabled.set(true);
});

test('camera off stops and removes the track; on brings the same camera back', async () => {
  const off = toggleVideo();
  await settle();
  assert.equal(await off, false);
  assert.equal(get(videoEnabled), false);
  assert.equal(streamCameras().length, 0);
  assert.equal(liveCameras().length, 0, 'camera released');
  assert.equal(get(selectedVideoDevice), 'cam-a');

  const on = toggleVideo();
  await settle();
  assert.equal(await on, true);
  assert.equal(streamCameras().length, 1);
  assert.equal(streamCameras()[0].deviceId, 'cam-a');
  assert.equal(liveCameras().length, 1);
});

test('camera on falls back to the default camera when the chosen one is gone', async () => {
  await Promise.all([toggleVideo(), settle()]);
  missingDevices.add('cam-a');
  const on = toggleVideo();
  await settle();
  assert.equal(await on, true);
  assert.equal(streamCameras()[0].deviceId, 'cam-default');
});

test('camera on that fails stays off with a message', async () => {
  await Promise.all([toggleVideo(), settle()]);
  failWith = 'NotReadableError';
  const on = assert.rejects(toggleVideo(), /busy/);
  await settle();
  await on;
  assert.equal(get(videoEnabled), false);
  assert.equal(streamCameras().length, 0);
  assert.equal(liveCameras().length, 0);
});

test('a second click while switching on gets the same result', async () => {
  await Promise.all([toggleVideo(), settle()]);
  const a = toggleVideo();
  const b = toggleVideo();
  assert.equal(a, b);
  await settle();
  assert.equal(await a, true);
  assert.equal(liveCameras().length, 1);
});

test('switching cameras while turning it off never leaves a camera open', async () => {
  const sw = switchVideoDevice('cam-b');
  const off = toggleVideo();
  await settle();
  await sw;
  await off;
  assert.equal(get(videoEnabled), false);
  assert.equal(streamCameras().length, 0);
  assert.equal(liveCameras().length, 0);
});

test('turning on and switching at once leaves exactly one camera open', async () => {
  await Promise.all([toggleVideo(), settle()]);
  const on = toggleVideo();
  const sw = switchVideoDevice('cam-b');
  await settle();
  await on;
  await sw;
  assert.equal(get(videoEnabled), true);
  assert.equal(streamCameras().length, 1);
  assert.equal(liveCameras().length, 1);
  assert.equal(streamCameras()[0].deviceId, 'cam-b');
});

test('a switch still waiting for its camera while the camera goes off and on again leaves one camera', async () => {
  const sw = switchVideoDevice('cam-b');
  const off = toggleVideo();
  await settle();
  await off;
  const on = toggleVideo();
  await settle();
  await Promise.all([sw, on]);
  assert.equal(get(videoEnabled), true);
  assert.equal(streamCameras().length, 1);
  assert.equal(liveCameras().length, 1);
  assert.equal(liveCameras()[0], streamCameras()[0]);
});

test('switching while the camera is off only remembers the choice', async () => {
  await Promise.all([toggleVideo(), settle()]);
  const sw = switchVideoDevice('cam-b');
  await settle();
  assert.equal(await sw, null);
  assert.equal(liveCameras().length, 0);
  assert.equal(get(selectedVideoDevice), 'cam-b');
});

test('leaving while the camera starts gives it straight back', async () => {
  await Promise.all([toggleVideo(), settle()]);
  const on = toggleVideo();
  await new Promise((r) => setTimeout(r, 0));
  localStream.set(null);
  await settle();
  await on;
  assert.equal(liveCameras().length, 0);
});

test('an unplugged camera counts as turned off', async () => {
  await Promise.all([toggleVideo(), settle()]); // off
  await Promise.all([toggleVideo(), settle()]); // on again: a camera this module opened
  streamCameras()[0].unplug();
  assert.equal(get(videoEnabled), false);
  assert.equal(streamCameras().length, 0);
});

test('a dismissed call cannot publish a late picker result over a new share', async () => {
  let finish!: (stream: FakeStream) => void;
  let pickers = 0;
  Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
    configurable: true,
    value: () => {
      pickers++;
      return new Promise<FakeStream>((resolve) => { finish = resolve; });
    },
  });
  const old = startScreenShare();
  const oldFinish = finish;
  assert.equal(await startScreenShare(), null);
  assert.equal(pickers, 1);
  stopScreenShare();
  const current = startScreenShare();
  const audio = new FakeTrack('audio');
  const live = new FakeStream([new FakeTrack('video'), audio]);
  finish(live);
  assert.equal(await current, live);
  const abandoned = new FakeStream([new FakeTrack('video'), new FakeTrack('audio')]);
  oldFinish(abandoned);
  assert.equal(await old, null);
  assert.ok(abandoned.getTracks().every((track) => track.readyState === 'ended'));
  assert.equal(get(screenStream), live);
  audio.unplug();
  assert.equal(live.getAudioTracks().length, 0);
  assert.equal(live.getVideoTracks()[0].readyState, 'live');
  stopScreenShare();
});

test('only the latest microphone selection can supply call audio', async (t) => {
  const first = deferred<MediaStream>();
  const second = deferred<MediaStream>();
  const open = t.mock.method(navigator.mediaDevices, 'getUserMedia');
  open.mock.mockImplementationOnce(() => first.promise);
  open.mock.mockImplementationOnce(() => second.promise, 1);
  const oldMic = get(localStream)!.getAudioTracks()[0];
  const slow = switchAudioDevice('first');
  const fast = switchAudioDevice('second');
  const chosen = new FakeTrack('audio', 'second');
  second.resolve(new FakeStream([chosen]) as unknown as MediaStream);
  assert.equal(await fast, chosen);
  const stale = new FakeTrack('audio', 'first');
  first.resolve(new FakeStream([stale]) as unknown as MediaStream);
  assert.equal(await slow, null);
  assert.equal(stale.readyState, 'ended');
  assert.equal(oldMic.readyState, 'ended');
  assert.deepEqual(get(localStream)!.getAudioTracks(), [chosen]);
  assert.equal(get(selectedAudioDevice), 'second');
});
