// Front/back flip racing camera switches and on/off, joining from the pre-join check, and what gets
// remembered, with fake camera devices (no browser needed).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { get } from 'svelte/store';
import {
  adoptMedia,
  cameraFacing,
  localStream,
  selectedVideoDevice,
  stopMedia,
  switchVideoDevice,
  toggleVideo,
  videoDevices,
  videoEnabled,
  voiceOnlyMode,
} from './manager.js';
import { flipCamera, rememberCameraWhenInUse } from './call-camera.js';

/** The cameras on this fake phone, and which way each faces. */
const CAMERAS: Record<string, 'user' | 'environment' | undefined> = {
  'cam-front': 'user',
  'cam-back': 'environment',
  'cam-usb': undefined,
};

const opened: FakeTrack[] = [];

class FakeTrack {
  static next = 0;
  id = `t${FakeTrack.next++}`;
  readyState: 'live' | 'ended' = 'live';
  enabled = true;
  private listeners: (() => void)[] = [];
  constructor(
    public kind: 'audio' | 'video',
    public deviceId = 'mic'
  ) {
    if (kind === 'video') opened.push(this);
  }
  stop() {
    this.readyState = 'ended';
  }
  getSettings() {
    return { deviceId: this.deviceId, facingMode: CAMERAS[this.deviceId] };
  }
  addEventListener(_type: string, fn: () => void) {
    this.listeners.push(fn);
  }
  removeEventListener() {}
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

type Constraint = { exact?: string; ideal?: string } | undefined;
let pending: (() => void)[] = [];
let failNext: string[] = [];
let missing = new Set<string>();
const requests: MediaTrackConstraints[] = [];

/** Pick the camera a real browser would for these constraints. */
function pickCamera(video: MediaTrackConstraints): string | DOMException {
  const id = video.deviceId as Constraint;
  const facing = video.facingMode as Constraint;
  const present = Object.keys(CAMERAS).filter((c) => !missing.has(c));
  if (id?.exact) return present.includes(id.exact) ? id.exact : new DOMException('gone', 'OverconstrainedError');
  if (id?.ideal && present.includes(id.ideal)) return id.ideal;
  if (facing?.exact) return present.find((c) => CAMERAS[c] === facing.exact) ?? new DOMException('no', 'OverconstrainedError');
  if (facing?.ideal) return present.find((c) => CAMERAS[c] === facing.ideal) ?? present[0];
  return present[0];
}

Object.defineProperty(globalThis.navigator, 'mediaDevices', {
  configurable: true,
  value: {
    getUserMedia(constraints: MediaStreamConstraints) {
      const video = constraints.video as MediaTrackConstraints;
      requests.push(video);
      return new Promise((resolve, reject) => {
        pending.push(() => {
          const failure = failNext.shift();
          if (failure) return reject(new DOMException('no', failure));
          const camera = pickCamera(video);
          if (camera instanceof DOMException) return reject(camera);
          resolve(new FakeStream([new FakeTrack('video', camera)]));
        });
      });
    },
  },
});

const saved = new Map<string, string>();
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: {
    localStorage: {
      getItem: (k: string) => saved.get(k) ?? null,
      setItem: (k: string, v: string) => saved.set(k, v),
      removeItem: (k: string) => saved.delete(k),
    },
  },
});

/** Let every queued step run, answering device requests as they come. */
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 0));
    const batch = pending;
    pending = [];
    batch.forEach((answer) => answer());
  }
}

const liveCameras = () => opened.filter((t) => t.readyState === 'live');
const streamCameras = () => (get(localStream) as unknown as FakeStream).getVideoTracks();

/** Exactly one camera is running, it's the one in the stream, and the camera is on. */
function assertOneCamera(deviceId?: string) {
  assert.equal(get(videoEnabled), true);
  assert.equal(liveCameras().length, 1, 'exactly one camera running');
  assert.equal(streamCameras().length, 1);
  assert.equal(streamCameras()[0], liveCameras()[0]);
  if (deviceId) assert.equal(streamCameras()[0].deviceId, deviceId);
}

function assertCameraOff() {
  assert.equal(get(videoEnabled), false);
  assert.equal(liveCameras().length, 0, 'no camera running');
  assert.equal(streamCameras().length, 0);
}

beforeEach(async () => {
  await settle();
  opened.length = 0;
  pending = [];
  failNext = [];
  missing = new Set();
  requests.length = 0;
  saved.clear();
  videoDevices.set(Object.keys(CAMERAS).map((deviceId) => ({ deviceId, kind: 'videoinput' }) as MediaDeviceInfo));
  const stream = new FakeStream([new FakeTrack('audio'), new FakeTrack('video', 'cam-front')]);
  await adoptMedia(stream as unknown as MediaStream, { audio: true, video: true });
});

test('flip opens the other camera and un-mirrors for the back one', async () => {
  const flip = flipCamera();
  await settle();
  assert.equal((await flip)?.getSettings().deviceId, 'cam-back');
  assertOneCamera('cam-back');
  assert.equal(get(cameraFacing), 'environment');
  assert.deepEqual(requests[0].facingMode, { exact: 'environment' });
});

