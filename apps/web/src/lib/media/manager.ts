import { writable, get } from 'svelte/store';

export const localStream = writable<MediaStream | null>(null);
export const screenStream = writable<MediaStream | null>(null);
export const audioEnabled = writable(true);
export const videoEnabled = writable(true);
export const isScreenSharing = writable(false);

export const audioDevices = writable<MediaDeviceInfo[]>([]);
export const videoDevices = writable<MediaDeviceInfo[]>([]);
export const audioOutputDevices = writable<MediaDeviceInfo[]>([]);
export const selectedAudioDevice = writable<string>('');
export const selectedVideoDevice = writable<string>('');
export const selectedAudioOutput = writable<string>('');
export const voiceOnlyMode = writable(false);
/** The camera is being turned back on (waiting for the device). */
export const cameraStarting = writable(false);
/** Which way the camera faces, when the browser says (phones): the self view isn't mirrored for the back one. */
export const cameraFacing = writable<'user' | 'environment' | undefined>(undefined);

function cameraConstraints(deviceId?: string, facing?: 'user' | 'environment'): MediaTrackConstraints {
  return {
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 30, max: 30 },
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    // No camera named (or it's gone): at least keep facing the same way (front or back).
    ...(!deviceId && facing ? { facingMode: { ideal: facing } } : {}),
  };
}

function facingOfTrack(track: MediaStreamTrack): 'user' | 'environment' | undefined {
  const facing = track.getSettings().facingMode;
  return facing === 'user' || facing === 'environment' ? facing : undefined;
}

export async function enumerateDevices(): Promise<void> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  audioDevices.set(devices.filter((d) => d.kind === 'audioinput'));
  videoDevices.set(devices.filter((d) => d.kind === 'videoinput'));
  audioOutputDevices.set(devices.filter((d) => d.kind === 'audiooutput'));
}

export async function startMedia(opts?: {
  audioDeviceId?: string;
  videoDeviceId?: string;
  voiceOnly?: boolean;
}): Promise<MediaStream> {
  const isVoiceOnly = opts?.voiceOnly ?? get(voiceOnlyMode);

  const constraints: MediaStreamConstraints = {
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      ...(opts?.audioDeviceId ? { deviceId: { exact: opts.audioDeviceId } } : {}),
    },
    video: isVoiceOnly ? false : cameraConstraints(opts?.videoDeviceId),
  };

  let stream: MediaStream;
  let videoUnavailable = false;
  try {
    stream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err) {
    // No camera (or camera blocked/in use) but a working mic? Join with audio only.
    const name = err instanceof DOMException ? err.name : '';
    if (isVoiceOnly || !['NotFoundError', 'NotReadableError', 'OverconstrainedError'].includes(name)) throw err;
    stream = await navigator.mediaDevices.getUserMedia({ audio: constraints.audio, video: false });
    videoUnavailable = true;
  }
  stream.getVideoTracks().forEach(watchCamera);
  localStream.set(stream);
  audioEnabled.set(true);
  videoEnabled.set(!isVoiceOnly && !videoUnavailable);
  voiceOnlyMode.set(isVoiceOnly || videoUnavailable);

  await enumerateDevices();
  return stream;
}

export function stopMedia(): void {
  const stream = get(localStream);
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    localStream.set(null);
  }
  stopScreenShare();
  audioEnabled.set(true);
  videoEnabled.set(true);
  voiceOnlyMode.set(false);
}

export function toggleAudio(): boolean {
  const stream = get(localStream);
  if (!stream) return false;

  const audioTrack = stream.getAudioTracks()[0];
  if (audioTrack) {
    audioTrack.enabled = !audioTrack.enabled;
    audioEnabled.set(audioTrack.enabled);
    return audioTrack.enabled;
  }
  return false;
}

/**
 * If the camera stops by itself (unplugged, or taken away by the system), treat it as turned off
 * so the controls, the self view and what peers are told all match.
 */
function watchCamera(track: MediaStreamTrack): void {
  track.addEventListener('ended', () => {
    const stream = get(localStream);
    if (!stream || !stream.getVideoTracks().includes(track)) return;
    stream.removeTrack(track);
    videoEnabled.set(false);
    localStream.set(stream);
  });
}

/** What to tell someone whose camera didn't turn on. */
function cameraErrorMessage(err: unknown): string {
  const name = err instanceof DOMException ? err.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return "Camera access is blocked. Allow it in your browser's site settings, then try again.";
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No camera found. Check that it is plugged in.';
  if (name === 'NotReadableError' || name === 'AbortError') {
    return 'Your camera is busy or not responding. Close other apps that may be using it, then try again.';
  }
  return "Couldn't turn the camera on.";
}

