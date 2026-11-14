// In-call camera helpers: flipping between the front and back camera, opening the camera when you
// joined with it off, and the stand-in track that makes joining with the camera off possible.
// These only change the local stream; the caller hands the new track to the call with
// replaceTrackOnAllPeers (mesh.ts), which holds it back from any connection that isn't verified.

import { get, writable } from 'svelte/store';
import { localStream, videoEnabled, selectedVideoDevice, videoDevices } from './manager.js';
import { facingOf, openFlippedCamera, openTrack, videoConstraints, type Facing } from './camera.js';
import { insecureContextError } from './media-errors.js';

/** Which way your camera faces (undefined: the browser doesn't say, as for most webcams). */
export const cameraFacing = writable<Facing | undefined>(undefined);

function getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream> {
  const devices = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
  return devices?.getUserMedia ? devices.getUserMedia(constraints) : Promise.reject(insecureContextError());
}

/** Phones and tablets (where a front/back camera flip makes sense). */
export function isTouchDevice(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
}

/**
 * A stand-in for a camera that's off when you join: an already-stopped video track from a canvas,
 * so no device is touched and nothing is ever sent. It gives every connection a video sender, so
 * the camera can be turned on later in the call. null if the browser can't make one.
 */
export function stoppedVideoPlaceholder(): MediaStreamTrack | null {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 2;
    canvas.height = 2;
    const track = canvas.captureStream(0).getVideoTracks()[0] ?? null;
    track?.stop();
    return track;
  } catch {
    return null;
  }
}

/** The camera was released (joined with it off, or a flip failed): turning it on must reopen it. */
export function cameraNeedsReopen(): boolean {
  const track = get(localStream)?.getVideoTracks()[0];
  return !!track && track.readyState === 'ended';
}

const isEnded = (track: MediaStreamTrack) => track.readyState === 'ended';

let busy: Promise<MediaStreamTrack | null> | null = null;

/** Run one camera change at a time (a double tap must not open two cameras). */
function exclusive(run: () => Promise<MediaStreamTrack | null>): Promise<MediaStreamTrack | null> {
  if (!busy) busy = run().finally(() => (busy = null));
  return busy;
}

/** Put `track` in place of the stream's current camera track. */
function useCameraTrack(stream: MediaStream, track: MediaStreamTrack, facing: Facing | undefined): void {
  const old = stream.getVideoTracks()[0];
  if (old && old !== track) {
    old.stop();
    stream.removeTrack(old);
  }
  stream.addTrack(track);
  selectedVideoDevice.set(track.getSettings().deviceId ?? get(selectedVideoDevice));
  cameraFacing.set(facing);
  localStream.set(stream);
}

/**
 * Open the camera again after it was released (the call's "camera on" when you joined with it
 * off). Returns the new track, or null if there was nothing to reopen or the call ended meanwhile.
 */
export function reopenCamera(): Promise<MediaStreamTrack | null> {
  return exclusive(async () => {
    const stream = get(localStream);
    const old = stream?.getVideoTracks()[0];
    if (!stream || !old || old.readyState !== 'ended') return null;
    const deviceId = get(selectedVideoDevice);
    const facing = get(cameraFacing);
    const track = await openTrack(
      getUserMedia,
      'video',
      videoConstraints(deviceId ? { deviceId, exact: false } : { facingMode: facing })
    );
    // Left the call (or the camera changed) while the browser was opening it: release it again.
    if (get(localStream) !== stream || stream.getVideoTracks()[0] !== old) {
      track.stop();
      return null;
    }
    track.enabled = true;
    useCameraTrack(stream, track, facingOf(track) ?? facing);
    videoEnabled.set(true);
    return track;
  });
}

/**
 * Switch between the front and back camera. Returns the new track, or null if the camera is off
 * or the call ended meanwhile. If it fails on a phone that can't run two cameras at once, the
 * camera ends up off (and can be turned on again).
 */
export function flipCamera(): Promise<MediaStreamTrack | null> {
  return exclusive(async () => {
    const stream = get(localStream);
    const current = stream?.getVideoTracks()[0];
    if (!stream || !current || current.readyState !== 'live' || !get(videoEnabled)) return null;
    let result: { track: MediaStreamTrack; facing: Facing | undefined };
    try {
      result = await openFlippedCamera(getUserMedia, current, get(videoDevices), get(cameraFacing));
    } catch (err) {
      // A phone that released the camera for the attempt: it's off now (and can be turned on again).
      if (isEnded(current) && get(localStream) === stream) videoEnabled.set(false);
      throw err;
    }
    if (get(localStream) !== stream || stream.getVideoTracks()[0] !== current) {
      result.track.stop();
      return null;
    }
    result.track.enabled = get(videoEnabled);
    useCameraTrack(stream, result.track, result.facing);
    return result.track;
  });
}

/** Set the facing from the camera currently in use (after joining or switching cameras). */
export function syncCameraFacing(): void {
  const track = get(localStream)?.getVideoTracks()[0];
  if (track && track.readyState === 'live') cameraFacing.set(facingOf(track));
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
