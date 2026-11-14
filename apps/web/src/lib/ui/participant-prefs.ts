// Your own view of other participants: how loud each one plays and who's pinned to the stage.
// Kept in memory for this call only (never stored, never sent to anyone).

import { get, writable } from 'svelte/store';
import { onPeerLeft, onRoomLeft } from '../webrtc/mesh.js';
import { clampVolume, DEFAULT_AUDIO_PREF, type PeerAudioPref } from './participants.js';

/**
 * Volume and "Mute for me" per participant. Kept if their connection drops and comes back (so
 * someone you muted stays muted), forgotten when you leave the call.
 */
export const peerAudioPrefs = writable<Map<string, PeerAudioPref>>(new Map());
/** The participant you pinned to the stage. Cleared when they leave. */
export const pinnedPeerId = writable<string | null>(null);

function updatePref(peerId: string, change: (prev: PeerAudioPref) => PeerAudioPref): void {
  peerAudioPrefs.update((map) => {
    const prev = map.get(peerId) ?? DEFAULT_AUDIO_PREF;
    return new Map(map).set(peerId, change(prev));
  });
}

export function setPeerVolume(peerId: string, volume: unknown): void {
  updatePref(peerId, (prev) => ({ ...prev, volume: clampVolume(volume, prev.volume) }));
}

export function setPeerMutedForMe(peerId: string, muted: boolean): void {
  updatePref(peerId, (prev) => ({ ...prev, muted: !!muted }));
}

export function pinPeer(peerId: string): void {
  pinnedPeerId.set(peerId);
}

export function unpinPeer(): void {
  pinnedPeerId.set(null);
}

export function togglePin(peerId: string): void {
  pinnedPeerId.set(get(pinnedPeerId) === peerId ? null : peerId);
}

onPeerLeft((peerId) => {
  if (get(pinnedPeerId) === peerId) pinnedPeerId.set(null);
});

onRoomLeft(() => {
  peerAudioPrefs.set(new Map());
  pinnedPeerId.set(null);
});
