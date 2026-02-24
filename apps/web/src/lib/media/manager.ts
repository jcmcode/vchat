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
    video: isVoiceOnly
      ? false
      : {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30, max: 30 },
          ...(opts?.videoDeviceId ? { deviceId: { exact: opts.videoDeviceId } } : {}),
        },
  };

  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  localStream.set(stream);

  if (isVoiceOnly) {
    voiceOnlyMode.set(true);
    videoEnabled.set(false);
  }

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

export function toggleVideo(): boolean {
  const stream = get(localStream);
  if (!stream) return false;

  const videoTrack = stream.getVideoTracks()[0];
  if (videoTrack) {
    videoTrack.enabled = !videoTrack.enabled;
    videoEnabled.set(videoTrack.enabled);
    return videoTrack.enabled;
  }
  return false;
}

export async function switchAudioDevice(deviceId: string): Promise<MediaStreamTrack | null> {
  const stream = get(localStream);
  if (!stream) return null;

  // Stop old audio track
  const oldTrack = stream.getAudioTracks()[0];
  if (oldTrack) oldTrack.stop();

  // Get new audio
  const newStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: { exact: deviceId },
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  const newTrack = newStream.getAudioTracks()[0];
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

  // Stop old video track
  const oldTrack = stream.getVideoTracks()[0];
  if (oldTrack) oldTrack.stop();

  // Get new video
  const newStream = await navigator.mediaDevices.getUserMedia({
    video: {
      deviceId: { exact: deviceId },
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30, max: 30 },
    },
  });

  const newTrack = newStream.getVideoTracks()[0];
  if (oldTrack) stream.removeTrack(oldTrack);
  stream.addTrack(newTrack);
  selectedVideoDevice.set(deviceId);

  localStream.set(stream);
  return newTrack;
}

export async function startScreenShare(): Promise<MediaStream | null> {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30 } },
      audio: false,
    });

    // When user stops sharing via browser UI
    stream.getVideoTracks()[0].onended = () => {
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
