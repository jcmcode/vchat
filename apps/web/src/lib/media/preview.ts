// The pre-join preview: opens the camera and microphone only for the mode the user chose, releases
// them as soon as they aren't needed, and hands the open tracks to the call so the devices aren't
// opened twice.
//
// Every request is tagged per kind (audio/video). A newer request, a mode change, turning the
// camera off, cancelling or joining makes older requests stale, and a stale result is stopped the
// moment it arrives, so a slow permission prompt can never leave the camera on behind your back.

import {
  audioConstraints,
  videoConstraints,
  facingOf,
  openTrack,
  openCamera,
  openFlippedCamera,
  type DeviceChoice,
  type Facing,
} from './camera.js';
import { classifyMediaError, insecureContextError, type MediaProblem } from './media-errors.js';

export type JoinMode = 'video' | 'audio' | 'chat';
type Kind = 'audio' | 'video';
type TrackKey = 'audioTrack' | 'videoTrack';

export interface PreviewSnapshot {
  /** idle: nothing opened (yet); requesting: waiting for the browser or its permission prompt. */
  status: 'idle' | 'requesting' | 'live' | 'error';
  audioTrack: MediaStreamTrack | null;
  videoTrack: MediaStreamTrack | null;
  /** Join with the microphone on (off = muted: the track stays open but sends silence). */
  micOn: boolean;
  /** Join with the camera on (off = the camera is released). */
  camOn: boolean;
  facing: Facing | undefined;
  /** Nothing usable could be opened (the microphone, or both). */
  problem: MediaProblem | null;
  /** The microphone works but the camera couldn't be used. */
  cameraProblem: MediaProblem | null;
}

type GetUserMedia = (constraints: MediaStreamConstraints) => Promise<{ getTracks(): MediaStreamTrack[] }>;

export interface PreviewEnv {
  /** Missing where the browser offers no camera/microphone API (e.g. a plain http page). */
  getUserMedia?: GetUserMedia;
  /** Permissions API state ('granted', 'denied', 'prompt'), so a retry never causes a second prompt. */
  permission?: (name: 'camera' | 'microphone') => Promise<string>;
}

export interface HandOff {
  audioTrack: MediaStreamTrack | null;
  videoTrack: MediaStreamTrack | null;
  micOn: boolean;
  camOn: boolean;
  facing: Facing | undefined;
  /** The camera to open if it's turned on later in the call ('' = any). */
  videoDevice: string;
}

/** What the pre-join screen (PreJoin.svelte) hands to the call. */
export interface PreJoinResult {
  name: string;
  mode: JoinMode;
  hideIp: boolean;
  /** The open microphone, and the camera if it's on (none when joining with it off). null: chat only. */
  stream: MediaStream | null;
  micOn: boolean;
  camOn: boolean;
  /** Audio only: no camera at all (chosen, or none was found), so the call offers no camera button. */
  voiceOnly: boolean;
  facing: Facing | undefined;
  /** The camera to open if it's turned on later ('' = any). */
  videoDeviceId: string;
}

const isLive = (t: MediaStreamTrack | null): t is MediaStreamTrack => !!t && t.readyState === 'live';
const keyOf = (kind: Kind): TrackKey => (kind === 'audio' ? 'audioTrack' : 'videoTrack');
const trackPatch = (kind: Kind, track: MediaStreamTrack | null): Partial<PreviewSnapshot> =>
  kind === 'audio' ? { audioTrack: track } : { videoTrack: track };

export class MediaPreview {
  private state: PreviewSnapshot = {
    status: 'idle',
    audioTrack: null,
    videoTrack: null,
    micOn: true,
    camOn: true,
    facing: undefined,
    problem: null,
    cameraProblem: null,
  };
  private readonly subscribers = new Set<(s: PreviewSnapshot) => void>();
  private mode: JoinMode = 'chat';
  /** The user has asked for media at least once (until then, nothing is ever opened). */
  private started = false;
  private closed = false;
  private inflight = 0;
  private readonly gen: Record<Kind, number> = { audio: 0, video: 0 };
  private readonly endedListeners = new Map<MediaStreamTrack, () => void>();
  private audioChoice: DeviceChoice;
  private videoChoice: DeviceChoice;

  constructor(
    private readonly env: PreviewEnv,
    remembered: { audioDevice?: string; videoDevice?: string } = {}
  ) {
    this.audioChoice = { deviceId: remembered.audioDevice || undefined, exact: false };
    this.videoChoice = { deviceId: remembered.videoDevice || undefined, exact: false };
  }

  /** Svelte store contract. */
  subscribe(run: (s: PreviewSnapshot) => void): () => void {
    this.subscribers.add(run);
    run(this.state);
    return () => {
      this.subscribers.delete(run);
    };
  }

  get snapshot(): PreviewSnapshot {
    return this.state;
  }

  /** Open what `mode` needs and release what it doesn't. Only call this on the user's choice. */
  async use(mode: JoinMode): Promise<void> {
    if (this.closed) return;
    this.mode = mode;
    if (mode === 'chat') {
      this.release('audio');
      this.release('video');
      this.update({ problem: null, cameraProblem: null });
      return;
    }
    this.started = true;
    if (mode === 'audio') {
      this.release('video');
      this.update({ cameraProblem: null });
    }
    await this.fill();
  }

