// Which transceiver carries what on a peer connection: microphone, camera, shared screen.
//
// Every connection has the same layout, made by the side that sends the offer (createPeerConnection
// in mesh.ts): one audio transceiver (the microphone, mixed with shared-screen audio while
// presenting), then two video transceivers, the first for the camera and the second for a shared
// screen. All three can send and receive from the start, so turning the camera off or on and
// starting or stopping a share only changes the track a sender carries (replaceTrack, behind the
// trust gate) and never needs a renegotiation. That also means someone who joined audio-only, or
// with the camera off, can share a screen.
//
// Both sides list transceivers in m-section order: the offerer creates them in that order, and the
// answerer gets them from the offer (the offer adopts, in order, the ones it added with addTrack
// beforehand: its microphone and camera). So the first video transceiver is the camera on both
// sides. Which incoming video is a shared screen is never guessed: the sender announces the mid of
// its screen transceiver over the verified data channel, and the receiver looks that mid up only
// among the transceivers of that same connection, so a peer can only ever label its own video.
//
// Pure (works on anything shaped like RTCRtpTransceiver), so it's unit-testable.

export type Direction = 'sendrecv' | 'sendonly' | 'recvonly' | 'inactive' | 'stopped';

export interface TransceiverLike {
  mid: string | null;
  direction: Direction;
  currentDirection?: Direction | null;
  /** Deprecated in browsers, but still reported by some. */
  stopped?: boolean;
  receiver: { track: { kind: string } | null };
}

export interface Slots<T> {
  audio?: T;
  camera?: T;
  screen?: T;
}

function isLive(t: TransceiverLike): boolean {
  return !t.stopped && t.direction !== 'stopped' && t.currentDirection !== 'stopped';
}

function ofKind<T extends TransceiverLike>(ts: readonly T[], kind: 'audio' | 'video'): T[] {
  return ts.filter((t) => isLive(t) && t.receiver?.track?.kind === kind);
}

/** The transceivers we send our microphone, camera and screen on. */
export function localSlots<T extends TransceiverLike>(ts: readonly T[]): Slots<T> {
  const videos = ofKind(ts, 'video');
  return { audio: ofKind(ts, 'audio')[0], camera: videos[0], screen: videos[1] };
}

/** A mid as browsers write them ("0", "1", …; older Firefox "sdparta_0"). Anything else is refused. */
export function isValidMid(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_.{}-]{1,32}$/.test(value);
}

/**
 * The transceivers a peer's audio, camera and shared screen arrive on. `screenMid` is what that
 * peer announced (null while it isn't sharing). It only counts if it names a live video transceiver
 * of this connection; the camera is then the first other video transceiver.
 */
export function remoteSlots<T extends TransceiverLike>(ts: readonly T[], screenMid: string | null): Slots<T> {
  const videos = ofKind(ts, 'video');
  const screen = isValidMid(screenMid) ? videos.find((t) => t.mid === screenMid) : undefined;
  return { audio: ofKind(ts, 'audio')[0], camera: videos.find((t) => t !== screen), screen };
}

/**
 * Answerer: transceivers created from the remote offer start out receive-only. Let our three slots
 * send too (they still carry nothing until the connection is verified). Returns the ones changed.
 */
export function enableSending<T extends TransceiverLike>(ts: readonly T[]): T[] {
  const slots = localSlots(ts);
  const changed: T[] = [];
  for (const t of [slots.audio, slots.camera, slots.screen]) {
    if (t && (t.direction === 'recvonly' || t.direction === 'inactive')) {
      t.direction = 'sendrecv';
      changed.push(t);
    }
  }
  return changed;
}

const canSend = (d: Direction | null | undefined) => d === 'sendrecv' || d === 'sendonly';

/** Whether one of our slots wants to send but the last negotiation didn't allow it (needs another round). */
export function sendingBlocked(ts: readonly TransceiverLike[]): boolean {
  const slots = localSlots(ts);
  return [slots.audio, slots.camera, slots.screen].some(
    (t) => !!t && canSend(t.direction) && !!t.currentDirection && !canSend(t.currentDirection)
  );
}