test('flip and switch at the same time leave exactly one camera, whichever finished last', async () => {
  const flip = flipCamera();
  const sw = switchVideoDevice('cam-usb');
  await settle();
  await Promise.all([flip, sw]);
  assertOneCamera('cam-usb');

  const sw2 = switchVideoDevice('cam-front');
  const flip2 = flipCamera();
  await settle();
  await Promise.all([sw2, flip2]);
  assertOneCamera('cam-back');
});

test('flip and camera off at the same time: off wins, nothing keeps sending', async () => {
  const flip = flipCamera();
  const off = toggleVideo();
  await settle();
  await Promise.all([flip, off]);
  assertCameraOff();

  // Off first, then flip: the flip does nothing (it never opens a camera while it's off).
  const on = toggleVideo();
  await settle();
  await on;
  const off2 = toggleVideo();
  const flip2 = flipCamera();
  await settle();
  assert.equal(await flip2, null);
  await off2;
  assertCameraOff();
});

test('flip, switch and on/off all racing never leave a second camera running', async () => {
  const ops = [flipCamera(), switchVideoDevice('cam-usb'), toggleVideo(), flipCamera(), toggleVideo(), switchVideoDevice('cam-back')];
  await settle();
  await Promise.allSettled(ops);
  assert.ok(liveCameras().length <= 1);
  if (get(videoEnabled)) assertOneCamera();
  else assertCameraOff();
});

test('camera off and on again keeps facing the same way (front or back)', async () => {
  await Promise.all([flipCamera(), settle()]);
  await Promise.all([toggleVideo(), settle()]);
  assertCameraOff();
  await Promise.all([toggleVideo(), settle()]);
  assertOneCamera('cam-back');
  assert.equal(get(cameraFacing), 'environment');

  // The back camera's id stopped working: still the back camera, found by facing.
  await Promise.all([toggleVideo(), settle()]);
  selectedVideoDevice.set('cam-gone');
  await Promise.all([toggleVideo(), settle()]);
  assertOneCamera('cam-back');
  assert.deepEqual(requests.at(-1)!.facingMode, { ideal: 'environment' });
});

test('a phone that cannot run two cameras: released for the flip, and left off if that fails', async () => {
  failNext = ['NotReadableError'];
  await Promise.all([flipCamera(), settle()]);
  assertOneCamera('cam-back');

  failNext = ['NotReadableError', 'NotReadableError'];
  const flip = assert.rejects(flipCamera());
  await settle();
  await flip;
  assertCameraOff();
  await Promise.all([toggleVideo(), settle()]); // one tap brings it back
  assertOneCamera();
});

test('joining with the camera off: no camera track, camera on opens the camera picked before', async () => {
  stopMedia(); // a new call
  const preview = new FakeTrack('video', 'cam-usb');
  const stream = new FakeStream([new FakeTrack('audio'), preview]);
  await adoptMedia(stream as unknown as MediaStream, { audio: false, video: false, videoDeviceId: 'cam-back', facing: 'environment' });
  assert.equal(preview.readyState, 'ended');
  assertCameraOff();
  assert.equal(get(voiceOnlyMode), false);
  assert.equal(get(selectedVideoDevice), 'cam-back');
  assert.equal(get(cameraFacing), 'environment');
  assert.equal((stream.getAudioTracks()[0] as FakeTrack).enabled, false); // joined muted
  await Promise.all([toggleVideo(), settle()]);
  assertOneCamera('cam-back');
});

test('joining audio only: no camera, no camera button', async () => {
  stopMedia(); // a new call
  const stream = new FakeStream([new FakeTrack('audio')]);
  await adoptMedia(stream as unknown as MediaStream, { voiceOnly: true });
  assert.equal(get(voiceOnlyMode), true);
  assert.equal(get(videoEnabled), false);
});

test('an unplugged camera is treated as turned off, so one tap turns it back on', async () => {
  streamCameras()[0].unplug();
  assertCameraOff();
  await Promise.all([toggleVideo(), settle()]);
  assertOneCamera();
});

test('a camera picked while off is remembered only once it is the one in use', async () => {
  await Promise.all([toggleVideo(), settle()]);
  const sw = switchVideoDevice('cam-usb');
  await settle();
  assert.equal(await sw, null);
  rememberCameraWhenInUse('cam-usb');
  assert.equal(saved.size, 0);
  await Promise.all([toggleVideo(), settle()]);
  assertOneCamera('cam-usb');
  assert.equal(JSON.parse(saved.get('vchat_devices')!).videoInput, 'cam-usb');

  // Picked while off, but it's gone when the camera comes back on: the fallback isn't remembered.
  saved.clear();
  await Promise.all([toggleVideo(), settle()]);
  await Promise.all([switchVideoDevice('cam-back'), settle()]);
  rememberCameraWhenInUse('cam-back');
  missing.add('cam-back');
  await Promise.all([toggleVideo(), settle()]);
  assert.notEqual(streamCameras()[0].deviceId, 'cam-back');
  assert.equal(saved.size, 0);
});
