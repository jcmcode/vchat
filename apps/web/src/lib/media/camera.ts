// Camera and microphone helpers shared by the pre-join preview and the call: constraints, front/back
// camera flipping and opening a camera on phones that can only run one at a time. Nothing here
// touches a device by itself: callers pass in getUserMedia.

export type Facing = 'user' | 'environment';

/** Same processing as manager.ts uses for the call. */
export const MIC_PROCESSING = { echoCancellation: true, noiseSuppression: true, autoGainControl: true } as const;
/** Same quality as manager.ts uses for the call. */
export const CAMERA_QUALITY = {
  width: { ideal: 1280 },
  height: { ideal: 720 },
  frameRate: { ideal: 30, max: 30 },
} as const;

export interface DeviceChoice {
  deviceId?: string;
  /** true when the user just picked this device; false for a remembered one (falls back if it's gone). */
  exact?: boolean;
}

export function audioConstraints(choice: DeviceChoice = {}): MediaTrackConstraints {
  return {
    ...MIC_PROCESSING,
    ...(choice.deviceId ? { deviceId: choice.exact ? { exact: choice.deviceId } : { ideal: choice.deviceId } } : {}),
  };
}

export function videoConstraints(choice: DeviceChoice & { facingMode?: Facing; exactFacing?: boolean } = {}): MediaTrackConstraints {
  return {
    width: { ...CAMERA_QUALITY.width },
    height: { ...CAMERA_QUALITY.height },
    frameRate: { ...CAMERA_QUALITY.frameRate },
    ...(choice.deviceId ? { deviceId: choice.exact ? { exact: choice.deviceId } : { ideal: choice.deviceId } } : {}),
    ...(choice.facingMode && !choice.deviceId
      ? { facingMode: choice.exactFacing ? { exact: choice.facingMode } : { ideal: choice.facingMode } }
      : {}),
  };
}

/** Which way a camera track faces, when the browser says (phones do; most webcams don't). */
export function facingOf(track: Pick<MediaStreamTrack, 'getSettings'> | null | undefined): Facing | undefined {
  const facing = track?.getSettings?.().facingMode;
  return facing === 'user' || facing === 'environment' ? facing : undefined;
}

export function nextFacing(current: Facing | undefined): Facing {
  return current === 'environment' ? 'user' : 'environment';
}

/** The self-view is mirrored like a mirror, except for a back camera (text would read backwards). */
export function shouldMirror(facing: Facing | undefined): boolean {
  return facing !== 'environment';
}

/** The camera after `currentId` in the list (wrapping round), or null if there's no other camera. */
export function nextDeviceId(devices: readonly { deviceId: string }[], currentId: string | undefined): string | null {
  const ids = devices.map((d) => d.deviceId).filter((id) => !!id);
  if (ids.length < 2) return null;
  const at = currentId ? ids.indexOf(currentId) : -1;
  const next = ids[(at + 1) % ids.length];
  return next === currentId ? null : next;
}

export function errorName(err: unknown): string {
  return err && typeof err === 'object' && 'name' in err ? String((err as { name: unknown }).name) : '';
}

type GetUserMedia = (constraints: MediaStreamConstraints) => Promise<{ getTracks(): MediaStreamTrack[] }>;

function notFound(): Error {
  return Object.assign(new Error('No matching device'), { name: 'NotFoundError' });
}

/** Open one track of `kind`. Any other track that comes back is stopped straight away. */
export async function openTrack(
  getUserMedia: GetUserMedia,
  kind: 'audio' | 'video',
  constraints: MediaTrackConstraints
): Promise<MediaStreamTrack> {
  const stream = await getUserMedia(kind === 'audio' ? { audio: constraints, video: false } : { audio: false, video: constraints });
  const tracks = stream.getTracks();
  const track = tracks.find((t) => t.kind === kind);
  for (const t of tracks) if (t !== track) t.stop();
  if (!track) throw notFound();
  return track;
}

/** The camera can't be opened right now: in use, or the device can't run two cameras at once. */
function isBusy(err: unknown): boolean {
  const name = errorName(err);
  return name === 'NotReadableError' || name === 'AbortError' || name === 'TrackStartError';
}

/**
 * Open a camera. Many phones can't run two cameras at once, so if that fails because the camera is
 * busy, `current` is released and it's tried once more. If that fails too, `current` stays stopped
 * (the camera is simply off) and the error is thrown.
 */
export async function openCamera(
  getUserMedia: GetUserMedia,
  constraints: MediaTrackConstraints,
  current: MediaStreamTrack | null
): Promise<MediaStreamTrack> {
  try {
    return await openTrack(getUserMedia, 'video', constraints);
  } catch (err) {
    if (!current || current.readyState !== 'live' || !isBusy(err)) throw err;
    current.stop();
    return openTrack(getUserMedia, 'video', constraints);
  }
}

/**
 * Switch between the front and back camera. Where no camera faces the other way (two webcams on a
 * touch laptop, say), the next camera in `devices` is used instead.
 */
export async function openFlippedCamera(
  getUserMedia: GetUserMedia,
  current: MediaStreamTrack,
  devices: readonly { deviceId: string }[],
  facingHint?: Facing
): Promise<{ track: MediaStreamTrack; facing: Facing | undefined }> {
  const target = nextFacing(facingOf(current) ?? facingHint);
  try {
    const track = await openCamera(getUserMedia, videoConstraints({ facingMode: target, exactFacing: true }), current);
    return { track, facing: facingOf(track) ?? target };
  } catch (err) {
    const name = errorName(err);
    if ((name !== 'OverconstrainedError' && name !== 'NotFoundError') || current.readyState !== 'live') throw err;
    const next = nextDeviceId(devices, current.getSettings().deviceId);
    if (!next) throw err;
    const track = await openCamera(getUserMedia, videoConstraints({ deviceId: next, exact: true }), current);
    return { track, facing: facingOf(track) };
  }
}