  /** Mute or unmute (the microphone stays open, like muting in the call). */
  setMic(on: boolean): void {
    if (this.state.audioTrack) this.state.audioTrack.enabled = on;
    this.update({ micOn: on });
  }

  /** Camera off releases the camera; camera on reopens it (if the preview has been started). */
  async setCamera(on: boolean): Promise<void> {
    if (!on) {
      this.update({ camOn: false, cameraProblem: null });
      this.release('video');
      return;
    }
    this.update({ camOn: true });
    if (this.started && this.mode === 'video') await this.fill();
  }

  /** Use the microphone the user picked. If it fails, the current one keeps working. */
  async useMic(deviceId: string): Promise<void> {
    const previous = this.audioChoice;
    this.audioChoice = { deviceId, exact: true };
    if (!this.started || !this.wants('audio')) return;
    const token = ++this.gen.audio;
    this.inflight++;
    this.update();
    try {
      const track = await openTrack(this.gum, 'audio', audioConstraints(this.audioChoice));
      this.install([track], { audio: token, video: -1 });
    } catch (err) {
      this.audioChoice = previous;
      throw err;
    } finally {
      this.inflight--;
      this.update();
    }
  }

  /** Use the camera the user picked. */
  async useCamera(deviceId: string): Promise<void> {
    this.videoChoice = { deviceId, exact: true };
    if (!this.started || !this.wants('video')) return;
    await this.replaceCamera(async (current) => ({
      track: await openCamera(this.gum, videoConstraints(this.videoChoice), current),
      facing: undefined,
    }));
  }

  /** Switch between the front and back camera (phones and tablets). */
  async flip(devices: readonly { deviceId: string }[]): Promise<void> {
    const current = this.state.videoTrack;
    if (!isLive(current) || !this.wants('video')) return;
    await this.replaceCamera(async (cur) => {
      const flipped = await openFlippedCamera(this.gum, cur ?? current, devices, this.state.facing);
      // Reopen this camera if it's turned off and on again (it isn't remembered for next time).
      this.videoChoice = { deviceId: flipped.track.getSettings().deviceId || undefined, exact: false };
      return flipped;
    });
  }

  /**
   * Give the open tracks to the call. The preview forgets them (stop() no longer stops them), and
   * any request still in flight is stopped when it arrives.
   */
  handOff(): HandOff {
    const { audioTrack, videoTrack, micOn, camOn, facing } = this.state;
    this.closed = true;
    this.gen.audio++;
    this.gen.video++;
    const keepAudio = this.mode !== 'chat' && isLive(audioTrack);
    const keepVideo = this.mode === 'video' && camOn && isLive(videoTrack);
    for (const [track, keep] of [[audioTrack, keepAudio], [videoTrack, keepVideo]] as const) {
      if (track && keep) this.unwatch(track);
      else if (track) this.drop(track);
    }
    this.update({ audioTrack: null, videoTrack: null });
    return {
      audioTrack: keepAudio ? audioTrack : null,
      videoTrack: keepVideo ? videoTrack : null,
      micOn,
      camOn: camOn && this.mode === 'video',
      facing,
      videoDevice: this.videoChoice.deviceId ?? '',
    };
  }

  /**
   * The page was hidden: release the camera and microphone and drop any request in flight, but
   * keep the choices (mode, mute, camera off, devices). Nothing is reopened until the user asks
   * again, so the preview shows "Check camera & mic" when they come back.
   */
  suspend(): void {
    if (this.closed) return;
    this.started = false;
    this.release('audio');
    this.release('video');
    this.update({ problem: null, cameraProblem: null });
  }

  /** Release everything (cancel, leaving the page). Safe to call more than once. */
  stop(): void {
    this.closed = true;
    this.release('audio');
    this.release('video');
  }

  // ── internals ────────────────────────────────────────────────────────────

  private readonly gum: GetUserMedia = (constraints) => {
    const getUserMedia = this.env.getUserMedia;
    return getUserMedia ? getUserMedia(constraints) : Promise.reject(insecureContextError());
  };

  private update(patch: Partial<PreviewSnapshot> = {}): void {
    const next = { ...this.state, ...patch };
    next.status =
      this.inflight > 0 ? 'requesting' : next.audioTrack || next.videoTrack ? 'live' : next.problem ? 'error' : 'idle';
    this.state = next;
    for (const run of this.subscribers) run(next);
  }

  private wants(kind: Kind): boolean {
    if (this.closed || this.mode === 'chat') return false;
    return kind === 'audio' || (this.mode === 'video' && this.state.camOn);
  }

  /** A result for `token` may still be used: nothing newer was asked for, and it's still wanted. */
  private isCurrent(kind: Kind, token: number): boolean {
    return token === this.gen[kind] && this.wants(kind);
  }

