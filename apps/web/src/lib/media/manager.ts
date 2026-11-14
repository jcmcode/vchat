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

function cameraConstraints(deviceId?: string): MediaTrackConstraints {
  return {
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 30, max: 30 },
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
  };
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

let cameraToggle: Promise<boolean> | null = null;

/**
 * Camera off really releases the camera: the track is stopped (the camera light goes off) and
 * removed from the local stream, and peers' video senders are pointed at nothing (mesh.ts follows
 * `localStream`). Camera on asks for the selected camera again, or the default one if that camera
 * is gone. If it can't be had (busy, unplugged, blocked) the camera stays off and this throws an
 * Error with a message to show. Resolves to whether the camera is now on.
 */
export function toggleVideo(): Promise<boolean> {
  if (!cameraToggle) {
    cameraToggle = (get(videoEnabled) ? turnCameraOff() : turnCameraOn()).finally(() => {
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
  cameraStarting.set(true);
  let camera: MediaStream;
  try {
    try {
      camera = await navigator.mediaDevices.getUserMedia({ video: cameraConstraints(wanted || undefined) });
    } catch (err) {
      // The chosen camera is gone: use the default one instead.
      const name = err instanceof DOMException ? err.name : '';
      if (!wanted || !['NotFoundError', 'OverconstrainedError'].includes(name)) throw err;
      camera = await navigator.mediaDevices.getUserMedia({ video: cameraConstraints() });
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
  stream.addTrack(track);
  watchCamera(track);
  const deviceId = track.getSettings().deviceId;
  if (deviceId) selectedVideoDevice.set(deviceId);
  videoEnabled.set(true);
  localStream.set(stream);
  return true;
}

export async function switchAudioDevice(deviceId: string): Promise<MediaStreamTrack | null> {
  const stream = get(localStream);
  if (!stream) return null;

  // Get the new microphone first: if it fails (busy, unplugged) the current one keeps working.
  const oldTrack = stream.getAudioTracks()[0];
  const newStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: { exact: deviceId },
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  const newTrack = newStream.getAudioTracks()[0];
  newTrack.enabled = get(audioEnabled); // stay muted if we were muted
  oldTrack?.stop();
  if (oldTrack) stream.removeTrack(oldTrack);
  stream.addTrack(newTrack);
  selectedAudioDevice.set(deviceId);

  // Trigger store update
  localStream.set(stream);
  return newTrack;
}

export async function switchVideoDevice(deviceId: string): Promise<MediaStreamTrack | null> {
  const stream = get(localStream);
  if (!stream) return null;

  // Camera off: don't open the new camera now, just use it when the camera is turned back on.
  if (!get(videoEnabled) || get(voiceOnlyMode)) {
    selectedVideoDevice.set(deviceId);
    return null;
  }

  // Get the new camera first: if it fails (busy, unplugged) the current one keeps working.
  const oldTrack = stream.getVideoTracks()[0];
  const newStream = await navigator.mediaDevices.getUserMedia({ video: cameraConstraints(deviceId) });

  const newTrack = newStream.getVideoTracks()[0];
  // Turned off (or left the call) while we waited: release the new camera again.
  if (!newTrack || !get(videoEnabled) || get(localStream) !== stream) {
    newStream.getTracks().forEach((t) => t.stop());
    return null;
  }
  oldTrack?.stop();
  if (oldTrack) stream.removeTrack(oldTrack);
  stream.addTrack(newTrack);
  watchCamera(newTrack);
  selectedVideoDevice.set(deviceId);

  localStream.set(stream);
  return newTrack;
}

export async function startScreenShare(): Promise<MediaStream | null> {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30 } },
      audio: true,
    });

    const video = stream.getVideoTracks()[0];
    // Tell the encoder this is screen content: keep text sharp and let the frame rate give way.
    if ('contentHint' in video) video.contentHint = 'detail';

    // When user stops sharing via browser UI
    video.onended = () => {
      stopScreenShare();
    };

    screenStream.set(stream);
    isScreenSharing.set(true);
    return stream;
  } catch {
    // User cancelled
    return null;
  }
}

export function stopScreenShare(): void {
  const stream = get(screenStream);
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    screenStream.set(null);
  }
  isScreenSharing.set(false);
}
