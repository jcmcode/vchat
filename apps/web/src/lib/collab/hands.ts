// Raise hand: each person raises or lowers only their own hand, and everyone sees it on their tile.
// Sent peer-to-peer over the end-to-end encrypted data channels; the server never sees it.
// Validation, rate limiting and notice rules live in hand-model.ts.

import { get, writable } from 'svelte/store';
import {
  broadcastData,
  getPeerConnection,
  onPeerConnected,
  onPeerCreated,
  onPeerLeft,
  onRoomLeft,
  peerDisplayName,
  registerDataHandler,
  sendData,
} from '../webrtc/mesh.js';
import { LatestSender } from '../webrtc/latest-sender.js';
import { RaisedHands } from './hand-model.js';

/** Your own hand. */
export const localHandRaised = writable(false);
/** Remote participants whose hand is up. */
export const raisedHands = writable<Set<string>>(new Set());

export interface HandToast {
  id: number;
  /** The name this app shows for that person (the authenticated one), never text from the message. */
  name: string;
}
/** Brief "… raised their hand" notices. */
export const handToasts = writable<HandToast[]>([]);

const TOAST_MS = 4000;
const MAX_TOASTS = 3;

const hands = new RaisedHands();
let toastSeq = 0;
const toastTimers = new Set<ReturnType<typeof setTimeout>>();
/** Pressing the button repeatedly sends at most one update per 300ms, always the latest (peers assume "lowered"). */
const sender = new LatestSender<boolean>(
  { intervalMs: 300, read: () => get(localHandRaised), send: (raised) => broadcastData({ type: 'hand', raised }) },
  false
);

function publishStore(): void {
  raisedHands.set(new Set(hands.list()));
}

function showToast(name: string): void {
  const id = ++toastSeq;
  handToasts.update((list) => [...list, { id, name }].slice(-MAX_TOASTS));
  const timer = setTimeout(() => {
    toastTimers.delete(timer);
    handToasts.update((list) => list.filter((t) => t.id !== id));
  }, TOAST_MS);
  toastTimers.add(timer);
}

registerDataHandler('hand', (fromPeerId, msg) => {
  // mesh only hands us messages from verified connections; check again, and take the identity
  // from the connection (fromPeerId), never from anything in the message.
  if (!getPeerConnection(fromPeerId)?.trusted) return;
  const change = hands.receive(fromPeerId, msg, Date.now());
  if (!change) return;
  publishStore();
  if (change.toast) showToast(peerDisplayName(fromPeerId));
});

onPeerConnected((peerId) => {
  hands.connected(peerId, Date.now());
  // A newcomer (or someone whose connection was rebuilt) learns where our hand is now.
  sendData(peerId, { type: 'hand', raised: get(localHandRaised) });
});

// A rebuilt connection starts from scratch: no stale badge until the new verified channel re-sends it.
onPeerCreated((peerId) => {
  if (hands.remove(peerId)) publishStore();
});

onPeerLeft((peerId) => {
  if (hands.remove(peerId)) publishStore();
});

onRoomLeft(() => {
  hands.clear();
  publishStore();
  localHandRaised.set(false);
  sender.reset(false);
  for (const timer of toastTimers) clearTimeout(timer);
  toastTimers.clear();
  handToasts.set([]);
});

export function setHandRaised(raised: boolean): void {
  localHandRaised.set(raised);
  sender.notify();
}

export function toggleHand(): void {
  setHandRaised(!get(localHandRaised));
}