  private async permission(name: 'camera' | 'microphone'): Promise<string> {
    try {
      return (await this.env.permission?.(name)) ?? 'unknown';
    } catch {
      return 'unknown';
    }
  }

  /** Open whatever the current mode needs but doesn't have (or lost, e.g. a device was unplugged). */
  private async fill(): Promise<void> {
    const audio = this.wants('audio') && !isLive(this.state.audioTrack);
    const video = this.wants('video') && !isLive(this.state.videoTrack);
    if (audio || video) await this.open(audio, video);
  }

  private async open(audio: boolean, video: boolean): Promise<void> {
    const token = { audio: audio ? ++this.gen.audio : -1, video: video ? ++this.gen.video : -1 };
    let micOnly = false;
    this.inflight++;
    this.update(video ? { problem: null, cameraProblem: null } : { problem: null });
    try {
      try {
        const stream = await this.gum({
          audio: audio ? audioConstraints(this.audioChoice) : false,
          video: video ? videoConstraints(this.videoChoice) : false,
        });
        this.install(stream.getTracks(), token);
      } catch (err) {
        if (!(audio && video)) throw err;
        // Both were asked for at once. If the camera is the problem, carry on with the microphone
        // alone, but never by causing a second permission prompt.
        const kind = classifyMediaError(err);
        const micAllowed = kind === 'denied' && (await this.permission('microphone')) === 'granted';
        if (kind !== 'notfound' && kind !== 'busy' && !micAllowed) throw err;
        if (!this.isCurrent('audio', token.audio)) return;
        micOnly = true;
        const track = await openTrack(this.gum, 'audio', audioConstraints(this.audioChoice));
        this.install([track], { audio: token.audio, video: -1 });
        if (this.isCurrent('video', token.video)) this.update({ cameraProblem: { kind, devices: 'camera' } });
      }
    } catch (err) {
      const audioCurrent = audio && this.isCurrent('audio', token.audio);
      const videoCurrent = video && this.isCurrent('video', token.video);
      const kind = classifyMediaError(err);
      if (audioCurrent) this.update({ problem: { kind, devices: video && !micOnly ? 'both' : 'microphone' } });
      else if (videoCurrent) this.update({ cameraProblem: { kind, devices: 'camera' } });
      // (Otherwise the request was abandoned: mode changed, camera turned off, cancelled.)
    } finally {
      this.inflight--;
      this.update();
    }
  }

  private async replaceCamera(
    openNew: (current: MediaStreamTrack | null) => Promise<{ track: MediaStreamTrack; facing: Facing | undefined }>
  ): Promise<void> {
    const token = ++this.gen.video;
    this.inflight++;
    this.update({ cameraProblem: null });
    try {
      const { track, facing } = await openNew(this.state.videoTrack);
      this.install([track], { audio: -1, video: token });
      if (facing && this.state.videoTrack === track) this.update({ facing });
    } catch (err) {
      // On phones the current camera may have been released for the attempt: it's now off.
      const current = this.state.videoTrack;
      if (current && !isLive(current)) {
        this.unwatch(current);
        this.update({ videoTrack: null });
      }
      throw err;
    } finally {
      this.inflight--;
      this.update();
    }
  }

  private install(tracks: MediaStreamTrack[], token: Record<Kind, number>): void {
    let patch: Partial<PreviewSnapshot> = {};
    for (const track of tracks) {
      const kind = track.kind === 'audio' || track.kind === 'video' ? track.kind : null;
      if (!kind || !this.isCurrent(kind, token[kind])) {
        track.stop();
        continue;
      }
      const old = this.state[keyOf(kind)];
      if (old && old !== track) this.drop(old);
      if (kind === 'audio') track.enabled = this.state.micOn;
      else patch.facing = facingOf(track);
      this.watch(track, kind);
      patch = { ...patch, ...trackPatch(kind, track) };
    }
    this.update(patch);
  }

  /** A device that's unplugged (or whose permission is revoked) ends its track: forget it. */
  private watch(track: MediaStreamTrack, kind: Kind): void {
    const onEnded = () => {
      if (this.state[keyOf(kind)] !== track) return;
      this.unwatch(track);
      this.update(trackPatch(kind, null));
    };
    this.endedListeners.set(track, onEnded);
    track.addEventListener('ended', onEnded);
  }

  private unwatch(track: MediaStreamTrack): void {
    const onEnded = this.endedListeners.get(track);
    if (!onEnded) return;
    track.removeEventListener('ended', onEnded);
    this.endedListeners.delete(track);
  }

  private drop(track: MediaStreamTrack): void {
    this.unwatch(track);
    track.stop();
  }

  private release(kind: Kind): void {
    this.gen[kind]++;
    const track = this.state[keyOf(kind)];
    if (!track) return;
    this.drop(track);
    this.update(trackPatch(kind, null));
  }
}

/** The real browser environment. */
export function browserPreviewEnv(): PreviewEnv {
  const devices = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
  return {
    getUserMedia: devices?.getUserMedia ? (constraints) => devices.getUserMedia(constraints) : undefined,
    permission: async (name) => (await navigator.permissions.query({ name: name as PermissionName })).state,
  };
}