/**
 * Camera changes (on, off, switch, flip in call-camera.ts) run one at a time, so two cameras are
 * never left open.
 */
let cameraQueue: Promise<unknown> = Promise.resolve();
export function withCamera<T>(task: () => Promise<T>): Promise<T> {
  const run = cameraQueue.then(task);
  cameraQueue = run.catch(() => {});
  return run;
}

/** Make `track` the only camera in `stream`: any other one is stopped and removed. */
export function putCamera(stream: MediaStream, track: MediaStreamTrack): void {
  for (const old of stream.getVideoTracks()) {
    if (old === track) continue;
    old.stop();
    stream.removeTrack(old);
  }
  if (!stream.getVideoTracks().includes(track)) stream.addTrack(track);
  watchCamera(track);
  const deviceId = track.getSettings().deviceId;
  if (deviceId) selectedVideoDevice.set(deviceId);
  cameraFacing.set(facingOfTrack(track));
}

let cameraToggle: Promise<boolean> | null = null;

/**
 * Camera off really releases the camera: the track is stopped (the camera light goes off) and
 * removed from the local stream, and peers' video senders are pointed at nothing (mesh.ts follows
 * `localStream`). Camera on asks for the selected camera again, or the default one if that camera
 * is gone. If it can't be had (busy, unplugged, blocked) the camera stays off and this throws an
 * Error with a message to show. Resolves to whether the camera is now on. A second click while
 * one is in progress gets the same result instead of toggling again.
 */
export function toggleVideo(): Promise<boolean> {
  if (!cameraToggle) {
    cameraToggle = withCamera(() => (get(videoEnabled) ? turnCameraOff() : turnCameraOn())).finally(() => {
      cameraToggle = null;
    });
  }
  return cameraToggle;
}

async function turnCameraOff(): Promise<boolean> {
  const stream = get(localStream);
  if (!stream) return false;
  for (const track of stream.getVideoTracks()) {
    // Remember which camera this was, so turning it back on picks the same one.
    const deviceId = track.getSettings().deviceId;
    if (deviceId && !get(selectedVideoDevice)) selectedVideoDevice.set(deviceId);
    track.stop();
    stream.removeTrack(track);
  }
  videoEnabled.set(false);
  localStream.set(stream);
  return false;
}

async function turnCameraOn(): Promise<boolean> {
  const stream = get(localStream);
  if (!stream || get(voiceOnlyMode)) return false;
  const wanted = get(selectedVideoDevice);
  const facing = get(cameraFacing); // front or back, as it was before it was turned off
  cameraStarting.set(true);
  let camera: MediaStream;
  try {
    try {
      camera = await navigator.mediaDevices.getUserMedia({ video: cameraConstraints(wanted || undefined, facing) });
    } catch (err) {
      // The chosen camera is gone: use the default one (facing the same way) instead.
      const name = err instanceof DOMException ? err.name : '';
      if (!wanted || !['NotFoundError', 'OverconstrainedError'].includes(name)) throw err;
      camera = await navigator.mediaDevices.getUserMedia({ video: cameraConstraints(undefined, facing) });
    }
  } catch (err) {
    throw new Error(cameraErrorMessage(err));
  } finally {
    cameraStarting.set(false);
  }

  const track = camera.getVideoTracks()[0];
  // Left the call (or the media was restarted) while we waited: give the camera straight back.
  if (!track || get(localStream) !== stream || get(videoEnabled)) {
    camera.getTracks().forEach((t) => t.stop());
    return get(videoEnabled);
  }
  putCamera(stream, track);
  videoEnabled.set(true);
  localStream.set(stream);
  return true;
}

let microphoneSelection = 0;

export async function switchAudioDevice(deviceId: string): Promise<MediaStreamTrack | null> {
  const stream = get(localStream);
  if (!stream) return null;
  const selection = ++microphoneSelection;
  const isCurrent = () => selection === microphoneSelection && get(localStream) === stream;

  // Keep the current microphone working until the latest selection has opened.
  let newStream: MediaStream;
  try {
    newStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: { exact: deviceId },
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  } catch (error) {
    if (isCurrent()) throw error;
    return null;
  }
  const newTrack = newStream.getAudioTracks()[0];
  if (!isCurrent() || !newTrack) {
    newStream.getTracks().forEach((track) => track.stop());
    return null;
  }
  newTrack.enabled = get(audioEnabled);
  for (const previous of stream.getAudioTracks()) {
    previous.stop();
    stream.removeTrack(previous);
  }
  stream.addTrack(newTrack);
  selectedAudioDevice.set(deviceId);
  localStream.set(stream);
  return newTrack;
}

