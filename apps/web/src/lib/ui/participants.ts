// Per-viewer participant choices: what's on the stage, and how loud each person plays.
// Pure logic, unit-tested in participants.test.ts. Nothing here is ever sent to anyone.

import { pickPresenter } from '../webrtc/media-slots.js';

export type StageKind = 'whiteboard' | 'games' | 'local-screen' | 'remote-screen' | 'pinned';

export interface StageInput {
  /** You opened the whiteboard. */
  whiteboardOpen: boolean;
  /** You opened the games view. */
  gamesOpen?: boolean;
  /** You are sharing your screen. */
  localSharing: boolean;
  /** Remote participants who say they're sharing their screen (oldest first). */
  sharingPeers: Iterable<string>;
  /** Whether we're actually receiving that participant's screen. */
  hasScreen: (peerId: string) => boolean;
  /** Remote participants currently in the call. */
  peerIds: Iterable<string>;
  /** The participant you pinned, if any. */
  pinned: string | null;
}

export interface StageLayout {
  stage: StageKind | null;
  /** The remote participant shown on the stage (remote screen or pinned). */
  stagePeerId: string | null;
  /** While your pin holds the stage: someone else sharing their screen (offer to view it). */
  otherSharer: string | null;
}

/**
 * What takes the big stage, in order: the whiteboard or the games view (if you opened it), your own screen share,
 * the person you pinned (their screen, if it's arriving), then the latest remote screen that's
 * actually arriving (pickPresenter, so a bare claim can't take the stage). Your pin outranks other
 * people's shares; while it does, `otherSharer` names the presenter you can switch to. A pin for
 * someone who isn't in the call counts for nothing. With no stage, everyone is in the grid.
 */
export function selectStage(input: StageInput): StageLayout {
  const none = { stagePeerId: null, otherSharer: null };
  if (input.whiteboardOpen) return { stage: 'whiteboard', ...none };
  if (input.gamesOpen) return { stage: 'games', ...none };
  if (input.localSharing) return { stage: 'local-screen', ...none };
  const present = new Set(input.peerIds);
  const sharers = [...input.sharingPeers];
  const presenter = pickPresenter(sharers, (id) => present.has(id) && input.hasScreen(id));
  const pinned = input.pinned && present.has(input.pinned) ? input.pinned : null;
  if (pinned) {
    if (sharers.includes(pinned) && input.hasScreen(pinned)) return { stage: 'remote-screen', stagePeerId: pinned, otherSharer: null };
    return { stage: 'pinned', stagePeerId: pinned, otherSharer: presenter };
  }
  if (presenter) return { stage: 'remote-screen', stagePeerId: presenter, otherSharer: null };
  return { stage: null, ...none };
}

/** How you hear one participant: volume in percent (0–100) and "Mute for me". */
export interface PeerAudioPref {
  volume: number;
  muted: boolean;
}

export const DEFAULT_AUDIO_PREF: Readonly<PeerAudioPref> = Object.freeze({ volume: 100, muted: false });

/** A whole percentage between 0 and 100; anything that isn't a number keeps `fallback`. */
export function clampVolume(value: unknown, fallback = 100): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(100, Math.max(0, Math.round(n)));
}

/** What to set on the participant's media element: `volume` (0..1) and `muted`. */
export function playbackFor(pref: PeerAudioPref | undefined): { volume: number; muted: boolean } {
  const volume = clampVolume(pref?.volume ?? 100);
  return { volume: volume / 100, muted: !!pref?.muted || volume === 0 };
}

/** Whether you've silenced this participant for yourself (muted, or the volume all the way down). */
export function isSilencedForMe(pref: PeerAudioPref | undefined): boolean {
  return playbackFor(pref).muted;
}
