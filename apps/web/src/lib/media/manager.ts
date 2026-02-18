import { writable, get } from 'svelte/store';

export const localStream = writable<MediaStream | null>(null);
export const screenStream = writable<MediaStream | null>(null);
export const audioEnabled = writable(true);
export const videoEnabled = writable(true);
export const isScreenSharing = writable(false);

export async function startMedia(): Promise<MediaStream> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    video: {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30, max: 30 },
    },
  });
  localStream.set(stream);
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
