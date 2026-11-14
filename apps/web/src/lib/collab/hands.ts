// Raise hand: each person raises or lowers only their own hand, and everyone sees it on their tile.
// Sent peer-to-peer over the end-to-end encrypted data channels; the server never sees it.
// Validation, rate limiting and notice rules live in hand-model.ts.

import { get, writable } from 'svelte/store';
import {
  broadcastData,
  getPeerConnection,
  onPeerConnected,
  onPeerLeft,
  onRoomLeft,
  peerDisplayName,
  registerDataHandler,
  sendData,
} from '../webrtc/mesh.js';
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
/** Pressing the button repeatedly sends at most one update per this many ms (always the latest). */
const MIN_SEND_INTERVAL_MS = 300;

const hands = new RaisedHands();
let toastSeq = 0;
const toastTimers = new Set<ReturnType<typeof setTimeout>>();
let lastSent = false;
let lastSentAt = 0;
let sendTimer: ReturnType<typeof setTimeout> | null = null;

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

onPeerLeft((peerId) => {
  if (hands.remove(peerId)) publishStore();
});

onRoomLeft(() => {
  hands.clear();
  publishStore();
  localHandRaised.set(false);
  lastSent = false;
  lastSentAt = 0;
  if (sendTimer) clearTimeout(sendTimer);
  sendTimer = null;
  for (const timer of toastTimers) clearTimeout(timer);
  toastTimers.clear();
  handToasts.set([]);
});

/** Tell everyone the current state, coalescing rapid toggles so the last one is never lost. */
function publish(): void {
  if (sendTimer) return; // a send is already scheduled; it reads the latest state
  const wait = lastSentAt + MIN_SEND_INTERVAL_MS - Date.now();
  if (wait > 0) {
    sendTimer = setTimeout(() => {
      sendTimer = null;
      publish();
    }, wait);
    return;
  }
  const raised = get(localHandRaised);
  if (raised === lastSent) return;
  lastSent = raised;
  lastSentAt = Date.now();
  broadcastData({ type: 'hand', raised });
}

export function setHandRaised(raised: boolean): void {
  localHandRaised.set(raised);
  publish();
}

export function toggleHand(): void {
  setHandRaised(!get(localHandRaised));
}