/** Switch cameras (queued with turning it on and off). Resolves to the new track, or null if the camera is off. */
export function switchVideoDevice(deviceId: string): Promise<MediaStreamTrack | null> {
  return withCamera(async () => {
    const stream = get(localStream);
    if (!stream) return null;

    // Camera off: don't open the new camera now, just use it when the camera is turned back on.
    if (!get(videoEnabled) || get(voiceOnlyMode)) {
      selectedVideoDevice.set(deviceId);
      return null;
    }

    // Get the new camera first: if it fails (busy, unplugged) the current one keeps working.
    const newStream = await navigator.mediaDevices.getUserMedia({ video: cameraConstraints(deviceId) });
    const newTrack = newStream.getVideoTracks()[0];
    // Turned off (or left the call) while we waited: release the new camera again.
    if (!newTrack || !get(videoEnabled) || get(localStream) !== stream) {
      newStream.getTracks().forEach((t) => t.stop());
      return null;
    }
    putCamera(stream, newTrack);
    selectedVideoDevice.set(deviceId);
    localStream.set(stream);
    return newTrack;
  });
}

let pendingScreenPicker: symbol | null = null;

export async function startScreenShare(): Promise<MediaStream | null> {
  if (pendingScreenPicker || get(screenStream)) return null;
  const request = Symbol();
  pendingScreenPicker = request;
  try {
    // The picker controls which sources include audio. Preserve music and movie sound and
    // ask the browser to exclude this call's own audio when capturing the entire display.
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30 } },
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        restrictOwnAudio: true,
      } as MediaTrackConstraints,
      systemAudio: 'include',
    } as DisplayMediaStreamOptions);

    const video = stream.getVideoTracks()[0];
    if (pendingScreenPicker !== request || !video || video.readyState === 'ended') {
      stream.getTracks().forEach((track) => track.stop());
      return null;
    }

    // Tell the encoder this is screen content: keep text sharp and let the frame rate give way.
    if ('contentHint' in video) video.contentHint = 'detail';

    // When user stops sharing via browser UI
    video.onended = () => {
      if (get(screenStream) === stream) stopScreenShare();
    };
    for (const sound of stream.getAudioTracks()) {
      if (sound.readyState === 'ended') stream.removeTrack(sound);
      else sound.addEventListener('ended', () => {
        stream.removeTrack(sound);
        if (get(screenStream) === stream) screenStream.set(stream);
      }, { once: true });
    }

    screenStream.set(stream);
    isScreenSharing.set(true);
    return stream;
  } catch {
    return null;
  } finally {
    if (pendingScreenPicker === request) pendingScreenPicker = null;
  }
}

export function stopScreenShare(): void {
  pendingScreenPicker = null;
  const stream = get(screenStream);
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    screenStream.set(null);
  }
  isScreenSharing.set(false);
}

/**
 * Use a stream that's already open (the pre-join preview) instead of opening the devices again,
 * as startMedia would. `audio: false` joins muted (the track stays open, sending silence).
 * `video: false` joins with the camera off, in the same state turning it off leaves: no camera
 * track at all (any that came along is stopped), so the camera isn't held, and turning it on asks
 * for `videoDeviceId` (facing `facing`). `voiceOnly` is audio only: no camera at all.
 */
export async function adoptMedia(
  stream: MediaStream,
  opts: {
    audio?: boolean;
    video?: boolean;
    voiceOnly?: boolean;
    audioDeviceId?: string;
    videoDeviceId?: string;
    facing?: 'user' | 'environment';
  } = {}
): Promise<MediaStream> {
  const voiceOnly = !!opts.voiceOnly;
  // At most one live camera, and none when joining with it off (or audio only).
  let camera: MediaStreamTrack | undefined;
  for (const track of stream.getVideoTracks()) {
    if (!camera && !voiceOnly && opts.video !== false && track.readyState === 'live') {
      camera = track;
      continue;
    }
    track.stop();
    stream.removeTrack(track);
  }
  if (camera) {
    camera.enabled = true;
    watchCamera(camera); // unplugged: treated as turned off, so one tap turns it back on
  }
  const audioTrack = stream.getAudioTracks()[0];
  const audioOn = !!audioTrack && opts.audio !== false;
  if (audioTrack) audioTrack.enabled = audioOn;

  selectedAudioDevice.set(audioTrack?.getSettings().deviceId || opts.audioDeviceId || '');
  selectedVideoDevice.set(camera?.getSettings().deviceId || opts.videoDeviceId || '');
  cameraFacing.set((camera && facingOfTrack(camera)) ?? opts.facing);
  audioEnabled.set(audioOn);
  videoEnabled.set(!!camera);
  voiceOnlyMode.set(voiceOnly);
  localStream.set(stream);

  await enumerateDevices().catch(() => {});
  return stream;
}
