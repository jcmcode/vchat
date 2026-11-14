// In-call camera helpers: flipping between the front and back camera, and remembering a camera
// picked while the camera is off once it's really in use. Camera changes go through manager.ts's
// camera queue (withCamera) and putCamera, so they never overlap with turning the camera on or off
// or switching it, and only one camera is ever left running. mesh.ts follows the local stream, so
// peers get the new camera through the usual trust gate.

import { get } from 'svelte/store';
import { localStream, videoEnabled, videoDevices, cameraFacing, withCamera, putCamera } from './manager.js';
import { facingOf, openFlippedCamera, type Facing } from './camera.js';
import { insecureContextError } from './media-errors.js';
import { rememberDevice } from './device-prefs.js';

function getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream> {
  const devices = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
  return devices?.getUserMedia ? devices.getUserMedia(constraints) : Promise.reject(insecureContextError());
}

/** Phones and tablets (where a front/back camera flip makes sense). */
export function isTouchDevice(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
}

const liveCamera = (stream: MediaStream | null) =>
  stream?.getVideoTracks().find((t) => t.readyState === 'live') ?? null;

/**
 * Switch between the front and back camera (queued with turning the camera on, off and switching
 * it). Resolves to the new track, or null if the camera is off or the call ended meanwhile. If it
 * fails on a phone that can't run two cameras at once, the camera ends up off (and can be turned
 * on again).
 */
export function flipCamera(): Promise<MediaStreamTrack | null> {
  return withCamera(async () => {
    const stream = get(localStream);
    const current = liveCamera(stream);
    if (!stream || !current || !get(videoEnabled)) return null;
    let result: { track: MediaStreamTrack; facing: Facing | undefined };
    try {
      result = await openFlippedCamera(getUserMedia, current, get(videoDevices), get(cameraFacing));
    } catch (err) {
      // A phone that released the camera for the attempt: it's off now, as if turned off.
      if (current.readyState === 'ended' && get(localStream) === stream) {
        stream.removeTrack(current);
        videoEnabled.set(false);
        localStream.set(stream);
      }
      throw err;
    }
    // Turned off, or left the call, while the browser was opening it: release it again.
    if (get(localStream) !== stream || !get(videoEnabled)) {
      result.track.stop();
      return null;
    }
    putCamera(stream, result.track); // stops and removes every other camera track
    cameraFacing.set(facingOf(result.track) ?? result.facing);
    localStream.set(stream);
    return result.track;
  });
}

/** Set the facing from the camera currently in use (after joining with startMedia). */
export function syncCameraFacing(): void {
  const track = liveCamera(get(localStream));
  if (track) cameraFacing.set(facingOf(track));
}

/** A camera picked while the camera was off, waiting to be remembered once it's the one in use. */
let pickedWhileOff: { stream: MediaStream; deviceId: string } | null = null;
let stopWatchingPick: (() => void) | null = null;

function settlePick(): void {
  pickedWhileOff = null;
  const stop = stopWatchingPick;
  stopWatchingPick = null;
  stop?.();
}

/**
 * Remember `deviceId` for next time (vchat_devices) only once the camera is turned on and it's
 * really that camera (not a fallback, and not one picked again while it was starting). Forgotten
 * if the call ends first.
 */
export function rememberCameraWhenInUse(deviceId: string): void {
  const stream = get(localStream);
  if (!stream) return;
  pickedWhileOff = { stream, deviceId };
  if (stopWatchingPick) return;
  let ready = false;
  const unsubscribe = localStream.subscribe((current) => {
    const picked = pickedWhileOff;
    if (!picked || !ready) return;
    if (current !== picked.stream) return settlePick(); // left the call
    const camera = liveCamera(current);
    if (!camera) return; // still off
    if (camera.getSettings().deviceId === picked.deviceId) rememberDevice('videoInput', picked.deviceId);
    settlePick(); // the camera is on (with this camera or another): settled either way
  });
  stopWatchingPick = unsubscribe;
  ready = true;
}

const shownTrack = new WeakMap<HTMLVideoElement, string>();

/**
 * Some browsers (notably Safari on iOS) keep showing the old picture when a stream's camera track
 * is swapped. Re-attach the stream when the track changes.
 */
export function reattachOnTrackChange(el: HTMLVideoElement, track: MediaStreamTrack | null | undefined): void {
  if (!track) return;
  const previous = shownTrack.get(el);
  shownTrack.set(el, track.id);
  if (previous === undefined || previous === track.id || !el.srcObject) return;
  const stream = el.srcObject;
  el.srcObject = null;
  el.srcObject = stream;
  el.play().catch(() => {});
}
